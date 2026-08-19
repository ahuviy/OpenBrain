#!/usr/bin/env node
/**
 * Bring a database up to the schema the integration suites expect.
 *
 * Three layers, in this order, because they accumulated in this order:
 *   1. db/init.sql          base tables, extensions, triggers
 *   2. db/migrations/*.sql  001-003, which predate knex and are untracked by it
 *   3. knex                 004 onward
 *
 * Skipping layer 2 leaves migration 003's provenance helpers absent, and the
 * provenance suite then fails with a confusing "column does not exist".
 *
 * Reads the same DB_* variables as knexfile.cjs. Safe to re-run.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { cli, run, step } from "./lib/proc.js";

const env = {
  ...process.env,
  PGHOST: process.env.DB_HOST ?? "localhost",
  PGPORT: process.env.DB_PORT ?? "5432",
  PGDATABASE: process.env.DB_NAME ?? "openbrain",
  PGUSER: process.env.DB_USER ?? "openbrain",
  PGPASSWORD: process.env.DB_PASSWORD ?? "changeme",
};

const psql = (file) => run("psql", ["-q", "-v", "ON_ERROR_STOP=1", "-f", file], { env });

/** Legacy migrations, sorted. `.down.sql` files are rollbacks and never applied. */
function legacyMigrations() {
  return readdirSync("db/migrations")
    .filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql"))
    .sort()
    .map((name) => join("db/migrations", name));
}

cli(async () => {
  step("Base schema (db/init.sql)");
  await psql("db/init.sql");

  step("Legacy migrations (001-003)");
  for (const migration of legacyMigrations()) {
    console.log(`  applying ${migration}`);
    await psql(migration);
  }

  step("Knex migrations (004+)");
  await run("npm", ["run", "db:migrate"], { env });

  // A check the suites cannot make for themselves: they SKIP when no database
  // answers, so a broken database would otherwise read as a pass.
  step("Verify");
  await run("psql", ["-c", "SELECT 1 FROM dream_state LIMIT 0"], { env });
  console.log("  schema ready");
});
