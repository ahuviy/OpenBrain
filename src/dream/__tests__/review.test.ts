/**
 * Unit tests for src/dream/review.ts
 *
 * A proposal used to come back as a count and an id: "contradiction: 2". The
 * caller then had to either accept items it had never read, or reject them by
 * omission — a proposal is reviewed exactly once, so there was no third move.
 * Rendering the bodies alongside the keys is what makes the review a decision.
 *
 * The keys here MUST match dream_apply's, so they come from keysFor() rather
 * than from a second numbering scheme that could drift from it.
 */

import { describe, it, expect } from "vitest";

import { describeProposal, referencedThoughtIds, reviewItems } from "../review.js";
import { keysFor, type ProposalItem } from "../proposal.js";
import type { ThoughtRow } from "../../db/queries.js";

function thought(id: string, content: string): ThoughtRow {
  return {
    id,
    content,
    metadata: {},
    created_at: new Date("2026-08-01T00:00:00Z"),
    updated_at: new Date("2026-08-01T00:00:00Z"),
  } as unknown as ThoughtRow;
}

const CONTRADICTION: ProposalItem = {
  kind: "contradiction",
  a: "id-a",
  b: "id-b",
  verdict: "contradicts",
  reason: "b reverses a",
  obsolete_id: "id-a",
};

const SYNTHESIS: ProposalItem = {
  kind: "synthesis",
  content: "Postgres is the default store here.",
  sources: ["id-b", "id-c"],
};

const CORPUS = [
  thought("id-a", "We use MySQL."),
  thought("id-b", "We moved off MySQL to Postgres."),
  thought("id-c", "pgvector needs Postgres."),
];

describe("reviewItems", () => {
  it("renders a contradiction with both thoughts and which one dies", () => {
    const [item] = reviewItems([CONTRADICTION], CORPUS);

    expect(item).toEqual({
      key: "contradiction:1",
      kind: "contradiction",
      verdict: "contradicts",
      reason: "b reverses a",
      obsolete_id: "id-a",
      thoughts: [
        { id: "id-a", content: "We use MySQL.", obsolete: true },
        { id: "id-b", content: "We moved off MySQL to Postgres.", obsolete: false },
      ],
    });
  });

  it("renders a synthesis with the text it would add and the sources behind it", () => {
    const [item] = reviewItems([SYNTHESIS], CORPUS);

    expect(item).toEqual({
      key: "synthesis:1",
      kind: "synthesis",
      content: "Postgres is the default store here.",
      sources: [
        { id: "id-b", content: "We moved off MySQL to Postgres." },
        { id: "id-c", content: "pgvector needs Postgres." },
      ],
    });
  });

  it("uses the same keys dream_apply accepts", () => {
    const items = [CONTRADICTION, SYNTHESIS, CONTRADICTION];

    expect(reviewItems(items, CORPUS).map((item) => item.key)).toEqual(keysFor(items));
  });

  it("marks a thought that no longer exists rather than dropping it", () => {
    // A thought deleted between the run and the review still has to appear: an
    // item whose sources silently shrink reads as a smaller change than it is.
    const [item] = reviewItems([SYNTHESIS], [CORPUS[0]!]);

    expect(item).toMatchObject({
      sources: [
        { id: "id-b", content: null },
        { id: "id-c", content: null },
      ],
    });
  });
});

describe("referencedThoughtIds", () => {
  it("collects every id an item points at, without duplicates", () => {
    // id-b is both half of the contradiction and a synthesis source; a caller
    // fetching these ids should ask for it once.
    expect(referencedThoughtIds([CONTRADICTION, SYNTHESIS])).toEqual(["id-a", "id-b", "id-c"]);
  });

  it("is empty for an empty proposal", () => {
    expect(referencedThoughtIds([])).toEqual([]);
  });
});

describe("describeProposal", () => {
  const stored = {
    id: "d0fb9e42",
    status: "open",
    expires_at: new Date("2026-08-20T00:00:00Z"),
    items: [CONTRADICTION, SYNTHESIS],
  };

  it("renders every item and says the proposal is still actionable", () => {
    const view = describeProposal(stored, CORPUS, new Date("2026-08-19T00:00:00Z"));

    expect(view).toMatchObject({
      proposal_id: "d0fb9e42",
      status: "open",
      expires_at: "2026-08-20T00:00:00.000Z",
      actionable: true,
    });
    expect(view.items.map((item) => item.key)).toEqual(["contradiction:1", "synthesis:1"]);
  });

  it("is not actionable once expired, even while the row still says open", () => {
    // dream_apply expires the row lazily, on the call that finds it stale. A
    // review that reported "open" here would promise a call that then throws.
    const view = describeProposal(stored, CORPUS, new Date("2026-08-21T00:00:00Z"));

    expect(view).toMatchObject({ status: "expired", actionable: false });
  });

  it("is not actionable once already reviewed", () => {
    const view = describeProposal(
      { ...stored, status: "applied" },
      CORPUS,
      new Date("2026-08-19T00:00:00Z"),
    );

    expect(view).toMatchObject({ status: "applied", actionable: false });
  });
});
