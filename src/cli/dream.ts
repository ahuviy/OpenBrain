#!/usr/bin/env node
/**
 * Entry point for the scheduled dream run.
 *
 * Runs on a one-off Fly machine from a cron (.github/workflows/dream.yml) and
 * exits. Everything it decides lives in scheduled-dream.ts, which is tested;
 * this file is the wiring — pool, embedder, port, ntfy — and the exit code.
 *
 * It does NOT go through initializeDatabase: that starts a background migration
 * for a process about to exit, and the long-running app already owns that job.
 *
 * `DREAM_OPS` narrows the operations (e.g. "vocabulary,merge") for a schedule
 * that should not spend judgments on contradictions nobody is reviewing.
 */

import { closePool, getPool } from "../db/connection.js";
import { insertDreamRun, listProjects } from "../db/queries.js";
import { getEmbedder } from "../embedder/index.js";
import { getDisciplineConfig } from "../capture/discipline.js";
import { runDream } from "../dream/index.js";
import { createDreamPort } from "../dream/port.js";
import { getDreamThresholds, getProposalTtlHours } from "../dream/config.js";
import { DREAM_OPS, type DreamOp } from "../dream/constants.js";
import { sendNotification } from "../notify.js";
import { runScheduledDream } from "./scheduled-dream.js";

function requestedOps(raw: string | undefined): DreamOp[] | undefined {
  if (!raw) return undefined;

  const requested = raw.split(",").map((op) => op.trim()).filter(Boolean);
  const unknown = requested.filter((op) => !DREAM_OPS.includes(op as DreamOp));
  if (unknown.length > 0) {
    throw new Error(`DREAM_OPS contains unknown operations: ${unknown.join(", ")}`);
  }

  return requested as DreamOp[];
}

async function main(): Promise<void> {
  const pool = getPool();
  const embedder = getEmbedder();
  const discipline = getDisciplineConfig();
  const ops = requestedOps(process.env.DREAM_OPS);

  const outcome = await runScheduledDream({
    listProjects: () => listProjects(pool),
    dream: (project) =>
      runDream(
        createDreamPort(pool, embedder, getProposalTtlHours()),
        (a, b) =>
          embedder.judgeContradiction({ id: a.id, content: a.content }, { id: b.id, content: b.content }),
        (contents) => embedder.synthesise(contents),
        {
          topicAliases: discipline.topicAliases,
          personAliases: discipline.personAliases,
          selfNames: discipline.selfNames,
        },
        getDreamThresholds(),
        { project, ops, trigger: "schedule" },
        () => new Date(),
      ),
    recordFailure: async (project, error) => {
      await insertDreamRun(pool, {
        project,
        status: "failed",
        dry_run: false,
        trigger: "schedule",
        applied: {},
        proposed: {},
        skipped: {},
        actions: [],
        candidates: 0,
        clusters: 0,
        proposal_id: null,
        error,
        started_at: new Date(),
      });
    },
    notify: async (notification) => {
      await sendNotification(notification);
    },
    log: (line) => console.log(line),
  });

  // Machine-readable, for the job log. The notification is for a human.
  console.log(JSON.stringify({ runs: outcome.runs, failures: outcome.failures }, null, 2));

  await closePool();
  process.exit(outcome.exitCode);
}

main().catch(async (err) => {
  console.error("[dream] fatal", err instanceof Error ? (err.stack ?? err.message) : err);
  await closePool().catch(() => undefined);
  process.exit(1);
});
