/**
 * Tests for applying an accepted proposal.
 */

import { describe, it, expect } from "vitest";

import { applyProposal, type ApplyPort, type ProposalItem, type StoredProposal } from "../proposal.js";

const items: ProposalItem[] = [
  { kind: "contradiction", a: "a", b: "b", verdict: "contradicts", reason: "clash", obsolete_id: "a" },
  { kind: "synthesis", content: "summary", sources: ["c", "d", "e"] },
];

const now = new Date("2026-08-20T00:00:00Z");

function fakePort(overrides: Partial<StoredProposal> = {}) {
  const calls = { archived: [] as string[], superseded: [] as string[][], synthesised: 0, status: "" };
  const proposal: StoredProposal = {
    id: "p1",
    status: "open",
    expires_at: new Date("2026-08-21T00:00:00Z"),
    items,
    ...overrides,
  };
  const port: ApplyPort = {
    load: async () => proposal,
    archiveThought: async (id) => { calls.archived.push(id); },
    setSupersedes: async (winner, loser) => { calls.superseded.push([winner, loser]); },
    insertSynthesis: async () => { calls.synthesised += 1; },
    setStatus: async (_id, status) => { calls.status = status; },
  };
  return { port, calls };
}

describe("applyProposal", () => {
  it("archives the loser and points the winner at it", async () => {
    const { port, calls } = fakePort();

    const result = await applyProposal(port, "p1", ["contradiction:1"], now);

    expect(calls.archived).toEqual(["a"]);
    expect(calls.superseded).toEqual([["b", "a"]]);
    expect(result.applied).toEqual(["contradiction:1"]);
    expect(result.rejected).toEqual(["synthesis:1"]);
    expect(calls.status).toBe("applied");
  });

  it("refuses a proposal that has already been applied", async () => {
    const { port } = fakePort({ status: "applied" });

    await expect(applyProposal(port, "p1", [], now)).rejects.toThrow(/is applied, not open/);
  });

  it("marks an expired proposal expired and refuses it", async () => {
    const { port, calls } = fakePort({ expires_at: new Date("2026-08-19T00:00:00Z") });

    await expect(applyProposal(port, "p1", ["contradiction:1"], now)).rejects.toThrow(/expired/);
    expect(calls.status).toBe("expired");
    expect(calls.archived).toEqual([]);
  });

  it("rejects an unknown item key before writing anything", async () => {
    const { port, calls } = fakePort();

    await expect(applyProposal(port, "p1", ["synthesis:9"], now)).rejects.toThrow(/synthesis:9/);
    expect(calls.archived).toEqual([]);
    expect(calls.status).toBe("");
  });

  it("errors when the proposal does not exist", async () => {
    const port = { ...fakePort().port, load: async () => undefined };

    await expect(applyProposal(port, "nope", [], now)).rejects.toThrow(/not found/);
  });
});
