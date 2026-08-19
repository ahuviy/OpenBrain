/**
 * Proposal bookkeeping.
 *
 * The risky operations are judgments, and a judgment the caller has not seen is
 * not a decision. A proposal is therefore reviewed exactly once: whatever is not
 * accepted is rejected, and the proposal closes either way. Leaving it open
 * would let the corpus drift underneath a stale plan.
 */

import { PROPOSAL_STATUSES, type ProposalStatus } from "./constants.js";
import type { ContradictionItem } from "./ops/contradiction.js";
import type { SynthesisItem } from "./ops/synthesis.js";

export type ProposalItem = ContradictionItem | SynthesisItem;

export interface ProposalPartition {
  accepted: ProposalItem[];
  rejected: string[];
}

/** Stable handle a caller names in `dream_apply`. Index is position within kind. */
export function itemKey(item: ProposalItem, indexWithinKind: number): string {
  return `${item.kind}:${indexWithinKind}`;
}

export function keysFor(items: ProposalItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const next = (seen.get(item.kind) ?? 0) + 1;
    seen.set(item.kind, next);
    return itemKey(item, next);
  });
}

/** Throws on any unknown key, before a single row is written. */
export function partitionByAccepted(items: ProposalItem[], accept: string[]): ProposalPartition {
  const keys = keysFor(items);

  for (const key of accept) {
    if (!keys.includes(key)) {
      throw new Error(`dream_apply: unknown proposal item ${key}`);
    }
  }

  const accepted: ProposalItem[] = [];
  const rejected: string[] = [];

  keys.forEach((key, index) => {
    const item = items[index];
    if (!item) return;
    if (accept.includes(key)) accepted.push(item);
    else rejected.push(key);
  });

  return { accepted, rejected };
}

export interface StoredProposal {
  id: string;
  status: string;
  expires_at: Date;
  items: ProposalItem[];
}

export interface ApplyPort {
  load(id: string): Promise<StoredProposal | undefined>;
  archiveThought(id: string): Promise<void>;
  setSupersedes(winner: string, loser: string): Promise<void>;
  insertSynthesis(content: string, sources: string[]): Promise<void>;
  setStatus(id: string, status: ProposalStatus): Promise<void>;
}

export interface ApplyResult {
  applied: string[];
  rejected: string[];
  status: ProposalStatus;
}

/**
 * A proposal is reviewed exactly once. Expiry is enforced here rather than by a
 * sweeper: the corpus moves under a stored plan, and applying a week-old
 * judgment would archive thoughts judged against content that has since changed.
 */
export async function applyProposal(
  port: ApplyPort,
  id: string,
  accept: string[],
  now: Date,
): Promise<ApplyResult> {
  const proposal = await port.load(id);
  if (!proposal) throw new Error(`dream_apply: proposal not found ${id}`);

  if (proposal.status !== "open") {
    throw new Error(`dream_apply: proposal ${id} is ${proposal.status}, not open`);
  }

  if (proposal.expires_at.getTime() <= now.getTime()) {
    await port.setStatus(id, "expired");
    throw new Error(`dream_apply: proposal ${id} expired at ${proposal.expires_at.toISOString()}`);
  }

  // Throws on an unknown key before a single row is written.
  const partition = partitionByAccepted(proposal.items, accept);
  const applied: string[] = [];
  const keys = keysFor(proposal.items);

  for (const item of partition.accepted) {
    const key = keys[proposal.items.indexOf(item)] ?? "";
    if (item.kind === "contradiction") {
      const winner = item.obsolete_id === item.a ? item.b : item.a;
      await port.archiveThought(item.obsolete_id);
      await port.setSupersedes(winner, item.obsolete_id);
    } else {
      await port.insertSynthesis(item.content, item.sources);
    }
    applied.push(key);
  }

  await port.setStatus(id, "applied");

  return { applied, rejected: partition.rejected, status: "applied" };
}

export { PROPOSAL_STATUSES };
