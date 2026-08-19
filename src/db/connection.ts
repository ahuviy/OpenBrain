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

/**
 * Brings the schema up to date, then proves the pool can talk to it.
 *
 * Migrations run here rather than in a platform release command because every
 * deploy target boots through this function and only one of them (Azure) had a
 * migration step at all — which is how production ran without the dream tables
 * migration 006 creates. Startup fails loudly if a migration fails: serving MCP
 * traffic against a half-migrated schema turns one clear error into many
 * confusing ones.
 */
export async function initializeDatabase(): Promise<void> {
  await runMigrations();

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

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log("[db] Pool closed.");
  }
}
