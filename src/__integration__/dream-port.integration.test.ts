/**
 * The pg-backed DreamPort against a real Postgres.
 *
 * Runs the SAME contract suite as the in-memory fake. When both are green the
 * fake is trustworthy; when only the fake is green the fake is a fiction and
 * every unit test standing on it is worth less than it looks.
 *
 * Requires a migrated database — see README > Integration tests. Skips (does not
 * fail) when none is reachable: "you didn't start docker" is not a defect, and a
 * suite that reds for that reason is one people learn to ignore.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";

import dreamPortContractTests from "../integration-suites/dream-port-contract.suite.js";
import { runBackfillSlice } from "../dream/backfill.js";
import { createDreamPort, loadProposalReview } from "../dream/port.js";
import { runDream } from "../dream/index.js";
import { getDreamThresholds } from "../dream/config.js";
import { insertProposal, insertThought, type ThoughtRow } from "../db/queries.js";
import type { DreamPort } from "../dream/index.js";
import type { Embedder } from "../embedder/types.js";
import { connectTestDatabase, isDatabaseReachable, testEmbedding, type TestDatabase } from "./helpers/database.js";

/**
 * The contract under test is SQL semantics, not a provider's. A deterministic
 * embedder keeps the suite hermetic and free — no network, no API key, no spend.
 */
const stubEmbedder: Embedder = {
  generateEmbedding: async (text) => testEmbedding(text.length),
  extractMetadata: async () => ({ type: "observation", topics: [], people: [], action_items: [], dates: [] }),
  judgeContradiction: async () => ({ verdict: "independent", reason: "stub" }),
  synthesise: async () => "stub summary",
};

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)("pg dream port", () => {
  let database: TestDatabase;
  let pool: pg.Pool;
  let port: DreamPort;

  beforeAll(async () => {
    database = await connectTestDatabase();
    pool = database.pool;
    port = createDreamPort(pool, stubEmbedder, 72);
  });

  afterAll(async () => {
    await database?.close();
  });

  dreamPortContractTests({
    setup: async () => {
      await database.truncate();
    },
    port: () => port,
    seed: async (thought) => {
      const row = await insertThought(
        pool,
        thought.content,
        testEmbedding(thought.content.length),
        (thought.metadata ?? {}) as ThoughtRow["metadata"],
        thought.project ?? undefined,
        undefined,
        "ahuvi",
      );
      if (thought.archived) {
        await pool.query("UPDATE thoughts SET archived = true WHERE id = $1", [row.id]);
      }
      return row.id;
    },
    read: async (id) => {
      const { rows } = await pool.query(
        `SELECT id, content, metadata, project, created_by, archived, supersedes, created_at
         FROM thoughts WHERE id = $1`,
        [id],
      );
      return rows[0];
    },
    cleanup: async () => {},
  });
});

describe.skipIf(!reachable)("loadProposalReview", () => {
  let database: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    database = await connectTestDatabase();
    pool = database.pool;
  });

  afterAll(async () => {
    await database?.close();
  });

  async function seed(content: string): Promise<string> {
    const row = await insertThought(
      pool,
      content,
      testEmbedding(content.length),
      {} as ThoughtRow["metadata"],
      undefined,
      undefined,
      "ahuvi",
    );
    return row.id;
  }

  it("renders a stored proposal's items with the thoughts behind them", async () => {
    await database.truncate();
    const a = await seed("We use MySQL.");
    const b = await seed("We moved off MySQL to Postgres.");
    const proposal = await insertProposal(
      pool,
      "",
      [{ kind: "contradiction", a, b, verdict: "contradicts", reason: "b reverses a", obsolete_id: a }],
      72,
    );

    const view = await loadProposalReview(pool, proposal.id, new Date());

    expect(view).toMatchObject({ proposal_id: proposal.id, status: "open", actionable: true });
    expect(view?.items).toEqual([
      {
        key: "contradiction:1",
        kind: "contradiction",
        verdict: "contradicts",
        reason: "b reverses a",
        obsolete_id: a,
        thoughts: [
          { id: a, content: "We use MySQL.", obsolete: true },
          { id: b, content: "We moved off MySQL to Postgres.", obsolete: false },
        ],
      },
    ]);
  });

  it("still renders a thought the proposal archived", async () => {
    await database.truncate();
    const a = await seed("We use MySQL.");
    const b = await seed("We moved off MySQL to Postgres.");
    await pool.query("UPDATE thoughts SET archived = true WHERE id = $1", [a]);
    const proposal = await insertProposal(
      pool,
      "",
      [{ kind: "contradiction", a, b, verdict: "contradicts", reason: "b reverses a", obsolete_id: a }],
      72,
    );

    const view = await loadProposalReview(pool, proposal.id, new Date());

    expect(view?.items[0]).toMatchObject({
      thoughts: [expect.objectContaining({ id: a, content: "We use MySQL." }), expect.anything()],
    });
  });

  it("returns undefined for an id that is not a proposal", async () => {
    await expect(
      loadProposalReview(pool, "00000000-0000-0000-0000-000000000000", new Date()),
    ).resolves.toBeUndefined();
  });
});

