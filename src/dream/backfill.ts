/**
 * The backward-moving hand of consolidation.
 *
 * A watermark makes a run cost a function of activity rather than of history,
 * and pays for it by never looking back: every thought it settles is behind the
 * watermark for ever, and every consolidation improvement is forward-only. That
 * is most of a brain, and the part most likely to need the work — four days of
 * scheduled runs applied three vocabulary rewrites while one full-corpus pass
 * over a single project found sixteen findings sitting untouched behind it.
 *
 * So a run has two hands. The forward one reads `(watermark, ∞)`. The backward
 * one reads ONE bounded slice ending at a cursor that starts at the watermark
 * and walks back a window per run, until it reaches the oldest live thought and
 * stops. Bounded, so a large corpus cannot make a single run unaffordable;
 * resumable, so a failure costs one slice; and finite, so the sweep ends rather
 * than re-embedding the whole corpus for ever.
 *
 * Clearing `dream_state.backfill_cursor` and `backfill_done_at` restarts it,
 * which is what to do after changing a rule that should reach old thoughts.
 */

import type { DreamPort, DreamResult } from "./index.js";

export interface BackfillState {
  cursor: Date | null;
  done: boolean;
}

export interface BackfillSlice {
  /** Exclusive lower bound — the run reads `(from, until]`. */
  from: Date;
  /** Inclusive upper bound. */
  until: Date;
  /** Where the cursor lands after this slice. */
  cursor: Date;
  /** Whether this slice reaches the oldest thought, ending the sweep. */
  done: boolean;
}

/**
 * The next slice, or undefined when there is nothing left to sweep.
 *
 * Undefined covers every "not now": the sweep is disabled, already finished, the
 * project is empty, or the cursor has passed the oldest thought. A caller that
 * gets undefined does nothing rather than running an empty pass, because an
 * empty pass still writes a run row and reads like a sweep that found nothing.
 */
export function planBackfill(
  state: BackfillState,
  watermark: Date,
  oldest: Date | undefined,
  windowMs: number,
): BackfillSlice | undefined {
  if (windowMs <= 0) return undefined;
  if (state.done) return undefined;
  if (oldest === undefined) return undefined;

  // The sweep starts where the forward hand had already got to: everything above
  // the watermark is the forward hand's, and re-reading it here would double
  // every run's cost to consolidate what was just consolidated.
  const until = state.cursor ?? watermark;
  if (until.getTime() <= oldest.getTime()) return undefined;

  // `from` is exclusive and `oldest` is a real row, so the floor has to sit one
  // millisecond BELOW it or the last slice of the sweep skips the oldest thought
  // in the project — the one most likely to carry a spelling nothing else uses.
  const floor = new Date(oldest.getTime() - 1);
  const stepped = new Date(until.getTime() - windowMs);
  const from = stepped.getTime() < floor.getTime() ? floor : stepped;

  return { from, until, cursor: from, done: from.getTime() <= floor.getTime() };
}

export interface BackfillRun {
  slice: BackfillSlice;
  result: DreamResult;
}

/**
 * Consolidates one slice of history and moves the cursor.
 *
 * The cursor moves only after the slice has run: a slice that throws is retried
 * whole on the next run rather than silently skipped, which for a sweep that
 * passes each thought exactly once is the difference between "later" and
 * "never".
 *
 * `run` is injected rather than closing over runDream here so the decision this
 * function owns — which slice, and when to stop — is testable without a judge,
 * an embedder or a database.
 */
export async function runBackfillSlice(
  port: Pick<DreamPort, "loadWatermark" | "loadBackfill" | "oldestThought" | "saveBackfill">,
  project: string,
  windowMs: number,
  run: (slice: BackfillSlice) => Promise<DreamResult>,
): Promise<BackfillRun | undefined> {
  const state = await port.loadBackfill(project);
  if (state.done || windowMs <= 0) return undefined;

  const watermark = await port.loadWatermark(project);
  const slice = planBackfill(state, watermark, await port.oldestThought(project), windowMs);
  if (!slice) return undefined;

  const result = await run(slice);
  await port.saveBackfill(project, slice.cursor, slice.done);

  return { slice, result };
}
