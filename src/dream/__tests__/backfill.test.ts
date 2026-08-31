/**
 * Tests for the backward-moving hand.
 *
 * The forward watermark only ever moves forward, so everything it settles is
 * behind it for ever — including every thought written before a consolidation
 * rule existed. These are the decisions that let a run reach back there without
 * the cost of a full-corpus pass on every run.
 */

import { describe, it, expect, vi } from "vitest";

import { planBackfill, runBackfillSlice, type BackfillState } from "../backfill.js";
import type { DreamPort, DreamResult } from "../index.js";

const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);
const fresh: BackfillState = { cursor: null, done: false };

describe("planBackfill", () => {
  const watermark = at("2026-08-31T00:00:00Z");
  const oldest = at("2026-05-01T00:00:00Z");

  it("starts at the watermark, which is where the forward hand stopped looking", () => {
    // Everything above the watermark belongs to the forward run. Starting the
    // sweep any higher would pay to re-consolidate what was just consolidated.
    const slice = planBackfill(fresh, watermark, oldest, 30 * DAY);

    expect(slice?.until).toEqual(watermark);
    expect(slice?.from).toEqual(at("2026-08-01T00:00:00Z"));
    expect(slice?.done).toBe(false);
  });

  it("resumes from the cursor, so each run reads a different stretch", () => {
    const slice = planBackfill({ cursor: at("2026-08-01T00:00:00Z"), done: false }, watermark, oldest, 30 * DAY);

    expect(slice?.until).toEqual(at("2026-08-01T00:00:00Z"));
    expect(slice?.from).toEqual(at("2026-07-02T00:00:00Z"));
  });

  it("stops one millisecond below the oldest thought, not at it", () => {
    // `from` is exclusive: landing ON the oldest row would skip the very
    // thought most likely to carry a spelling nothing else in the brain uses.
    const slice = planBackfill({ cursor: at("2026-05-10T00:00:00Z"), done: false }, watermark, oldest, 30 * DAY);

    expect(slice?.from).toEqual(new Date(oldest.getTime() - 1));
    expect(slice?.done).toBe(true);
  });

  it("has nothing left once the cursor has passed the oldest thought", () => {
    expect(planBackfill({ cursor: oldest, done: false }, watermark, oldest, 30 * DAY)).toBeUndefined();
  });

  it("does not sweep a finished project again", () => {
    // Finite by design: a sweep that wrapped would re-embed the whole corpus
    // every few runs for ever. Clearing the columns restarts it deliberately.
    expect(planBackfill({ cursor: at("2026-06-01T00:00:00Z"), done: true }, watermark, oldest, 30 * DAY)).toBeUndefined();
  });

  it("does nothing for an empty project", () => {
    expect(planBackfill(fresh, watermark, undefined, 30 * DAY)).toBeUndefined();
  });

  it("is off at zero, and at a window configured backwards", () => {
    // A negative window would walk FORWARD over the watermark and re-do the
    // forward hand's work, which is worse than not sweeping at all.
    expect(planBackfill(fresh, watermark, oldest, 0)).toBeUndefined();
    expect(planBackfill(fresh, watermark, oldest, -30 * DAY)).toBeUndefined();
  });
});

describe("runBackfillSlice", () => {
  const result = { applied: { merge: 1 } } as unknown as DreamResult;

  function port(state: BackfillState, oldest: Date | undefined = at("2026-05-01T00:00:00Z")) {
    const saved: Array<{ cursor: Date; done: boolean }> = [];
    const stub: Pick<DreamPort, "loadWatermark" | "loadBackfill" | "oldestThought" | "saveBackfill"> = {
      loadWatermark: async () => at("2026-08-31T00:00:00Z"),
      loadBackfill: async () => state,
      oldestThought: async () => oldest,
      saveBackfill: async (_project, cursor, done) => {
        saved.push({ cursor, done });
      },
    };
    return { stub, saved };
  }

  it("consolidates the slice and moves the cursor to its floor", async () => {
    const { stub, saved } = port(fresh);
    const run = vi.fn(async () => result);

    const ran = await runBackfillSlice(stub, "markets", 30 * DAY, run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(ran?.slice.until).toEqual(at("2026-08-31T00:00:00Z"));
    expect(saved).toEqual([{ cursor: at("2026-08-01T00:00:00Z"), done: false }]);
  });

  it("leaves the cursor where it was when the slice throws", async () => {
    // The sweep passes each thought exactly once, so a slice silently skipped
    // is a stretch of history never consolidated. Retried whole instead.
    const { stub, saved } = port(fresh);

    await expect(
      runBackfillSlice(stub, "markets", 30 * DAY, async () => {
        throw new Error("embedder timeout");
      }),
    ).rejects.toThrow("embedder timeout");
    expect(saved).toEqual([]);
  });

  it("runs nothing when there is no slice left", async () => {
    const { stub, saved } = port({ cursor: null, done: true });
    const run = vi.fn(async () => result);

    expect(await runBackfillSlice(stub, "markets", 30 * DAY, run)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("does not read a project's state at all when the sweep is off", async () => {
    const { stub } = port(fresh);
    const run = vi.fn(async () => result);

    expect(await runBackfillSlice(stub, "markets", 0, run)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
});
