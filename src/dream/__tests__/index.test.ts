/**
 * Tests for the dream run's tiering: what applies now, what waits for review.
 */

import { describe, it, expect } from "vitest";

import { runDream, type DreamPort, type DreamThresholds } from "../index.js";
import type { CandidateRow } from "../candidates.js";
import type { ThoughtRow } from "../../db/queries.js";
import type { JudgePair } from "../ops/contradiction.js";
import type { Synthesise } from "../ops/synthesis.js";

const thresholds: DreamThresholds = {
  neighbour: 0.8,
  merge: 0.94,
  contradictionFloor: 0.8,
  minSynthesisCluster: 3,
  watermarkSlackMs: 60_000,
};

const config = { topicAliases: { fx: "forex" }, personAliases: {}, selfNames: [] };
const now = () => new Date("2026-08-20T00:00:00Z");

function candidate(id: string, overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id,
    content: `content ${id}`,
    metadata: {},
    project: "markets",
    created_by: "ahuvi",
    archived: false,
    supersedes: null,
    created_at: new Date("2026-08-01T10:00:00Z"),
    updated_at: new Date("2026-08-10T10:00:00Z"),
    ...overrides,
  } as CandidateRow;
}

interface Recorded {
  vocabulary: string[];
  merges: number;
  proposals: number;
  watermarks: Date[];
}

function fakePort(rows: CandidateRow[], neighbourMap: Record<string, Array<ThoughtRow & { similarity: number }>>) {
  const recorded: Recorded = { vocabulary: [], merges: 0, proposals: 0, watermarks: [] };
  const port: DreamPort = {
    loadWatermark: async () => new Date("2026-08-01T00:00:00Z"),
    listCandidates: async () => rows,
    neighbours: async (row) => neighbourMap[row.id] ?? [],
    knownTopics: async () => ["forex"],
    applyVocabulary: async (change) => {
      recorded.vocabulary.push(change.id);
    },
    applyMerge: async () => {
      recorded.merges += 1;
    },
    saveProposal: async () => {
      recorded.proposals += 1;
      return "proposal-1";
    },
    saveWatermark: async (_p, watermark) => {
      recorded.watermarks.push(watermark);
    },
  };
  return { port, recorded };
}

const judgeContradicts: JudgePair = async (a) => ({
  verdict: "contradicts",
  reason: "clash",
  obsolete_id: a.id,
});
const synthesise: Synthesise = async () => "a summary";

describe("runDream", () => {
  it("applies vocabulary immediately without a proposal", async () => {
    const rows = [candidate("a", { metadata: { topics: ["fx"] } })];
    const { port, recorded } = fakePort(rows, {});

    const result = await runDream(port, judgeContradicts, synthesise, config, thresholds, {}, now);

    expect(recorded.vocabulary).toEqual(["a"]);
    expect(result.applied.vocabulary).toBe(1);
    expect(result.proposal_id).toBeNull();
  });

  it("proposes a contradiction instead of applying it", async () => {
    const rows = [candidate("a")];
    const other = { ...candidate("b"), similarity: 0.85 } as ThoughtRow & { similarity: number };
    const { port, recorded } = fakePort(rows, { a: [other] });

    const result = await runDream(port, judgeContradicts, synthesise, config, thresholds, {}, now);

    expect(result.proposed.contradiction).toBe(1);
    expect(result.proposal_id).toBe("proposal-1");
    expect(recorded.proposals).toBe(1);
    expect(recorded.merges).toBe(0);
  });

  it("writes nothing at all on a dry run", async () => {
    const rows = [candidate("a", { metadata: { topics: ["fx"] } })];
    const other = { ...candidate("b"), similarity: 0.85 } as ThoughtRow & { similarity: number };
    const { port, recorded } = fakePort(rows, { a: [other] });

    const result = await runDream(
      port, judgeContradicts, synthesise, config, thresholds, { dry_run: true }, now,
    );

    expect(recorded.vocabulary).toEqual([]);
    expect(recorded.merges).toBe(0);
    expect(recorded.proposals).toBe(0);
    expect(recorded.watermarks).toEqual([]);
    expect(result.proposal_id).toBeNull();
    expect(result.applied.vocabulary).toBe(1);
  });

  it("returns the proposed items with their bodies, keyed as dream_apply takes them", async () => {
    // Counts alone made a proposal unreviewable: the caller had to accept
    // thoughts it had never read, or reject them by omission.
    const rows = [candidate("a")];
    const other = { ...candidate("b"), similarity: 0.85 } as ThoughtRow & { similarity: number };
    const { port } = fakePort(rows, { a: [other] });

    const result = await runDream(port, judgeContradicts, synthesise, config, thresholds, {}, now);

    expect(result.items).toEqual([
      {
        key: "contradiction:1",
        kind: "contradiction",
        verdict: "contradicts",
        reason: "clash",
        obsolete_id: "a",
        thoughts: [
          { id: "a", content: "content a", obsolete: true },
          { id: "b", content: "content b", obsolete: false },
        ],
      },
    ]);
  });

  it("returns the items on a dry run too, when nothing was stored to review later", async () => {
    const rows = [candidate("a")];
    const other = { ...candidate("b"), similarity: 0.85 } as ThoughtRow & { similarity: number };
    const { port } = fakePort(rows, { a: [other] });

    const result = await runDream(
      port, judgeContradicts, synthesise, config, thresholds, { dry_run: true }, now,
    );

    expect(result.proposal_id).toBeNull();
    expect(result.items.map((item) => item.key)).toEqual(["contradiction:1"]);
  });

  it("only runs the operations it was asked for", async () => {
    const rows = [candidate("a", { metadata: { topics: ["fx"] } })];
    const other = { ...candidate("b"), similarity: 0.85 } as ThoughtRow & { similarity: number };
    const { port, recorded } = fakePort(rows, { a: [other] });

    const result = await runDream(
      port, judgeContradicts, synthesise, config, thresholds, { ops: ["vocabulary"] }, now,
    );

    expect(recorded.vocabulary).toEqual(["a"]);
    expect(result.proposed.contradiction ?? 0).toBe(0);
    expect(recorded.proposals).toBe(0);
  });
});
