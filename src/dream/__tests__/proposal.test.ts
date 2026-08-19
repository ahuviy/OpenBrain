/**
 * Tests for proposal item keys and accept/reject partitioning.
 */

import { describe, it, expect } from "vitest";

import { keysFor, partitionByAccepted, type ProposalItem } from "../proposal.js";

const items: ProposalItem[] = [
  { kind: "contradiction", a: "a", b: "b", verdict: "contradicts", reason: "clash", obsolete_id: "a" },
  { kind: "synthesis", content: "summary one", sources: ["c", "d", "e"] },
  { kind: "synthesis", content: "summary two", sources: ["f", "g", "h"] },
];

describe("keysFor", () => {
  it("numbers each kind independently from one", () => {
    expect(keysFor(items)).toEqual(["contradiction:1", "synthesis:1", "synthesis:2"]);
  });
});

describe("partitionByAccepted", () => {
  it("splits accepted items from rejected keys", () => {
    const partition = partitionByAccepted(items, ["synthesis:2"]);

    expect(partition.accepted).toHaveLength(1);
    expect((partition.accepted[0] as { content: string }).content).toBe("summary two");
    expect(partition.rejected).toEqual(["contradiction:1", "synthesis:1"]);
  });

  it("rejects everything when nothing is accepted", () => {
    const partition = partitionByAccepted(items, []);

    expect(partition.accepted).toEqual([]);
    expect(partition.rejected).toHaveLength(3);
  });

  it("throws on an unknown key rather than silently applying a subset", () => {
    expect(() => partitionByAccepted(items, ["synthesis:9"])).toThrow(/synthesis:9/);
  });
});
