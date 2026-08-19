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
import { createDreamPort, loadProposalReview } from "../dream/port.js";
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

if (!reachable) {
  describe("pg dream port", () => {
    // Vitest requires at least one collected test in a file; this documents WHY
    // the suite above was skipped so a green run cannot be mistaken for coverage.
    it.skip("skipped: no Postgres reachable (see README > Integration tests)", () => {});
  });
}
