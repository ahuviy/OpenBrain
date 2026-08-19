/**
 * Database connection pool using node-postgres (pg).
 * Singleton pool with pgvector support.
 */

import pg from "pg";

import { runMigrations } from "./migrate.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const useSSL = (process.env.DB_SSL ?? "false").toLowerCase() === "true";

    pool = new Pool({
      host: process.env.DB_HOST ?? "openbrain-postgres",
      port: parseInt(process.env.DB_PORT ?? "5432", 10),
      database: process.env.DB_NAME ?? "openbrain",
      user: process.env.DB_USER ?? "openbrain",
      password: process.env.DB_PASSWORD ?? "changeme",
      ssl: useSSL ? { rejectUnauthorized: false } : false,
      min: 2,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on("error", (err) => {
      console.error("[db] Unexpected pool error:", err.message);
    });

    console.log(
      `[db] Pool created → ${process.env.DB_HOST ?? "openbrain-postgres"}:${process.env.DB_PORT ?? "5432"}/${process.env.DB_NAME ?? "openbrain"}`
    );
  }
  return pool;
}

/** Tracks the in-flight background migration so shutdown can wait for it. */
let migrations: Promise<void> | null = null;

/**
 * Starts the migrations and proves the pool can talk to the database.
 *
 * Migrations run here because every deploy target boots through this function
 * and only one of them (Azure) had a migration step at all — which is how
 * production ran without the dream tables migration 006 creates.
 *
 * They are deliberately NOT awaited. Blocking the servers on a migration means
 * a cold machine does not bind its port until the migration finishes, and on
 * Fly that is a failed health check on every boot. The connectivity check below
 * still blocks: a database the pool cannot reach at all is a startup failure,
 * while a schema that is one migration behind is a transient state.
 *
 * That window — new code, old schema — is the standing constraint on every
 * migration in db/knex-migrations: each one must leave the schema readable by
 * both the running code and the incoming code. Expand, deploy, contract; never
 * drop or rename a column in the same release that stops using it.
 *
 * A migration that fails is logged, not fatal. It has not applied (knex runs
 * each in a transaction), the previous schema is intact, and taking the process
 * down would trade a subset of failing tools for a hard outage.
 */
export async function initializeDatabase(): Promise<void> {
  migrations = runMigrations().then(
    () => undefined,
    (err: unknown) => {
      console.error("[db] Migrations failed:", err instanceof Error ? err.stack ?? err.message : String(err));
    }
  );

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    const result = await client.query("SELECT COUNT(*) FROM thoughts");
    console.log(`[db] Connected. ${result.rows[0]?.count ?? 0} thoughts in database.`);
  } finally {
    client.release();
  }
}

/**
 * Resolves once the background migration has finished, successfully or not.
 *
 * Shutdown awaits this. Killing the process mid-migration leaves knex's row in
 * `knex_migrations_lock` held, and the next boot then blocks on a lock whose
 * owner is gone — a worse failure than the few seconds spent waiting here.
 */
export function migrationsSettled(): Promise<void> {
  return migrations ?? Promise.resolve();
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log("[db] Pool closed.");
  }
}
