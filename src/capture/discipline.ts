/**
 * Capture discipline — server-side enforcement of write quality.
 *
 * Prompt-side discipline ("remember to pick a good type") does not survive a
 * phone. Mobile clients have no hooks, no settings file and no way to run a
 * pre-write checklist, so the rules that keep a brain clean have to live in the
 * server where every transport hits them: REST, MCP-over-stdio, and the OAuth
 * connector used by the claude.ai mobile app.
 *
 * Four rules, all individually switchable:
 *   1. type      — reject a capture that fell back to the catch-all `observation`
 *                  unless the caller asked for it explicitly.
 *   2. people    — collapse aliases onto one canonical name, drop self-references.
 *   3. topics    — normalise tag shape, apply alias map, and gate brand-new tags
 *                  so the vocabulary stops fragmenting.
 *   4. project   — never write into a null namespace.
 *
 * Deduplication lives next door in `dedupe.ts` because it needs an embedding and
 * a live pool; everything here is pure and unit-testable.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ThoughtType } from "../embedder/types.js";

/** The catch-all the metadata extractor falls back to when nothing else fits. */
export const FALLBACK_TYPE: ThoughtType = "observation";

export const THOUGHT_TYPES: readonly ThoughtType[] = [
  "observation",
  "task",
  "idea",
  "reference",
  "person_note",
  "decision",
  "meeting",
  "architecture",
  "pattern",
  "postmortem",
  "requirement",
  "bug",
  "convention",
];

export interface DisciplineNote {
  field: "type" | "people" | "topics" | "project";
  action: "canonicalised" | "dropped" | "normalised" | "defaulted" | "new_topic";
  message: string;
}

export class CaptureDisciplineError extends Error {
  readonly field: DisciplineNote["field"];

  constructor(field: DisciplineNote["field"], message: string) {
    super(message);
    this.name = "CaptureDisciplineError";
    this.field = field;
  }
}

// ─── Config ──────────────────────────────────────────────────────────

export interface DisciplineConfig {
  /** Reject a capture whose type fell back to `observation` without opt-in. */
  requireSpecificType: boolean;
  /** Reject a capture that introduces an unseen topic tag without opt-in. */
  requireKnownTopics: boolean;
  /** Applied when the caller sends no project. Empty string disables. */
  defaultProject: string;
  /** Reject a capture with no project instead of defaulting one in. */
  requireProject: boolean;
  /** Cosine similarity at or above which a capture is treated as a duplicate. */
  dedupeThreshold: number;
  /** Disable the pre-write duplicate check entirely. */
  dedupeEnabled: boolean;
  /** alias (lowercased) → canonical person name. */
  personAliases: Record<string, string>;
  /** People to strip from every capture — the brain owner is not a mention. */
  selfNames: string[];
  /** alias (normalised) → canonical topic tag. */
  topicAliases: Record<string, string>;
}

export const DEFAULT_DISCIPLINE_CONFIG: DisciplineConfig = {
  requireSpecificType: true,
  requireKnownTopics: false,
  defaultProject: "personal",
  requireProject: false,
  dedupeThreshold: 0.9,
  dedupeEnabled: true,
  personAliases: {},
  selfNames: [],
  topicAliases: {},
};

interface DisciplineConfigFile {
  personAliases?: Record<string, string>;
  selfNames?: string[];
  topicAliases?: Record<string, string>;
  requireSpecificType?: boolean;
  requireKnownTopics?: boolean;
  defaultProject?: string;
  requireProject?: boolean;
  dedupeThreshold?: number;
  dedupeEnabled?: boolean;
}

let cachedConfig: DisciplineConfig | undefined;

/** Drop the memoised config. Tests and config reloads use this. */
export function resetDisciplineConfig(): void {
  cachedConfig = undefined;
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "true" || v === "1";
}

function envNumber(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function readConfigFile(): DisciplineConfigFile {
  const path = process.env.OPENBRAIN_DISCIPLINE_CONFIG ?? resolve("config/discipline.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DisciplineConfigFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[discipline] Ignoring unreadable config at ${path}: ${String(err)}`);
    }
    return {};
  }
}

/**
 * Resolve the effective config: defaults < config file < environment.
 * Memoised — call `resetDisciplineConfig()` after mutating either source.
 */
