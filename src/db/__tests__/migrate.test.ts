/**
 * Unit tests for src/db/migrate.ts
 *
 * The bug these pin down: a deployment whose schema came from db/init.sql alone
 * has no dream_state, because nothing on the hosted path ever ran the knex
 * migrations. Migrating at boot fixes that for every deploy target at once, so
 * what matters here is that the runner finds the migration directory no matter
 * what the process cwd is, and that it releases its connection either way.
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect, vi } from "vitest";

import { migrationConfig, runMigrations, type MigrationDriver } from "../migrate.js";

function createMockKnex(latest: () => Promise<[number, string[]]>) {
  const destroy = vi.fn().mockResolvedValue(undefined);
  const factory: MigrationDriver = vi.fn().mockReturnValue({
    migrate: { latest: vi.fn(latest) },
    destroy,
  });
  return { factory, destroy };
}

describe("migrationConfig", () => {
  it("points at the real migration directory regardless of cwd", () => {
    const spy = vi.spyOn(process, "cwd").mockReturnValue("/");
    try {
      const directory = migrationConfig().migrations?.directory as string;
      expect(directory.startsWith("/")).toBe(true);
      expect(existsSync(directory)).toBe(true);
      expect(readdirSync(directory)).toContain("006_dream.cjs");
    } finally {
      spy.mockRestore();
    }
  });

  it("reads the same DB_* variables as knexfile.cjs", () => {
    vi.stubEnv("DB_HOST", "db.example");
    vi.stubEnv("DB_PORT", "6543");
    vi.stubEnv("DB_NAME", "brain");
    vi.stubEnv("DB_USER", "reader");
    vi.stubEnv("DB_PASSWORD", "secret");
    vi.stubEnv("DB_SSL", "true");
    try {
      const connection = migrationConfig().connection as Record<string, unknown>;
      expect(connection).toMatchObject({
        host: "db.example",
        port: 6543,
        database: "brain",
        user: "reader",
        password: "secret",
        ssl: { rejectUnauthorized: false },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("tracks applied migrations in knex_migrations and loads .cjs files", () => {
    const { migrations } = migrationConfig();
    expect(migrations?.tableName).toBe("knex_migrations");
    expect(migrations?.loadExtensions).toEqual([".cjs"]);
  });
});

describe("runMigrations", () => {
  it("applies pending migrations and returns their names", async () => {
    const { factory, destroy } = createMockKnex(async () => [1, ["006_dream.cjs"]]);

    await expect(runMigrations(factory)).resolves.toEqual(["006_dream.cjs"]);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("releases the migration connection when a migration fails", async () => {
    const { factory, destroy } = createMockKnex(async () => {
      throw new Error("relation \"knex_migrations\" is locked");
    });

    await expect(runMigrations(factory)).rejects.toThrow("locked");
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe("knexfile.cjs parity", () => {
  // The CLI path (`npm run db:migrate`, and scripts/prepare-database.js behind
  // it) reads knexfile.cjs, while the app reads migrationConfig(). Two copies of
  // one connection means a database that migrates from a laptop and not from the
  // app, or the reverse — the failure is a missing relation at runtime, far from
  // the edit that caused it.
  const require = createRequire(import.meta.url);

  function knexfile(): Record<string, any> {
    const path = resolve(__dirname, "../../../knexfile.cjs");
    delete require.cache[require.resolve(path)];
    return require(path) as Record<string, any>;
  }

  it("connects to the same database the CLI migrates", () => {
    vi.stubEnv("DB_HOST", "db.example");
    vi.stubEnv("DB_PORT", "6543");
    vi.stubEnv("DB_NAME", "brain");
    vi.stubEnv("DB_USER", "reader");
    vi.stubEnv("DB_PASSWORD", "secret");
    vi.stubEnv("DB_SSL", "true");
    try {
      expect(migrationConfig().connection).toEqual(knexfile().connection);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("defaults identically when nothing is configured", () => {
    for (const key of ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_SSL"]) {
      vi.stubEnv(key, "");
      vi.unstubAllEnvs();
    }
    expect(migrationConfig().connection).toEqual(knexfile().connection);
    expect(migrationConfig().client).toBe(knexfile().client);
  });

  it("applies the same migrations, tracked in the same table", () => {
    const theirs = knexfile().migrations;
    const ours = migrationConfig().migrations!;

    expect(ours.tableName).toBe(theirs.tableName);
    expect(ours.loadExtensions).toEqual(theirs.loadExtensions);
    // knexfile's path is relative to the repo root it is run from; ours is
    // absolute by design. Compare what they resolve to, not how they spell it.
    expect(resolve(__dirname, "../../..", theirs.directory as string)).toBe(ours.directory);
  });
});
