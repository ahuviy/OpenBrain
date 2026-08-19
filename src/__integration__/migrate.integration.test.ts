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
    await db.pool.query(`DELETE FROM knex_migrations WHERE name = '006_dream.cjs'`);
    expect(await tableExists(db.pool, "dream_state")).toBe(false);

    const applied = await runMigrations();

    expect(applied).toContain("006_dream.cjs");
    expect(await tableExists(db.pool, "dream_state")).toBe(true);
    expect(await tableExists(db.pool, "dream_proposals")).toBe(true);
  });

  it("is a no-op on a database that is already current", async () => {
    await expect(runMigrations()).resolves.toEqual([]);
    expect(await tableExists(db.pool, "dream_state")).toBe(true);
  });
});
