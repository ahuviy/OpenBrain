/**
 * Tests for cross-item consistency in a proposal.
 *
 * Each item is judged on its own, so a thought can be the obsolete side of one
 * and the surviving, authoritative side of another. Both items read as coherent
 * alone; accepting both archives a thought that the second item says is the one
 * to keep — and a reviewer working item by item cannot see it without diffing
 * ids by hand.
 */

import { describe, it, expect } from "vitest";

import { dropConflictingItems, overlappingThoughts } from "../consistency.js";
import type { ProposalItem } from "../proposal.js";

const A_KILLS_B: ProposalItem = {
  kind: "contradiction",
  a: "x",
  b: "y",
  verdict: "supersedes",
  reason: "y is stale",
  obsolete_id: "y",
};

// Same thought y, but here it is the survivor.
const Y_SURVIVES: ProposalItem = {
  kind: "contradiction",
  a: "y",
  b: "z",
  verdict: "supersedes",
  reason: "z is stale",
  obsolete_id: "z",
};

const UNRELATED: ProposalItem = {
  kind: "contradiction",
  a: "p",
  b: "q",
  verdict: "contradicts",
  reason: "clash",
  obsolete_id: "q",
};

describe("dropConflictingItems", () => {
  it("keeps a set with no thought dispositioned both ways", () => {
    expect(dropConflictingItems([A_KILLS_B, UNRELATED])).toEqual({
      items: [A_KILLS_B, UNRELATED],
      dropped: [],
    });
  });

  it("drops the item that would archive a thought another item relies on", () => {
    // Order matters and is deliberate: the earlier item stands, the later one
    // that contradicts it goes. Emitting both and letting the reviewer notice
    // is how a thought gets archived by an item that assumed it survived.
    expect(dropConflictingItems([Y_SURVIVES, A_KILLS_B])).toEqual({
      items: [Y_SURVIVES],
      dropped: [A_KILLS_B],
    });
  });

  it("drops an item that would archive the same thought twice over", () => {
    const alsoKillsY: ProposalItem = {
      kind: "contradiction",
      a: "w",
      b: "y",
      verdict: "supersedes",
      reason: "y is stale here too",
      obsolete_id: "y",
    };

    expect(dropConflictingItems([A_KILLS_B, alsoKillsY]).dropped).toEqual([alsoKillsY]);
  });

  it("leaves a synthesis alone: it archives nothing", () => {
    const synthesis: ProposalItem = { kind: "synthesis", content: "summary", sources: ["y", "z"] };

    expect(dropConflictingItems([A_KILLS_B, synthesis]).items).toEqual([A_KILLS_B, synthesis]);
  });
});

describe("overlappingThoughts", () => {
  it("names a thought that appears in more than one item, with its dispositions", () => {
    // For dream_review: the set that survives the drop can still legitimately
    // mention one thought twice — a reviewer should be told, not made to diff.
    expect(overlappingThoughts([A_KILLS_B, Y_SURVIVES])).toEqual([
      { id: "y", keys: ["contradiction:1", "contradiction:2"], obsolete_in: ["contradiction:1"] },
    ]);
  });

  it("says nothing when every thought appears once", () => {
    expect(overlappingThoughts([A_KILLS_B, UNRELATED])).toEqual([]);
  });

  it("counts a synthesis source as an appearance", () => {
    const synthesis: ProposalItem = { kind: "synthesis", content: "summary", sources: ["y"] };

    expect(overlappingThoughts([A_KILLS_B, synthesis])).toEqual([
      { id: "y", keys: ["contradiction:1", "synthesis:1"], obsolete_in: ["contradiction:1"] },
    ]);
  });
});
