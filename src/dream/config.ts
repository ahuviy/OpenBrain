/**
 * Dream tuning, read from the environment.
 *
 * Thresholds are deployment-specific: how close two thoughts sit depends on the
 * embedder, and the merge threshold in particular must stay ABOVE the write-path
 * dedupe threshold — dream consolidating what capture would have allowed is a
 * rule the two would otherwise disagree on.
 */

import { getDisciplineConfig } from "../capture/discipline.js";
import type { DreamThresholds } from "./index.js";

export const DEFAULT_THRESHOLDS: DreamThresholds = {
  neighbour: 0.8,
  merge: 0.94,
  contradictionFloor: 0.8,
  minSynthesisCluster: 3,
  watermarkSlackMs: 60_000,
};

export const DEFAULT_PROPOSAL_TTL_HOURS = 72;

/**
 * How much history one backfill slice covers.
 *
 * Days rather than a row count: the sweep walks a timeline, and a window in rows
 * would make each slice's cost depend on how busy that stretch of history
 * happened to be. Thirty days is roughly a month of writing per run, which for a
 * personal brain finishes a first sweep in a few runs and stays affordable on a
 * corpus years old. Zero disables the sweep.
 */
export const DEFAULT_BACKFILL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function numberFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function getDreamThresholds(env: NodeJS.ProcessEnv = process.env): DreamThresholds {
  const thresholds: DreamThresholds = {
    neighbour: numberFrom(env.DREAM_NEIGHBOUR_THRESHOLD, DEFAULT_THRESHOLDS.neighbour),
    merge: numberFrom(env.DREAM_MERGE_THRESHOLD, DEFAULT_THRESHOLDS.merge),
    contradictionFloor: numberFrom(
      env.DREAM_CONTRADICTION_FLOOR,
      DEFAULT_THRESHOLDS.contradictionFloor,
    ),
    minSynthesisCluster: numberFrom(
      env.DREAM_MIN_SYNTHESIS_CLUSTER,
      DEFAULT_THRESHOLDS.minSynthesisCluster,
    ),
    watermarkSlackMs: numberFrom(
      env.DREAM_WATERMARK_SLACK_MS,
      DEFAULT_THRESHOLDS.watermarkSlackMs,
    ),
  };

  const dedupeThreshold = getDisciplineConfig().dedupeThreshold;
  if (thresholds.merge < dedupeThreshold) {
    throw new Error(
      `DREAM_MERGE_THRESHOLD ${thresholds.merge} is below the write-path dedupe threshold ${dedupeThreshold}: dream would consolidate captures the write path deliberately allowed`,
    );
  }

  return thresholds;
}

export function getProposalTtlHours(env: NodeJS.ProcessEnv = process.env): number {
  return numberFrom(env.DREAM_PROPOSAL_TTL_HOURS, DEFAULT_PROPOSAL_TTL_HOURS);
}

/**
 * The backfill window in milliseconds, or 0 when the sweep is off.
 *
 * Negative is read as off rather than rejected: a sweep configured backwards
 * would walk forwards over the watermark and re-consolidate what the forward
 * hand just did, which is worse than not sweeping.
 */
export function getBackfillWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const days = numberFrom(env.DREAM_BACKFILL_DAYS, DEFAULT_BACKFILL_DAYS);
  return days > 0 ? days * DAY_MS : 0;
}
