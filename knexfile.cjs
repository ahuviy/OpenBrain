/**
 * Knex configuration for Open Brain migrations.
 *
 * Reads the same discrete DB_* environment variables as src/db/connection.ts
 * (Supabase in production, local Postgres in dev). Migrations live in
 * db/knex-migrations and are tracked in the knex_migrations table.
 *
 * Legacy raw-SQL migrations (db/migrations/001..003) predate knex and were
 * already applied; knex manages 004 onward.
 */

const useSSL = (process.env.DB_SSL ?? "false").toLowerCase() === "true";

/** @type {import('knex').Knex.Config} */
module.exports = {
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
    directory: "./db/knex-migrations",
    extension: "cjs",
    loadExtensions: [".cjs"],
    tableName: "knex_migrations",
  },
};
