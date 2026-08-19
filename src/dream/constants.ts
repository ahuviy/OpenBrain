/**
 * Finite value sets dream uses on the wire and in storage.
 *
 * Typed constants rather than bare strings: a verdict typo would otherwise
 * silently archive the wrong thought, and a proposal status typo would silently
 * let a proposal be applied twice.
 */

export const DREAM_OPS = ["vocabulary", "merge", "contradiction", "synthesis"] as const;
export type DreamOp = (typeof DREAM_OPS)[number];

export const PROPOSAL_STATUSES = ["open", "applied", "expired", "superseded"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * Re-exported, never redeclared: the provider contract owns this set, and a
 * second copy here would type-check while drifting from the runtime guard.
 */
export {
  CONTRADICTION_VERDICTS,
  type ContradictionVerdictName as ContradictionVerdict,
} from "../embedder/types.js";
