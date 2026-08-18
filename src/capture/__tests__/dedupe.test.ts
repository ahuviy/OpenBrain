/**
 * Tests for pre-write duplicate detection.
 */

import { describe, it, expect, vi } from "vitest";

import { findDuplicate, formatDuplicateRejection, type SimilaritySearch } from "../dedupe.js";
import type { SearchResult } from "../../db/queries.js";

function match(similarity: number, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    content: "Gold broke out above 3400",
    metadata: {},
    similarity,
    created_at: new Date("2026-08-01T10:00:00Z"),
    ...overrides,
  } as SearchResult;
}

const options = { enabled: true, threshold: 0.9 };

describe("findDuplicate", () => {
  it("returns the neighbour when similarity clears the threshold", async () => {
    const search: SimilaritySearch = vi.fn(async () => [match(0.94)]);
    const result = await findDuplicate(search, [0.1], options);
    expect(result?.similarity).toBe(0.94);
  });

  it("returns nothing when the closest neighbour is below the threshold", async () => {
    const search: SimilaritySearch = vi.fn(async () => [match(0.72)]);
    expect(await findDuplicate(search, [0.1], options)).toBeUndefined();
  });

  it("ignores a NaN similarity from a degenerate stored embedding", async () => {
    // Postgres compares NaN as greater than every float, so such a row comes
    // back as the "nearest" neighbour for any query. It is not a duplicate.
    const search: SimilaritySearch = vi.fn(async () => [match(NaN)]);
    expect(await findDuplicate(search, [0.1], options)).toBeUndefined();
  });

  it("returns nothing when the brain is empty", async () => {
    const search: SimilaritySearch = vi.fn(async () => []);
    expect(await findDuplicate(search, [0.1], options)).toBeUndefined();
  });

  it("skips the query entirely when the check is disabled", async () => {
    const search: SimilaritySearch = vi.fn(async () => [match(0.99)]);
    expect(await findDuplicate(search, [0.1], { ...options, enabled: false })).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
  });

  it("skips the query when the caller forces the write", async () => {
    const search: SimilaritySearch = vi.fn(async () => [match(0.99)]);
    expect(await findDuplicate(search, [0.1], { ...options, force: true })).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
  });

  it("skips the query when the capture declares what it supersedes", async () => {
    const search: SimilaritySearch = vi.fn(async () => [match(0.99)]);
    const result = await findDuplicate(search, [0.1], { ...options, supersedes: "abc" });
    expect(result).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
  });

  it("scopes the search to the capture's project", async () => {
    const search: SimilaritySearch = vi.fn(async () => []);
    await findDuplicate(search, [0.1], { ...options, project: "mono" });
    expect(search).toHaveBeenCalledWith([0.1], 0.9, "mono");
  });

  it("searches the whole brain when the capture names no project", async () => {
    const search: SimilaritySearch = vi.fn(async () => []);
    await findDuplicate(search, [0.1], options);
    expect(search).toHaveBeenCalledWith([0.1], 0.9, undefined);
  });

  it("rounds similarity to three decimals for the caller", async () => {
    const search: SimilaritySearch = vi.fn(async () => [match(0.923456)]);
    expect((await findDuplicate(search, [0.1], options))?.similarity).toBe(0.923);
  });
});

describe("formatDuplicateRejection", () => {
  it("names the existing thought and both ways forward", () => {
    const text = formatDuplicateRejection({
      id: "11111111-2222-3333-4444-555555555555",
      content: "Gold broke out above 3400",
      similarity: 0.94,
      created_at: "2026-08-01T10:00:00.000Z",
    });
    expect(text).toContain("11111111-2222-3333-4444-555555555555");
    expect(text).toContain("update_thought");
    expect(text).toContain("force: true");
  });

  it("truncates a long existing thought", () => {
    const text = formatDuplicateRejection({
      id: "11111111-2222-3333-4444-555555555555",
      content: "x".repeat(400),
      similarity: 0.94,
      created_at: "2026-08-01T10:00:00.000Z",
    });
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(300));
  });
});
