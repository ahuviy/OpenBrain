/**
 * Tests for the unattended dream run.
 *
 * This is the one caller nobody is watching: it runs from a cron on a one-off
 * Fly machine, so anything it cannot decide for itself has to be a decision
 * made here, not a prompt nobody will answer. It never asks, never blocks, and
 * always reports — a scheduled job that fails silently is worse than no job.
 *
 * A bare dream covers only thoughts with no project, which is why this walks
 * every project: the scheduled run exists precisely so nobody has to remember
 * that.
 */

import { describe, it, expect, vi } from "vitest";

import { runScheduledDream, type ScheduledDreamDeps } from "../scheduled-dream.js";
import type { DreamResult } from "../../dream/index.js";
import type { Notification } from "../../notify.js";

function result(overrides: Partial<DreamResult> = {}): DreamResult {
  return {
    applied: {},
    proposed: {},
    proposal_id: null,
    items: [],
    applied_items: [],
    watermark: { from: "1970-01-01T00:00:00.000Z", to: "2026-08-19T00:00:00.000Z" },
    candidates: 0,
    clusters: 0,
    skipped: {},
    ...overrides,
  };
}

function deps(overrides: Partial<ScheduledDreamDeps> = {}): ScheduledDreamDeps {
  return {
    listProjects: async () => ["", "markets"],
    dream: async () => result(),
    notify: vi.fn(async (_notification: Notification) => undefined),
    log: () => undefined,
    ...overrides,
  };
}

describe("runScheduledDream", () => {
  it("consolidates every project, including the no-project bucket", async () => {
    const dream = vi.fn(async (_project: string) => result());

    await runScheduledDream(deps({ dream }));

    expect(dream.mock.calls.map(([project]) => project)).toEqual(["", "markets"]);
  });

  it("succeeds quietly-but-audibly: one notification, normal priority, exit 0", async () => {
    const notify = vi.fn(async (_notification: Notification) => undefined);

    const outcome = await runScheduledDream(deps({
      notify,
      dream: async () => result({ applied: { vocabulary: 2, merge: 1 } }),
    }));

    expect(outcome.exitCode).toBe(0);
    expect(notify).toHaveBeenCalledOnce();
    const [notification] = notify.mock.calls[0]!;
    expect(notification.priority).toBe("default");
    expect(notification.message).toContain("vocabulary");
  });

  it("names the proposals waiting on a human", async () => {
    // The run cannot apply these itself — that is the entire point of the
    // proposal gate — so the notification has to carry the id to review.
    const notify = vi.fn(async (_notification: Notification) => undefined);

    await runScheduledDream(deps({
      listProjects: async () => ["markets"],
      notify,
      dream: async () => result({ proposed: { contradiction: 2 }, proposal_id: "p-1" }),
    }));

    expect(notify.mock.calls[0]![0].message).toContain("p-1");
  });

  it("reports what it refused to do, not just what it did", async () => {
    // With contradiction off, a merge the judge blocked leaves no proposal and
    // no applied change — `skipped` is the only trace, and a notification
    // without it says "nothing happened" about a real finding.
    const notify = vi.fn(async (_notification: Notification) => undefined);

    await runScheduledDream(deps({
      listProjects: async () => ["markets"],
      notify,
      dream: async () => result({ skipped: { merge_contradicts: 2 } }),
    }));

    expect(notify.mock.calls[0]![0].message).toContain("merge_contradicts 2");
  });

  it("keeps going when one project fails, and reports which", async () => {
    // One bad project must not cost the others their consolidation: the next
    // run is two days away.
    const notify = vi.fn(async (_notification: Notification) => undefined);
    const dream = vi.fn(async (project: string) => {
      if (project === "markets") throw new Error("embedder timeout");
      return result({ applied: { merge: 1 } });
    });

    const outcome = await runScheduledDream(deps({ notify, dream }));

    expect(dream).toHaveBeenCalledTimes(2);
    expect(outcome.exitCode).toBe(1);
    const [notification] = notify.mock.calls[0]!;
    expect(notification.priority).toBe("urgent");
    expect(notification.message).toContain("markets");
    expect(notification.message).toContain("embedder timeout");
  });

  it("reports a total failure rather than exiting silently", async () => {
    const notify = vi.fn(async (_notification: Notification) => undefined);

    const outcome = await runScheduledDream(deps({
      listProjects: async () => {
        throw new Error("database unreachable");
      },
      notify,
    }));

    expect(outcome.exitCode).toBe(1);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0].message).toContain("database unreachable");
  });

  it("still notifies when there is nothing to consolidate", async () => {
    // Silence is indistinguishable from a cron that stopped firing.
    const notify = vi.fn(async (_notification: Notification) => undefined);

    const outcome = await runScheduledDream(deps({ listProjects: async () => [], notify }));

    expect(outcome.exitCode).toBe(0);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not let a broken notifier change what the run did", async () => {
    // ntfy being down is not a dream failure, and an exit code that says
    // otherwise would send someone looking in the wrong place.
    const log = vi.fn();

    const outcome = await runScheduledDream(deps({
      notify: async () => {
        throw new Error("ntfy 503");
      },
      log,
    }));

    expect(outcome.exitCode).toBe(0);
    expect(log.mock.calls.flat().join(" ")).toContain("ntfy 503");
  });

  it("reports a project failure even when the notifier is also down", async () => {
    const outcome = await runScheduledDream(deps({
      dream: async () => {
        throw new Error("embedder timeout");
      },
      notify: async () => {
        throw new Error("ntfy 503");
      },
    }));

    expect(outcome.exitCode).toBe(1);
  });

  it("returns a machine-readable summary for the job log", async () => {
    const outcome = await runScheduledDream(deps({
      listProjects: async () => ["markets"],
      dream: async () => result({ applied: { merge: 1 }, candidates: 4 }),
    }));

    expect(outcome.runs).toEqual([
      {
        project: "markets",
        applied: { merge: 1 },
        proposed: {},
        skipped: {},
        proposal_id: null,
        candidates: 4,
      },
    ]);
    expect(outcome.failures).toEqual([]);
  });
});
