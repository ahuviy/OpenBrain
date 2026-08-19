/**
 * Tests for the retrospective vocabulary sweep.
 */

import { describe, it, expect } from "vitest";

import { planVocabularyChange } from "../ops/vocabulary.js";
import type { ThoughtRow } from "../../db/queries.js";

function row(metadata: Record<string, unknown>): ThoughtRow {
  return {
    id: "row-1",
    content: "Gold broke out",
    metadata,
    project: "markets",
    created_by: "ahuvi",
    archived: false,
    supersedes: null,
    created_at: new Date("2026-08-01T10:00:00Z"),
  } as ThoughtRow;
}

const config = { topicAliases: { fx: "forex" }, personAliases: { bert: "Bert Dohmen" }, selfNames: ["ahuvi"] };

describe("planVocabularyChange", () => {
  it("rewrites a topic through an alias minted after the thought was written", () => {
    const change = planVocabularyChange(row({ topics: ["fx"] }), ["forex"], config);

    expect(change?.topics).toEqual(["forex"]);
  });

  it("collapses a plural onto the singular already in the vocabulary", () => {
    const change = planVocabularyChange(row({ topics: ["markets"] }), ["market"], config);

    expect(change?.topics).toEqual(["market"]);
  });

  it("resolves a person alias and strips the brain owner", () => {
    const change = planVocabularyChange(row({ people: ["bert", "ahuvi"] }), [], config);

    expect(change?.people).toEqual(["Bert Dohmen"]);
  });

  it("returns nothing when the stored vocabulary already matches", () => {
    const change = planVocabularyChange(row({ topics: ["market"], people: [] }), ["market"], config);

    expect(change).toBeUndefined();
  });

  it("treats a missing topics array as empty rather than throwing", () => {
    expect(() => planVocabularyChange(row({}), ["market"], config)).not.toThrow();
  });
});
