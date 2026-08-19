/**
 * Postgres harness for database-backed integration tests.
 *
 * The existing integration tests here talk to a LIVE deployment over HTTP. These
 * talk to a throwaway database instead, because the dream layer's contract is
 * mostly SQL semantics — a partial UNIQUE index, `FOR UPDATE`, `metadata ||`,
 * `updated_at` triggers — and none of that is observable through the REST API.
 *
 * Reads the same DB_* variables as knexfile.cjs and src/db/connection.ts, so one
 * env shape drives dev, CI, and migrations. Defaults point at localhost so a
 * developer with the compose stack up needs no configuration; CI overrides the
 * port to whatever its service container publishes.
 */

import pg from "pg";

export interface TestDatabase {
  pool: pg.Pool;
  /** Empties every table the dream layer touches, leaving the schema in place. */
  truncate(): Promise<void>;
  close(): Promise<void>;
}

export function databaseUrlFromEnv(): pg.PoolConfig {
  return {
    host: process.env.DB_HOST ?? "localhost",
    port: parseInt(process.env.DB_PORT ?? "5432", 10),
    database: process.env.DB_NAME ?? "openbrain",
    user: process.env.DB_USER ?? "openbrain",
    password: process.env.DB_PASSWORD ?? "changeme",
  };
}

/**
 * True when a Postgres is actually reachable. Integration tests skip rather than
 * fail when it is not: a developer running `npm test` without the stack up has
 * not broken anything, and a red suite that means "you didn't start docker" is
 * a suite people learn to ignore.
 */
export async function isDatabaseReachable(): Promise<boolean> {
  const pool = new pg.Pool({ ...databaseUrlFromEnv(), connectionTimeoutMillis: 2_000 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const DREAM_TABLES = ["dream_proposals", "dream_state", "thoughts"] as const;

export async function connectTestDatabase(): Promise<TestDatabase> {
  const pool = new pg.Pool(databaseUrlFromEnv());

  const missing = await pool.query<{ table_name: string }>(
    `SELECT unnest($1::text[]) AS table_name
     EXCEPT
     SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    [[...DREAM_TABLES]],
  );

  if (missing.rowCount && missing.rowCount > 0) {
    const names = missing.rows.map((row) => row.table_name).join(", ");
    await pool.end();
    throw new Error(
      `Integration database is missing tables: ${names}. Run: npm run db:migrate (see README > Integration tests).`,
    );
  }

  return {
    pool,
    async truncate() {
      // RESTART IDENTITY is unnecessary (uuid keys) but CASCADE is not: thoughts
      // self-references via supersedes.
      await pool.query(`TRUNCATE ${DREAM_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    },
    async close() {
      await pool.end();
    },
  };
}

/** Deterministic non-zero vector of the dimension the deployment is built for. */
export function testEmbedding(seed: number, dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 768)): number[] {
  return Array.from({ length: dimensions }, (_, i) => Math.sin(seed + i) / 100);
}
