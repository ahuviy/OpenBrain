/**
 * Unit tests for src/api/routes.ts
 * Tests route registration, input validation, and parameter passing using Hono test client.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("../../db/connection.js", () => ({
  getPool: () => {
    const mockQuery = vi.fn();
    const mockConnect = vi.fn().mockResolvedValue({
      query: vi.fn(),
      release: vi.fn(),
    });
    return { query: mockQuery, connect: mockConnect };
  },
}));

const mockGenerateEmbedding = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
const mockExtractMetadata = vi.fn().mockResolvedValue({
  type: "observation",
  topics: ["test"],
  people: [],
  action_items: [],
  dates: [],
});

vi.mock("../../embedder/index.js", () => ({
  getEmbedder: () => ({
    generateEmbedding: mockGenerateEmbedding,
    extractMetadata: mockExtractMetadata,
  }),
}));

// Mock query functions
const mockInsertThought = vi.fn();
const mockSearchThoughts = vi.fn();
const mockHybridSearchThoughts = vi.fn().mockResolvedValue([]);
const mockListThoughts = vi.fn();
const mockGetThoughtStats = vi.fn();
const mockUpdateThought = vi.fn();
const mockDeleteThought = vi.fn();
const mockBatchInsertThoughts = vi.fn();
const mockListDistinctTopics = vi.fn().mockResolvedValue(["test"]);

vi.mock("../../db/queries.js", () => ({
  insertThought: (...args: any[]) => mockInsertThought(...args),
  searchThoughts: (...args: any[]) => mockSearchThoughts(...args),
  hybridSearchThoughts: (...args: any[]) => mockHybridSearchThoughts(...args),
  listThoughts: (...args: any[]) => mockListThoughts(...args),
  getThoughtStats: (...args: any[]) => mockGetThoughtStats(...args),
  updateThought: (...args: any[]) => mockUpdateThought(...args),
  deleteThought: (...args: any[]) => mockDeleteThought(...args),
  batchInsertThoughts: (...args: any[]) => mockBatchInsertThoughts(...args),
  listDistinctTopics: (...args: any[]) => mockListDistinctTopics(...args),
}));

const mockLoadProposalReview = vi.fn();

vi.mock("../../dream/port.js", () => ({
  createDreamPort: () => ({}),
  createApplyPort: () => ({}),
  loadProposalReview: (...args: any[]) => mockLoadProposalReview(...args),
}));

import { createApi } from "../routes.js";

describe("REST API Routes", () => {
  const app = createApi();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Health ────────────────────────────────────────────────────────

  it("GET /health returns healthy", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("healthy");
  });

  // ─── POST /memories ────────────────────────────────────────────────

  it("POST /memories accepts project and supersedes", async () => {
    mockInsertThought.mockResolvedValueOnce({
      id: "abc-123",
      content: "test",
      metadata: { type: "decision" },
      project: "plan-forge",
      created_at: new Date(),
    });

    const res = await app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "We chose Redis for caching",
        project: "plan-forge",
        supersedes: "a1b2c3d4-1234-5678-9abc-def012345678",
        metadata: { type: "decision" },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: string };
    expect(body.project).toBe("plan-forge");
  });

  it("POST /memories returns 400 for invalid supersedes UUID", async () => {
    const res = await app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Some valid content",
        supersedes: "not-a-uuid",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /memories returns 400 for empty content", async () => {
    const res = await app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });

  // ─── POST /memories/search ─────────────────────────────────────────

  it("POST /memories/search accepts filter params", async () => {
    mockHybridSearchThoughts.mockResolvedValueOnce([]);

    const res = await app.request("/memories/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "caching decisions",
        project: "plan-forge",
        type: "decision",
        topic: "caching",
        include_archived: false,
      }),
    });

    expect(res.status).toBe(200);

    // Hybrid is the default; the raw query text is passed for the full-text leg.
    expect(mockHybridSearchThoughts).toHaveBeenCalled();
    const callArgs = mockHybridSearchThoughts.mock.calls[0]!;
    expect(callArgs[2]).toBe("caching decisions"); // query text
    expect(callArgs[6]).toBe("plan-forge");        // project param
    expect(callArgs[7]).toBe(false);               // include_archived param
  });

  it("POST /memories/search honours mode=semantic", async () => {
    mockSearchThoughts.mockResolvedValueOnce([]);

    const res = await app.request("/memories/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "caching decisions",
        project: "plan-forge",
        include_archived: false,
        mode: "semantic",
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHybridSearchThoughts).not.toHaveBeenCalled();
    const callArgs = mockSearchThoughts.mock.calls[0]!;
    expect(callArgs[5]).toBe("plan-forge"); // project param
    expect(callArgs[6]).toBe(false);        // include_archived param
  });

  it("POST /memories/search reports which leg matched each hybrid result", async () => {
    mockHybridSearchThoughts.mockResolvedValueOnce([
      {
        id: "id-1",
        content: "call 03-5340199",
        metadata: {},
        similarity: 0.41,
        text_rank: 0.0607,
        score: 0.0164,
        matched_by: "text",
        created_at: new Date(),
      },
    ]);

    const res = await app.request("/memories/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "03-5340199" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; results: { matched_by: string }[] };
    expect(body.mode).toBe("hybrid");
    expect(body.results[0]!.matched_by).toBe("text");
  });

  // ─── PUT /memories/:id ─────────────────────────────────────────────

  it("PUT /memories/:id returns updated thought", async () => {
    mockUpdateThought.mockResolvedValueOnce({
      id: "a1b2c3d4-1234-5678-9abc-def012345678",
      content: "updated content",
      metadata: { type: "decision" },
      created_at: new Date(),
    });

    const res = await app.request("/memories/a1b2c3d4-1234-5678-9abc-def012345678", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "updated content" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; id: string };
    expect(body.status).toBe("updated");
    expect(body.id).toBe("a1b2c3d4-1234-5678-9abc-def012345678");
  });

  it("PUT /memories/:id returns 404 when not found", async () => {
    mockUpdateThought.mockRejectedValueOnce(new Error("Thought not found: 00000000-0000-0000-0000-000000000000"));

    const res = await app.request("/memories/00000000-0000-0000-0000-000000000000", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "anything" }),
    });

    expect(res.status).toBe(404);
  });

  it("PUT /memories/:id returns 400 for invalid UUID", async () => {
    const res = await app.request("/memories/not-a-uuid", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "anything" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT /memories/:id returns 400 for empty content", async () => {
    const res = await app.request("/memories/00000000-0000-0000-0000-000000000000", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });

  // ─── DELETE /memories/:id ──────────────────────────────────────────

  it("DELETE /memories/:id returns deletion status", async () => {
    mockDeleteThought.mockResolvedValueOnce({ deleted: true, id: "a1b2c3d4-1234-5678-9abc-def012345678" });

    const res = await app.request("/memories/a1b2c3d4-1234-5678-9abc-def012345678", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("deleted");
  });

  it("DELETE /memories/:id returns 404 when not found", async () => {
    mockDeleteThought.mockResolvedValueOnce({ deleted: false, id: "00000000-0000-0000-0000-000000000000" });

    const res = await app.request("/memories/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });

  it("DELETE /memories/:id returns 400 for invalid UUID", async () => {
    const res = await app.request("/memories/not-a-uuid", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });

  // ─── POST /memories/batch ──────────────────────────────────────────

  it("POST /memories/batch returns array of results", async () => {
    mockBatchInsertThoughts.mockResolvedValueOnce([
      { id: "id-1", content: "thought 1", metadata: {}, project: "proj", created_at: new Date() },
      { id: "id-2", content: "thought 2", metadata: {}, project: "proj", created_at: new Date() },
    ]);

    const res = await app.request("/memories/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        thoughts: [
          { content: "thought 1", metadata: { type: "idea" } },
          { content: "thought 2", metadata: { type: "idea" } },
        ],
        project: "proj",
        source: "plan-forge",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; results: unknown[] };
    expect(body.count).toBe(2);
    expect(body.results).toHaveLength(2);
  });

  it("POST /memories/batch returns 400 for empty array", async () => {
    const res = await app.request("/memories/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thoughts: [] }),
    });
    expect(res.status).toBe(400);
  });

  // ─── GET /stats ────────────────────────────────────────────────────

  it("GET /stats accepts project query param", async () => {
    mockGetThoughtStats.mockResolvedValueOnce({
      total_thoughts: 5,
      types: {},
      top_topics: [],
      top_people: [],
      date_range: { earliest: null, latest: null },
    });

    const res = await app.request("/stats?project=plan-forge");
    expect(res.status).toBe(200);

    // Verify getThoughtStats was called with project
    expect(mockGetThoughtStats).toHaveBeenCalled();
    const callArgs = mockGetThoughtStats.mock.calls[0]!;
    expect(callArgs[1]).toBe("plan-forge");
  });
});

// ─── Dream review ───────────────────────────────────────────────────

describe("GET /dream/proposals/:id", () => {
  const app = createApi();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the rendered proposal", async () => {
    mockLoadProposalReview.mockResolvedValue({
      proposal_id: "p1",
      status: "open",
      expires_at: "2026-08-22T09:00:00.000Z",
      actionable: true,
      items: [{ key: "contradiction:1" }],
    });

    const res = await app.request("/dream/proposals/p1");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ proposal_id: "p1", actionable: true });
    expect(mockLoadProposalReview.mock.calls[0]?.[1]).toBe("p1");
  });

  it("404s on an id that is not a proposal, rather than 500", async () => {
    mockLoadProposalReview.mockResolvedValue(undefined);

    const res = await app.request("/dream/proposals/nope");

    expect(res.status).toBe(404);
  });

  it("does not close or modify the proposal it reads", async () => {
    // The whole point of a separate review call: dream_apply closes a proposal
    // whichever way it is called, so reading one must not go through it.
    mockLoadProposalReview.mockResolvedValue({
      proposal_id: "p1",
      status: "open",
      expires_at: "2026-08-22T09:00:00.000Z",
      actionable: true,
      items: [],
    });

    const res = await app.request("/dream/proposals/p1", { method: "POST" });

    expect(res.status).toBe(404);
  });
});
