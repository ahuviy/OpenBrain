/**
 * Tests for dream tuning read from the environment.
 */

import { describe, it, expect } from "vitest";

import { getDreamThresholds, getProposalTtlHours, DEFAULT_THRESHOLDS } from "../config.js";

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
