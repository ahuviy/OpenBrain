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

import { describeProposal, referencedThoughtIds, reviewItems, vocabularyAudit } from "../review.js";
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

  it("flags a thought that appears in more than one item", () => {
    // The set that survives the conflict drop can still mention one thought
    // twice — legitimately — and a reviewer accepting item by item would have
    // to diff ids across items by hand to notice.
    const view = describeProposal(
      { ...stored, items: [CONTRADICTION, SYNTHESIS] },
      CORPUS,
      new Date("2026-08-19T00:00:00Z"),
    );

    expect(view.overlaps).toEqual([
      { id: "id-b", keys: ["contradiction:1", "synthesis:1"], obsolete_in: [] },
    ]);
  });

  it("has no overlaps to report when each thought appears once", () => {
    const view = describeProposal(
      { ...stored, items: [CONTRADICTION] },
      CORPUS,
      new Date("2026-08-19T00:00:00Z"),
    );

    expect(view.overlaps).toEqual([]);
  });

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

describe("reviewItems cautions", () => {
  // A contradiction retires a WHOLE thought on the strength of one contradicted
  // section. When the doomed thought is long and multi-topic, accepting it
  // discards unrelated material — the July 7 digest carried rate-cut data, a
  // breadth crack and trigger history alongside the one stale paragraph.
  const long = "x".repeat(4000);

  it("warns when the thought to archive is long enough to hold unrelated material", () => {
    const corpus = [thought("id-a", long), thought("id-b", "short and to the point")];

    const [item] = reviewItems([CONTRADICTION], corpus);

    expect(item).toMatchObject({
      caution: expect.stringContaining("unrelated"),
    });
  });

  it("says nothing when both thoughts are short", () => {
    const [item] = reviewItems([CONTRADICTION], CORPUS);

    expect(item).not.toHaveProperty("caution");
  });

  it("says nothing about a synthesis, which archives nothing", () => {
    const corpus = [thought("id-b", long), thought("id-c", long)];

    expect(reviewItems([SYNTHESIS], corpus)[0]).not.toHaveProperty("caution");
  });
});

describe("vocabularyAudit", () => {
  // Vocabulary and merge apply immediately, with no proposal gate, so they are
  // exactly the operations where an after-the-fact trail matters most. Only
  // merges were reported; a vocabulary rewrite left `applied_items` empty.
  it("reports what changed on which thought, from what to what", () => {
    const before = { topics: ["market-analysis"], people: ["Bert Dohmen"] };

    expect(vocabularyAudit("id-a", before, { topics: ["markets"], people: ["Dohmen"] })).toEqual({
      kind: "vocabulary",
      id: "id-a",
      topics: { from: ["market-analysis"], to: ["markets"] },
      people: { from: ["Bert Dohmen"], to: ["Dohmen"] },
    });
  });

  it("omits the field that did not change", () => {
    const before = { topics: ["markets"], people: ["Dohmen"] };

    expect(vocabularyAudit("id-a", before, { people: ["Bert Dohmen"] })).toEqual({
      kind: "vocabulary",
      id: "id-a",
      people: { from: ["Dohmen"], to: ["Bert Dohmen"] },
    });
  });

  it("treats a thought with no prior tags as an empty list, not a missing one", () => {
    expect(vocabularyAudit("id-a", {}, { topics: ["markets"] })).toEqual({
      kind: "vocabulary",
      id: "id-a",
      topics: { from: [], to: ["markets"] },
    });
  });
});
