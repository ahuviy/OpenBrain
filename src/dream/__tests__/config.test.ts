/**
 * Tests for dream tuning read from the environment.
 */

import { describe, it, expect } from "vitest";

import {
  getDreamThresholds,
  getProposalTtlHours,
  getBackfillWindowMs,
  getBackfillOps,
  getDreamOps,
  parseDreamOps,
  DEFAULT_THRESHOLDS,
  DEFAULT_BACKFILL_DAYS,
  DEFAULT_BACKFILL_OPS,
} from "../config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("getDreamThresholds", () => {
  it("falls back to defaults when nothing is set", () => {
    expect(getDreamThresholds({})).toEqual(DEFAULT_THRESHOLDS);
  });

  it("takes an override from the environment", () => {
    expect(getDreamThresholds({ DREAM_MERGE_THRESHOLD: "0.97" }).merge).toBe(0.97);
  });

  it("ignores a value that is not a finite number", () => {
    expect(getDreamThresholds({ DREAM_MERGE_THRESHOLD: "very-high" }).merge).toBe(
      DEFAULT_THRESHOLDS.merge,
    );
  });

  it("refuses a merge threshold below the write-path dedupe threshold", () => {
    // Dream must never consolidate what capture would have let through.
    expect(() => getDreamThresholds({ DREAM_MERGE_THRESHOLD: "0.5" })).toThrow(/dedupe/i);
  });
});

describe("getProposalTtlHours", () => {
  it("defaults when unset and reads an override", () => {
    expect(getProposalTtlHours({})).toBe(72);
    expect(getProposalTtlHours({ DREAM_PROPOSAL_TTL_HOURS: "12" })).toBe(12);
  });
});

describe("getBackfillWindowMs", () => {
  it("defaults to a month of history per run", () => {
    expect(getBackfillWindowMs({})).toBe(DEFAULT_BACKFILL_DAYS * DAY_MS);
  });

  it("takes a window from the environment, in days", () => {
    expect(getBackfillWindowMs({ DREAM_BACKFILL_DAYS: "7" })).toBe(7 * DAY_MS);
  });

  it("reads zero as the sweep being switched off", () => {
    expect(getBackfillWindowMs({ DREAM_BACKFILL_DAYS: "0" })).toBe(0);
  });

  it("reads a negative window as off rather than sweeping forwards", () => {
    // A negative window would walk FORWARD over the watermark and re-consolidate
    // what the forward hand had just done, which is worse than not sweeping.
    expect(getBackfillWindowMs({ DREAM_BACKFILL_DAYS: "-30" })).toBe(0);
  });

  it("falls back to the default when the value is not a number", () => {
    expect(getBackfillWindowMs({ DREAM_BACKFILL_DAYS: "a month" })).toBe(
      DEFAULT_BACKFILL_DAYS * DAY_MS,
    );
  });
});

describe("parseDreamOps", () => {
  it("reads a list, ignoring spacing", () => {
    expect(parseDreamOps("vocabulary, merge")).toEqual(["vocabulary", "merge"]);
  });

  it("refuses an unknown operation instead of quietly dropping it", () => {
    // A typo in a scheduled job's environment would otherwise narrow the run
    // silently, and "stopped merging" looks exactly like "nothing to merge".
    expect(() => parseDreamOps("vocabulary,merg")).toThrow(/merg/);
  });

  it("is undefined for unset, empty, and separators only", () => {
    expect(parseDreamOps(undefined)).toBeUndefined();
    expect(parseDreamOps("")).toBeUndefined();
    expect(parseDreamOps(" , ")).toBeUndefined();
  });
});

describe("getDreamOps and getBackfillOps", () => {
  it("leaves the forward run at every operation when nothing is set", () => {
    expect(getDreamOps({})).toBeUndefined();
  });

  it("keeps the sweep off the proposal path by default", () => {
    // A sweep that proposed would keep superseding the proposal drawn from the
    // newest thoughts with one about history nobody asked to review.
    expect(getBackfillOps({})).toEqual(DEFAULT_BACKFILL_OPS);
    expect(getBackfillOps({})).not.toContain("contradiction");
  });

  it("takes overrides for each hand independently", () => {
    const env = { DREAM_OPS: "vocabulary", DREAM_BACKFILL_OPS: "merge" };

    expect(getDreamOps(env)).toEqual(["vocabulary"]);
    expect(getBackfillOps(env)).toEqual(["merge"]);
  });
});