describe.skipIf(!reachable)("vocabulary unification end to end", () => {
  let database: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    database = await connectTestDatabase();
    pool = database.pool;
  });

  afterAll(async () => {
    await database?.close();
  });

  it("rewrites an old spelling on rows the watermark excludes", async () => {
    // The report's case: `Dohmen` (used more) and `Bert Dohmen` coexisting, on
    // thoughts old enough that a run would not otherwise look at them.
    await database.truncate();

    const seed = async (content: string, people: string[]) =>
      (await insertThought(
        pool,
        content,
        testEmbedding(content.length),
        { people } as unknown as ThoughtRow["metadata"],
        "markets",
        undefined,
        "ahuvi",
      )).id;

    const majority = [await seed("one", ["Dohmen"]), await seed("two", ["Dohmen"])];
    const odd = await seed("three", ["Bert Dohmen"]);

    // Everything is now behind the watermark: without the corpus sweep the run
    // has no candidates at all and the two spellings survive.
    const port = createDreamPort(pool, stubEmbedder, 72);
    // loadWatermark first: saveWatermark is an UPDATE, and dream_state was
    // truncated, so saving without the row present writes nothing at all — and
    // the run would then see every thought as a candidate.
    await port.loadWatermark("markets");
    await port.saveWatermark("markets", new Date(Date.now() + 60_000), {});

    const result = await runDream(
      port,
      async () => ({ verdict: "independent", reason: "stub" }),
      async () => "stub summary",
      { topicAliases: {}, personAliases: {}, selfNames: [] },
      getDreamThresholds(),
      { project: "markets", ops: ["vocabulary"] },
      () => new Date(),
    );

    expect(result.candidates).toBe(0);
    expect(result.applied.vocabulary).toBe(1);

    const { rows } = await pool.query<{ id: string; people: string[] }>(
      `SELECT id, ARRAY(SELECT jsonb_array_elements_text(metadata->'people')) AS people
       FROM thoughts WHERE id = ANY($1::uuid[])`,
      [[...majority, odd]],
    );

    for (const row of rows) {
      expect(row.people).toEqual(["Dohmen"]);
    }
  });
});

