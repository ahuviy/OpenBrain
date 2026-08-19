/**
 * Pairwise contradiction judgment.
 *
 * Cosine similarity cannot tell "X is true" from "X is false" — the two
 * sentences differ by one token and sit almost on top of each other in the
 * embedding space. That is why this is the one operation dream never applies on
 * its own: the judgment is a model's opinion, and a wrong one silently archives
 * a true thought.
 */

import type { ThoughtRow } from "../../db/queries.js";
import type { ContradictionJudgment } from "../../embedder/types.js";
import { CONTRADICTION_VERDICTS, type ContradictionVerdict } from "../constants.js";

export type { ContradictionJudgment } from "../../embedder/types.js";

/** Narrow view of the embedder so this stays unit-testable without a provider. */
export type JudgePair = (a: ThoughtRow, b: ThoughtRow) => Promise<ContradictionJudgment>;

export interface ContradictionItem {
  kind: "contradiction";
  a: string;
  b: string;
  verdict: ContradictionVerdict;
  reason: string;
  obsolete_id: string;
}

function isKnownVerdict(value: unknown): value is ContradictionVerdict {
  return CONTRADICTION_VERDICTS.includes(value as ContradictionVerdict);
}

export async function planContradictionItems(
  pairs: Array<[ThoughtRow, ThoughtRow]>,
  judge: JudgePair,
): Promise<ContradictionItem[]> {
  const items: ContradictionItem[] = [];

  for (const [a, b] of pairs) {
    let judgment: ContradictionJudgment;
    try {
      judgment = await judge(a, b);
    } catch (err) {
      console.warn(`[dream] judgment failed pair=${a.id},${b.id} error=${String(err)}`);
      continue;
    }

    if (!isKnownVerdict(judgment.verdict)) {
      console.warn(`[dream] judgment discarded pair=${a.id},${b.id} reason=unknown_verdict raw=${String(judgment.verdict)}`);
      continue;
    }

    if (judgment.verdict === "independent") continue;

    const obsolete = judgment.obsolete_id;
    if (obsolete !== a.id && obsolete !== b.id) {
      // A model that names a third id has hallucinated one; a model that names
      // none simply omitted it. Same outcome, different diagnosis.
      const reason = obsolete === undefined ? "missing_obsolete_id" : "unknown_obsolete_id";
      console.warn(
        `[dream] judgment discarded pair=${a.id},${b.id} reason=${reason} obsolete_id=${String(obsolete)}`,
      );
      continue;
    }

    items.push({
      kind: "contradiction",
      a: a.id,
      b: b.id,
      verdict: judgment.verdict,
      reason: judgment.reason,
      obsolete_id: obsolete,
    });
  }

  return items;
}
