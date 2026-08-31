/**
 * The scheduled run, end to end.
 *
 * Everything below this line has unit tests; what none of them can show is the
 * whole job doing its work — walking every project, consolidating what arrived,
 * sweeping a slice of the history the watermark left behind, and saying so. The
 * production failure this suite exists for looked fine at every level except
 * this one: four runs, thirteen projects, "applied nothing" every time, and a
 * watermark that had not moved since August.
 *
 * Two levels of acceptance here. The first drives `runScheduledDream` in process
 * against a real Postgres, so the orchestration and the SQL are exercised
 * together. The second runs the actual cron entry point — `dist/cli/dream.js`,
 * the file the workflow invokes — as a subprocess against a fake embedder,
 * because the wiring in that file (which port, which ops, which window) is
 * exactly what no in-process test can vouch for.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type pg from "pg";

import { runScheduledDream } from "../cli/scheduled-dream.js";
import { runDream } from "../dream/index.js";
import { runBackfillSlice } from "../dream/backfill.js";
import { createDreamPort } from "../dream/port.js";
import { getDreamThresholds } from "../dream/config.js";
import { insertDreamRun, insertThought, listProjects, type ThoughtRow } from "../db/queries.js";
import type { Notification } from "../notify.js";
import type { Embedder } from "../embedder/types.js";
import { connectTestDatabase, isDatabaseReachable, testEmbedding, type TestDatabase } from "./helpers/database.js";

const DAY = 24 * 60 * 60 * 1000;

const stubEmbedder: Embedder = {
  generateEmbedding: async (text) => testEmbedding(text.length),
  extractMetadata: async () => ({ type: "observation", topics: [], people: [], action_items: [], dates: [] }),
  judgeContradiction: async () => ({ verdict: "independent", reason: "stub" }),
  synthesise: async () => "stub summary",
};

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)("the scheduled run, against a real database", () => {
  let database: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    database = await connectTestDatabase();
    pool = database.pool;
  });

  afterAll(async () => {
    await database?.close();
  });

  /** Seeds a thought and backdates it, bypassing the trigger that stamps now(). */
  async function seedAged(content: string, project: string, ageDays: number): Promise<string> {
    const row = await insertThought(
      pool,
      content,
      testEmbedding(content.length),
      { people: ["Bert Dohmen"] } as unknown as ThoughtRow["metadata"],
      project,
      undefined,
      "ahuvi",
    );
    await pool.query("ALTER TABLE thoughts DISABLE TRIGGER set_updated_at");
    await pool.query(
      `UPDATE thoughts SET updated_at = now() - ($2 || ' days')::interval,
                           created_at = now() - ($2 || ' days')::interval
       WHERE id = $1`,
      [row.id, String(ageDays)],
    );
    await pool.query("ALTER TABLE thoughts ENABLE TRIGGER set_updated_at");
    return row.id;
  }

  function schedule(notifications: Notification[], windowMs = 30 * DAY) {
    const port = createDreamPort(pool, stubEmbedder, 72);
    const consolidate = (options: Parameters<typeof runDream>[5]) =>
      runDream(
        port,
        async () => ({ verdict: "independent", reason: "stub" }),
        async () => "stub summary",
        { topicAliases: {}, personAliases: {}, selfNames: [] },
        getDreamThresholds(),
        options,
        () => new Date(),
      );

    return runScheduledDream({
      listProjects: () => listProjects(pool),
      dream: (project) => consolidate({ project, ops: ["vocabulary", "merge"], trigger: "schedule" }),
      backfill: (project) =>
        runBackfillSlice(port, project, windowMs, (slice) =>
          consolidate({
            project,
            ops: ["vocabulary", "merge"],
            since: slice.from,
            until: slice.until,
            trigger: "schedule-backfill",
          }),
        ),
      recordFailure: async (project, error) => {
        await insertDreamRun(pool, {
          project, status: "failed", dry_run: false, trigger: "schedule",
          applied: {}, proposed: {}, skipped: {}, actions: [],
          candidates: 0, clusters: 0, proposal_id: null, error,
          started_at: new Date(), watermark_from: null, watermark_to: null,
        });
      },
      notify: async (notification) => {
        notifications.push(notification);
      },
      log: () => undefined,
    });
  }

  it("walks every project, consolidates the new, and sweeps back through the old", async () => {
    await database.truncate();

    // A corpus like the real one: a little written this week, most of it months
    // old and behind the watermark for ever.
    await seedAged("this week in the markets", "markets", 0);
    await seedAged("a spring note about the markets", "markets", 100);
    await seedAged("a note with no project at all", "", 100);

    const notifications: Notification[] = [];
    const outcome = await schedule(notifications);

    expect(outcome.exitCode).toBe(0);
    // Every project, the no-project bucket included: a bare dream covers only
    // the latter, which is the whole reason this job exists.
    expect(outcome.runs.map((run) => run.project).sort()).toEqual(["", "markets"]);
    expect(outcome.failures).toEqual([]);

    // Both hands ran for both projects, and the history says which was which.
    const { rows: runs } = await pool.query<{ project: string; trigger: string }>(
      `SELECT project, trigger FROM dream_runs ORDER BY project, trigger`,
    );
    expect(runs).toEqual([
      { project: "", trigger: "schedule" },
      { project: "", trigger: "schedule-backfill" },
      { project: "markets", trigger: "schedule" },
      { project: "markets", trigger: "schedule-backfill" },
    ]);

    // And the report names the stretch of history swept, or a quiet corpus and
    // a stalled sweep read identically.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.message).toMatch(/backfill \d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}/);
  });

  it("walks the sweep further back on every run until it is finished", async () => {
    await database.truncate();
    // A hundred days of history and a ten-day window: the sweep cannot finish in
    // one run, which is the case a single-run test would miss entirely — and the
    // case that matters, because a cursor that failed to move would stall on the
    // same slice for ever while every run still reported doing work.
    for (const age of [100, 60, 30, 5]) {
      await seedAged(`a note ${age} days old about the markets`, "markets", age);
    }

    const notifications: Notification[] = [];
    const cursorAfterEachRun: Array<Date | null> = [];
    let done = false;
    for (let run = 0; run < 20 && !done; run += 1) {
      await schedule(notifications, 10 * DAY);
      const { rows } = await pool.query<{ cursor: Date | null; done: Date | null }>(
        `SELECT backfill_cursor AS cursor, backfill_done_at AS done FROM dream_state WHERE project = 'markets'`,
      );
      cursorAfterEachRun.push(rows[0]!.cursor);
      done = rows[0]!.done !== null;
    }

    expect(done).toBe(true);
    // Several runs, not one: the sweep is bounded per run by design.
    expect(cursorAfterEachRun.length).toBeGreaterThan(3);
    // Strictly backwards, every run, and the slices tile: no run repeats the one
    // before it, which is what makes the sweep finite.
    const times = cursorAfterEachRun.map((cursor) => cursor!.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(new Set(times).size).toBe(times.length);

    // A finished sweep stays finished: no further runs, no re-embedding.
    const before = (await pool.query(`SELECT count(*) FROM dream_runs WHERE trigger = 'schedule-backfill'`)).rows[0];
    await schedule(notifications, 10 * DAY);
    const after = (await pool.query(`SELECT count(*) FROM dream_runs WHERE trigger = 'schedule-backfill'`)).rows[0];
    expect(after).toEqual(before);
  });

  it("consolidates old thoughts no forward run would ever have looked at", async () => {
    // The point of the whole exercise. Two duplicates written three months ago,
    // with the watermark already past them: without the sweep they are behind it
    // permanently, and the schedule reports "applied nothing" for ever.
    await database.truncate();
    await seedAged("aaaaaaaaaaaaaaaaaaaa", "markets", 100);
    await seedAged("bbbbbbbbbbbbbbbbbbbb", "markets", 100);

    const port = createDreamPort(pool, stubEmbedder, 72);
    await port.loadWatermark("markets");
    await port.saveWatermark("markets", new Date(), {});

    const notifications: Notification[] = [];
    let merged = 0;
    for (let run = 0; run < 6 && merged === 0; run += 1) {
      const outcome = await schedule(notifications, 30 * DAY);
      merged += outcome.runs.reduce((total, run) => total + (run.backfill?.applied.merge ?? 0), 0);
      // The forward hand never sees them, run after run.
      expect(outcome.runs.every((forward) => forward.candidates === 0)).toBe(true);
    }

    expect(merged).toBe(1);
    const { rows: live } = await pool.query<{ project: string; created_by: string }>(
      `SELECT project, created_by FROM thoughts WHERE archived = false`,
    );
    expect(live).toEqual([{ project: "markets", created_by: "ahuvi" }]);
  });

  it("keeps consolidating the other projects when one of them fails", async () => {
    // The next run is two days away. One project's bad slice must not cost the
    // rest their consolidation, and the failure has to reach the history.
    await database.truncate();
    await seedAged("a note about the markets", "markets", 10);
    await seedAged("a note with no project", "", 10);

    const notifications: Notification[] = [];
    const port = createDreamPort(pool, stubEmbedder, 72);
    const outcome = await runScheduledDream({
      listProjects: () => listProjects(pool),
      dream: async (project) => {
        if (project === "markets") throw new Error("embedder timeout");
        return runDream(
          port,
          async () => ({ verdict: "independent", reason: "stub" }),
          async () => "stub summary",
          { topicAliases: {}, personAliases: {}, selfNames: [] },
          getDreamThresholds(),
          { project, ops: ["vocabulary"], trigger: "schedule" },
          () => new Date(),
        );
      },
      backfill: async () => undefined,
      recordFailure: async (project, error) => {
        await insertDreamRun(pool, {
          project, status: "failed", dry_run: false, trigger: "schedule",
          applied: {}, proposed: {}, skipped: {}, actions: [],
          candidates: 0, clusters: 0, proposal_id: null, error,
          started_at: new Date(), watermark_from: null, watermark_to: null,
        });
      },
      notify: async (notification) => {
        notifications.push(notification);
      },
      log: () => undefined,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.runs.map((run) => run.project)).toEqual([""]);
    expect(notifications[0]!.priority).toBe("urgent");

    const { rows } = await pool.query<{ project: string; status: string; error: string | null }>(
      `SELECT project, status, error FROM dream_runs ORDER BY status`,
    );
    expect(rows).toEqual([
      { project: "markets", status: "failed", error: "embedder timeout" },
      { project: "", status: "ok", error: null },
    ]);
  });
});

