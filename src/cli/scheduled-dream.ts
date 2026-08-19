/**
 * The unattended dream run.
 *
 * Nobody is watching this one: it fires from a cron against a one-off machine,
 * so every question it could ask has to be answered here instead. It walks all
 * projects — a bare dream covers only thoughts with no project, and the whole
 * reason to schedule it is that nobody should have to remember that — it never
 * blocks, and it always reports.
 *
 * The dependencies are injected because the decisions worth testing are the
 * unattended ones: keep going after a failure, report which project broke, and
 * never let the notifier's health change what the run says it did.
 */

import type { DreamResult } from "../dream/index.js";
import type { Notification } from "../notify.js";

export interface ScheduledDreamDeps {
  /** Every project to consolidate, `""` being the no-project bucket. */
  listProjects(): Promise<string[]>;
  dream(project: string): Promise<DreamResult>;
  notify(notification: Notification): Promise<void>;
  log(line: string): void;
}

export interface ScheduledDreamRun {
  project: string;
  applied: Record<string, number>;
  proposed: Record<string, number>;
  proposal_id: string | null;
  candidates: number;
}

export interface ScheduledDreamOutcome {
  exitCode: number;
  runs: ScheduledDreamRun[];
  failures: Array<{ project: string; error: string }>;
}

const label = (project: string) => (project === "" ? "(no project)" : project);

function counts(record: Record<string, number>): string {
  const entries = Object.entries(record).filter(([, value]) => value > 0);
  return entries.length === 0 ? "nothing" : entries.map(([key, value]) => `${key} ${value}`).join(", ");
}

function summarise(runs: ScheduledDreamRun[], failures: Array<{ project: string; error: string }>): string {
  const lines: string[] = [];

  for (const run of runs) {
    lines.push(`${label(run.project)}: applied ${counts(run.applied)}; proposed ${counts(run.proposed)}`);
    // The id is the actionable part: these are the judgments the run is not
    // allowed to apply, and they expire.
    if (run.proposal_id) lines.push(`  review: dream_review ${run.proposal_id}`);
  }

  for (const failure of failures) {
    lines.push(`${label(failure.project)}: FAILED — ${failure.error}`);
  }

  return lines.length > 0 ? lines.join("\n") : "Nothing to consolidate.";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runScheduledDream(deps: ScheduledDreamDeps): Promise<ScheduledDreamOutcome> {
  const runs: ScheduledDreamRun[] = [];
  const failures: Array<{ project: string; error: string }> = [];

  let projects: string[] = [];
  try {
    projects = await deps.listProjects();
  } catch (err) {
    // Nothing ran, so there is no per-project failure to report — but silence
    // here is indistinguishable from a cron that stopped firing.
    failures.push({ project: "", error: messageOf(err) });
  }

  for (const project of projects) {
    try {
      const result = await deps.dream(project);
      runs.push({
        project,
        applied: result.applied,
        proposed: result.proposed,
        proposal_id: result.proposal_id,
        candidates: result.candidates,
      });
      deps.log(`[dream] ${label(project)} ok — ${counts(result.applied)}`);
    } catch (err) {
      // One bad project must not cost the others their consolidation: the next
      // run is two days away.
      failures.push({ project, error: messageOf(err) });
      deps.log(`[dream] ${label(project)} failed — ${messageOf(err)}`);
    }
  }

  const failed = failures.length > 0;

  try {
    await deps.notify({
      title: failed ? "Open Brain dream FAILED" : "Open Brain dream complete",
      message: summarise(runs, failures),
      priority: failed ? "urgent" : "default",
      tags: failed ? "rotating_light" : "sparkles",
    });
  } catch (err) {
    // ntfy being down is not a dream failure, and an exit code that said
    // otherwise would send someone looking in the wrong place.
    deps.log(`[dream] notification failed — ${messageOf(err)}`);
  }

  return { exitCode: failed ? 1 : 0, runs, failures };
}
