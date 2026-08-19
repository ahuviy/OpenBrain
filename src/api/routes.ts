/**
 * REST API routes using Hono.
 * Provides /health, /memories, /memories/search, /memories/list, /memories/batch,
 * /memories/:id (PUT, DELETE), /stats endpoints.
 */

import { getSearchThreshold } from "./search-config.js";
import { runDream } from "../dream/index.js";
import { applyProposal } from "../dream/proposal.js";
import { createApplyPort, createDreamPort, loadProposalReview } from "../dream/port.js";
import { getDreamThresholds, getProposalTtlHours } from "../dream/config.js";
import type { DreamOp } from "../dream/constants.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { getPool } from "../db/connection.js";
import { notifyFailure } from "../notify.js";
import {
  insertThought,
  searchThoughts,
  hybridSearchThoughts,
  listThoughts,
  getThoughtStats,
  updateThought,
  deleteThought,
  batchInsertThoughts,
  searchThoughtsBySource,
  type ListFilters,
  type BatchThoughtInput,
} from "../db/queries.js";
import { getEmbedder } from "../embedder/index.js";
import {
  validateCaptureInput,
  validateBatchInput,
  CaptureValidationError,
  logWarnings,
  isStrictIngestEnabled,
} from "./validation.js";
import {
  applyCaptureDiscipline,
  CaptureDisciplineError,
  getDisciplineConfig,
} from "../capture/discipline.js";
import { findDuplicate } from "../capture/dedupe.js";
import { getTopicVocabulary, rememberTopics } from "../capture/vocabulary.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApi(): Hono {
  const app = new Hono();
  const embedder = getEmbedder();
  const pool = getPool();

  /** One nearest neighbour, for the pre-write duplicate check. */
  const nearestNeighbour = (embedding: number[], threshold: number, project?: string) =>
    searchThoughts(pool, embedding, 1, threshold, {}, project, false, undefined);

  // Middleware
  app.use("*", cors());
  app.use("*", logger());

  // Global error handler — return structured JSON for all errors
  app.onError((err, c) => {
    console.error("[api] Unhandled error:", err.message);
    notifyFailure("⚠️ Open Brain DOWN", `REST error: ${err.message}`);
    return c.json(
      { error: err.message, service: "open-brain-api" },
      500
    );
  });

  // ─── Health Check ────────────────────────────────────────────────

  app.get("/health", (c) => {
    const capabilities = [
      "capture",
      "search",
      "list",
      "batch",
      "update",
      "delete",
      "stats",
      "by-source",
      "hybrid-search",
      "strict-validation",
      "warning-channel",
      "embed-truncation-warning",
    ];
    if (isStrictIngestEnabled()) capabilities.push("strict-ingest");

    const discipline = getDisciplineConfig();
    if (discipline.dedupeEnabled) capabilities.push("dedupe-on-write");
    if (discipline.requireSpecificType) capabilities.push("require-specific-type");
    if (discipline.requireKnownTopics) capabilities.push("require-known-topics");
    if (discipline.requireProject) capabilities.push("require-project");
    return c.json({
      status: "healthy",
      service: "open-brain-api",
      capabilities,
    });
  });

  // ─── Capture Memory ──────────────────────────────────────────────

  app.post("/memories", async (c) => {
    const rawBody = (await c.req.json()) as Record<string, unknown>;
    const force = rawBody.force === true;
    const allowNewTopics = rawBody.new_topics === true;
    delete rawBody.force;
    delete rawBody.new_topics;

    let input;
    try {
      input = validateCaptureInput(rawBody, { defaultSource: "api" });
    } catch (err) {
      if (err instanceof CaptureValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    try {
      const config = getDisciplineConfig();

      const [embedding, autoMetadata] = await Promise.all([
        embedder.generateEmbedding(input.content),
        embedder.extractMetadata(input.content),
      ]);

      const duplicate = await findDuplicate(nearestNeighbour, embedding, {
        enabled: config.dedupeEnabled,
        threshold: config.dedupeThreshold,
        force,
        supersedes: input.supersedes,
        project: input.project,
      });
      if (duplicate) {
        return c.json({ error: "duplicate_thought", duplicate }, 409);
      }

      let disciplined;
      try {
        disciplined = applyCaptureDiscipline({
          extracted: autoMetadata,
          callerMetadata: input.metadata,
          project: input.project,
          vocabulary: await getTopicVocabulary(pool),
          allowNewTopics,
          config,
        });
      } catch (err) {
        if (err instanceof CaptureDisciplineError) {
          return c.json({ error: err.message, field: err.field }, 422);
        }
        throw err;
      }

      // Caller-supplied metadata wins over auto-extracted; both lose to the fields the
      // discipline pass normalised and to `source`, which is canonicalised at the top
      // level so we can index on it.
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
        transport: "rest",
        source: input.source,
        project: disciplined.project,
        created_by: input.created_by,
      });

      return c.json({
        id: result.id,
        type: disciplined.type,
        topics: disciplined.topics,
        people: disciplined.people,
        project: result.project,
        captured_at: result.created_at.toISOString(),
        warnings: input.warnings,
        discipline_notes: disciplined.notes,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Capture failed:", message);
      return c.json(
        { error: "Failed to capture thought", detail: message },
        502
      );
    }
  });

  // ─── Batch Capture ───────────────────────────────────────────────

  app.post("/memories/batch", async (c) => {
    const rawBatch = (await c.req.json()) as Record<string, unknown>;
    const batchForce = rawBatch.force === true;
    const batchAllowNewTopics = rawBatch.new_topics === true;
    delete rawBatch.force;
    delete rawBatch.new_topics;

    let batch;
    try {
      batch = validateBatchInput(rawBatch, { defaultSource: "api" });
    } catch (err) {
      if (err instanceof CaptureValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    try {
      const config = getDisciplineConfig();
      const vocabulary = await getTopicVocabulary(pool);

      const prepared = await Promise.all(
        batch.items.map(async (item, index) => {
          const [embedding, autoMetadata] = await Promise.all([
            embedder.generateEmbedding(item.content),
            embedder.extractMetadata(item.content),
          ]);

          const duplicate = await findDuplicate(nearestNeighbour, embedding, {
            enabled: config.dedupeEnabled,
            threshold: config.dedupeThreshold,
            force: batchForce,
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
              allowNewTopics: batchAllowNewTopics,
              config,
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
            transport: "rest",
            scope: "batch-envelope",
            field: w.field,
            reason: w.reason,
            message: w.message,
          })}`,
        );
      }
      for (const item of batch.items) {
        logWarnings(item.warnings, {
          transport: "rest",
          source: item.source,
          project: item.project,
          created_by: item.created_by,
        });
      }

      return c.json({
        count: results.length,
        submitted: batch.items.length,
        skipped,
        envelope_warnings: batch.warnings,
        results: results.map((r, i) => {
          const origin = writable[i];
          return {
            id: r.id,
            index: origin?.index ?? i,
            content: r.content,
            metadata: r.metadata,
            project: r.project,
            captured_at: r.created_at.toISOString(),
            warnings: origin ? (batch.items[origin.index]?.warnings ?? []) : [],
            discipline_notes: origin?.notes ?? [],
          };
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Batch capture failed:", message);
      return c.json(
        { error: "Failed to batch capture thoughts", detail: message },
        502
      );
    }
  });

  // ─── Search Memories ─────────────────────────────────────────────

  app.post("/memories/search", async (c) => {
    const body = await c.req.json<{
      query: string;
      limit?: number;
      threshold?: number;
      project?: string;
      created_by?: string;
      type?: string;
      topic?: string;
      include_archived?: boolean;
      mode?: "hybrid" | "semantic";
    }>();

    if (!body.query || body.query.trim().length === 0) {
      return c.json({ error: "query is required" }, 400);
    }

    try {
      // Build JSONB filter from type/topic
      const filter: Record<string, unknown> = {};
      if (body.type) filter.type = body.type;
      if (body.topic) filter.topics = [body.topic];

      const mode = body.mode ?? "hybrid";
      const queryEmbedding = await embedder.generateEmbedding(body.query);

      if (mode === "semantic") {
        const results = await searchThoughts(
          pool,
          queryEmbedding,
          body.limit ?? 10,
          body.threshold ?? getSearchThreshold(),
          filter,
          body.project,
          body.include_archived,
          body.created_by
        );

        return c.json({
          query: body.query,
          mode,
          count: results.length,
          results: results.map((r) => ({
            id: r.id,
            content: r.content,
            metadata: r.metadata,
            similarity: Math.round(r.similarity * 1000) / 1000,
            created_at: r.created_at.toISOString(),
          })),
        });
      }

      const results = await hybridSearchThoughts(
        pool,
        queryEmbedding,
        body.query,
        body.limit ?? 10,
        body.threshold ?? getSearchThreshold(),
        filter,
        body.project,
        body.include_archived,
        body.created_by
      );

      return c.json({
        query: body.query,
        mode: "hybrid",
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          similarity: Math.round(r.similarity * 1000) / 1000,
          text_rank: Math.round(r.text_rank * 100000) / 100000,
          score: Math.round(r.score * 100000) / 100000,
          matched_by: r.matched_by,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Search failed:", message);
      return c.json(
        { error: "Failed to search thoughts", detail: message },
        502
      );
    }
  });

  // ─── List Memories ───────────────────────────────────────────────

  app.post("/memories/list", async (c) => {
    try {
      const body = await c.req.json<ListFilters>();
      const results = await listThoughts(pool, body);

      return c.json({
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          project: r.project,
          created_by: r.created_by,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] List failed:", message);
      return c.json(
        { error: "Failed to list thoughts", detail: message },
        500
      );
    }
  });

  // ─── Update Memory ───────────────────────────────────────────────

  app.put("/memories/:id", async (c) => {
    const id = c.req.param("id");

    if (!UUID_RE.test(id)) {
      return c.json({ error: "id must be a valid UUID" }, 400);
    }

    const body = await c.req.json<{ content: string }>();

    if (!body.content || body.content.trim().length === 0) {
      return c.json({ error: "content is required" }, 400);
    }

    try {
      const [embedding, metadata] = await Promise.all([
        embedder.generateEmbedding(body.content),
        embedder.extractMetadata(body.content),
      ]);

      const result = await updateThought(pool, id, body.content, embedding, metadata);

      return c.json({
        status: "updated",
        id: result.id,
        type: metadata.type,
        topics: metadata.topics,
        content: result.content,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        return c.json({ error: message }, 404);
      }
      console.error("[api] Update failed:", message);
      return c.json(
        { error: "Failed to update thought", detail: message },
        502
      );
    }
  });

  // ─── Delete Memory ───────────────────────────────────────────────

  app.delete("/memories/:id", async (c) => {
    const id = c.req.param("id");

    if (!UUID_RE.test(id)) {
      return c.json({ error: "id must be a valid UUID" }, 400);
    }

    try {
      const result = await deleteThought(pool, id);

      if (!result.deleted) {
        return c.json({ error: `Thought not found: ${id}` }, 404);
      }

      return c.json({ status: "deleted", id: result.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Delete failed:", message);
      return c.json(
        { error: "Failed to delete thought", detail: message },
        502
      );
    }
  });

  // ─── Get Memories by Source ──────────────────────────────────────────

  app.get("/memories/by-source", async (c) => {
    const source = c.req.query("source");

    if (!source || source.trim().length === 0) {
      return c.json({ error: "source query parameter is required" }, 400);
    }

    try {
      const project = c.req.query("project");
      const created_by = c.req.query("created_by");
      const include_archived = c.req.query("include_archived") === "true";
      const limitParam = c.req.query("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;

      const results = await searchThoughtsBySource(pool, source, {
        project: project ?? undefined,
        created_by: created_by ?? undefined,
        include_archived,
        limit,
      });

      return c.json({
        source,
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          project: r.project,
          created_by: r.created_by,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] By-source lookup failed:", message);
      return c.json(
        { error: "Failed to look up memories by source", detail: message },
        500
      );
    }
  });

  // ─── Stats ───────────────────────────────────────────────────────

  app.get("/stats", async (c) => {
    try {
      const project = c.req.query("project");
      const created_by = c.req.query("created_by");
      const stats = await getThoughtStats(pool, project, created_by);
      return c.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Stats failed:", message);
      return c.json(
        { error: "Failed to get stats", detail: message },
        500
      );
    }
  });

  // Dream has a REST twin of each MCP tool: the rules must bind on every
  // transport, so neither port owns any dream logic.
  app.post("/dream", async (c) => {
    try {
      const body = await c.req.json<{ project?: string; ops?: DreamOp[]; dry_run?: boolean }>();
      const discipline = getDisciplineConfig();
      const port = createDreamPort(pool, embedder, getProposalTtlHours());

      const result = await runDream(
        port,
        (a, b) => embedder.judgeContradiction({ id: a.id, content: a.content }, { id: b.id, content: b.content }),
        (contents) => embedder.synthesise(contents),
        {
          topicAliases: discipline.topicAliases,
          personAliases: discipline.personAliases,
          selfNames: discipline.selfNames,
        },
        getDreamThresholds(),
        { project: body.project ?? "", ops: body.ops, dry_run: body.dry_run === true },
        () => new Date(),
      );

      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Dream failed:", message);
      return c.json({ error: "Dream failed", detail: message }, 500);
    }
  });

  // GET, not POST: reading a proposal changes nothing, and dream_apply is the
  // only call that should ever close one.
  app.get("/dream/proposals/:id", async (c) => {
    try {
      const review = await loadProposalReview(pool, c.req.param("id"), new Date());
      if (!review) {
        return c.json({ error: "Proposal not found" }, 404);
      }
      return c.json(review);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Dream review failed:", message);
      return c.json({ error: "Dream review failed", detail: message }, 500);
    }
  });

  app.post("/dream/apply", async (c) => {
    try {
      const body = await c.req.json<{ proposal_id?: string; accept?: string[] }>();
      if (!body.proposal_id) {
        return c.json({ error: "proposal_id is required" }, 400);
      }

      const result = await applyProposal(
        createApplyPort(pool, embedder),
        body.proposal_id,
        body.accept ?? [],
        new Date(),
      );

      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[api] Dream apply failed:", message);
      return c.json({ error: "Dream apply failed", detail: message }, 500);
    }
  });

  return app;
}
