import { describe, expect, it } from "vitest";

import { isCaptured, isDerived } from "../origin.js";

const row = (metadata: unknown) => ({ metadata }) as never;

describe("isDerived", () => {
  it("marks a synthesis as derived", () => {
    expect(isDerived(row({ dream: { op: "synthesis", run_at: "2026-01-01", sources: ["a"] } }))).toBe(true);
  });

  it("marks any dream-authored op as derived, not just synthesis", () => {
    // The guard is the presence of an op, not its value: a future op that also
    // writes a row must be excluded without anyone remembering to add it here.
    expect(isDerived(row({ dream: { op: "some-future-op" } }))).toBe(true);
  });

  it("treats an ordinary capture as captured", () => {
    expect(isCaptured(row({ type: "observation", topics: ["prism"] }))).toBe(true);
  });

  it("treats a merged canonical as captured", () => {
    // Merge concatenates sources deterministically rather than paraphrasing, so
    // its output is still evidence and stays eligible as dream input.
    expect(isCaptured(row({ type: "note", merged_from: ["a", "b"] }))).toBe(true);
  });

  it("does not trip on a dream key that carries no op", () => {
    expect(isDerived(row({ dream: { note: "audit leftover" } }))).toBe(false);
    expect(isDerived(row({ dream: "synthesis" }))).toBe(false);
  });

  it("survives null, missing and non-object metadata", () => {
    expect(isDerived(row(null))).toBe(false);
    expect(isDerived(row(undefined))).toBe(false);
    expect(isDerived(row({}))).toBe(false);
    expect(isDerived(row("not an object"))).toBe(false);
  });
});
