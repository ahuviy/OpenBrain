/**
 * Tests for the configurable search threshold default.
 */

import { describe, it, expect } from "vitest";

import { getSearchThreshold, DEFAULT_SEARCH_THRESHOLD } from "../search-config.js";

describe("getSearchThreshold", () => {
  it("defaults to the documented value when unset", () => {
    expect(getSearchThreshold({})).toBe(DEFAULT_SEARCH_THRESHOLD);
  });

  it("takes an override from the environment", () => {
    expect(getSearchThreshold({ OPENBRAIN_SEARCH_THRESHOLD: "0.15" })).toBe(0.15);
  });

  it("ignores a value that is not a finite number", () => {
    expect(getSearchThreshold({ OPENBRAIN_SEARCH_THRESHOLD: "loose" })).toBe(
      DEFAULT_SEARCH_THRESHOLD,
    );
  });

  it("ignores a value outside the cosine range rather than returning nothing forever", () => {
    expect(getSearchThreshold({ OPENBRAIN_SEARCH_THRESHOLD: "2" })).toBe(DEFAULT_SEARCH_THRESHOLD);
    expect(getSearchThreshold({ OPENBRAIN_SEARCH_THRESHOLD: "-1" })).toBe(DEFAULT_SEARCH_THRESHOLD);
  });
});
