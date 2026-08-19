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
  listedSince: Date[];
  runs: Array<{ project: string; status: string; dry_run: boolean; actions: unknown[] }>;
  changes: Array<{ id: string; topics?: string[]; people?: string[] }>;
  vocabulary: string[];
  merges: number;
  proposals: number;
  watermarks: Date[];
}

interface VocabularyFixture {
  counts?: { topics: Record<string, number>; people: Record<string, number> };
  tagged?: ThoughtRow[];
}

function fakePort(
  rows: CandidateRow[],
  neighbourMap: Record<string, Array<ThoughtRow & { similarity: number }>>,
  vocabulary: VocabularyFixture = {},
) {
  const recorded: Recorded = {
    vocabulary: [], merges: 0, proposals: 0, watermarks: [], changes: [], runs: [], listedSince: [],
  };
  const port: DreamPort = {
    loadWatermark: async () => new Date("2026-08-01T00:00:00Z"),
    listCandidates: async (watermark) => {
      recorded.listedSince.push(watermark);
      return rows;
    },
    neighbours: async (row) => neighbourMap[row.id] ?? [],
    knownTopics: async () => ["forex"],
    vocabularyCounts: async () => vocabulary.counts ?? { topics: {}, people: {} },
    // Matches the pg port: jsonb `?|` compares stored spellings exactly, so a
    // lookup by a normalised key finds nothing.
    listTagged: async (field, values) =>
      (vocabulary.tagged ?? []).filter((row) => {
        const tags = (row.metadata as Record<string, unknown>)[field];
        return Array.isArray(tags) && tags.some((tag) => values.includes(tag as string));
      }),
    applyVocabulary: async (change) => {
      recorded.vocabulary.push(change.id);
      recorded.changes.push(change);
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
    listRuns: async () => [],
    recordRun: async (run) => {
      recorded.runs.push({
        project: run.project,
        status: run.status,
        dry_run: run.dry_run,
        actions: run.actions,
      });
    },
  };
  return { port, recorded };
}

const judgeContradicts: JudgePair = async (a) => ({
  verdict: "contradicts",
  reason: "clash",
  obsolete_id: a.id,
});
const judgeIndependent: JudgePair = async () => ({ verdict: "independent", reason: "same claim" });
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

  it("does not merge a cluster the judge calls contradictory — it proposes it", async () => {
    // The bug this pins: two flatly incompatible conventions, phrased alike,
    // sat above the merge threshold and were merged immediately and without
    // review, while the same disagreement phrased differently went through the
    // proposal gate. The pairs most in need of review were skipping it.
    const rows = [candidate("a")];
    const other = { ...candidate("b"), similarity: 0.97 } as ThoughtRow & { similarity: number };
    const { port, recorded } = fakePort(rows, { a: [other] });

    const result = await runDream(port, judgeContradicts, synthesise, config, thresholds, {}, now);

    expect(recorded.merges).toBe(0);
    expect(result.applied.merge ?? 0).toBe(0);
    expect(result.proposed.contradiction).toBe(1);
    expect(result.items.map((item) => item.key)).toEqual(["contradiction:1"]);
  });

  it("merges what the judge clears, and reports what it merged", async () => {
    // A merge applies immediately and archives its sources, so the run has to
    // say what it collapsed — counts alone leave an unreviewable write.
    const rows = [candidate("a")];
    const other = { ...candidate("b"), similarity: 0.97 } as ThoughtRow & { similarity: number };
    const { port, recorded } = fakePort(rows, { a: [other] });

    const result = await runDream(port, judgeIndependent, synthesise, config, thresholds, {}, now);

    expect(recorded.merges).toBe(1);
    expect(result.applied.merge).toBe(1);
    expect(result.applied_items).toEqual([
      {
        kind: "merge",
        sources: [
          { id: "a", content: "content a" },
          { id: "b", content: "content b" },
        ],
      },
    ]);
  });

  it("holds the watermark behind thoughts left in a proposal", async () => {
    // Advancing past them makes the proposal unreconstructable: the next run no
    // longer selects those thoughts, so nothing can regenerate the items.
    const rows = [candidate("a", { updated_at: new Date("2026-08-10T10:00:00Z") })];
    const other = { ...candidate("b"), similarity: 0.85 } as ThoughtRow & { similarity: number };
    const { port, recorded } = fakePort(rows, { a: [other] });

    await runDream(port, judgeContradicts, synthesise, config, thresholds, {}, now);

    expect(recorded.watermarks).toHaveLength(1);
    expect(recorded.watermarks[0]!.getTime()).toBeLessThan(
      new Date("2026-08-10T10:00:00Z").getTime(),
    );
  });

  it("advances the watermark normally when nothing is awaiting review", async () => {
    const rows = [candidate("a", { updated_at: new Date("2026-08-10T10:00:00Z") })];
    const { port, recorded } = fakePort(rows, {});

    await runDream(port, judgeIndependent, synthesise, config, thresholds, {}, now);

    expect(recorded.watermarks[0]).toEqual(new Date("2026-08-10T10:00:00Z"));
  });

  it("unifies a person's short and full name, reaching thoughts the watermark excludes", async () => {
    // The pass named for unifying vocabulary only ever applied the CONFIGURED
    // alias table, so `Dohmen` and `Bert Dohmen` survived every run. The rows
    // that need fixing are old ones — exactly what the watermark filters out.
    const old = {
      ...candidate("old", { metadata: { people: ["Bert Dohmen"] } }),
    } as ThoughtRow;
    const { port, recorded } = fakePort([], {}, {
      counts: { topics: {}, people: { Dohmen: 7, "Bert Dohmen": 3 } },
      tagged: [old],
    });

    const result = await runDream(port, judgeIndependent, synthesise, config, thresholds, {}, now);

    expect(result.applied.vocabulary).toBe(1);
    expect(recorded.changes).toEqual([{ id: "old", people: ["Dohmen"] }]);
  });

  it("leaves related-but-different topics alone", async () => {
    // `markets` is not a spelling of `market-analysis`; folding them would
    // rewrite metadata on a guess, which is a judgment call, not a sweep.
    const tagged = [candidate("old", { metadata: { topics: ["markets"] } }) as ThoughtRow];
    const { port, recorded } = fakePort([], {}, {
      counts: { topics: { "market-analysis": 5, markets: 3 }, people: {} },
      tagged,
    });

    const result = await runDream(port, judgeIndependent, synthesise, config, thresholds, {}, now);

    expect(result.applied.vocabulary ?? 0).toBe(0);
    expect(recorded.changes).toEqual([]);
  });

  it("never emits an alias pair that rewrites config back the other way", async () => {
    // The full-corpus dry run's finding: config says dohmen -> "Bert Dohmen",
    // inference in a project where "Dohmen" dominates says the reverse, and the
    // pair churns the same rows on every run.
    const tagged = [
      candidate("old", { metadata: { people: ["Bert Dohmen"] } }) as ThoughtRow,
      candidate("older", { metadata: { people: ["Dohmen"] } }) as ThoughtRow,
    ];
    const { port, recorded } = fakePort([], {}, {
      counts: { topics: {}, people: { Dohmen: 7, "Bert Dohmen": 3 } },
      tagged,
    });

    await runDream(
      port,
      judgeIndependent,
      synthesise,
      { ...config, personAliases: { dohmen: "Bert Dohmen" } },
      thresholds,
      {},
      now,
    );

    // Only the configured direction survives: "Dohmen" becomes "Bert Dohmen",
    // and nothing rewrites "Bert Dohmen" back.
    expect(recorded.changes).toEqual([{ id: "older", people: ["Bert Dohmen"] }]);
  });

  it("lets a configured alias override an inferred one", async () => {
    // Config is someone's decision; inference is a rule of thumb about spelling.
    const tagged = [candidate("old", { metadata: { people: ["Bert Dohmen"] } }) as ThoughtRow];
    const { port, recorded } = fakePort([], {}, {
      counts: { topics: {}, people: { Dohmen: 7, "Bert Dohmen": 3 } },
      tagged,
    });

    await runDream(
      port,
      judgeIndependent,
      synthesise,
      { ...config, personAliases: { "bert dohmen": "Bert Dohmen (Dohmen Capital)" } },
      thresholds,
      {},
      now,
    );

    expect(recorded.changes).toEqual([
      { id: "old", people: ["Bert Dohmen (Dohmen Capital)"] },
    ]);
  });

  it("does not sweep the corpus when vocabulary was not asked for", async () => {
    const tagged = [candidate("old", { metadata: { people: ["Bert Dohmen"] } }) as ThoughtRow];
    const { port, recorded } = fakePort([candidate("a")], {}, {
      counts: { topics: {}, people: { Dohmen: 7, "Bert Dohmen": 3 } },
      tagged,
    });

    await runDream(
      port, judgeIndependent, synthesise, config, thresholds, { ops: ["merge"] }, now,
    );

    expect(recorded.changes).toEqual([]);
  });

  it("blocks the merge but proposes nothing when contradiction was not asked for", async () => {
    // For a caller who never reviews proposals, a proposal is worse than no
    // finding: it pins the watermark behind those thoughts forever and the run
    // re-judges the same pair every time. The merge is still refused — that is
    // the data-loss half — and the disagreement is counted, not discarded.
    const rows = [candidate("a")];
    const other = { ...candidate("b"), similarity: 0.97 } as ThoughtRow & { similarity: number };
    const { port, recorded } = fakePort(rows, { a: [other] });

    const result = await runDream(
      port, judgeContradicts, synthesise, config, thresholds, { ops: ["merge"] }, now,
    );

    expect(recorded.merges).toBe(0);
    expect(recorded.proposals).toBe(0);
    expect(result.proposal_id).toBeNull();
    expect(result.skipped.merge_contradicts).toBe(1);
  });

  it("advances the watermark when a blocked merge produced no proposal", async () => {
    // Nothing is awaiting review, so nothing is held back.
    const rows = [candidate("a", { updated_at: new Date("2026-08-10T10:00:00Z") })];
    const other = { ...candidate("b"), similarity: 0.97 } as ThoughtRow & { similarity: number };
    const { port, recorded } = fakePort(rows, { a: [other] });

    await runDream(
      port, judgeContradicts, synthesise, config, thresholds, { ops: ["merge"] }, now,
    );

    expect(recorded.watermarks[0]).toEqual(new Date("2026-08-10T10:00:00Z"));
  });

  it("still proposes the disagreement when contradiction WAS asked for", async () => {
    const rows = [candidate("a")];
    const other = { ...candidate("b"), similarity: 0.97 } as ThoughtRow & { similarity: number };
    const { port } = fakePort(rows, { a: [other] });

    const result = await runDream(
      port, judgeContradicts, synthesise, config, thresholds, { ops: ["merge", "contradiction"] }, now,
    );

    expect(result.proposed.contradiction).toBe(1);
    expect(result.skipped.merge_contradicts ?? 0).toBe(0);
  });

  it("reports a vocabulary rewrite in applied_items, both sides", async () => {
    // applied_items was merges-only, so the operation that rewrites metadata on
    // rows nobody reviewed left no trail at all. `applied.vocabulary` counts
    // THOUGHTS rewritten, not tags changed — one thought whose topics and
    // people both move is one.
    const rows = [candidate("a", { metadata: { topics: ["fx"], people: ["Dohmen"] } })];
    const { port } = fakePort([], {}, {
      counts: { topics: {}, people: { Dohmen: 1, "Bert Dohmen": 5 } },
      tagged: rows as unknown as ThoughtRow[],
    });

    const result = await runDream(port, judgeIndependent, synthesise, config, thresholds, {}, now);

    expect(result.applied.vocabulary).toBe(1);
    expect(result.applied_items).toEqual([
      {
        kind: "vocabulary",
        id: "a",
        topics: { from: ["fx"], to: ["forex"] },
        people: { from: ["Dohmen"], to: ["Bert Dohmen"] },
      },
    ]);
  });

  it("records what it did, not just how much", async () => {
    // The retro question is "why did it merge those two", and a count cannot
    // answer it. Every applied change and every refusal gets an entry.
    const rows = [candidate("a", { metadata: { topics: ["fx"] } })];
    const other = { ...candidate("b"), similarity: 0.97 } as ThoughtRow & { similarity: number };
    const { port, recorded } = fakePort(rows, { a: [other] });

    const result = await runDream(port, judgeIndependent, synthesise, config, thresholds, {}, now);

    expect(result.actions).toEqual([
      { kind: "vocabulary", id: "a", topics: ["forex"] },
      { kind: "merge", sources: ["a", "b"] },
    ]);
    expect(recorded.runs).toHaveLength(1);
    expect(recorded.runs[0]).toMatchObject({ status: "ok", project: "", dry_run: false });
  });

  it("records the pair it refused to merge, and why", async () => {
    const rows = [candidate("a")];
    const other = { ...candidate("b"), similarity: 0.97 } as ThoughtRow & { similarity: number };
    const { port } = fakePort(rows, { a: [other] });
    const judgeBroken: JudgePair = async () => {
      throw new Error("provider timeout");
    };

    const result = await runDream(
      port, judgeBroken, synthesise, config, thresholds, { ops: ["merge"] }, now,
    );

    expect(result.actions).toEqual([
      {
        kind: "merge_blocked",
        a: "a",
        b: "b",
        reason: "judgment_failed",
        detail: "Error: provider timeout",
      },
    ]);
  });

  it("records a contradiction it refused to merge on", async () => {
    const rows = [candidate("a")];
    const other = { ...candidate("b"), similarity: 0.97 } as ThoughtRow & { similarity: number };
    const { port } = fakePort(rows, { a: [other] });

    const result = await runDream(
      port, judgeContradicts, synthesise, config, thresholds, { ops: ["merge"] }, now,
    );

    expect(result.actions).toEqual([
      { kind: "merge_blocked", a: "a", b: "b", reason: "contradiction", detail: "clash" },
    ]);
  });

  it("records a dry run as a dry run, having changed nothing", async () => {
    // A dry run belongs in the history — it is how someone checks what a real
    // run would do — but a history that could not tell the two apart would
    // attribute changes to a run that made none.
    const rows = [candidate("a", { metadata: { topics: ["fx"] } })];
    const { port, recorded } = fakePort(rows, {});

    await runDream(
      port, judgeIndependent, synthesise, config, thresholds, { dry_run: true }, now,
    );

    expect(recorded.runs[0]).toMatchObject({ dry_run: true, status: "ok" });
    expect(recorded.vocabulary).toEqual([]);
  });

  it("re-examines an earlier window when asked, without rewinding the watermark", async () => {
    // Every consolidation fix is otherwise forward-only: the thoughts that
    // accumulated the mess sit behind the watermark and are never considered
    // again. `since` is how a fix reaches them.
    const rows = [candidate("a", { updated_at: new Date("2026-08-10T10:00:00Z") })];
    const { port, recorded } = fakePort(rows, {});

    await runDream(
      port, judgeIndependent, synthesise, config, thresholds,
      { since: "1970-01-01T00:00:00Z" }, now,
    );

    // The run looked at everything...
    expect(recorded.listedSince).toEqual([new Date("1970-01-01T00:00:00Z")]);
    // ...but the stored watermark is a floor: a backfill must not make the next
    // ordinary run re-examine the whole corpus too.
    expect(recorded.watermarks[0]!.getTime()).toBeGreaterThanOrEqual(
      new Date("2026-08-01T00:00:00Z").getTime(),
    );
  });

  it("reports the window it actually used", async () => {
    const rows = [candidate("a")];
    const { port } = fakePort(rows, {});

    const result = await runDream(
      port, judgeIndependent, synthesise, config, thresholds,
      { since: "1970-01-01T00:00:00Z" }, now,
    );

    expect(result.watermark.from).toBe("1970-01-01T00:00:00.000Z");
  });

  it("refuses a since it cannot parse rather than silently scanning everything", async () => {
    // A bad date coerced to epoch is a full-corpus pass nobody asked for, which
    // on a large brain is a lot of embedding calls.
    const { port } = fakePort([], {});

    await expect(
      runDream(port, judgeIndependent, synthesise, config, thresholds, { since: "yesterday" }, now),
    ).rejects.toThrow(/since/i);
  });

  it("never proposes a set whose items destroy each other", async () => {
    // Judged pairwise, a thought can be obsolete in one item and the survivor in
    // another; accepting both archives the thought the second says to keep.
    const rows = [candidate("a"), candidate("b")];
    const neighbourOfA = { ...candidate("b"), similarity: 0.85 } as ThoughtRow & { similarity: number };
    const neighbourOfB = { ...candidate("c"), similarity: 0.85 } as ThoughtRow & { similarity: number };
    const { port } = fakePort(rows, { a: [neighbourOfA], b: [neighbourOfB] });

    // Always retires the FIRST argument: pair (a,b) kills a, pair (b,c) kills b,
    // so the second item would archive a thought the first relies on.
    const judgeKillsFirst: JudgePair = async (first) => ({
      verdict: "supersedes",
      reason: "stale",
      obsolete_id: first.id,
    });

    const result = await runDream(
      port, judgeKillsFirst, synthesise, config, thresholds, { ops: ["contradiction"] }, now,
    );

    const archived = result.items.flatMap((item) =>
      item.kind === "contradiction" ? [item.obsolete_id] : [],
    );
    const survivors = result.items.flatMap((item) =>
      item.kind === "contradiction"
        ? item.thoughts.filter((t) => !t.obsolete).map((t) => t.id)
        : [],
    );
    expect(archived.filter((id) => survivors.includes(id))).toEqual([]);
    expect(result.skipped.proposal_conflict).toBeGreaterThan(0);
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
