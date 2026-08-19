/**
 * Tests for run scoping.
 */

import { describe, it, expect } from "vitest";

import { projectKey, nextWatermark, holdBackWatermark, type CandidateRow } from "../candidates.js";

function candidate(updated: string): CandidateRow {
  return {
    id: `row-${updated}`,
    content: "content",
    metadata: {},
    project: "markets",
    created_by: "ahuvi",
    archived: false,
    supersedes: null,
    created_at: new Date("2026-08-01T10:00:00Z"),
    updated_at: new Date(updated),
  } as CandidateRow;
}

describe("projectKey", () => {
  it("maps a null project onto the empty-string bucket", () => {
    expect(projectKey(null)).toBe("");
    expect(projectKey(undefined)).toBe("");
  });

  it("passes a real project through unchanged", () => {
    expect(projectKey("markets")).toBe("markets");
  });
});

describe("nextWatermark", () => {
  const runStart = new Date("2026-08-15T00:00:00Z");
  const slackMs = 60_000;

  it("advances to the newest row observed when it is safely before the run", () => {
    const rows = [candidate("2026-08-10T10:00:00Z"), candidate("2026-08-12T10:00:00Z")];

    const next = nextWatermark(rows, new Date("2026-08-01T00:00:00Z"), runStart, slackMs);

    expect(next.toISOString()).toBe("2026-08-12T10:00:00.000Z");
  });

  it("never advances past the run's commit horizon, even when a row is newer", () => {
    // Stamped during the run: a sibling transaction may have stamped an earlier
    // updated_at and not committed yet, so anything at or after the horizon must
    // stay eligible for the next run.
    const rows = [candidate("2026-08-15T00:00:30Z")];

    const next = nextWatermark(rows, new Date("2026-08-01T00:00:00Z"), runStart, slackMs);

    expect(next.toISOString()).toBe("2026-08-14T23:59:00.000Z");
  });

  it("leaves the watermark alone when nothing changed", () => {
    const current = new Date("2026-08-01T00:00:00Z");

    expect(nextWatermark([], current, runStart, slackMs)).toBe(current);
  });

  it("never moves the watermark backwards", () => {
    const current = new Date("2026-08-20T00:00:00Z");

    expect(nextWatermark([candidate("2026-08-10T10:00:00Z")], current, runStart, slackMs)).toBe(
      current,
    );
  });
});

describe("holdBackWatermark", () => {
  const current = new Date("2026-08-01T00:00:00Z");
  const advanced = new Date("2026-08-10T00:00:00Z");
  const held = (iso: string) => ({ updated_at: new Date(iso) });

  it("leaves the watermark alone when nothing is awaiting review", () => {
    expect(holdBackWatermark(advanced, [], current)).toEqual(advanced);
  });

  it("stops short of the oldest thought sitting in a proposal", () => {
    // A thought marked settled while its proposal is still unreviewed can never
    // be found again: the run that would regenerate the item no longer selects
    // it, and an expired or lost proposal takes the judgment with it.
    const result = holdBackWatermark(advanced, [held("2026-08-05T00:00:00Z")], current);

    expect(result.getTime()).toBeLessThan(new Date("2026-08-05T00:00:00Z").getTime());
    expect(result.getTime()).toBeGreaterThanOrEqual(current.getTime());
  });

  it("never moves the watermark backwards", () => {
    // Held thoughts older than the stored watermark were settled by an earlier
    // run; rewinding would re-examine the whole corpus behind them.
    expect(holdBackWatermark(advanced, [held("2026-07-01T00:00:00Z")], current)).toEqual(current);
  });

  it("holds at the oldest of several", () => {
    const result = holdBackWatermark(
      advanced,
      [held("2026-08-08T00:00:00Z"), held("2026-08-04T00:00:00Z")],
      current,
    );

    expect(result.getTime()).toBeLessThan(new Date("2026-08-04T00:00:00Z").getTime());
  });
});
