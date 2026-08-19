/**
 * Unit tests for src/db/connection.ts bootstrap order.
 *
 * initializeDatabase is the one place every deploy target passes through on the
 * way up, which is why the migrations run from here rather than from a
 * platform-specific release command. The order matters: the readiness query
 * runs against the migrated schema, so a migration failure surfaces as itself
 * instead of as a missing relation later.
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

const { initializeDatabase, closePool } = await import("../connection.js");

describe("initializeDatabase", () => {
  beforeEach(() => {
    query.mockClear();
    runMigrations.mockClear();
    runMigrations.mockResolvedValue([]);
  });

  it("migrates before querying the schema", async () => {
    await initializeDatabase();

    expect(runMigrations).toHaveBeenCalledOnce();
    expect(runMigrations.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      query.mock.invocationCallOrder[0] ?? 0,
    );
    await closePool();
  });

  it("fails startup when migrations fail", async () => {
    runMigrations.mockRejectedValueOnce(new Error("permission denied for schema public"));

    await expect(initializeDatabase()).rejects.toThrow("permission denied");
    await closePool();
  });
});
