/**
 * Run the knex migrations at boot.
 *
 * The hosted path (Supabase + Fly) creates its schema by pasting db/init.sql
 * into the SQL editor, and nothing after that ever ran `npm run db:migrate` —
 * no release command, no entrypoint step. Every migration from 004 onward was
 * therefore absent in production, which surfaced as the `dream` tool failing
 * with `relation "dream_state" does not exist`.
 *
 * Migrating on startup fixes every deploy target at once rather than one
 * platform's config file. The call is not awaited — see initializeDatabase in
 * connection.ts for why, and for the compatibility rule that buys. It is safe
 * to repeat: knex records applied migrations
 * in `knex_migrations` and takes a row lock in `knex_migrations_lock`, so a
 * second machine booting concurrently waits instead of applying twice.
 *
 * The migration directory is resolved from this module's own URL, not from
 * `process.cwd()`: the container's CMD is `node dist/index.js`, and a cwd-based
 * path is one `WORKDIR` change away from silently migrating nothing.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import knex, { type Knex } from "knex";

const MIGRATION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../db/knex-migrations");

/**
 * The same shape as knexfile.cjs, which still drives the `npm run db:migrate`
 * CLI. Both read the discrete DB_* variables that src/db/connection.ts reads,
 * so one env shape covers the pool, the CLI and this runner.
 */
export function migrationConfig(): Knex.Config {
  const useSSL = (process.env.DB_SSL ?? "false").toLowerCase() === "true";

  return {
    client: "pg",
    connection: {
      host: process.env.DB_HOST ?? "openbrain-postgres",
      port: parseInt(process.env.DB_PORT ?? "5432", 10),
      database: process.env.DB_NAME ?? "openbrain",
      user: process.env.DB_USER ?? "openbrain",
      password: process.env.DB_PASSWORD ?? "changeme",
      ssl: useSSL ? { rejectUnauthorized: false } : false,
    },
    migrations: {
      directory: MIGRATION_DIR,
      extension: "cjs",
      loadExtensions: [".cjs"],
      tableName: "knex_migrations",
    },
  };
}

/**
 * The slice of knex this module uses. Narrower than `typeof knex` so a test can
 * substitute a stub without reconstructing the whole Knex surface.
 */
export type MigrationDriver = (config: Knex.Config) => {
  migrate: { latest(): Promise<[number, string[]]> };
  destroy(): Promise<void>;
};

/**
 * Applies every pending migration and returns the names applied (empty when the
 * database is already current). The knex instance is its own short-lived pool —
 * the app pool in connection.ts is pg, and migrations must not hold one of its
 * connections for the life of the process.
 */
export async function runMigrations(factory: MigrationDriver = knex): Promise<string[]> {
  const db = factory(migrationConfig());
  try {
    const [, applied] = await db.migrate.latest();
    console.log(
      applied.length === 0
        ? "[db] Migrations up to date."
        : `[db] Applied ${applied.length} migration(s): ${applied.join(", ")}`
    );
    return applied;
  } finally {
    await db.destroy();
  }
}
