/**
 * MCP Server for Open Brain.
 * Exposes seven tools: search_thoughts, list_thoughts, capture_thought, thought_stats,
 * update_thought, delete_thought, capture_thoughts (batch).
 *
 * Uses the official @modelcontextprotocol/sdk TypeScript SDK.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getPool } from "../db/connection.js";
import { notifyFailure } from "../notify.js";
import {
  insertThought,
  searchThoughts,
  listThoughts,
  getThoughtStats,
  updateThought,
  deleteThought,
  batchInsertThoughts,
  type ListFilters,
  type BatchThoughtInput,
} from "../db/queries.js";
import { getEmbedder } from "../embedder/index.js";
import {
  validateCaptureInput,
  validateBatchInput,
  CaptureValidationError,
  formatWarnings,
  logWarnings,
} from "../api/validation.js";
import {
  applyCaptureDiscipline,
  CaptureDisciplineError,
  formatDisciplineNotes,
  getDisciplineConfig,
  THOUGHT_TYPES,
} from "../capture/discipline.js";
import { findDuplicate, formatDuplicateRejection } from "../capture/dedupe.js";
import { getTopicVocabulary, rememberTopics } from "../capture/vocabulary.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tool params that steer the write itself rather than describing the thought. */
const CONTROL_PARAMS = ["force", "new_topics"] as const;

/** Tool params the schema exposes at the top level but the store keeps in metadata. */
const METADATA_PARAMS = ["type", "topics", "people"] as const;

/**
 * Reshape MCP tool arguments into the capture body the validator expects:
 * control flags dropped, descriptive params folded into `metadata`. Without
 * this, `type`/`topics`/`people` hit the validator's deprecated-top-level path
 * and would be rejected outright under strict ingest.
 */
export function toCaptureBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {
    ...(args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)
      ? (args.metadata as Record<string, unknown>)
      : {}),
  };

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if ((CONTROL_PARAMS as readonly string[]).includes(key)) continue;
    if ((METADATA_PARAMS as readonly string[]).includes(key)) {
      metadata[key] = value;
      continue;
    }
    if (key === "metadata") continue;
    body[key] = value;
  }

  if (Object.keys(metadata).length > 0) body.metadata = metadata;
  return body;
}

/** Same reshaping as `toCaptureBody`, applied to the envelope and every item. */
export function toBatchBody(args: Record<string, unknown>): Record<string, unknown> {
  const body = toCaptureBody(args);
  if (Array.isArray(args.thoughts)) {
    body.thoughts = args.thoughts.map((t) =>
      t !== null && typeof t === "object" ? toCaptureBody(t as Record<string, unknown>) : t
    );
  }
  return body;
}

