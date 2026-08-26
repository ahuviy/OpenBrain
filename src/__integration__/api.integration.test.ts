/**
 * Integration tests for Open Brain REST API.
 *
 * Tests run against a LIVE server — requires the API to be running.
 * Set OPENBRAIN_API_URL env var to point at your deployment.
 *
 * Usage:
 *   # Against local Docker Compose
 *   OPENBRAIN_API_URL=http://localhost:8000 npm run test:integration
 *
 *   # Against K8s / remote
 *   OPENBRAIN_API_URL=https://openbrain.example.com npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

const API_URL = process.env.OPENBRAIN_API_URL ?? "http://localhost:8000";

// IDs captured during tests for cleanup
const createdIds: string[] = [];

// Unique test marker to avoid collisions with real data
const TEST_PROJECT = `__integration-test-${Date.now()}`;
const TEST_USER = "integration-test-bot";

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

// ─── Cleanup ────────────────────────────────────────────────────────

afterAll(async () => {
  // Delete all thoughts created during the test run
  for (const id of createdIds) {
    try {
      await api(`/memories/${id}`, { method: "DELETE" });
    } catch {
      // best-effort cleanup
    }
  }
});

// ─── Health ─────────────────────────────────────────────────────────

describe("Health", () => {
  it("GET /health returns healthy", async () => {
    const { status, body } = await api("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.service).toBe("open-brain-api");
  });
});

// ─── Capture (POST /memories) ───────────────────────────────────────

describe("Capture", () => {
  it("captures a thought with all optional fields", async () => {
    const { status, body } = await api("/memories", {
      method: "POST",
      body: JSON.stringify({
        content: "Decision: Using PostgreSQL with pgvector for semantic search. Reason: self-hosted, supports HNSW indexes.",
        project: TEST_PROJECT,
        created_by: TEST_USER,
        source: "integration-test",
      }),
    });

    expect(status).toBe(200);
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
    expect(body.type).toBeDefined();
    expect(body.project).toBe(TEST_PROJECT);
    expect(body.captured_at).toBeDefined();
    createdIds.push(body.id);
  });

  it("captures a thought with only required fields", async () => {
    const { status, body } = await api("/memories", {
      method: "POST",
      body: JSON.stringify({
        content: "Observation: Minimal capture test — no optional fields.",
      }),
    });

    expect(status).toBe(200);
    expect(body.id).toBeDefined();
    createdIds.push(body.id);
  });

  it("rejects empty content", async () => {
    const { status, body } = await api("/memories", {
      method: "POST",
      body: JSON.stringify({ content: "" }),
    });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("rejects invalid supersedes UUID", async () => {
    const { status } = await api("/memories", {
      method: "POST",
      body: JSON.stringify({ content: "Valid content", supersedes: "not-a-uuid" }),
    });
    expect(status).toBe(400);
  });
});

// ─── Batch Capture (POST /memories/batch) ───────────────────────────

describe("Batch Capture", () => {
  it("captures multiple thoughts in one call", async () => {
    const { status, body } = await api("/memories/batch", {
      method: "POST",
      body: JSON.stringify({
        thoughts: [
          { content: "Pattern: Always add DB indexes before load testing." },
          { content: "Convention: Use kebab-case for API route paths." },
          { content: "Bug: Connection pool exhaustion under concurrent batch inserts." },
        ],
        project: TEST_PROJECT,
        created_by: TEST_USER,
        source: "integration-test-batch",
      }),
    });

    expect(status).toBe(200);
    expect(body.count).toBe(3);
    expect(body.results).toHaveLength(3);
    for (const r of body.results) {
      expect(r.id).toBeDefined();
      expect(r.project).toBe(TEST_PROJECT);
      createdIds.push(r.id);
    }
  });

  it("rejects empty thoughts array", async () => {
    const { status } = await api("/memories/batch", {
      method: "POST",
      body: JSON.stringify({ thoughts: [] }),
    });
    expect(status).toBe(400);
  });

  it("rejects thoughts with empty content", async () => {
    const { status } = await api("/memories/batch", {
      method: "POST",
      body: JSON.stringify({ thoughts: [{ content: "" }] }),
    });
    expect(status).toBe(400);
  });
});

// ─── Search (POST /memories/search) ─────────────────────────────────

describe("Search", () => {
  it("finds captured thoughts by semantic meaning", async () => {
    const { status, body } = await api("/memories/search", {
      method: "POST",
      body: JSON.stringify({
        query: "database indexing performance",
        project: TEST_PROJECT,
        limit: 10,
      }),
    });

    expect(status).toBe(200);
    expect(body.query).toBe("database indexing performance");
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.results[0].similarity).toBeGreaterThan(0);
    expect(body.results[0].content).toBeDefined();
    expect(body.results[0].metadata).toBeDefined();
  });

  it("filters search by created_by", async () => {
    const { status, body } = await api("/memories/search", {
      method: "POST",
      body: JSON.stringify({
        query: "PostgreSQL pgvector semantic search self-hosted",
        project: TEST_PROJECT,
        created_by: TEST_USER,
        threshold: 0.3,
        limit: 10,
      }),
    });

    expect(status).toBe(200);
    // Should find thoughts captured by our test user
    expect(body.count).toBeGreaterThanOrEqual(1);
  });

  it("filters search by type", async () => {
    const { status, body } = await api("/memories/search", {
      method: "POST",
      body: JSON.stringify({
        query: "connection issues",
        project: TEST_PROJECT,
        type: "bug",
        limit: 10,
      }),
    });

    expect(status).toBe(200);
    // Should find our "Bug: Connection pool exhaustion..." thought
    for (const r of body.results) {
      expect(r.metadata.type).toBe("bug");
    }
  });

  it("returns empty results for unrelated query", async () => {
    const { status, body } = await api("/memories/search", {
      method: "POST",
      body: JSON.stringify({
        query: "underwater basket weaving competition",
        project: TEST_PROJECT,
        threshold: 0.9,
        limit: 5,
      }),
    });

    expect(status).toBe(200);
    expect(body.count).toBe(0);
  });

  it("rejects empty query", async () => {
    const { status } = await api("/memories/search", {
      method: "POST",
      body: JSON.stringify({ query: "" }),
    });
    expect(status).toBe(400);
  });
});

// ─── List (POST /memories/list) ─────────────────────────────────────

describe("List", () => {
  it("lists thoughts filtered by project", async () => {
    const { status, body } = await api("/memories/list", {
      method: "POST",
      body: JSON.stringify({ project: TEST_PROJECT }),
    });

    expect(status).toBe(200);
    expect(body.count).toBeGreaterThanOrEqual(4); // 1 capture + 3 batch
    for (const r of body.results) {
      expect(r.id).toBeDefined();
      expect(r.content).toBeDefined();
      expect(r.created_at).toBeDefined();
    }
  });

  it("lists thoughts filtered by created_by", async () => {
    const { status, body } = await api("/memories/list", {
      method: "POST",
      body: JSON.stringify({
        project: TEST_PROJECT,
        created_by: TEST_USER,
      }),
    });

    expect(status).toBe(200);
    expect(body.count).toBeGreaterThanOrEqual(1);
    for (const r of body.results) {
      expect(r.created_by).toBe(TEST_USER);
    }
  });

  it("returns created_by in list results", async () => {
    const { status, body } = await api("/memories/list", {
      method: "POST",
      body: JSON.stringify({ project: TEST_PROJECT }),
    });

    expect(status).toBe(200);
    // At least some results should have created_by set
    const withUser = body.results.filter((r: any) => r.created_by === TEST_USER);
    expect(withUser.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Stats (GET /stats) ─────────────────────────────────────────────

describe("Stats", () => {
  it("returns stats for a project", async () => {
    const { status, body } = await api(`/stats?project=${TEST_PROJECT}`);

    expect(status).toBe(200);
    expect(body.total_thoughts).toBeGreaterThanOrEqual(4);
    expect(body.types).toBeDefined();
    expect(body.top_topics).toBeDefined();
    expect(body.top_people).toBeDefined();
    expect(body.date_range).toBeDefined();
    expect(body.date_range.earliest).toBeDefined();
    expect(body.date_range.latest).toBeDefined();
  });

  it("returns stats filtered by created_by", async () => {
    const { status, body } = await api(
      `/stats?project=${TEST_PROJECT}&created_by=${TEST_USER}`
    );

    expect(status).toBe(200);
    expect(body.total_thoughts).toBeGreaterThanOrEqual(1);
  });

  it("returns zero for nonexistent project", async () => {
    const { status, body } = await api("/stats?project=__nonexistent__");

    expect(status).toBe(200);
    expect(body.total_thoughts).toBe(0);
  });
});

// ─── Update (PUT /memories/:id) ─────────────────────────────────────

describe("Update", () => {
  it("updates a thought and re-extracts metadata", async () => {
    const id = createdIds[0]!;

    const { status, body } = await api(`/memories/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        content: "Updated decision: Confirmed PostgreSQL with pgvector after load testing 50k vectors. Sub-10ms p99 latency.",
      }),
    });

    expect(status).toBe(200);
    expect(body.status).toBe("updated");
    expect(body.id).toBe(id);
    expect(body.content).toContain("50k vectors");
  });

  it("preserves curated topics through a content-only edit", async () => {
    const { body: created } = await api("/memories", {
      method: "POST",
      body: JSON.stringify({
        content: "Cars4Rent booking wh9744 is paid in cash at pickup, not by card.",
        type: "task",
        topics: ["car-rental", "georgia"],
        project: TEST_PROJECT,
        new_topics: true,
      }),
    });
    createdIds.push(created.id);
    expect(created.topics).toEqual(["car-rental", "georgia"]);

    const { status, body } = await api(`/memories/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({
        content: "Cars4Rent booking wh9744 is paid in cash at pickup; a card adds 3.5%.",
      }),
    });

    expect(status).toBe(200);
    expect(body.topics).toEqual(["car-rental", "georgia"]);
    expect(body.type).toBe("task");

    // And it is the stored row that changed, not just the response.
    const { body: listed } = await api("/memories/list", {
      method: "POST",
      body: JSON.stringify({ project: TEST_PROJECT }),
    });
    const stored = listed.results.find((r: any) => r.id === created.id);
    expect(stored.metadata.topics).toEqual(["car-rental", "georgia"]);
    expect(stored.metadata.type).toBe("task");
  });

  it("replaces topics when the edit asks for it", async () => {
    const { body: created } = await api("/memories", {
      method: "POST",
      body: JSON.stringify({
        content: "Tire condition on the rental: front tires perished, dry-rot cracking.",
        type: "bug",
        topics: ["car-rental"],
        project: TEST_PROJECT,
        new_topics: true,
      }),
    });
    createdIds.push(created.id);

    const { status, body } = await api(`/memories/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({
        content: "Tire condition on the rental: front tires perished, replaced at the depot.",
        topics: ["Tire Safety"],
        new_topics: true,
      }),
    });

    expect(status).toBe(200);
    expect(body.topics).toEqual(["tire-safety"]);
  });

  it("stamps updated_at at the edit, not at the capture", async () => {
    const { body: created } = await api("/memories", {
      method: "POST",
      body: JSON.stringify({
        content: "Edit-stamp probe: the retention window for audit rows is ninety days.",
        type: "reference",
        project: TEST_PROJECT,
      }),
    });
    createdIds.push(created.id);

    const { status, body } = await api(`/memories/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({
        content: "Edit-stamp probe: the retention window for audit rows is one hundred and eighty days.",
      }),
    });

    expect(status).toBe(200);
    expect(new Date(body.updated_at).getTime()).toBeGreaterThan(
      new Date(created.captured_at).getTime()
    );
  });

  it("returns 404 for nonexistent thought", async () => {
    const { status } = await api("/memories/00000000-0000-0000-0000-000000000000", {
      method: "PUT",
      body: JSON.stringify({ content: "anything" }),
    });
    expect(status).toBe(404);
  });

  it("returns 400 for invalid UUID", async () => {
    const { status } = await api("/memories/not-a-uuid", {
      method: "PUT",
      body: JSON.stringify({ content: "anything" }),
    });
    expect(status).toBe(400);
  });

  it("returns 400 for empty content", async () => {
    const id = createdIds[0]!;
    const { status } = await api(`/memories/${id}`, {
      method: "PUT",
      body: JSON.stringify({ content: "" }),
    });
    expect(status).toBe(400);
  });
});

// ─── Delete (DELETE /memories/:id) ──────────────────────────────────

describe("Delete", () => {
  it("deletes a thought", async () => {
    // Create a throwaway thought just for deletion
    const { body: created } = await api("/memories", {
      method: "POST",
      body: JSON.stringify({
        content: "Throwaway thought for delete test.",
        project: TEST_PROJECT,
      }),
    });
    const throwawayId = created.id;

    const { status, body } = await api(`/memories/${throwawayId}`, {
      method: "DELETE",
    });

    expect(status).toBe(200);
    expect(body.status).toBe("deleted");
    expect(body.id).toBe(throwawayId);

    // Verify it's gone — list should not include it
    const { body: listBody } = await api("/memories/list", {
      method: "POST",
      body: JSON.stringify({ project: TEST_PROJECT }),
    });
    const ids = listBody.results.map((r: any) => r.id);
    expect(ids).not.toContain(throwawayId);
  });

  it("returns 404 for nonexistent thought", async () => {
    const { status } = await api(
      "/memories/00000000-0000-0000-0000-000000000000",
      { method: "DELETE" }
    );
    expect(status).toBe(404);
  });

  it("returns 400 for invalid UUID", async () => {
    const { status } = await api("/memories/not-a-uuid", {
      method: "DELETE",
    });
    expect(status).toBe(400);
  });
});

// ─── Full Lifecycle ─────────────────────────────────────────────────

describe("Full Lifecycle", () => {
  it("capture → search → update → search again → delete", async () => {
    // 1. Capture
    const { body: captured } = await api("/memories", {
      method: "POST",
      body: JSON.stringify({
        content: "Architecture: Using event sourcing with Kafka for the order service.",
        project: TEST_PROJECT,
        created_by: "lifecycle-test",
      }),
    });
    expect(captured.id).toBeDefined();
    const id = captured.id;

    // 2. Search — should find it
    const { body: searched } = await api("/memories/search", {
      method: "POST",
      body: JSON.stringify({
        query: "event sourcing order service",
        project: TEST_PROJECT,
        created_by: "lifecycle-test",
      }),
    });
    expect(searched.count).toBeGreaterThanOrEqual(1);
    const found = searched.results.some((r: any) =>
      r.content.includes("event sourcing")
    );
    expect(found).toBe(true);

    // 3. Update
    const { body: updated } = await api(`/memories/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        content: "Architecture: Switched from Kafka to NATS for the order service. Simpler ops.",
      }),
    });
    expect(updated.status).toBe("updated");

    // 4. Search again — should find updated content
    const { body: searched2 } = await api("/memories/search", {
      method: "POST",
      body: JSON.stringify({
        query: "NATS messaging order service",
        project: TEST_PROJECT,
      }),
    });
    const foundUpdated = searched2.results.some((r: any) =>
      r.content.includes("NATS")
    );
    expect(foundUpdated).toBe(true);

    // 5. Delete
    const { body: deleted } = await api(`/memories/${id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe("deleted");
  });
});
