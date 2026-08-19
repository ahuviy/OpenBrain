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
import { overlappingThoughts, type ThoughtOverlap } from "./consistency.js";
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
  /** Advisory, present only when accepting would retire more than the conflict. */
  caution?: string;
}

/**
 * A contradiction archives a WHOLE thought over one contradicted section. When
 * the doomed thought is long, accepting it discards whatever else it held — a
 * weekly digest retired for one stale paragraph takes its unrelated rate-cut
 * data and incident history with it.
 *
 * Advisory rather than a veto: the judgment may still be right, and suppressing
 * the item would hide a real conflict. The reviewer is the one who can tell.
 */
const LONG_THOUGHT_CHARS = 2000;

function cautionFor(obsolete: string | null, survivor: string | null): string | undefined {
  if (!obsolete || obsolete.length < LONG_THOUGHT_CHARS) return undefined;

  const ratio = survivor && survivor.length > 0 ? obsolete.length / survivor.length : Infinity;
  if (ratio < 2) return undefined;

  return (
    `the thought to archive is ${obsolete.length} characters, far longer than the one superseding ` +
    `it — accepting retires all of it, including any unrelated material it holds`
  );
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

/**
 * A vocabulary rewrite, with both sides.
 *
 * Vocabulary and merge are the operations that apply with no proposal gate, so
 * they are where an after-the-fact trail matters most — and a rewrite that only
 * says "1 change" cannot be checked against what you expected it to do.
 */
export interface VocabularyAudit {
  kind: "vocabulary";
  id: string;
  topics?: { from: string[]; to: string[] };
  people?: { from: string[]; to: string[] };
}

export type AppliedItem = MergeAudit | VocabularyAudit;

function tagList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function vocabularyAudit(
  id: string,
  before: Record<string, unknown>,
  after: { topics?: string[]; people?: string[] },
): VocabularyAudit {
  return {
    kind: "vocabulary",
    id,
    ...(after.topics ? { topics: { from: tagList(before.topics), to: after.topics } } : {}),
    ...(after.people ? { people: { from: tagList(before.people), to: after.people } } : {}),
  };
}

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
      const survivorId = item.obsolete_id === item.a ? item.b : item.a;
      const caution = cautionFor(
        resolve(item.obsolete_id).content,
        resolve(survivorId).content,
      );

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
        ...(caution ? { caution } : {}),
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
  /**
   * Thoughts appearing in more than one item, and which items would archive
   * them. A reviewer accepting item by item would otherwise have to diff ids
   * across items by hand to notice that two items disagree about one thought.
   */
  overlaps: ThoughtOverlap[];
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
    overlaps: overlappingThoughts(proposal.items),
  };
}