/**
 * The cron entry point itself.
 *
 * `.github/workflows/dream.yml` runs `node /app/dist/cli/dream.js` inside the
 * deployed machine. Nothing else in the suite executes that file, so nothing
 * else would notice it wiring the wrong port, reading the wrong environment, or
 * exiting zero on a failure — and nobody is watching when it runs.
 */
const built = existsSync("dist/cli/dream.js");

describe.skipIf(!reachable || !built)("the cron entry point", () => {
  const EMBEDDER_PORT = process.env.ACCEPTANCE_EMBEDDER_PORT ?? "11439";
  let embedder: ChildProcess;
  let database: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    database = await connectTestDatabase();
    pool = database.pool;
    embedder = spawn("node", ["scripts/fake-embedder-server.mjs", "--port", EMBEDDER_PORT], {
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fetch(`http://localhost:${EMBEDDER_PORT}/`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("fake embedder never came up");
  });

  afterAll(async () => {
    embedder?.kill();
    await database?.close();
  });

  function runCli(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn("node", ["dist/cli/dream.js"], {
        env: {
          ...process.env,
          EMBEDDER_PROVIDER: "ollama",
          OLLAMA_ENDPOINT: `http://localhost:${EMBEDDER_PORT}`,
          OLLAMA_EMBED_MODEL: "fake",
          OLLAMA_LLM_MODEL: "fake",
          // Unset, so the run's own reporting is a no-op rather than a push to
          // somebody's phone from a test.
          NTFY_URL: "",
          LOG_LEVEL: "error",
          ...env,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
      child.on("close", (code) => resolve({ code, stderr }));
    });
  }

  it("consolidates every project and records both hands, exiting zero", async () => {
    await database.truncate();
    for (const [content, project, age] of [
      ["a fresh note about the markets", "markets", 0],
      ["an old note about the markets", "markets", 100],
      ["an old note with no project", "", 100],
    ] as const) {
      const row = await insertThought(
        pool,
        content,
        testEmbedding(String(content).length),
        {} as ThoughtRow["metadata"],
        project === "" ? undefined : project,
        undefined,
        "ahuvi",
      );
      await pool.query("ALTER TABLE thoughts DISABLE TRIGGER set_updated_at");
      await pool.query(
        `UPDATE thoughts SET updated_at = now() - ($2 || ' days')::interval WHERE id = $1`,
        [row.id, String(age)],
      );
      await pool.query("ALTER TABLE thoughts ENABLE TRIGGER set_updated_at");
    }

    const { code, stderr } = await runCli({ DREAM_OPS: "vocabulary,merge", DREAM_BACKFILL_DAYS: "30" });

    expect(stderr).not.toMatch(/fatal/);
    expect(code).toBe(0);

    const { rows } = await pool.query<{ trigger: string; count: string }>(
      `SELECT trigger, count(*)::text AS count FROM dream_runs GROUP BY trigger ORDER BY trigger`,
    );
    expect(rows).toEqual([
      { trigger: "schedule", count: "2" },
      { trigger: "schedule-backfill", count: "2" },
    ]);

    // The sweep left its place behind for the next run, which is what makes the
    // job resumable rather than a full pass every two days.
    const { rows: state } = await pool.query<{ project: string; cursor: Date | null }>(
      `SELECT project, backfill_cursor AS cursor FROM dream_state ORDER BY project`,
    );
    expect(state).toHaveLength(2);
    expect(state.every((row) => row.cursor instanceof Date)).toBe(true);
  }, 60_000);

  it("refuses to run at all on a typo in its operations, rather than narrowing silently", async () => {
    // A schedule that quietly stopped merging would look exactly like a corpus
    // with nothing to merge — for as long as nobody checked.
    await database.truncate();

    const { code, stderr } = await runCli({ DREAM_BACKFILL_OPS: "vocabluary" });

    expect(code).toBe(1);
    expect(stderr).toMatch(/vocabluary/);
  }, 60_000);

  it("switches the sweep off when the window is zero", async () => {
    await database.truncate();
    const row = await insertThought(pool, "an old note", testEmbedding(11), {} as ThoughtRow["metadata"], "markets", undefined, "ahuvi");
    await pool.query("ALTER TABLE thoughts DISABLE TRIGGER set_updated_at");
    await pool.query(`UPDATE thoughts SET updated_at = now() - interval '100 days' WHERE id = $1`, [row.id]);
    await pool.query("ALTER TABLE thoughts ENABLE TRIGGER set_updated_at");

    const { code } = await runCli({ DREAM_OPS: "vocabulary", DREAM_BACKFILL_DAYS: "0" });

    expect(code).toBe(0);
    const { rows } = await pool.query<{ trigger: string }>(`SELECT DISTINCT trigger FROM dream_runs`);
    expect(rows).toEqual([{ trigger: "schedule" }]);
  }, 60_000);
});

if (!reachable) {
  describe("the scheduled run", () => {
    it.skip("skipped: no Postgres reachable (see README > Integration tests)", () => {});
  });
}