export function createMcpServer(): Server {
  const server = new Server(
    { name: "open-brain", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  const embedder = getEmbedder();
  const pool = getPool();

  /** One nearest neighbour, for the pre-write duplicate check. */
  const nearestNeighbour = (embedding: number[], threshold: number, project?: string) =>
    searchThoughts(pool, embedding, 1, threshold, {}, project, false, undefined);

  // ─── List Tools ──────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_thoughts",
        description:
          "Search your brain for thoughts semantically related to a query. Returns results ranked by similarity score. Supports project scoping and metadata filters.\n\n" +
          "Run this BEFORE every capture_thought: if a result is about the same thing, update that thought instead of adding a second copy of it.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Natural language search query",
            },
            limit: {
              type: "integer",
              description: "Maximum results to return (default: 10)",
              default: 10,
            },
            threshold: {
              type: "number",
              description: "Minimum similarity score 0-1 (default: 0.5)",
              default: 0.5,
            },
            project: {
              type: "string",
              description: "Scope search to a specific project",
            },
            type: {
              type: "string",
              description:
                "Filter by thought type: observation, task, idea, reference, person_note, decision, meeting, architecture, pattern, postmortem, requirement, bug, convention",
            },
            topic: {
              type: "string",
              description: "Filter by topic tag",
            },
            include_archived: {
              type: "boolean",
              description: "Include archived thoughts (default: false)",
              default: false,
            },
            created_by: {
              type: "string",
              description: "Filter results to thoughts created by a specific user",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "list_thoughts",
        description:
          "List thoughts filtered by type, topic, person mentioned, project, or time range.\n\n" +
          "Use it to check which topic tag the brain already uses for a subject before capturing with a new one.",
        inputSchema: {
          type: "object" as const,
          properties: {
            type: {
              type: "string",
              description:
                "Filter by thought type: observation, task, idea, reference, person_note, decision, meeting, architecture, pattern, postmortem, requirement, bug, convention",
            },
            topic: {
              type: "string",
              description: "Filter by topic tag",
            },
            person: {
              type: "string",
              description: "Filter by person mentioned",
            },
            days: {
              type: "integer",
              description: "Only return thoughts from the last N days",
            },
            project: {
              type: "string",
              description: "Scope to a specific project",
            },
            include_archived: {
              type: "boolean",
              description: "Include archived thoughts (default: false)",
              default: false,
            },
            created_by: {
              type: "string",
              description: "Filter results to thoughts created by a specific user",
            },
          },
        },
      },
      {
        name: "capture_thought",
        description:
          "Save a new thought to your brain. Generates the embedding and extracts metadata automatically.\n\n" +
          "CAPTURE PROTOCOL — follow it before every call:\n" +
          "1. Search first. Run search_thoughts on the gist of the thought. If a close match exists, call update_thought on that id instead of capturing a second copy. The server also checks this on write and will refuse a near-identical capture.\n" +
          `2. Type it. Pass 'type' explicitly — the most specific of: ${THOUGHT_TYPES.join(", ")}. 'observation' is the catch-all and is rejected unless you pass it deliberately, so reach for it last.\n` +
          "3. Reuse topic tags. Check thought_stats or list_thoughts for the tag the brain already uses and pass that one. Do not mint 'markets' when 'market-analysis' exists.\n" +
          "4. Name people canonically. Full names, and never the brain owner — a thought is not a mention of the person who wrote it.\n" +
          "5. Scope it. Pass the 'project' this thought belongs to; captures without one are filed under the default namespace.",
        inputSchema: {
          type: "object" as const,
          properties: {
            content: {
              type: "string",
              description: "The thought to capture (raw text)",
            },
            type: {
              type: "string",
              enum: [...THOUGHT_TYPES],
              description:
                "Thought type — pass the most specific one that fits. Omit only when you want the extractor to infer it; an inferred 'observation' is rejected.",
            },
            topics: {
              type: "array",
              items: { type: "string" },
              description:
                "1-3 topic tags (lowercase, hyphenated). Reuse tags the brain already has rather than minting near-duplicates.",
            },
            people: {
              type: "array",
              items: { type: "string" },
              description:
                "People mentioned, by canonical full name. Do not include the brain owner.",
            },
            project: {
              type: "string",
              description: "Scope this thought to a project/workspace",
            },
            source: {
              type: "string",
              description: "Provenance tracking — where this thought came from (default: 'mcp')",
            },
            supersedes: {
              type: "string",
              description: "UUID of a prior thought this one replaces",
            },
            created_by: {
              type: "string",
              description: "User who created this thought (optional, for multi-developer provenance)",
            },
            force: {
              type: "boolean",
              description:
                "Write even if a near-identical thought already exists. Only after reading the existing one and deciding it is genuinely separate.",
              default: false,
            },
            new_topics: {
              type: "boolean",
              description:
                "Allow this capture to mint topic tags the brain has never used. Only when no existing tag fits.",
              default: false,
            },
          },
          required: ["content"],
        },
      },
      {
        name: "thought_stats",
        description:
          "Get statistics about your brain: total thoughts, type distribution, top topics, and top people mentioned. Optionally scoped to a project or user.\n\n" +
          "The top-topics list is the brain's tag vocabulary — read it before inventing a new tag.",
        inputSchema: {
          type: "object" as const,
          properties: {
            project: {
              type: "string",
              description: "Scope stats to a specific project",
            },
            created_by: {
              type: "string",
              description: "Scope stats to a specific user",
            },
          },
        },
      },
      {
        name: "update_thought",
        description:
          "Update an existing thought's content. Re-generates embedding and re-extracts metadata automatically.\n\n" +
          "This is the correct response to a duplicate: when a capture is refused because a near-identical thought exists, merge the new information into that thought's content and update it here.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "UUID of the thought to update",
            },
            content: {
              type: "string",
              description: "New content for the thought",
            },
          },
          required: ["id", "content"],
        },
      },
      {
        name: "delete_thought",
        description:
          "Permanently delete a thought by ID. Deleted thoughts no longer appear in search or list results.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "UUID of the thought to delete",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "capture_thoughts",
        description:
          "Batch capture multiple thoughts in one call. Each thought gets independent embedding, metadata extraction, duplicate check and discipline pass. All share the same project and source.\n\n" +
          "The capture_thought protocol applies to every item: search first, give each item an explicit specific 'type', reuse existing topic tags, canonical people only. Items that duplicate an existing thought are skipped, not written — the response says which.",
        inputSchema: {
          type: "object" as const,
          properties: {
            thoughts: {
              type: "array",
              description: "Array of thoughts to capture",
              items: {
                type: "object",
                properties: {
                  content: {
                    type: "string",
                    description: "The thought content (raw text)",
                  },
                  type: {
                    type: "string",
                    enum: [...THOUGHT_TYPES],
                    description: "Thought type — the most specific one that fits this item",
                  },
                  topics: {
                    type: "array",
                    items: { type: "string" },
                    description: "1-3 topic tags, reusing the brain's existing vocabulary",
                  },
                  people: {
                    type: "array",
                    items: { type: "string" },
                    description: "People mentioned, by canonical full name",
                  },
                },
                required: ["content"],
              },
            },
            force: {
              type: "boolean",
              description: "Write every item even if a near-identical thought already exists",
              default: false,
            },
            new_topics: {
              type: "boolean",
              description: "Allow these captures to mint topic tags the brain has never used",
              default: false,
            },
            project: {
              type: "string",
              description: "Scope all thoughts to a project/workspace",
            },
            source: {
              type: "string",
              description: "Provenance tracking (default: 'mcp')",
            },
            created_by: {
              type: "string",
              description: "User who created these thoughts (optional, for multi-developer provenance)",
            },
          },
          required: ["thoughts"],
        },
      },
    ],
  }));

  // ─── Call Tool ───────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // ── search_thoughts ──
        case "search_thoughts": {
          const query = args?.query as string;
          const limit = (args?.limit as number) ?? 10;
          const threshold = (args?.threshold as number) ?? 0.5;
          const project = args?.project as string | undefined;
          const type = args?.type as string | undefined;
          const topic = args?.topic as string | undefined;
          const include_archived = (args?.include_archived as boolean) ?? false;
          const created_by = args?.created_by as string | undefined;

          // Build JSONB filter from type/topic
          const filter: Record<string, unknown> = {};
          if (type) filter.type = type;
          if (topic) filter.topics = [topic];

          const queryEmbedding = await embedder.generateEmbedding(query);
          const results = await searchThoughts(
            pool, queryEmbedding, limit, threshold, filter, project, include_archived, created_by
          );

          const formatted = results.map((r) => ({
            content: r.content,
            metadata: r.metadata,
            similarity: Math.round(r.similarity * 1000) / 1000,
            created_at: r.created_at.toISOString(),
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ count: formatted.length, results: formatted }, null, 2),
              },
            ],
          };
        }

        // ── list_thoughts ──
        case "list_thoughts": {
          const filters: ListFilters = {
            type: args?.type as string | undefined,
            topic: args?.topic as string | undefined,
            person: args?.person as string | undefined,
            days: args?.days as number | undefined,
            project: args?.project as string | undefined,
            created_by: args?.created_by as string | undefined,
            include_archived: (args?.include_archived as boolean) ?? false,
          };

          const results = await listThoughts(pool, filters);

          const formatted = results.map((r) => ({
            id: r.id,
            content: r.content,
            metadata: r.metadata,
            created_at: r.created_at.toISOString(),
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ count: formatted.length, results: formatted }, null, 2),
              },
            ],
          };
        }

        // ── capture_thought ──
        case "capture_thought": {
          let input;
          try {
            input = validateCaptureInput(toCaptureBody(args ?? {}), { defaultSource: "mcp" });
          } catch (err) {
            if (err instanceof CaptureValidationError) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err.message}` }],
                isError: true,
              };
            }
            throw err;
          }

          const config = getDisciplineConfig();

          // Generate embedding and extract metadata in parallel
          const [embedding, autoMetadata] = await Promise.all([
            embedder.generateEmbedding(input.content),
            embedder.extractMetadata(input.content),
          ]);

          const duplicate = await findDuplicate(nearestNeighbour, embedding, {
            enabled: config.dedupeEnabled,
            threshold: config.dedupeThreshold,
            force: args?.force === true,
            supersedes: input.supersedes,
            project: input.project,
          });
          if (duplicate) {
            return {
              content: [{ type: "text" as const, text: formatDuplicateRejection(duplicate) }],
              isError: true,
            };
          }

          let disciplined;
          try {
            disciplined = applyCaptureDiscipline({
              extracted: autoMetadata,
              callerMetadata: input.metadata,
              project: input.project,
              vocabulary: await getTopicVocabulary(pool),
              allowNewTopics: args?.new_topics === true,
              config,
            });
          } catch (err) {
            if (err instanceof CaptureDisciplineError) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err.message}` }],
                isError: true,
              };
            }
            throw err;
          }

          const fullMetadata = {
            ...autoMetadata,
            ...input.metadata,
            type: disciplined.type,
            topics: disciplined.topics,
            people: disciplined.people,
            source: input.source,
          };
          const result = await insertThought(
            pool, input.content, embedding, fullMetadata, disciplined.project, input.supersedes, input.created_by
          );
          rememberTopics(disciplined.topics);

          logWarnings(input.warnings, {
            transport: "mcp",
            source: input.source,
            project: disciplined.project,
            created_by: input.created_by,
          });

          const captureContent: { type: "text"; text: string }[] = [];
          if (input.warnings.length > 0) {
            captureContent.push({ type: "text" as const, text: formatWarnings(input.warnings) });
          }
          if (disciplined.notes.length > 0) {
            captureContent.push({ type: "text" as const, text: formatDisciplineNotes(disciplined.notes) });
          }
          captureContent.push({
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "captured",
                id: result.id,
                type: disciplined.type,
                topics: disciplined.topics,
                people: disciplined.people,
                project: result.project,
                action_items: autoMetadata.action_items,
                captured_at: result.created_at.toISOString(),
                warnings: input.warnings,
                discipline_notes: disciplined.notes,
              },
              null,
              2
            ),
          });

          return { content: captureContent };
        }

        // ── thought_stats ──
        case "thought_stats": {
          const project = args?.project as string | undefined;
          const created_by = args?.created_by as string | undefined;
          const stats = await getThoughtStats(pool, project, created_by);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(stats, null, 2),
              },
            ],
          };
        }

        // ── update_thought ──
        case "update_thought": {
          const id = args?.id as string;
          const content = args?.content as string;

          if (!UUID_RE.test(id)) {
            return {
              content: [{ type: "text" as const, text: "Error: id must be a valid UUID" }],
              isError: true,
            };
          }

          // Re-generate embedding and re-extract metadata
          const [embedding, metadata] = await Promise.all([
            embedder.generateEmbedding(content),
            embedder.extractMetadata(content),
          ]);

          const result = await updateThought(pool, id, content, embedding, metadata);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "updated",
                    id: result.id,
                    type: metadata.type,
                    topics: metadata.topics,
                    updated_at: result.created_at.toISOString(),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // ── delete_thought ──
        case "delete_thought": {
          const id = args?.id as string;

          if (!UUID_RE.test(id)) {
            return {
              content: [{ type: "text" as const, text: "Error: id must be a valid UUID" }],
              isError: true,
            };
          }

          const result = await deleteThought(pool, id);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        // ── capture_thoughts (batch) ──
        case "capture_thoughts": {
          let batch;
          try {
            batch = validateBatchInput(toBatchBody(args ?? {}), { defaultSource: "mcp" });
          } catch (err) {
            if (err instanceof CaptureValidationError) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err.message}` }],
                isError: true,
              };
            }
            throw err;
          }

          const batchConfig = getDisciplineConfig();
          const vocabulary = await getTopicVocabulary(pool);

          // Process each item: embed + extract metadata + duplicate check + discipline
          const prepared = await Promise.all(
            batch.items.map(async (item, index) => {
              const [embedding, autoMetadata] = await Promise.all([
                embedder.generateEmbedding(item.content),
                embedder.extractMetadata(item.content),
              ]);

              const duplicate = await findDuplicate(nearestNeighbour, embedding, {
                enabled: batchConfig.dedupeEnabled,
                threshold: batchConfig.dedupeThreshold,
                force: args?.force === true,
                supersedes: item.supersedes,
                project: item.project,
              });
              if (duplicate) {
                return { index, skipped: { reason: "duplicate" as const, duplicate } };
              }

              try {
                const disciplined = applyCaptureDiscipline({
                  extracted: autoMetadata,
                  callerMetadata: item.metadata,
                  project: item.project,
                  vocabulary,
                  allowNewTopics: args?.new_topics === true,
                  config: batchConfig,
                });
                const thought: BatchThoughtInput = {
                  content: item.content,
                  embedding,
                  metadata: {
                    ...autoMetadata,
                    ...item.metadata,
                    type: disciplined.type,
                    topics: disciplined.topics,
                    people: disciplined.people,
                    source: item.source,
                  },
                  project: disciplined.project,
                  created_by: item.created_by,
                };
                return { index, thought, notes: disciplined.notes };
              } catch (err) {
                if (err instanceof CaptureDisciplineError) {
                  return { index, skipped: { reason: "rejected" as const, message: err.message } };
                }
                throw err;
              }
            })
          );

          const writable = prepared.filter(
            (p): p is { index: number; thought: BatchThoughtInput; notes: ReturnType<typeof applyCaptureDiscipline>["notes"] } =>
              "thought" in p
          );
          const skipped = prepared
            .filter((p): p is { index: number; skipped: NonNullable<(typeof prepared)[number]["skipped"]> } => "skipped" in p)
            .map((p) => ({ index: p.index, ...p.skipped }));

          const results = await batchInsertThoughts(pool, writable.map((w) => w.thought));
          for (const w of writable) {
            rememberTopics((w.thought.metadata.topics as string[] | undefined) ?? []);
          }

          for (const w of batch.warnings) {
            console.warn(
              `[ingest-warning] ${JSON.stringify({
                transport: "mcp",
                scope: "batch-envelope",
                field: w.field,
                reason: w.reason,
                message: w.message,
              })}`,
            );
          }
          for (const item of batch.items) {
            logWarnings(item.warnings, {
              transport: "mcp",
              source: item.source,
              project: item.project,
              created_by: item.created_by,
            });
          }

          const formatted = results.map((r, i) => {
            const origin = writable[i];
            return {
              id: r.id,
              index: origin?.index ?? i,
              content: r.content,
              metadata: r.metadata,
              captured_at: r.created_at.toISOString(),
              warnings: origin ? (batch.items[origin.index]?.warnings ?? []) : [],
              discipline_notes: origin?.notes ?? [],
            };
          });

          const totalItemWarnings = formatted.reduce((n, f) => n + f.warnings.length, 0);
          const batchContent: { type: "text"; text: string }[] = [];
          if (batch.warnings.length > 0 || totalItemWarnings > 0) {
            const lines: string[] = [];
            if (batch.warnings.length > 0) {
              lines.push(formatWarnings(batch.warnings).replace(/^\u26a0\ufe0f.*\n/, "\u26a0\ufe0f Batch envelope:\n"));
            }
            formatted.forEach((f) => {
              if (f.warnings.length > 0) {
                lines.push(`\u26a0\ufe0f thoughts[${f.index}]:\n${formatWarnings(f.warnings).split("\n").slice(1).join("\n")}`);
              }
            });
            batchContent.push({ type: "text" as const, text: lines.join("\n\n") });
          }
          if (skipped.length > 0) {
            const lines = skipped.map((s) =>
              s.reason === "duplicate"
                ? `  \u2022 thoughts[${s.index}] skipped \u2014 duplicate of ${s.duplicate.id} (similarity ${s.duplicate.similarity})`
                : `  \u2022 thoughts[${s.index}] skipped \u2014 ${s.message}`
            );
            batchContent.push({
              type: "text" as const,
              text: `\u26d4 ${skipped.length} of ${batch.items.length} thoughts were not written:\n${lines.join("\n")}`,
            });
          }
          batchContent.push({
            type: "text" as const,
            text: JSON.stringify(
              {
                count: formatted.length,
                submitted: batch.items.length,
                skipped,
                envelope_warnings: batch.warnings,
                results: formatted,
              },
              null,
              2
            ),
          });

          return { content: batchContent };
        }

        default:
          return {
            content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[mcp] Tool "${name}" failed:`, message);
      notifyFailure("⚠️ Open Brain DOWN", `Tool "${name}" failed: ${message}`);
      return {
        content: [
          { type: "text" as const, text: `❌ OPEN BRAIN DOWN — ${message}` },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Start the MCP server on stdio transport.
 * Used when running as a standalone MCP process (e.g., `npx open-brain-mcp`).
 */
export async function startMcpStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] Server running on stdio transport");
}
