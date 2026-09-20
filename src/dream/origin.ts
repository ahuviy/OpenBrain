/**
 * Telling a captured thought from one the brain wrote itself.
 *
 * Synthesis adds a row and archives nothing, so its output sits in the corpus
 * beside the sources it was written from. Left unmarked, the next run treats it
 * as ordinary input — and because a summary is the most central text about its
 * own cluster, it is the row most likely to be pulled straight back into that
 * cluster and summarised again. Each pass drops the least predictable tokens
 * first, which are exactly the literals a later search needs.
 *
 * So: derived rows are OUTPUTS, never INPUTS. Dream's generative and
 * destructive operations read captured rows only, which caps generation depth
 * at one, permanently.
 *
 * Mirrors the `origin` generated column from migration 010 — the column is for
 * querying, this is for the row objects already in hand. Both read the same
 * metadata key, so they cannot disagree.
 */

import type { ThoughtRow } from "../db/queries.js";

/** True when a dream run wrote this thought rather than a person capturing it. */
export function isDerived(row: Pick<ThoughtRow, "metadata">): boolean {
  const metadata = row.metadata as Record<string, unknown> | null | undefined;
  if (!metadata || typeof metadata !== "object") return false;

  const dream = (metadata as { dream?: unknown }).dream;
  if (!dream || typeof dream !== "object") return false;

  return typeof (dream as { op?: unknown }).op === "string";
}

/** True when a person captured this thought. The only thing dream may generate from. */
export function isCaptured(row: Pick<ThoughtRow, "metadata">): boolean {
  return !isDerived(row);
}
