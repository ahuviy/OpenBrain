/**
 * Update discipline — what an edit is allowed to rewrite.
 *
 * An update re-runs metadata extraction over the new content, and the extractor
 * has no idea what the brain already decided. Letting its output replace the
 * stored metadata wholesale meant every content edit silently retyped the
 * thought and swapped its curated tags for freshly inferred near-duplicates —
 * `georgia` became `georgia-trip`, `car-rental` became `rental-issue`. The write
 * path was manufacturing exactly the vocabulary drift the dream sweep exists to
 * collapse, and `source` and `provenance` went with it.
 *
 * So the rule is inverted: an edit changes what it is asked to change. `type`,
 * `topics` and `people` are curated at capture, and a caller who wants them
 * different has to say so — anything absent from the patch is preserved by the
 * jsonb merge in `updateThought`. Only the fields genuinely derived from the
 * content refresh on their own.
 *
 * Caller-supplied values go through the same discipline capture uses, so an edit
 * cannot mint a tag a capture would have refused, and an edit that outgrows the
 * embedder's context is reported the same way a capture is.
 */

import {
  checkEmbeddingCoverage,
  EMBEDDING_COVERAGE_KEYS,
  type CaptureWarning,
} from "../api/validation.js";
import type { ThoughtMetadataExtracted } from "../embedder/types.js";
import {
  getDisciplineConfig,
  resolvePeople,
  resolveTopicsGated,
  resolveType,
  type DisciplineConfig,
  type DisciplineNote,
} from "./discipline.js";

/** The curated fields an edit may override, mirroring `capture_thought`. */
export interface UpdateFields {
  type?: string;
  topics?: string[];
  people?: string[];
}

export interface UpdateMetadataInput {
  /** The new content, for the embedding-coverage check. */
  content: string;
  /** Metadata the extractor produced from the NEW content. */
  extracted: ThoughtMetadataExtracted;
  /** What the caller explicitly asked to change. */
  caller: UpdateFields;
  /** Topic tags already present in the brain, for the new-tag gate. */
  vocabulary: readonly string[];
  /** Caller opted in to minting the unseen topic tags in this edit. */
  allowNewTopics?: boolean;
  config?: DisciplineConfig;
}

export interface UpdateMetadataResult {
  /** Keys to merge over the stored metadata. Absent key = preserved value. */
  patch: Record<string, unknown>;
  /** Keys to delete outright — a flag that is no longer true must not linger. */
  drop: string[];
  notes: DisciplineNote[];
  warnings: CaptureWarning[];
}

export function resolveUpdateMetadata(input: UpdateMetadataInput): UpdateMetadataResult {
  const config = input.config ?? getDisciplineConfig();
  const notes: DisciplineNote[] = [];

  // Re-derived from the content on every edit. Nothing curated lives here.
  const patch: Record<string, unknown> = {
    action_items: input.extracted.action_items,
    dates: input.extracted.dates,
  };

  // Shortening a thought back under the ceiling has to clear the flags, or the
  // metadata goes on claiming a truncation that no longer exists.
  const coverage = checkEmbeddingCoverage(input.content);
  Object.assign(patch, coverage.flags);
  const drop = coverage.warning ? [] : [...EMBEDDING_COVERAGE_KEYS];
  const warnings = coverage.warning ? [coverage.warning] : [];

  if (input.caller.type !== undefined) {
    patch.type = resolveType(undefined, input.caller.type, false);
  }

  if (input.caller.topics !== undefined) {
    const resolution = resolveTopicsGated(
      input.caller.topics,
      input.vocabulary,
      config,
      input.allowNewTopics,
    );
    notes.push(...resolution.notes);
    patch.topics = resolution.topics;
  }

  if (input.caller.people !== undefined) {
    const resolution = resolvePeople(input.caller.people, config.personAliases, config.selfNames);
    notes.push(...resolution.notes);
    patch.people = resolution.people;
  }

  return { patch, drop, notes, warnings };
}
