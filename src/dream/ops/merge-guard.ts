/**
 * The semantic screen in front of merge.
 *
 * Merge fires on embedding similarity alone, and cosine distance cannot tell
 * "X is forbidden" from "X is how we do it": one negation moves a sentence
 * barely at all. Two flatly incompatible conventions therefore sat ABOVE the
 * merge threshold and were merged immediately and unreviewably, while the same
 * disagreement phrased differently fell below it and went through the proposal
 * gate. The pairs most in need of review were the ones that skipped it.
 *
 * So merge now asks the same judge contradiction uses, and merges only what the
 * judge clears. That costs a judgment per merge cluster, where merge used to be
 * free — the alternative is a consolidation pass that silently resolves the
 * disagreements it exists to surface.
 *
 * Anything the screen cannot clear is held back rather than merged: a judge that
 * errors, or returns a verdict this code does not know, is not evidence that two
 * thoughts agree. A held-back cluster costs one re-judgment next run; a wrongly
 * merged one costs a thought.
 */

import type { ThoughtRow } from "../../db/queries.js";
import { CONTRADICTION_VERDICTS, type ContradictionVerdict } from "../constants.js";
import type { ContradictionItem, JudgePair } from "./contradiction.js";

export interface MergeScreen {
  /** Clusters the judge cleared to merge. */
  mergeable: ThoughtRow[][];
  /** Disagreements found while screening, for the proposal. */
  contradictions: ContradictionItem[];
  /** Clusters held back with nothing to propose — failed or unusable judgments. */
  blocked: number;
}

function isKnownVerdict(value: unknown): value is ContradictionVerdict {
  return CONTRADICTION_VERDICTS.includes(value as ContradictionVerdict);
}

function pairsOf<T>(members: T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      pairs.push([members[i]!, members[j]!]);
    }
  }
  return pairs;
}

export async function screenMergeClusters(
  clusters: ThoughtRow[][],
  judge: JudgePair,
): Promise<MergeScreen> {
  const screen: MergeScreen = { mergeable: [], contradictions: [], blocked: 0 };

  for (const cluster of clusters) {
    // A cluster merges as a unit, so one disagreement settles it: clearing the
    // pairs that agree and merging those would still collapse the disagreement
    // into the survivor. Stop judging as soon as that is known.
    let cleared = true;
    let proposed = false;

    for (const [a, b] of pairsOf(cluster)) {
      let judgment;
      try {
        judgment = await judge(a, b);
      } catch (err) {
        console.warn(`[dream] merge screen failed pair=${a.id},${b.id} error=${String(err)}`);
        cleared = false;
        break;
      }

      if (!isKnownVerdict(judgment.verdict)) {
        console.warn(
          `[dream] merge screen blocked pair=${a.id},${b.id} reason=unknown_verdict raw=${String(judgment.verdict)}`,
        );
        cleared = false;
        break;
      }

      if (judgment.verdict === "independent") continue;

      cleared = false;

      const obsolete = judgment.obsolete_id;
      if (obsolete !== a.id && obsolete !== b.id) {
        // "These two disagree" is established even when the judge names no
        // usable id; there is simply nothing to propose. Not merging is the
        // decision that matters.
        const reason = obsolete === undefined ? "missing_obsolete_id" : "unknown_obsolete_id";
        console.warn(
          `[dream] merge screen blocked pair=${a.id},${b.id} reason=${reason} obsolete_id=${String(obsolete)}`,
        );
        break;
      }

      screen.contradictions.push({
        kind: "contradiction",
        a: a.id,
        b: b.id,
        verdict: judgment.verdict,
        reason: judgment.reason,
        obsolete_id: obsolete,
      });
      proposed = true;
      break;
    }

    if (cleared) screen.mergeable.push(cluster);
    else if (!proposed) screen.blocked += 1;
  }

  return screen;
}
