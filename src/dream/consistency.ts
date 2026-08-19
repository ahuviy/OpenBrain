/**
 * Cross-item consistency within one proposal.
 *
 * Every item is judged on its own, so nothing stops a thought being the obsolete
 * side of one item and the surviving, authoritative side of another. Both read
 * as coherent alone. Accepting both archives the thought the second item says to
 * keep, and a reviewer working item by item cannot see the conflict without
 * diffing ids across items by hand.
 *
 * Two defences, because they answer different failures. `dropConflictingItems`
 * removes the item that would archive a thought an earlier item depends on —
 * the set that reaches the reviewer cannot destroy itself. `overlappingThoughts`
 * reports what remains: a thought may legitimately appear twice, and saying so
 * is cheaper than expecting anyone to notice.
 *
 * The earlier item wins, deliberately. Items arrive in the order the run found
 * them, and preferring the first keeps the outcome stable across reruns; the
 * dropped one comes back next run if it is still true.
 */

import { keysFor, type ProposalItem } from "./proposal.js";

export interface DroppedItems {
  items: ProposalItem[];
  dropped: ProposalItem[];
}

/** Ids an item would archive. Synthesis archives nothing. */
function archives(item: ProposalItem): string[] {
  return item.kind === "contradiction" ? [item.obsolete_id] : [];
}

/** Ids an item depends on still existing. */
function relies(item: ProposalItem): string[] {
  if (item.kind === "synthesis") return [];
  return [item.a, item.b].filter((id) => id !== item.obsolete_id);
}

export function dropConflictingItems(items: ProposalItem[]): DroppedItems {
  const kept: ProposalItem[] = [];
  const dropped: ProposalItem[] = [];
  const doomed = new Set<string>();
  const needed = new Set<string>();

  for (const item of items) {
    const kills = archives(item);
    const conflicts =
      kills.some((id) => needed.has(id)) || kills.some((id) => doomed.has(id));

    if (conflicts) {
      dropped.push(item);
      continue;
    }

    kept.push(item);
    for (const id of kills) doomed.add(id);
    for (const id of relies(item)) needed.add(id);
  }

  return { items: kept, dropped };
}

export interface ThoughtOverlap {
  id: string;
  /** Item keys the thought appears in. */
  keys: string[];
  /** The subset of those keys that would archive it. */
  obsolete_in: string[];
}

export function overlappingThoughts(items: ProposalItem[]): ThoughtOverlap[] {
  const keys = keysFor(items);
  const appearances = new Map<string, ThoughtOverlap>();

  items.forEach((item, index) => {
    const key = keys[index] ?? "";
    const ids = item.kind === "contradiction" ? [item.a, item.b] : item.sources;

    for (const id of ids) {
      const overlap = appearances.get(id) ?? { id, keys: [], obsolete_in: [] };
      overlap.keys.push(key);
      if (item.kind === "contradiction" && item.obsolete_id === id) overlap.obsolete_in.push(key);
      appearances.set(id, overlap);
    }
  });

  return [...appearances.values()].filter((overlap) => overlap.keys.length > 1);
}