describe.skipIf(!reachable)("watermark advancement end to end", () => {
  let database: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    database = await connectTestDatabase();
    pool = database.pool;
  });

  afterAll(async () => {
    await database?.close();
  });

  it("stops selecting a thought it has already consolidated", async () => {
    // The bug in production: `thoughts.updated_at` is a timestamptz with
    // microseconds, the pg driver hands JS a Date truncated to milliseconds, and
    // a watermark saved at that truncated value stays strictly below what the
    // `updated_at > watermark` filter compares against. Four scheduled runs over
    // four days reported one candidate for every project, applied nothing, and
    // left the watermark exactly where it started.
    //
    // Only a real Postgres shows it: the truncation happens in the driver, so
    // any fake that stores the Date it was given is green while the database is
    // stuck. Sub-millisecond stamps are forced here rather than hoped for.
    await database.truncate();

    const port = createDreamPort(pool, stubEmbedder, 72);
    const seeded = await insertThought(
      pool,
      "the corpus has exactly one thought",
      testEmbedding(12),
      {} as ThoughtRow["metadata"],
      "markets",
      undefined,
      "ahuvi",
    );
    // Backdated well clear of the run's commit horizon, so the only thing that
    // can keep the row eligible is the microsecond remainder. The trigger that
    // stamps `updated_at` on UPDATE has to be off for this: it would overwrite
    // the fixture with now() and quietly test the horizon instead.
    await pool.query("ALTER TABLE thoughts DISABLE TRIGGER set_updated_at");
    await pool.query(
      `UPDATE thoughts
          SET updated_at = date_trunc('milliseconds', now() - interval '1 day') + interval '789 microseconds'
        WHERE id = $1`,
      [seeded.id],
    );
    await pool.query("ALTER TABLE thoughts ENABLE TRIGGER set_updated_at");

    const run = (ops: Parameters<typeof runDream>[5]["ops"]) =>
      runDream(
        port,
        async () => ({ verdict: "independent", reason: "stub" }),
        async () => "stub summary",
        { topicAliases: {}, personAliases: {}, selfNames: [] },
        getDreamThresholds(),
        { project: "markets", ops, trigger: "test" },
        () => new Date(),
      );

    const first = await run(["vocabulary"]);
    expect(first.candidates).toBe(1);

    // The whole assertion: a second run over an unchanged corpus has nothing to
    // look at. Before the fix this was 1, for ever.
    const second = await run(["vocabulary"]);
    expect(second.candidates).toBe(0);

    // Compared inside Postgres, at the precision Postgres stores: the watermark
    // has to sit strictly above the row's microsecond stamp, which is exactly
    // what a truncated Date could not do.
    const { rows: clears } = await pool.query<{ clears: boolean; micro: string }>(
      `SELECT s.watermark > t.updated_at AS clears,
              to_char(t.updated_at, 'US') AS micro
       FROM dream_state s, thoughts t
       WHERE s.project = 'markets' AND t.id = $1`,
      [seeded.id],
    );
    expect(clears[0]!.micro).toMatch(/789$/);
    expect(clears[0]!.clears).toBe(true);

    const history = await port.listRuns("markets", 10);
    expect(history).toHaveLength(2);
    // Both runs recorded the window they looked at, so a stuck watermark is
    // visible from the history alone next time.
    for (const entry of history) {
      expect(entry.watermark_from).toBeInstanceOf(Date);
      expect(entry.watermark_to).toBeInstanceOf(Date);
    }
    expect(history[0]!.watermark_from!.getTime()).toBeGreaterThan(
      history[1]!.watermark_from!.getTime(),
    );
  });
});

describe.skipIf(!reachable)("neighbour hydration", () => {
  let database: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    database = await connectTestDatabase();
    pool = database.pool;
  });

  afterAll(async () => {
    await database?.close();
  });

  it("hands back the columns a merge builds its canonical row from", async () => {
    // `match_thoughts` projects id/content/metadata/similarity/created_at and
    // nothing else. A merge takes the project and the author from whichever
    // source is OLDEST, which is usually a neighbour rather than the candidate
    // that found it — so an unhydrated neighbour silently writes the merged
    // thought with a NULL project and no author.
    await database.truncate();
    const port = createDreamPort(pool, stubEmbedder, 72);

    await insertThought(pool, "aaaaaaaaaaaaaaaaaaaa", testEmbedding(20), {} as ThoughtRow["metadata"], "markets", undefined, "ahuvi");
    await insertThought(pool, "bbbbbbbbbbbbbbbbbbbb", testEmbedding(20), {} as ThoughtRow["metadata"], "markets", undefined, "ahuvi");

    const [candidate] = await port.listCandidates(new Date(0), "markets");
    const found = await port.neighbours(candidate!, 0.8);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ project: "markets", created_by: "ahuvi" });
    expect(found[0]!.similarity).toBeGreaterThanOrEqual(0.8);
    expect(found[0]!.id).not.toBe(candidate!.id);
  });
});

