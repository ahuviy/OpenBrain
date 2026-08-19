/**
 * Rendering a proposal for review.
 *
 * dream used to answer with counts and an id — "contradiction: 2" — and the
 * only tool that took the id was dream_apply. A proposal is reviewed exactly
 * once, so a caller who could not read the items had two moves, both bad:
 * accept thoughts it had never seen, or reject them by omission. This module
 * turns the stored items into something a reader can judge.
 *
 * It is pure and takes the thoughts it needs, because the two callers fetch
 * them differently — the run already holds every row it clustered, while a
 * later review has nothing but the ids inside the stored proposal.
 *
 * Keys come from keysFor() rather than a second numbering scheme. They are the
 * handles dream_apply resolves, and a review that numbered items independently
 * would eventually let someone accept a different item than the one they read.
 */

import { keysFor, type ProposalItem, type StoredProposal } from "./proposal.js";
import type { ContradictionVerdict } from "./constants.js";
import type { ThoughtRow } from "../db/queries.js";

/** `content` is null when the thought is gone — deleted since the run. */
export interface ReviewThought {
  id: string;
  content: string | null;
}

export interface ContradictionReview {
  key: string;
  kind: "contradiction";
  verdict: ContradictionVerdict;
  reason: string;
  obsolete_id: string;
  thoughts: Array<ReviewThought & { obsolete: boolean }>;
}

export interface SynthesisReview {
  key: string;
  kind: "synthesis";
  content: string;
  sources: ReviewThought[];
}

export type ReviewItem = ContradictionReview | SynthesisReview;

/**
 * What an immediately-applied operation did.
 *
 * A merge writes one row and archives the rest with no review step, so the run
 * has to say what it collapsed. Counts alone leave the one destructive thing
 * dream does on its own unauditable after the fact.
 */
export interface MergeAudit {
  kind: "merge";
  sources: ReviewThought[];
}

export type AppliedItem = MergeAudit;

export function mergeAudit(sources: ThoughtRow[]): MergeAudit {
  return { kind: "merge", sources: sources.map((row) => ({ id: row.id, content: row.content })) };
}

export function reviewItems(items: ProposalItem[], thoughts: ThoughtRow[]): ReviewItem[] {
  const byId = new Map(thoughts.map((row) => [row.id, row]));
  const keys = keysFor(items);

  // A missing thought is rendered, not skipped: an item whose sources silently
  // shrink reads as a smaller change than it is.
  const resolve = (id: string): ReviewThought => ({ id, content: byId.get(id)?.content ?? null });

  return items.map((item, index) => {
    const key = keys[index] ?? "";

    if (item.kind === "contradiction") {
      return {
        key,
        kind: "contradiction",
        verdict: item.verdict,
        reason: item.reason,
        obsolete_id: item.obsolete_id,
        thoughts: [item.a, item.b].map((id) => ({
          ...resolve(id),
          obsolete: id === item.obsolete_id,
        })),
      };
    }

    return { key, kind: "synthesis", content: item.content, sources: item.sources.map(resolve) };
  });
}

/** Every thought id a set of items refers to, for a caller that must fetch them. */
export function referencedThoughtIds(items: ProposalItem[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind === "contradiction") {
      ids.add(item.a);
      ids.add(item.b);
    } else {
      for (const source of item.sources) ids.add(source);
    }
  }
  return [...ids];
}

export interface ProposalReview {
  proposal_id: string;
  status: string;
  expires_at: string;
  /** True only when dream_apply would actually accept a call for this id. */
  actionable: boolean;
  items: ReviewItem[];
}

/**
 * A read-only view of a stored proposal.
 *
 * Expiry is reported as `expired` even while the stored row still says `open`,
 * because dream_apply expires lazily — on the call that finds the row stale.
 * Reporting the stored status here would promise a call that then throws.
 */
export function describeProposal(
  proposal: StoredProposal,
  thoughts: ThoughtRow[],
  now: Date,
): ProposalReview {
  const expired = proposal.expires_at.getTime() <= now.getTime();
  const status = proposal.status === "open" && expired ? "expired" : proposal.status;

  return {
    proposal_id: proposal.id,
    status,
    expires_at: proposal.expires_at.toISOString(),
    actionable: status === "open",
    items: reviewItems(proposal.items, thoughts),
  };
}
