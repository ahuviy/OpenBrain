/**
 * Tests for grouping similarity pairs into clusters.
 */

import { describe, it, expect } from "vitest";

import { clusterByEdges, type SimilarityEdge } from "../cluster.js";

describe("clusterByEdges", () => {
  it("groups a pair whose similarity clears the threshold", () => {
    const edges: SimilarityEdge[] = [{ a: "one", b: "two", similarity: 0.95 }];

    const clusters = clusterByEdges(edges, 0.9);

    expect(clusters).toEqual([["one", "two"]]);
  });

  it("folds a transitive chain into one cluster", () => {
    const edges: SimilarityEdge[] = [
      { a: "one", b: "two", similarity: 0.95 },
      { a: "two", b: "three", similarity: 0.95 },
    ];

    const clusters = clusterByEdges(edges, 0.9);

    expect(clusters).toHaveLength(1);
    expect([...(clusters[0] ?? [])].sort()).toEqual(["one", "three", "two"]);
  });

  it("keeps pairs below the threshold apart", () => {
    const edges: SimilarityEdge[] = [
      { a: "one", b: "two", similarity: 0.95 },
      { a: "three", b: "four", similarity: 0.5 },
    ];

    const clusters = clusterByEdges(edges, 0.9);

    expect(clusters).toEqual([["one", "two"]]);
  });
});
