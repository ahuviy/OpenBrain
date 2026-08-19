/**
 * Tests for building a canonical thought from a duplicate cluster.
 */

import { describe, it, expect } from "vitest";

import { buildCanonical, canMerge } from "../ops/merge.js";
import type { ThoughtRow } from "../../db/queries.js";

function source(overrides: Partial<ThoughtRow> = {}): ThoughtRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    content: "Gold broke out above 3400",
    metadata: {},
    project: "markets",
    created_by: "ahuvi",
    archived: false,
    supersedes: null,
    created_at: new Date("2026-08-01T10:00:00Z"),
    ...overrides,
  } as ThoughtRow;
}

const RUN_AT = "2026-08-19T00:00:00.000Z";

describe("canMerge", () => {
  it("allows a cluster whose sources agree on project and origin", () => {
    expect(canMerge([source({ id: "a" }), source({ id: "b" })])).toBe(true);
  });

  it("refuses a cluster spanning two projects", () => {
    const sources = [source({ id: "a", project: "markets" }), source({ id: "b", project: "personal" })];

    expect(canMerge(sources)).toBe(false);
  });

  it("refuses a cluster spanning a null and a named project", () => {
    const sources = [source({ id: "a", project: null }), source({ id: "b", project: "markets" })];

    expect(canMerge(sources)).toBe(false);
  });

  it("refuses a cluster spanning two import origins", () => {
    const sources = [
      source({ id: "a", metadata: { provenance: { origin: "notion" } } }),
      source({ id: "b", metadata: { provenance: { origin: "obsidian" } } }),
    ];

    expect(canMerge(sources)).toBe(false);
  });
});

describe("buildCanonical", () => {
  it("keeps the longest content when a shorter source is contained in it", () => {
    const sources = [
      source({ id: "short", content: "Gold broke out" }),
      source({ id: "long", content: "Gold broke out above 3400 on heavy volume" }),
    ];

    const canonical = buildCanonical(sources, RUN_AT);

    expect(canonical.content).toBe("Gold broke out above 3400 on heavy volume");
  });

  it("unions list metadata across sources without duplicating a shared value", () => {
    const sources = [
      source({ id: "a", metadata: { topics: ["gold", "macro"], people: ["Dana"] } }),
      source({ id: "b", metadata: { topics: ["gold", "rates"], people: ["Dana", "Omer"] } }),
    ];

    const canonical = buildCanonical(sources, RUN_AT);

    expect([...(canonical.metadata.topics as string[])].sort()).toEqual(["gold", "macro", "rates"]);
    expect([...(canonical.metadata.people as string[])].sort()).toEqual(["Dana", "Omer"]);
  });

  it("takes the most frequent source type", () => {
    const sources = [
      source({ id: "a", metadata: { type: "observation" } }),
      source({ id: "b", metadata: { type: "decision" } }),
      source({ id: "c", metadata: { type: "decision" } }),
    ];

    const canonical = buildCanonical(sources, RUN_AT);

    expect(canonical.metadata.type).toBe("decision");
  });

  it("breaks a type tie towards the earliest source", () => {
    const sources = [
      source({
        id: "later",
        metadata: { type: "idea" },
        created_at: new Date("2026-08-02T10:00:00Z"),
      }),
      source({
        id: "earlier",
        metadata: { type: "decision" },
        created_at: new Date("2026-08-01T10:00:00Z"),
      }),
    ];

    const canonical = buildCanonical(sources, RUN_AT);

    expect(canonical.metadata.type).toBe("decision");
  });

  it("records every source id in merged_from, oldest first", () => {
    const sources = [
      source({ id: "later", created_at: new Date("2026-08-03T10:00:00Z") }),
      source({ id: "earlier", created_at: new Date("2026-08-01T10:00:00Z") }),
    ];

    const canonical = buildCanonical(sources, RUN_AT);

    expect(canonical.merged_from).toEqual(["earlier", "later"]);
    expect(canonical.supersedes).toBe("earlier");
  });

  it("carries provenance forward so a merged import is not re-imported", () => {
    const sources = [
      source({
        id: "earlier",
        created_at: new Date("2026-08-01T10:00:00Z"),
        metadata: {
          topics: ["gold"],
          source: "notion",
          provenance: { origin: "notion", original_id: "n-1", imported_at: "2026-08-01" },
        },
      }),
      source({ id: "later", created_at: new Date("2026-08-02T10:00:00Z") }),
    ];

    const canonical = buildCanonical(sources, RUN_AT);

    expect(canonical.metadata.source).toBe("notion");
    expect(canonical.metadata.provenance).toEqual({
      origin: "notion",
      original_id: "n-1",
      imported_at: "2026-08-01",
    });
  });

  it("breaks a many-way type tie towards the earliest source, not the first to reach the count", () => {
    const at = (day: number) => new Date(`2026-08-0${day}T10:00:00Z`);
    const sources = [
      source({ id: "a", metadata: { type: "idea" }, created_at: at(1) }),
      source({ id: "b", metadata: { type: "decision" }, created_at: at(2) }),
      source({ id: "c", metadata: { type: "decision" }, created_at: at(3) }),
      source({ id: "d", metadata: { type: "idea" }, created_at: at(4) }),
    ];

    const canonical = buildCanonical(sources, RUN_AT);

    expect(canonical.metadata.type).toBe("idea");
  });

  it("stamps dream provenance into metadata so the lineage survives the single-FK supersedes", () => {
    const sources = [
      source({ id: "earlier", created_at: new Date("2026-08-01T10:00:00Z") }),
      source({ id: "later", created_at: new Date("2026-08-02T10:00:00Z") }),
    ];

    const canonical = buildCanonical(sources, RUN_AT);

    expect(canonical.metadata.dream).toEqual({
      op: "merge",
      run_at: RUN_AT,
      merged_from: ["earlier", "later"],
    });
  });

  it("refuses to build a canonical thought from an empty cluster", () => {
    expect(() => buildCanonical([], RUN_AT)).toThrow(/empty cluster/i);
  });
});
