/**
 * Default similarity threshold for search.
 *
 * The right value depends on the embedder: cosine distributions differ between a
 * 768-dimension local model and a 1536-dimension hosted one, so a constant that
 * suits one deployment silently returns nothing on another. Same reasoning as
 * OPENBRAIN_DEDUPE_THRESHOLD, which is already configurable for this reason.
 *
 * An explicit `threshold` in the request always wins; this is only the default.
 */

export const DEFAULT_SEARCH_THRESHOLD = 0.5;

export function getSearchThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENBRAIN_SEARCH_THRESHOLD;
  if (raw === undefined) return DEFAULT_SEARCH_THRESHOLD;

  const value = Number(raw);
  // Outside [0, 1] a cosine threshold is not merely odd, it is a brain that
  // returns nothing for every query — fall back rather than honour it.
  if (!Number.isFinite(value) || value < 0 || value > 1) return DEFAULT_SEARCH_THRESHOLD;

  return value;
}
