/**
 * Cluster synthesis.
 *
 * A merge collapses thoughts that say the same thing. Synthesis is for the
 * cluster that does not: several thoughts circling one subject from different
 * days, where the useful statement is the one nobody wrote down. It therefore
 * ADDS a thought and archives nothing — unlike merge, the sources keep standing
 * on their own.
 */

import type { ThoughtRow } from "../../db/queries.js";

/** Narrow view of the embedder so this stays unit-testable without a provider. */
export type Synthesise = (contents: string[]) => Promise<string>;

export interface SynthesisItem {
  kind: "synthesis";
  content: string;
  sources: string[];
}

/**
 * Metadata for a written summary.
 *
 * `dream.sources` is the whole point: a summary that cannot name what it was
 * written from is an unattributable claim, and nothing else in the row links it
 * back to its cluster — synthesis archives nothing, so there is no `supersedes`
 * edge to follow either.
 */
export function buildSynthesisMetadata(
  sources: string[],
  runAt: string,
): Record<string, unknown> {
  return {
    type: "observation",
    topics: [],
    people: [],
    dream: { op: "synthesis", run_at: runAt, sources },
  };
}

export async function planSynthesisItems(
  clusters: ThoughtRow[][],
  synthesise: Synthesise,
  minimumClusterSize: number,
): Promise<SynthesisItem[]> {
  const items: SynthesisItem[] = [];

  for (const cluster of clusters) {
    if (cluster.length < minimumClusterSize) continue;

    let content: string;
    try {
      content = await synthesise(cluster.map((row) => row.content));
    } catch (err) {
      console.warn(
        `[dream] cluster skipped cluster=${cluster.map((r) => r.id).join(",")} reason=synthesis_failed error=${String(err)}`,
      );
      continue;
    }

    if (content.trim().length === 0) {
      console.warn(
        `[dream] cluster skipped cluster=${cluster.map((r) => r.id).join(",")} reason=empty_synthesis`,
      );
      continue;
    }

    items.push({ kind: "synthesis", content, sources: cluster.map((row) => row.id) });
  }

  return items;
}