export function getDisciplineConfig(): DisciplineConfig {
  if (cachedConfig) return cachedConfig;

  const file = readConfigFile();
  const merged: DisciplineConfig = {
    requireSpecificType:
      envBool("OPENBRAIN_REQUIRE_SPECIFIC_TYPE") ??
      file.requireSpecificType ??
      DEFAULT_DISCIPLINE_CONFIG.requireSpecificType,
    requireKnownTopics:
      envBool("OPENBRAIN_REQUIRE_KNOWN_TOPICS") ??
      file.requireKnownTopics ??
      DEFAULT_DISCIPLINE_CONFIG.requireKnownTopics,
    defaultProject:
      process.env.OPENBRAIN_DEFAULT_PROJECT ??
      file.defaultProject ??
      DEFAULT_DISCIPLINE_CONFIG.defaultProject,
    requireProject:
      envBool("OPENBRAIN_REQUIRE_PROJECT") ??
      file.requireProject ??
      DEFAULT_DISCIPLINE_CONFIG.requireProject,
    dedupeThreshold:
      envNumber("OPENBRAIN_DEDUPE_THRESHOLD") ??
      file.dedupeThreshold ??
      DEFAULT_DISCIPLINE_CONFIG.dedupeThreshold,
    dedupeEnabled:
      envBool("OPENBRAIN_DEDUPE_ENABLED") ??
      file.dedupeEnabled ??
      DEFAULT_DISCIPLINE_CONFIG.dedupeEnabled,
    personAliases: lowerKeys(file.personAliases ?? {}),
    selfNames: file.selfNames ?? [],
    topicAliases: normaliseKeys(file.topicAliases ?? {}),
  };

  cachedConfig = merged;
  return merged;
}

function lowerKeys(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[k.trim().toLowerCase()] = v;
  return out;
}

function normaliseKeys(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[normaliseTopic(k)] = normaliseTopic(v);
  return out;
}

// ─── Topics ──────────────────────────────────────────────────────────

