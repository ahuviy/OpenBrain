/**
 * Tests for cluster synthesis.
 */

import { describe, it, expect } from "vitest";

import { buildSynthesisMetadata, planSynthesisItems, type Synthesise } from "../ops/synthesis.js";
import type { ThoughtRow } from "../../db/queries.js";

function row(id: string): ThoughtRow {
  return {
    id,
    content: `content of ${id}`,
    metadata: {},
    project: "markets",
    created_by: "ahuvi",
    archived: false,
    supersedes: null,
    created_at: new Date("2026-08-01T10:00:00Z"),
  } as ThoughtRow;
}

const cluster = [row("a"), row("b"), row("c")];

describe("planSynthesisItems", () => {
  it("proposes a summary carrying every source id", async () => {
    const synthesise: Synthesise = async () => "Gold is trending on macro flows";

    const items = await planSynthesisItems([cluster], synthesise, 3);

    expect(items).toHaveLength(1);
    expect(items[0]?.content).toBe("Gold is trending on macro flows");
    expect(items[0]?.sources).toEqual(["a", "b", "c"]);
  });

  it("ignores a cluster smaller than the minimum", async () => {
    const synthesise: Synthesise = async () => "should never be called";

    expect(await planSynthesisItems([[row("a"), row("b")]], synthesise, 3)).toEqual([]);
  });

  it("discards a summary that came back empty", async () => {
    const synthesise: Synthesise = async () => "   ";

    expect(await planSynthesisItems([cluster], synthesise, 3)).toEqual([]);
  });

  it("skips a cluster whose synthesis throws and keeps going", async () => {
    const clusters = [cluster, [row("d"), row("e"), row("f")]];
    const synthesise: Synthesise = async (contents) => {
      if (contents[0] === "content of a") throw new Error("provider down");
      return "second cluster summary";
    };

    const items = await planSynthesisItems(clusters, synthesise, 3);

    expect(items).toHaveLength(1);
    expect(items[0]?.sources).toEqual(["d", "e", "f"]);
  });
});

describe("buildSynthesisMetadata", () => {
  it("records the sources the summary was written from", () => {
    const metadata = buildSynthesisMetadata(["a", "b", "c"], "2026-08-19T00:00:00.000Z");

    expect(metadata.dream).toEqual({
      op: "synthesis",
      run_at: "2026-08-19T00:00:00.000Z",
      sources: ["a", "b", "c"],
    });
  });

  it("types the summary as an observation with empty extracted fields", () => {
    const metadata = buildSynthesisMetadata(["a"], "2026-08-19T00:00:00.000Z");

    expect(metadata.type).toBe("observation");
    expect(metadata.topics).toEqual([]);
    expect(metadata.people).toEqual([]);
  });
});
