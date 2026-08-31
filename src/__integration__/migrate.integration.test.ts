/**
 * Boot-time migrations against a real Postgres.
 *
 * The production failure this covers — `relation "dream_state" does not exist`
 * from the dream tool — came from a database that had db/init.sql and nothing
 * else. The unit tests mock knex, so only this one proves the migration files
 * actually apply and that re-running them on a current database is a no-op.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";

import { runMigrations } from "../db/migrate.js";
import { connectTestDatabase, isDatabaseReachable, type TestDatabase } from "./helpers/database.js";

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)("runMigrations", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await connectTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  async function tableExists(pool: pg.Pool, name: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
      [name],
    );
    return result.rowCount === 1;
  }

  it("creates the dream tables on a database that never ran migration 006", async () => {
    await db.pool.query(`DROP TABLE IF EXISTS dream_proposals, dream_state`);
    // Every later migration that ALTERS those tables has to be forgotten too.
    // Forgetting 006 alone leaves knex believing 009 has run, so the tables come
    // back without the columns it added — a database that then breaks every
    // suite that runs after this one, in a way that looks like their bug.
    await db.pool.query(
      `DELETE FROM knex_migrations WHERE name IN ('006_dream.cjs', '009_dream_backfill.cjs')`,
    );
    expect(await tableExists(db.pool, "dream_state")).toBe(false);

    const applied = await runMigrations();

    expect(applied).toContain("006_dream.cjs");
    expect(await tableExists(db.pool, "dream_state")).toBe(true);
    expect(await tableExists(db.pool, "dream_proposals")).toBe(true);
    // Restored whole, not just re-created: the sweep's columns are part of the
    // schema those tables are supposed to have.
    const { rows } = await db.pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'dream_state' AND column_name = 'backfill_cursor'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("is a no-op on a database that is already current", async () => {
    await expect(runMigrations()).resolves.toEqual([]);
    expect(await tableExists(db.pool, "dream_state")).toBe(true);
  });
});
