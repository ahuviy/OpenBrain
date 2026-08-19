/**
 * Choosing what a dream run looks at.
 *
 * The corpus only grows, so re-examining all of it every run makes cost a
 * function of history rather than of activity. A watermark bounds the run to
 * what changed, and neighbour expansion brings in the older thoughts those
 * changes actually touch — an old thought still gets merged when a new one
 * duplicates it, without paying to re-judge every settled pair.
 */

import type { ThoughtRow } from "../db/queries.js";

export interface CandidateRow extends ThoughtRow {
  updated_at: Date;
}

/**
 * `thoughts.project` is nullable but `dream_state.project` is the primary key.
 * Every mapping between the two goes through here, so the NULL bucket has
 * exactly one spelling.
 */
export function projectKey(project?: string | null): string {
  return project ?? "";
}

/**
 * Advancing to the newest row the run READ is unsafe. `set_updated_at` stamps
 * `updated_at` when a statement runs, not when its transaction commits, so a
 * write stamped before the run's snapshot can commit after it: invisible to this
 * run, yet below a watermark set from the rows this run could see. That thought
 * is then never selected again.
 *
 * The watermark therefore never passes a commit horizon — the run's start less a
 * slack window covering the longest transaction expected to be in flight.
 * Anything at or after the horizon stays eligible next run; the cost is
 * re-examining a few rows, which every operation is idempotent against.
 */
export function nextWatermark(
  rows: CandidateRow[],
  current: Date,
  runStartedAt: Date,
  slackMs: number,
): Date {
  if (rows.length === 0) return current;

  let newest = current;
  for (const row of rows) {
    if (row.updated_at.getTime() > newest.getTime()) newest = row.updated_at;
  }

  const horizon = new Date(runStartedAt.getTime() - slackMs);
  const capped = newest.getTime() > horizon.getTime() ? horizon : newest;

  return capped.getTime() > current.getTime() ? capped : current;
}

/**
 * Keeps the watermark behind anything still awaiting review.
 *
 * A thought marked settled while the proposal naming it is unreviewed can never
 * be found again: the next run does not select it, so nothing regenerates the
 * item, and an expired or superseded proposal takes the judgment with it. That
 * is how a proposal became unreadable AND unreconstructable at once.
 *
 * Holding costs a re-judgment of those pairs on every run until the proposal is
 * reviewed, which is bounded by the review and visible in the run's counts. A
 * new run supersedes the stale proposal rather than colliding with it.
 *
 * Never rewinds: held thoughts older than the stored watermark were settled by
 * an earlier run, and moving back would re-examine the whole corpus behind them.
 */
export function holdBackWatermark(
  advanced: Date,
  held: Array<{ updated_at: Date }>,
  current: Date,
): Date {
  if (held.length === 0) return advanced;

  let oldest = held[0]!.updated_at;
  for (const row of held) {
    if (row.updated_at.getTime() < oldest.getTime()) oldest = row.updated_at;
  }

  // Strictly before: listCandidatesSince selects on `updated_at > watermark`, so
  // a watermark equal to the row's stamp would exclude the very row being held.
  const limit = new Date(oldest.getTime() - 1);
  const capped = limit.getTime() < advanced.getTime() ? limit : advanced;

  return capped.getTime() > current.getTime() ? capped : current;
}