/** Lowercase, hyphenate, strip anything that is not `[a-z0-9-]`. */
export function normaliseTopic(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

export interface TopicResolution {
  topics: string[];
  unknown: string[];
  notes: DisciplineNote[];
}

/**
 * Normalise every tag, apply the alias map, then snap onto an existing tag when
 * the only difference is a plural `s`. Anything still unseen is reported as
 * `unknown` so the caller can decide whether to gate on it.
 *
 * Deliberately lexical, not semantic: an embedding call per tag would double the
 * latency of every phone capture, and a near-miss snap is worse than a flagged
 * new tag.
 */
export function resolveTopics(
  raw: string[],
  vocabulary: readonly string[],
  aliases: Record<string, string>,
): TopicResolution {
  const known = new Set(vocabulary.map(normaliseTopic));
  const notes: DisciplineNote[] = [];
  const unknown: string[] = [];
  const topics: string[] = [];

  for (const original of raw) {
    const normalised = normaliseTopic(original);
    if (normalised.length === 0) continue;

    const aliased = aliases[normalised];
    let resolved = aliased ?? normalised;

    if (!known.has(resolved)) {
      const stemmed = stemMatch(resolved, known);
      if (stemmed) resolved = stemmed;
    }

    if (resolved !== normaliseTopic(original)) {
      notes.push({
        field: "topics",
        action: "canonicalised",
        message: `topic '${original}' resolved to '${resolved}'`,
      });
    } else if (normalised !== original) {
      notes.push({
        field: "topics",
        action: "normalised",
        message: `topic '${original}' normalised to '${normalised}'`,
      });
    }

    if (!known.has(resolved) && !unknown.includes(resolved)) {
      unknown.push(resolved);
      notes.push({
        field: "topics",
        action: "new_topic",
        message: `topic '${resolved}' does not exist in the brain yet`,
      });
    }

    if (!topics.includes(resolved)) topics.push(resolved);
  }

  return { topics, unknown, notes };
}

/** Match `markets` onto an existing `market`, or vice versa. Nothing looser. */
function stemMatch(topic: string, known: Set<string>): string | undefined {
  if (topic.endsWith("s")) {
    const singular = topic.slice(0, -1);
    if (known.has(singular)) return singular;
  }
  const plural = `${topic}s`;
  if (known.has(plural)) return plural;
  return undefined;
}

// ─── People ──────────────────────────────────────────────────────────

export interface PeopleResolution {
  people: string[];
  notes: DisciplineNote[];
}

/**
 * Collapse aliases onto canonical names and drop the brain owner. `Dohmen` and
 * `Bert Dohmen` are one person; tagging yourself on your own thought adds a
 * filter value that matches everything, which is the same as matching nothing.
 */
export function resolvePeople(
  raw: string[],
  aliases: Record<string, string>,
  selfNames: readonly string[],
): PeopleResolution {
  const self = new Set(selfNames.map((n) => n.trim().toLowerCase()));
  const notes: DisciplineNote[] = [];
  const people: string[] = [];

  for (const original of raw) {
    const trimmed = original.trim();
    if (trimmed.length === 0) continue;

    const canonical = aliases[trimmed.toLowerCase()] ?? trimmed;

    if (self.has(canonical.trim().toLowerCase())) {
      notes.push({
        field: "people",
        action: "dropped",
        message: `person '${original}' dropped — the brain owner is not a mention`,
      });
      continue;
    }

    if (canonical !== trimmed) {
      notes.push({
        field: "people",
        action: "canonicalised",
        message: `person '${original}' resolved to '${canonical}'`,
      });
    }

    if (!people.includes(canonical)) people.push(canonical);
  }

  return { people, notes };
}

// ─── Type ────────────────────────────────────────────────────────────

/**
 * The extractor returns `observation` both when it means it and when it gave up,
 * and the two are indistinguishable downstream. Requiring an explicit opt-in
 * turns "gave up" into a retry the caller can resolve in one round trip.
 */
export function resolveType(
  extracted: string | undefined,
  explicit: string | undefined,
  requireSpecificType: boolean,
): string {
  if (explicit !== undefined) {
    if (!THOUGHT_TYPES.includes(explicit as ThoughtType)) {
      throw new CaptureDisciplineError(
        "type",
        `type '${explicit}' is not a known thought type. Use one of: ${THOUGHT_TYPES.join(", ")}`,
      );
    }
    return explicit;
  }

  const resolved = extracted ?? FALLBACK_TYPE;

  if (requireSpecificType && resolved === FALLBACK_TYPE) {
    throw new CaptureDisciplineError(
      "type",
      `This capture was auto-typed as '${FALLBACK_TYPE}', the catch-all. Re-send it with an explicit 'type' — one of: ${THOUGHT_TYPES.join(", ")}. Pass type: "${FALLBACK_TYPE}" if that genuinely is the best fit.`,
    );
  }

  return resolved;
}

// ─── Orchestration ───────────────────────────────────────────────────

export interface DisciplineInput {
  /** Metadata the extractor produced from the content. */
  extracted: { type?: string; topics?: string[]; people?: string[] };
  /** Metadata the caller supplied, which already wins over `extracted`. */
  callerMetadata: Record<string, unknown>;
  /** Explicit type from the caller, if the transport exposes one. */
  explicitType?: string;
  project?: string;
  /** Topic tags already present in the brain, for the new-tag gate. */
  vocabulary: readonly string[];
  /** Caller opted in to minting the unseen topic tags in this capture. */
  allowNewTopics?: boolean;
  config?: DisciplineConfig;
}

export interface DisciplineResult {
  type: string;
  topics: string[];
  people: string[];
  project?: string;
  notes: DisciplineNote[];
}

/**
 * Apply every rule to one capture. Throws CaptureDisciplineError on the first
 * violation the caller has to fix; everything it could resolve on its own comes
 * back in `notes` so the response can show what the server changed.
 */
export function applyCaptureDiscipline(input: DisciplineInput): DisciplineResult {
  const config = input.config ?? getDisciplineConfig();
  const notes: DisciplineNote[] = [];

  const callerType = typeof input.callerMetadata.type === "string" ? input.callerMetadata.type : undefined;
  const type = resolveType(input.extracted.type, input.explicitType ?? callerType, config.requireSpecificType);

  const rawTopics = pickStringArray(input.callerMetadata.topics) ?? input.extracted.topics ?? [];
  const topicResolution = resolveTopics(rawTopics, input.vocabulary, config.topicAliases);
  notes.push(...topicResolution.notes);

  if (config.requireKnownTopics && topicResolution.unknown.length > 0 && !input.allowNewTopics) {
    throw new CaptureDisciplineError(
      "topics",
      `New topic tag(s) ${topicResolution.unknown.map((t) => `'${t}'`).join(", ")} are not in the brain's vocabulary. Re-send with an existing tag, or with new_topics: true to mint them deliberately.`,
    );
  }

  const rawPeople = pickStringArray(input.callerMetadata.people) ?? input.extracted.people ?? [];
  const peopleResolution = resolvePeople(rawPeople, config.personAliases, config.selfNames);
  notes.push(...peopleResolution.notes);

  const project = resolveProject(input.project, config, notes);

  return { type, topics: topicResolution.topics, people: peopleResolution.people, project, notes };
}

function resolveProject(
  raw: string | undefined,
  config: DisciplineConfig,
  notes: DisciplineNote[],
): string | undefined {
  if (raw !== undefined && raw.trim().length > 0) return raw;

  if (config.requireProject) {
    throw new CaptureDisciplineError(
      "project",
      "project is required — every thought belongs to a namespace. Send the project this thought belongs to.",
    );
  }

  if (config.defaultProject.length === 0) return undefined;

  notes.push({
    field: "project",
    action: "defaulted",
    message: `no project supplied — filed under '${config.defaultProject}'`,
  });
  return config.defaultProject;
}

function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

/** Render notes for a human (or an agent) reading the tool response. */
export function formatDisciplineNotes(notes: DisciplineNote[]): string {
  if (notes.length === 0) return "";
  const lines = notes.map((n) => `  • [${n.field}/${n.action}] ${n.message}`);
  return `\u{1f9f9} Open Brain normalised this capture:\n${lines.join("\n")}`;
}
