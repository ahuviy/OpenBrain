/**
 * Unit tests for src/db/connection.ts bootstrap.
 *
 * Migrations run from here — the one place every deploy target passes through
 * on the way up — but they do NOT block the servers from listening. A cold Fly
 * machine that must finish a migration before binding its port fails its own
 * health check on the way up, and the fix for that belongs in code every target
 * shares rather than in one platform's release command.
 *
 * The cost of not blocking is a window where the code is newer than the schema,
 * which is why migrations here must stay backwards and forwards compatible:
 * expand, deploy, contract. These tests pin the two properties that window
 * depends on — startup never waits, and a failed migration never takes the
 * process down with it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn().mockResolvedValue({ rows: [{ count: "0" }] });
const release = vi.fn();
const connect = vi.fn().mockResolvedValue({ query, release });
const runMigrations = vi.fn().mockResolvedValue([]);

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(function Pool() {
      return { connect, on: vi.fn(), end: vi.fn().mockResolvedValue(undefined) };
    }),
  },
}));

vi.mock("../migrate.js", () => ({ runMigrations }));

const { initializeDatabase, closePool, migrationsSettled } = await import("../connection.js");

/** A promise plus its resolvers, so a test can hold a migration open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("initializeDatabase", () => {
  beforeEach(async () => {
    query.mockClear();
    runMigrations.mockClear();
    runMigrations.mockResolvedValue([]);
    vi.restoreAllMocks();
    await closePool();
  });

  it("starts the migrations", async () => {
    await initializeDatabase();
    await migrationsSettled();

    expect(runMigrations).toHaveBeenCalledOnce();
  });

  it("returns without waiting for the migrations to finish", async () => {
    const migration = deferred<string[]>();
    runMigrations.mockReturnValueOnce(migration.promise);

    await initializeDatabase();

    // Resolving only after initializeDatabase has already returned is the whole
    // point: an awaited migration would have deadlocked this test instead.
    expect(query).toHaveBeenCalled();
    migration.resolve([]);
    await migrationsSettled();
  });

  it("stays up when a migration fails, and says so", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runMigrations.mockRejectedValueOnce(new Error("permission denied for schema public"));

    await expect(initializeDatabase()).resolves.toBeUndefined();
    await expect(migrationsSettled()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("[db] Migrations failed"),
      expect.stringContaining("permission denied for schema public"),
    );
  });

  it("still fails startup when the database itself is unreachable", async () => {
    connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(initializeDatabase()).rejects.toThrow("ECONNREFUSED");
    await migrationsSettled();
  });
});

describe("migrationsSettled", () => {
  it("resolves immediately when no migration has been started", async () => {
    await closePool();
    await expect(migrationsSettled()).resolves.toBeUndefined();
  });
});
