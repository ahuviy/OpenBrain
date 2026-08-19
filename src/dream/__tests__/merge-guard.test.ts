/**
 * Tests for the semantic screen in front of merge.
 *
 * Merge fires on embedding similarity alone, and cosine distance cannot tell
 * "X is forbidden" from "X is how we do it" — one negation moves a sentence
 * barely at all. Those two sat above the merge threshold and were merged
 * immediately and without review, while the SAME disagreement phrased
 * differently landed below the threshold and went through the proposal gate.
 *
 * So the pairs most in need of review were the ones that skipped it. The screen
 * asks the judge before merging, and anything it cannot clear is held back.
 */

import { describe, it, expect, vi } from "vitest";

import { screenMergeClusters } from "../ops/merge-guard.js";
import type { JudgePair } from "../ops/contradiction.js";
import type { ThoughtRow } from "../../db/queries.js";

function thought(id: string, content: string): ThoughtRow {
  return { id, content, metadata: {} } as unknown as ThoughtRow;
}

const A = thought("a", "Staging deploys must go through the release pipeline.");
const B = thought("b", "Staging deploys are done by running fly deploy from a laptop.");
const C = thought("c", "Staging deploys go through the release pipeline.");

const independent: JudgePair = async () => ({ verdict: "independent", reason: "same claim" });
const contradicts: JudgePair = async (a, b) => ({
  verdict: "contradicts",
  reason: "one forbids what the other prescribes",
  obsolete_id: b.id,
});

describe("screenMergeClusters", () => {
  it("clears a cluster the judge calls independent", async () => {
    const screen = await screenMergeClusters([[A, C]], independent);

    expect(screen.mergeable).toEqual([[A, C]]);
    expect(screen.contradictions).toEqual([]);
    expect(screen.blocked).toBe(0);
  });

  it("blocks the merge and proposes the contradiction instead", async () => {
    const screen = await screenMergeClusters([[A, B]], contradicts);

    expect(screen.mergeable).toEqual([]);
    expect(screen.contradictions).toEqual([
      {
        kind: "contradiction",
        a: "a",
        b: "b",
        verdict: "contradicts",
        reason: "one forbids what the other prescribes",
        obsolete_id: "b",
      },
    ]);
  });

  it("blocks the whole cluster when any pair in it disagrees", async () => {
    // A cluster is merged as a unit: clearing the pairs that agree and merging
    // them anyway would still collapse the disagreement into the survivor.
    const judge: JudgePair = async (a, b) =>
      a.id === "b" || b.id === "b"
        ? { verdict: "contradicts", reason: "clash", obsolete_id: b.id }
        : { verdict: "independent", reason: "same claim" };

    const screen = await screenMergeClusters([[A, B, C]], judge);

    expect(screen.mergeable).toEqual([]);
    expect(screen.contradictions.length).toBeGreaterThan(0);
  });

  it("holds back a cluster it could not judge rather than merging it", async () => {
    // A judge that errors is not evidence of agreement. Merging on a failed
    // check is the exact silent data loss this screen exists to stop.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const judge: JudgePair = async () => {
      throw new Error("provider timeout");
    };

    const screen = await screenMergeClusters([[A, B]], judge);

    expect(screen.mergeable).toEqual([]);
    expect(screen.contradictions).toEqual([]);
    expect(screen.blocked).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it("holds back a verdict it does not recognise", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const judge = (async () => ({ verdict: "maybe", reason: "?" })) as unknown as JudgePair;

    const screen = await screenMergeClusters([[A, B]], judge);

    expect(screen.mergeable).toEqual([]);
    expect(screen.blocked).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it("blocks the merge even when the judge names no usable obsolete id", async () => {
    // Nothing can be proposed without knowing which thought dies, but "these
    // two disagree" is still established — merging them is not an option.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const judge: JudgePair = async () => ({ verdict: "contradicts", reason: "clash" });

    const screen = await screenMergeClusters([[A, B]], judge);

    expect(screen.mergeable).toEqual([]);
    expect(screen.contradictions).toEqual([]);
    expect(screen.blocked).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it("judges each pair once, and stops judging a cluster already blocked", async () => {
    const judge = vi.fn(contradicts);

    await screenMergeClusters([[A, B, C]], judge);

    // Three members are three pairs; the first disagreement settles the cluster.
    expect(judge.mock.calls.length).toBeLessThan(3);
  });

  it("passes a single-thought cluster through without asking", async () => {
    const judge = vi.fn(independent);

    const screen = await screenMergeClusters([[A]], judge);

    expect(screen.mergeable).toEqual([[A]]);
    expect(judge).not.toHaveBeenCalled();
  });
});
