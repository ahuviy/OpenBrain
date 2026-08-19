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

import { describe, it, beforeAll, afterAll } from "vitest";
import type pg from "pg";

import dreamPortContractTests from "../integration-suites/dream-port-contract.suite.js";
import { createDreamPort } from "../dream/port.js";
import { insertThought, type ThoughtRow } from "../db/queries.js";
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

if (!reachable) {
  describe("pg dream port", () => {
    // Vitest requires at least one collected test in a file; this documents WHY
    // the suite above was skipped so a green run cannot be mistaken for coverage.
    it.skip("skipped: no Postgres reachable (see README > Integration tests)", () => {});
  });
}
