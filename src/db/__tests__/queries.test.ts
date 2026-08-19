/**
 * Unit tests for src/db/queries.ts
 * Uses mocked pg.Pool to test query construction and parameter passing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type pg from "pg";

import {
  insertThought,
  searchThoughts,
  hybridSearchThoughts,
  listThoughts,
  getThoughtStats,
  updateThought,
  deleteThought,
  batchInsertThoughts,
  listThoughtsByIds,
  countVocabulary,
  listProjects,
  insertDreamRun,
  findOpenProposal,
  listDreamRuns,
  listThoughtsTagged,
  type ThoughtMetadata,
} from "../queries.js";

// ─── Mock Pool Factory ──────────────────────────────────────────────

function createMockPool() {
  const mockQuery = vi.fn();
  const mockRelease = vi.fn();
  const mockConnect = vi.fn().mockResolvedValue({
    query: mockQuery,
    release: mockRelease,
  });

  const pool = {
    query: mockQuery,
    connect: mockConnect,
  } as unknown as pg.Pool;

  return { pool, mockQuery, mockConnect, mockRelease };
}

// ─── insertThought ──────────────────────────────────────────────────

describe("insertThought", () => {
  it("inserts with project and supersedes params", async () => {
    const { pool, mockQuery } = createMockPool();
    const metadata: ThoughtMetadata = { type: "decision", source: "mcp" };
    const row = {
      id: "abc-123",
      content: "test content",
      metadata,
      project: "plan-forge",
      archived: false,
      supersedes: null,
      created_at: new Date(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await insertThought(
      pool, "test content", [0.1, 0.2], metadata, "plan-forge", undefined, undefined
    );

    expect(result.id).toBe("abc-123");
    expect(result.project).toBe("plan-forge");

    // Verify SQL includes project, supersedes, and created_by columns
    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("project");
    expect(sql).toContain("supersedes");
    expect(sql).toContain("created_by");

    // Verify params include project, null supersedes, and null created_by
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[3]).toBe("plan-forge");
    expect(params[4]).toBeNull();
    expect(params[5]).toBeNull();
  });

  it("inserts without project (backward compatible)", async () => {
    const { pool, mockQuery } = createMockPool();
    const metadata: ThoughtMetadata = { type: "observation" };
    const row = {
      id: "def-456",
      content: "old style",
      metadata,
      project: null,
      archived: false,
      supersedes: null,
      created_at: new Date(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await insertThought(pool, "old style", [0.3], metadata);

    expect(result.project).toBeNull();
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[3]).toBeNull(); // project
    expect(params[4]).toBeNull(); // supersedes
    expect(params[5]).toBeNull(); // created_by
  });

  it("inserts with created_by when provided", async () => {
    const { pool, mockQuery } = createMockPool();
    const metadata: ThoughtMetadata = { type: "observation" };
    const row = {
      id: "ghi-789",
      content: "user thought",
      metadata,
      project: "proj",
      created_by: "sarah",
      archived: false,
      supersedes: null,
      created_at: new Date(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await insertThought(pool, "user thought", [0.4], metadata, "proj", undefined, "sarah");

    expect(result.created_by).toBe("sarah");
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[5]).toBe("sarah");
  });
});

// ─── searchThoughts ─────────────────────────────────────────────────

describe("searchThoughts", () => {
  it("passes project and include_archived to match_thoughts RPC", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await searchThoughts(pool, [0.1], 10, 0.5, {}, "plan-forge", false);

    const params = mockQuery.mock.calls[0]![1] as unknown[];
    // Params: embedding, threshold, limit, filter, project_filter, include_archived, user_filter
    expect(params[4]).toBe("plan-forge");
    expect(params[5]).toBe(false);
  });

  it("passes created_by as user_filter to match_thoughts RPC", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await searchThoughts(pool, [0.1], 10, 0.5, {}, "plan-forge", false, "sarah");

    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[6]).toBe("sarah");
  });

  it("passes type and topic as JSONB filter", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const filter = { type: "decision", topics: ["caching"] };
    await searchThoughts(pool, [0.1], 10, 0.5, filter);

    const params = mockQuery.mock.calls[0]![1] as unknown[];
    const jsonFilter = JSON.parse(params[3] as string);
    expect(jsonFilter.type).toBe("decision");
    expect(jsonFilter.topics).toEqual(["caching"]);
  });

  it("works without filters (backward compatible)", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await searchThoughts(pool, [0.1]);

    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[4]).toBeNull();  // project
    expect(params[5]).toBe(false); // include_archived
    expect(params[6]).toBeNull();  // created_by
  });
});

// ─── listThoughts ───────────────────────────────────────────────────

describe("listThoughts", () => {
  it("filters by project when provided", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThoughts(pool, { project: "openbrain" });

    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("project =");
  });

  it("excludes archived by default", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThoughts(pool, {});

    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("archived = false");
  });

  it("filters by created_by when provided", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThoughts(pool, { created_by: "sarah" });

    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("created_by =");
  });

  it("includes archived when requested", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listThoughts(pool, { include_archived: true });

    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).not.toContain("archived = false");
  });
});

// ─── getThoughtStats ────────────────────────────────────────────────

describe("getThoughtStats", () => {
  const defaultMocks = (mockQuery: ReturnType<typeof vi.fn>) => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: "5" }] })       // total
      .mockResolvedValueOnce({ rows: [] })                       // types
      .mockResolvedValueOnce({ rows: [] })                       // topics
      .mockResolvedValueOnce({ rows: [] })                       // people
      .mockResolvedValueOnce({ rows: [{ earliest: null, latest: null }] }); // range
  };

  it("scopes by project when provided", async () => {
    const { pool, mockQuery } = createMockPool();
    defaultMocks(mockQuery);

    await getThoughtStats(pool, "plan-forge");

    // First call (count) should include project filter
    const countSql = mockQuery.mock.calls[0]![0] as string;
    expect(countSql).toContain("project =");
    const countParams = mockQuery.mock.calls[0]![1] as unknown[];
    expect(countParams[0]).toBe("plan-forge");
  });

  it("scopes by created_by when provided", async () => {
    const { pool, mockQuery } = createMockPool();
    defaultMocks(mockQuery);

    await getThoughtStats(pool, undefined, "sarah");

    const countSql = mockQuery.mock.calls[0]![0] as string;
    expect(countSql).toContain("created_by =");
    const countParams = mockQuery.mock.calls[0]![1] as unknown[];
    expect(countParams[0]).toBe("sarah");
  });

  it("does not filter by project when omitted", async () => {
    const { pool, mockQuery } = createMockPool();
    defaultMocks(mockQuery);

    await getThoughtStats(pool);

    const countSql = mockQuery.mock.calls[0]![0] as string;
    expect(countSql).not.toContain("project =");
  });
});

// ─── updateThought ──────────────────────────────────────────────────

describe("updateThought", () => {
  it("returns updated row", async () => {
    const { pool, mockQuery } = createMockPool();
    const row = {
      id: "abc-123",
      content: "updated",
      metadata: { type: "decision" },
      project: null,
      archived: false,
      supersedes: null,
      created_at: new Date(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await updateThought(
      pool, "abc-123", "updated", [0.1], { type: "decision" }
    );

    expect(result.id).toBe("abc-123");
    expect(result.content).toBe("updated");
  });

  it("throws when thought not found", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(
      updateThought(pool, "nonexistent", "content", [0.1], {})
    ).rejects.toThrow("Thought not found");
  });
});

// ─── deleteThought ──────────────────────────────────────────────────

describe("deleteThought", () => {
  it("returns deletion confirmation", async () => {
    const { pool, mockQuery } = createMockPool();
    // First call: clear supersedes refs
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    // Second call: delete
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await deleteThought(pool, "abc-123");

    expect(result.deleted).toBe(true);
    expect(result.id).toBe("abc-123");
  });

  it("returns deleted=false when thought not found", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const result = await deleteThought(pool, "nonexistent");

    expect(result.deleted).toBe(false);
  });
});

// ─── batchInsertThoughts ────────────────────────────────────────────

describe("batchInsertThoughts", () => {
  it("inserts all thoughts within a transaction", async () => {
    const { pool, mockQuery, mockConnect } = createMockPool();
    const clientQuery = (await mockConnect()).query;

    const row = (i: number) => ({
      id: `id-${i}`,
      content: `thought ${i}`,
      metadata: {},
      project: "proj",
      archived: false,
      supersedes: null,
      created_at: new Date(),
    });

    // BEGIN, INSERT x2, COMMIT
    clientQuery
      .mockResolvedValueOnce({})                     // BEGIN
      .mockResolvedValueOnce({ rows: [row(1)] })     // INSERT 1
      .mockResolvedValueOnce({ rows: [row(2)] })     // INSERT 2
      .mockResolvedValueOnce({});                     // COMMIT

    const results = await batchInsertThoughts(pool, [
      { content: "thought 1", embedding: [0.1], metadata: {}, project: "proj" },
      { content: "thought 2", embedding: [0.2], metadata: {}, project: "proj" },
    ]);

    expect(results).toHaveLength(2);

    // Verify transaction flow: BEGIN → INSERTs → COMMIT
    expect(clientQuery.mock.calls[0]![0]).toBe("BEGIN");
    expect(clientQuery.mock.calls[3]![0]).toBe("COMMIT");
  });

  it("rolls back on error", async () => {
    const { pool, mockConnect } = createMockPool();
    const client = await mockConnect();

    client.query
      .mockResolvedValueOnce({})                          // BEGIN
      .mockRejectedValueOnce(new Error("insert failed")); // INSERT fails

    await expect(
      batchInsertThoughts(pool, [
        { content: "fail", embedding: [0.1], metadata: {} },
      ])
    ).rejects.toThrow("insert failed");

    // Should have called ROLLBACK
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });
});

// ─── hybridSearchThoughts ───────────────────────────────────────────

describe("hybridSearchThoughts", () => {
  it("calls the fusion function with the query text alongside the embedding", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await hybridSearchThoughts(pool, [0.1, 0.2], "gaya.org.il", 5, 0.4, { type: "reference" }, "personal", false, "ahuvi");

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("hybrid_match_thoughts");
    expect(params[0]).toBe("[0.1,0.2]");
    expect(params[1]).toBe("gaya.org.il");
    expect(params[2]).toBe(5);
    expect(params[3]).toBe(0.4);
    expect(params[5]).toBe("personal");
  });

  it("returns fused rows untouched", async () => {
    const { pool, mockQuery } = createMockPool();
    const row = {
      id: "id-1",
      content: "x",
      metadata: {},
      similarity: 0.3,
      text_rank: 0.06,
      score: 0.016,
      matched_by: "text",
      created_at: new Date(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    expect(await hybridSearchThoughts(pool, [0.1], "x")).toEqual([row]);
  });

  it("falls back to semantic search when migration 005 has not been applied", async () => {
    const { pool, mockQuery } = createMockPool();
    const undefinedFunction = Object.assign(new Error("function does not exist"), { code: "42883" });
    mockQuery.mockRejectedValueOnce(undefinedFunction);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "id-1", content: "x", metadata: {}, similarity: 0.8, created_at: new Date() }],
    });

    const results = await hybridSearchThoughts(pool, [0.1], "x");

    expect(mockQuery.mock.calls[1]![0]).toContain("match_thoughts");
    expect(results[0]!.matched_by).toBe("semantic");
    expect(results[0]!.score).toBe(0.8);
    expect(results[0]!.text_rank).toBe(0);
  });

  it("propagates errors that are not a missing function", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockRejectedValueOnce(Object.assign(new Error("connection refused"), { code: "08006" }));

    await expect(hybridSearchThoughts(pool, [0.1], "x")).rejects.toThrow("connection refused");
  });
});

// ─── listThoughtsByIds ──────────────────────────────────────────────

describe("listThoughtsByIds", () => {
  it("fetches by id array in one query, archived rows included", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValue({ rows: [{ id: "id-a", content: "a" }] });

    const rows = await listThoughtsByIds(pool, ["id-a", "id-b"]);

    expect(rows).toHaveLength(1);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("= ANY($1::uuid[])");
    // Archived is NOT filtered: a proposal that archived a thought must still
    // render it when the review comes back to look at what it did.
    expect(sql).not.toContain("archived = false");
    expect(params).toEqual([["id-a", "id-b"]]);
  });

  it("does not hit the database for an empty id list", async () => {
    const { pool, mockQuery } = createMockPool();

    await expect(listThoughtsByIds(pool, [])).resolves.toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ─── Vocabulary sweep ───────────────────────────────────────────────

describe("countVocabulary", () => {
  it("counts topics and people across the corpus in one round trip", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValue({
      rows: [
        { field: "topics", value: "markets", uses: "3" },
        { field: "people", value: "Dohmen", uses: "7" },
      ],
    });

    const counts = await countVocabulary(pool, "");

    expect(mockQuery).toHaveBeenCalledOnce();
    expect(counts).toEqual({ topics: { markets: 3 }, people: { Dohmen: 7 } });
  });

  it("counts the project it was given, not the whole brain", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValue({ rows: [] });

    await countVocabulary(pool, "markets");

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("COALESCE(project, '') = $1");
    expect(sql).toContain("archived = false");
    expect(params).toEqual(["markets"]);
  });
});

describe("listThoughtsTagged", () => {
  it("finds every thought carrying any of the given tags", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValue({ rows: [{ id: "id-a" }] });

    const rows = await listThoughtsTagged(pool, "people", ["Bert Dohmen"], "");

    expect(rows).toHaveLength(1);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("metadata->'people'");
    expect(sql).toContain("?|");
    expect(params).toEqual([["Bert Dohmen"], ""]);
  });

  it("does not query for an empty tag list", async () => {
    const { pool, mockQuery } = createMockPool();

    await expect(listThoughtsTagged(pool, "topics", [], "")).resolves.toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("only accepts the two metadata fields it knows how to index", async () => {
    const { pool } = createMockPool();

    await expect(
      // A field name reaches SQL by interpolation, so the set must be closed.
      listThoughtsTagged(pool, "metadata'; DROP TABLE thoughts; --" as never, ["x"], ""),
    ).rejects.toThrow();
  });
});

// ─── listProjects ───────────────────────────────────────────────────

describe("listProjects", () => {
  it("returns every project bucket, the no-project one included", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValue({ rows: [{ project: "" }, { project: "markets" }] });

    // The empty string is a real bucket, not a missing value: a scheduled run
    // that skipped it would never consolidate project-less thoughts, which is
    // most of a personal brain.
    await expect(listProjects(pool)).resolves.toEqual(["", "markets"]);
    expect(mockQuery.mock.calls[0]![0]).toContain("COALESCE(project, '')");
  });

  it("ignores archived thoughts", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValue({ rows: [] });

    await listProjects(pool);

    expect(mockQuery.mock.calls[0]![0]).toContain("archived = false");
  });
});

// ─── Run history ────────────────────────────────────────────────────

describe("insertDreamRun", () => {
  it("records a successful run with its action log", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValue({ rows: [{ id: "run-1" }] });

    await insertDreamRun(pool, {
      project: "markets",
      status: "ok",
      dry_run: false,
      trigger: "schedule",
      applied: { merge: 1 },
      proposed: {},
      skipped: {},
      actions: [{ kind: "merge", sources: ["a", "b"] }],
      candidates: 4,
      clusters: 1,
      proposal_id: null,
      error: null,
      started_at: new Date("2026-08-19T03:00:00Z"),
    });

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO dream_runs");
    expect(params).toContain("markets");
    expect(params).toContain("ok");
    // JSONB columns are stringified once, at the boundary.
    expect(params).toContain(JSON.stringify([{ kind: "merge", sources: ["a", "b"] }]));
  });

  it("records a failed run, which is the row a retro most needs", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValue({ rows: [{ id: "run-2" }] });

    await insertDreamRun(pool, {
      project: "",
      status: "failed",
      dry_run: false,
      trigger: "schedule",
      applied: {},
      proposed: {},
      skipped: {},
      actions: [],
      candidates: 0,
      clusters: 0,
      proposal_id: null,
      error: "embedder timeout",
      started_at: new Date("2026-08-19T03:00:00Z"),
    });

    expect(mockQuery.mock.calls[0]![1]).toContain("embedder timeout");
  });
});

describe("listDreamRuns", () => {
  it("returns a project's runs newest first, bounded", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValue({ rows: [] });

    await listDreamRuns(pool, "markets", 20);

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("ORDER BY started_at DESC");
    expect(sql).toContain("LIMIT");
    expect(params).toEqual(["markets", 20]);
  });

  it("reads every project when none is named", async () => {
    // A retro usually asks "how have the runs been going", not "how has this
    // one project been going".
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValue({ rows: [] });

    await listDreamRuns(pool, undefined, 20);

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).not.toContain("WHERE project");
    expect(params).toEqual([20]);
  });
});

// ─── Pending proposals ──────────────────────────────────────────────

describe("findOpenProposal", () => {
  it("returns the open proposal for a project, with when it lapses", async () => {
    // Nothing surfaced a pending proposal, so unless dream happened to be run
    // again it expired unnoticed — and expiry is not the same as a reject.
    const { pool, mockQuery } = createMockPool();
    const expires = new Date("2026-08-22T09:00:00Z");
    mockQuery.mockResolvedValue({ rows: [{ id: "p-1", expires_at: expires, item_count: 3 }] });

    await expect(findOpenProposal(pool, "markets")).resolves.toEqual({
      id: "p-1",
      expires_at: expires,
      item_count: 3,
    });

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("status = 'open'");
    expect(sql).toContain("expires_at > now()");
    expect(params).toEqual(["markets"]);
  });

  it("returns undefined when nothing is pending", async () => {
    const { pool, mockQuery } = createMockPool();
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(findOpenProposal(pool, "")).resolves.toBeUndefined();
  });
});
