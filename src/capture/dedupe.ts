/**
 * Pre-write duplicate detection.
 *
 * A phone capture cannot run "search first, then decide" reliably — the client
 * has to remember to do it, and on a small screen it usually doesn't. Doing the
 * check on the write path makes it unskippable: the embedding needed for the
 * INSERT is the same one used to look for a near-identical neighbour, so the
 * check costs one extra vector query and no extra embedding call.
 */

import type { SearchResult } from "../db/queries.js";

export interface DuplicateMatch {
  id: string;
  content: string;
  similarity: number;
  created_at: string;
}

/** Narrow view of `searchThoughts` so this stays unit-testable without a pool. */
export type SimilaritySearch = (
  embedding: number[],
  threshold: number,
  project?: string,
) => Promise<SearchResult[]>;

export interface DedupeOptions {
  enabled: boolean;
  threshold: number;
  /** Caller explicitly wants a second copy written. */
  force?: boolean;
  /** A capture that declares what it replaces is deliberate, never a duplicate. */
  supersedes?: string;
  project?: string;
}

/**
 * Return the closest existing thought at or above the threshold, or undefined
 * when the capture is new enough to write.
 */
export async function findDuplicate(
  search: SimilaritySearch,
  embedding: number[],
  options: DedupeOptions,
): Promise<DuplicateMatch | undefined> {
  if (!options.enabled || options.force || options.supersedes) return undefined;

  const matches = await search(embedding, options.threshold, options.project);
  const best = Array.isArray(matches) ? matches[0] : undefined;
  if (!best || best.similarity < options.threshold) return undefined;

  return {
    id: best.id,
    content: best.content,
    similarity: Math.round(best.similarity * 1000) / 1000,
    created_at: best.created_at.toISOString(),
  };
}

/** The message the caller sees instead of a silent second copy. */
export function formatDuplicateRejection(match: DuplicateMatch): string {
  const preview = match.content.length > 240 ? `${match.content.slice(0, 240)}…` : match.content;
  return [
    `Not captured — the brain already holds a near-identical thought (similarity ${match.similarity}).`,
    ``,
    `  id:      ${match.id}`,
    `  created: ${match.created_at}`,
    `  content: ${preview}`,
    ``,
    `If the new text adds something, call update_thought with id ${match.id} and the merged content.`,
    `If it is genuinely a separate thought, re-send this capture with force: true.`,
  ].join("\n");
}
