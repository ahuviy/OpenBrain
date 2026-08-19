/**
 * Building one canonical thought from a cluster of near-duplicates.
 *
 * Merging is deterministic on purpose. An LLM asked to "combine these" will
 * paraphrase, and a paraphrase silently drops the literal a future search needs
 * — a ticket id, a price, a phone number. Concatenating what is not already
 * present keeps every token the sources held, at the cost of some redundancy.
 */

import type { ThoughtRow } from "../../db/queries.js";

export interface CanonicalThought {
  content: string;
  metadata: Record<string, unknown>;
  project: string | null;
  created_by: string | null;
  supersedes: string;
  merged_from: string[];
}

const UNIONED_LIST_KEYS = ["topics", "people", "action_items", "dates"] as const;

function unionListMetadata(sources: ThoughtRow[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of UNIONED_LIST_KEYS) {
    const seen: string[] = [];
    for (const row of sources) {
      const value = (row.metadata as Record<string, unknown>)[key];
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        if (typeof entry === "string" && !seen.includes(entry)) seen.push(entry);
      }
    }
    if (seen.length > 0) merged[key] = seen;
  }
  return merged;
}

/**
 * Most frequent type wins; a tie goes to the type the EARLIEST source carries.
 * Counting first and resolving ties afterwards is the only way to honour that —
 * a single pass keeping `>` awards whichever type reaches the count first, which
 * is a different rule that happens to agree only when the tie is two-way.
 */
function dominantType(ordered: ThoughtRow[]): string | undefined {
  const counts = new Map<string, number>();

  for (const row of ordered) {
    const type = typeOf(row);
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  let best = 0;
  for (const count of counts.values()) if (count > best) best = count;
  if (best === 0) return undefined;

  for (const row of ordered) {
    const type = typeOf(row);
    if (type && counts.get(type) === best) return type;
  }

  return undefined;
}

function typeOf(row: ThoughtRow): string | undefined {
  const type = (row.metadata as Record<string, unknown>).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * `source` and `provenance` are what `searchThoughtsBySource` matches importers
 * on. Dropping them makes a merged import invisible to its own importer, which
 * re-creates the originals on the next run and undoes the merge — permanently,
 * every run. They are carried from the earliest source that carries them.
 */
function withProvenance(
  metadata: Record<string, unknown>,
  ordered: ThoughtRow[],
): Record<string, unknown> {
  const merged = { ...metadata };

  for (const row of ordered) {
    const source = (row.metadata as Record<string, unknown>).source;
    if (merged.source === undefined && source !== undefined) merged.source = source;

    const provenance = (row.metadata as Record<string, unknown>).provenance;
    if (merged.provenance === undefined && provenance !== undefined) merged.provenance = provenance;
  }

  return merged;
}

function withType(
  metadata: Record<string, unknown>,
  type: string | undefined,
): Record<string, unknown> {
  return type ? { ...metadata, type } : metadata;
}

/**
 * A merge writes ONE row and archives the rest, so any dimension the sources
 * disagree on is silently collapsed onto the earliest source's value. For
 * `project` that means the other project's thoughts vanish from every
 * project-scoped search; for an import origin it means one importer loses its
 * anchor. Neither is recoverable by reading the merged row, so a cluster that
 * disagrees is left alone instead.
 */
export function canMerge(sources: ThoughtRow[]): boolean {
  const projects = new Set(sources.map((row) => row.project ?? ""));
  const authors = new Set(sources.map((row) => row.created_by ?? ""));
  const origins = new Set(sources.map((row) => originOf(row)));

  return projects.size <= 1 && authors.size <= 1 && origins.size <= 1;
}

function originOf(row: ThoughtRow): string {
  const metadata = row.metadata as Record<string, unknown>;
  const provenance = metadata.provenance as { origin?: string } | undefined;
  return provenance?.origin ?? (typeof metadata.source === "string" ? metadata.source : "");
}

function byCreatedAtAscending(a: ThoughtRow, b: ThoughtRow): number {
  return a.created_at.getTime() - b.created_at.getTime();
}

export function buildCanonical(sources: ThoughtRow[], runAt: string): CanonicalThought {
  const ordered = [...sources].sort(byCreatedAtAscending);
  const earliest = ordered[0];
  if (!earliest) throw new Error("buildCanonical: empty cluster");

  const byLengthDescending = [...sources].sort((a, b) => b.content.length - a.content.length);
  const parts: string[] = [];
  for (const row of byLengthDescending) {
    if (parts.some((part) => part.includes(row.content))) continue;
    parts.push(row.content);
  }

  const mergedFrom = ordered.map((row) => row.id);

  return {
    content: parts.join("\n\n"),
    metadata: {
      ...withProvenance(withType(unionListMetadata(ordered), dominantType(ordered)), ordered),
      // `supersedes` is a single FK and cannot express an N-way merge. This is
      // where the complete lineage lives, and the reason the FK was left alone.
      dream: { op: "merge", run_at: runAt, merged_from: mergedFrom },
    },
    project: earliest.project ?? null,
    created_by: earliest.created_by ?? null,
    supersedes: earliest.id,
    merged_from: mergedFrom,
  };
}
