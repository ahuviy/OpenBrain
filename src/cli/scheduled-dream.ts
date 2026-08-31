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

import type { BackfillRun } from "../dream/backfill.js";
import type { DreamResult } from "../dream/index.js";
import type { Notification } from "../notify.js";

export interface ScheduledDreamDeps {
  /** Every project to consolidate, `""` being the no-project bucket. */
  listProjects(): Promise<string[]>;
  dream(project: string): Promise<DreamResult>;
  /**
   * One slice of the backward sweep, or undefined when there is none left.
   *
   * Separate from `dream` because the two hands fail independently: a sweep over
   * old thoughts must not cost this project its consolidation of the new ones,
   * which is the run someone is actually waiting on.
   */
  backfill(project: string): Promise<BackfillRun | undefined>;
  notify(notification: Notification): Promise<void>;
  /**
   * Writes a project that threw into the run history. runDream records its own
   * runs, but a run that threw never reached that point — and a history holding
   * only successes is the one that lies.
   */
  recordFailure(project: string, error: string): Promise<void>;
  log(line: string): void;
}

export interface ScheduledBackfill {
  /** The slice's window, for the report: which stretch of history was swept. */
  from: Date;
  until: Date;
  applied: Record<string, number>;
  skipped: Record<string, number>;
  candidates: number;
  /** True when this slice reached the oldest thought and ended the sweep. */
  done: boolean;
}

export interface ScheduledDreamRun {
  project: string;
  applied: Record<string, number>;
  proposed: Record<string, number>;
  /** What the run refused to do — a blocked merge leaves no other trace. */
  skipped: Record<string, number>;
  proposal_id: string | null;
  candidates: number;
  /** Undefined when the sweep is off, finished, or had nothing left to read. */
  backfill?: ScheduledBackfill;
}

export interface ScheduledDreamOutcome {
  exitCode: number;
  runs: ScheduledDreamRun[];
  failures: Array<{ project: string; error: string }>;
}

const label = (project: string) => (project === "" ? "(no project)" : project);

const day = (at: Date) => at.toISOString().slice(0, 10);

function counts(record: Record<string, number>): string {
  const entries = Object.entries(record).filter(([, value]) => value > 0);
  return entries.length === 0 ? "nothing" : entries.map(([key, value]) => `${key} ${value}`).join(", ");
}

function summarise(runs: ScheduledDreamRun[], failures: Array<{ project: string; error: string }>): string {
  const lines: string[] = [];

  for (const run of runs) {
    lines.push(`${label(run.project)}: applied ${counts(run.applied)}; proposed ${counts(run.proposed)}`);
    // A merge the judge blocked with contradiction off leaves no proposal and
    // no applied change; without this the notification reads "nothing
    // happened" about a real finding.
    const refused = counts(run.skipped);
    if (refused !== "nothing") lines.push(`  skipped: ${refused}`);
    // The id is the actionable part: these are the judgments the run is not
    // allowed to apply, and they expire.
    if (run.proposal_id) lines.push(`  review: dream_review ${run.proposal_id}`);

    // The sweep is the half nobody sees: it consolidates thoughts written months
    // ago, so a report that only ever spoke about new ones would say "nothing"
    // through an entire backfill.
    const swept = run.backfill;
    if (swept) {
      const finished = swept.done ? ", sweep complete" : "";
      lines.push(
        `  backfill ${day(swept.from)}..${day(swept.until)}: ${swept.candidates} thoughts, applied ${counts(swept.applied)}${finished}`,
      );
      const refusedInSweep = counts(swept.skipped);
      if (refusedInSweep !== "nothing") lines.push(`    skipped: ${refusedInSweep}`);
    }
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
      const run: ScheduledDreamRun = {
        project,
        applied: result.applied,
        proposed: result.proposed,
        skipped: result.skipped,
        proposal_id: result.proposal_id,
        candidates: result.candidates,
      };
      runs.push(run);
      deps.log(`[dream] ${label(project)} ok — ${counts(result.applied)}`);

      // After the forward run, and inside its try: a sweep that throws is a
      // failure of this project's run, but the consolidation of the new thoughts
      // above already happened and is already recorded.
      const swept = await deps.backfill(project);
      if (swept) {
        run.backfill = {
          from: swept.slice.from,
          until: swept.slice.until,
          applied: swept.result.applied,
          skipped: swept.result.skipped,
          candidates: swept.result.candidates,
          done: swept.slice.done,
        };
        deps.log(
          `[dream] ${label(project)} backfill ${day(swept.slice.from)}..${day(swept.slice.until)} — ${counts(swept.result.applied)}`,
        );
      }
    } catch (err) {
      // One bad project must not cost the others their consolidation: the next
      // run is two days away.
      failures.push({ project, error: messageOf(err) });
      deps.log(`[dream] ${label(project)} failed — ${messageOf(err)}`);

      try {
        await deps.recordFailure(project, messageOf(err));
      } catch (recordErr) {
        // Losing the history entry must not lose the failure it was recording.
        deps.log(`[dream] could not record the failure — ${messageOf(recordErr)}`);
      }
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
