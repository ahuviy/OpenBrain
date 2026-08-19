/**
 * Tests for pairwise contradiction judgment.
 */

import { describe, it, expect } from "vitest";

import { planContradictionItems, type JudgePair } from "../ops/contradiction.js";
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

const pair: Array<[ThoughtRow, ThoughtRow]> = [[row("a"), row("b")]];

describe("planContradictionItems", () => {
  it("proposes an item when the judge finds a contradiction", async () => {
    const judge: JudgePair = async () => ({
      verdict: "contradicts",
      reason: "one says up, the other down",
      obsolete_id: "a",
    });

    const items = await planContradictionItems(pair, judge);

    expect(items).toHaveLength(1);
    expect(items[0]?.obsolete_id).toBe("a");
  });

  it("does not propose a pair the judge calls independent", async () => {
    // obsolete_id is valid on purpose: only the verdict may reject this pair.
    const judge: JudgePair = async () => ({
      verdict: "independent",
      reason: "unrelated",
      obsolete_id: "a",
    });

    expect(await planContradictionItems(pair, judge)).toEqual([]);
  });

  it("discards a verdict outside the known set", async () => {
    // obsolete_id is valid on purpose: only the whitelist may reject this pair.
    const judge: JudgePair = async () =>
      ({ verdict: "probably-fine", reason: "invented", obsolete_id: "a" }) as never;

    expect(await planContradictionItems(pair, judge)).toEqual([]);
  });

  it("discards a supersedes verdict that names neither thought", async () => {
    const judge: JudgePair = async () => ({
      verdict: "supersedes",
      reason: "stale",
      obsolete_id: "some-other-id",
    });

    expect(await planContradictionItems(pair, judge)).toEqual([]);
  });

  it("skips a pair whose judgment throws and keeps going", async () => {
    const pairs: Array<[ThoughtRow, ThoughtRow]> = [
      [row("a"), row("b")],
      [row("c"), row("d")],
    ];
    const judge: JudgePair = async (x) => {
      if (x.id === "a") throw new Error("provider down");
      return { verdict: "contradicts", reason: "clash", obsolete_id: "c" };
    };

    const items = await planContradictionItems(pairs, judge);

    expect(items).toHaveLength(1);
    expect(items[0]?.a).toBe("c");
  });
});