describe.skipIf(!reachable)("backfill sweep end to end", () => {
  const DAY = 24 * 60 * 60 * 1000;

  let database: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    database = await connectTestDatabase();
    pool = database.pool;
  });

  afterAll(async () => {
    await database?.close();
  });

  it("consolidates duplicates the forward watermark had left behind for ever", async () => {
    // The gap this closes: the watermark only moves forward, so two duplicates
    // written before a run existed are behind it permanently — no schedule ever
    // looks at them again. Four days of scheduled runs applied three vocabulary
    // rewrites while a full pass over one project found sixteen findings.
    await database.truncate();

    const port = createDreamPort(pool, stubEmbedder, 72);
    // Equal length, so the deterministic stub embeds them identically and they
    // cluster above the merge threshold — the duplicate case, without a provider.
    const older = await insertThought(pool, "aaaaaaaaaaaaaaaaaaaa", testEmbedding(20), {} as ThoughtRow["metadata"], "markets", undefined, "ahuvi");
    const newer = await insertThought(pool, "bbbbbbbbbbbbbbbbbbbb", testEmbedding(20), {} as ThoughtRow["metadata"], "markets", undefined, "ahuvi");

    // Both written 45 days ago, and the forward hand has long since passed them.
    await pool.query("ALTER TABLE thoughts DISABLE TRIGGER set_updated_at");
    await pool.query(
      `UPDATE thoughts SET updated_at = now() - interval '45 days' WHERE id = ANY($1::uuid[])`,
      [[older.id, newer.id]],
    );
    await pool.query("ALTER TABLE thoughts ENABLE TRIGGER set_updated_at");
    await port.loadWatermark("markets");
    await port.saveWatermark("markets", new Date(), {});

    const consolidate = (options: Parameters<typeof runDream>[5]) =>
      runDream(
        port,
        async () => ({ verdict: "independent", reason: "stub" }),
        async () => "stub summary",
        { topicAliases: {}, personAliases: {}, selfNames: [] },
        getDreamThresholds(),
        options,
        () => new Date(),
      );

    // The forward hand, first: it has nothing to look at, which is exactly how
    // this looked in production for four runs running.
    const forward = await consolidate({ project: "markets", ops: ["merge"] });
    expect(forward.candidates).toBe(0);
    expect(forward.applied.merge).toBeUndefined();

    const sweep = () =>
      runBackfillSlice(port, "markets", 30 * DAY, (slice) =>
        consolidate({
          project: "markets",
          ops: ["merge"],
          since: slice.from,
          until: slice.until,
          trigger: "schedule-backfill",
        }),
      );

    // First slice covers the last 30 days — the duplicates are older than that,
    // so it finds nothing and the cursor still has to move, or the sweep stalls.
    const first = await sweep();
    expect(first?.result.candidates).toBe(0);
    expect(first?.slice.done).toBe(false);

    // Second slice reaches back over them.
    const second = await sweep();
    expect(second?.result.applied.merge).toBe(1);
    expect(second?.slice.done).toBe(true);

    const { rows: live } = await pool.query<{ id: string; content: string; project: string | null; created_by: string | null }>(
      `SELECT id, content, project, created_by
       FROM thoughts WHERE archived = false AND COALESCE(project, '') = 'markets'`,
    );
    expect(live).toHaveLength(1);
    expect(live[0]!.content).toContain("aaaaaaaaaaaaaaaaaaaa");
    expect(live[0]!.id).not.toBe(older.id);
    // The merged thought stays in its project and keeps its author: a canonical
    // row written with a NULL project is out of the brain the sources belonged
    // to, invisible to every project-scoped search and to every later run.
    expect(live[0]!.project).toBe("markets");
    expect(live[0]!.created_by).toBe("ahuvi");

    // The forward watermark is untouched by the sweep: a watermark taken from
    // 45-day-old rows would rewind it over the whole corpus it had settled.
    const { rows: state } = await pool.query<{ watermark: Date; done: Date | null }>(
      `SELECT watermark, backfill_done_at AS done FROM dream_state WHERE project = 'markets'`,
    );
    expect(state[0]!.watermark.getTime()).toBeGreaterThan(Date.now() - DAY);
    expect(state[0]!.done).toBeInstanceOf(Date);

    // And a finished sweep does not start again.
    expect(await sweep()).toBeUndefined();

    const history = await port.listRuns("markets", 10);
    expect(history.filter((run) => run.trigger === "schedule-backfill")).toHaveLength(2);
  });
});

if (!reachable) {
  describe("pg dream port", () => {
    // Vitest requires at least one collected test in a file; this documents WHY
    // the suite above was skipped so a green run cannot be mistaken for coverage.
    it.skip("skipped: no Postgres reachable (see README > Integration tests)", () => {});
  });
}
