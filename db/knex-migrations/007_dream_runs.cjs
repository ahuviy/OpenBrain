/**
 * Migration 007: dream_runs — the history of what consolidation did.
 *
 * `dream_state.last_run_stats` holds only the LAST run for a project, and the
 * scheduled run's ntfy push is gone the moment it is read. Neither answers the
 * questions a retro asks: is the blocked-merge rate rising, did that alias sweep
 * touch more rows than expected, has this project failed three runs running.
 *
 * One row per project per run — a handful of rows every two days, so the table
 * is written far more often than it is read and carries no indexes beyond the
 * one lookup that exists: this project's runs, newest first.
 *
 * `actions` is JSONB rather than a child table for the same reason
 * `dream_proposals.items` is: a run's action log is written once, read as a
 * whole, and never queried by its contents. A join would buy nothing and cost a
 * write amplification per merged thought.
 *
 * A failed run is a row too, with `status = 'failed'` and the error text. A
 * history that only records successes cannot tell a project that consolidated
 * cleanly from one whose runs have been dying for a month.
 */

const UP = `
CREATE TABLE IF NOT EXISTS dream_runs (
    id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    project     TEXT        NOT NULL DEFAULT '',
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status      TEXT        NOT NULL,
    dry_run     BOOLEAN     NOT NULL DEFAULT false,
    trigger     TEXT        NOT NULL DEFAULT 'unknown',
    applied     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    proposed    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    skipped     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    actions     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    candidates  INTEGER     NOT NULL DEFAULT 0,
    clusters    INTEGER     NOT NULL DEFAULT 0,
    proposal_id UUID,
    error       TEXT,
    CONSTRAINT dream_runs_status_known CHECK (status IN ('ok', 'failed'))
);

-- The only lookup: this project's runs, newest first. A retro reads a window,
-- never the whole table, and never filters on anything else.
CREATE INDEX IF NOT EXISTS idx_dream_runs_project_started
    ON dream_runs (project, started_at DESC);
`;

const DOWN = `
DROP INDEX IF EXISTS idx_dream_runs_project_started;
DROP TABLE IF EXISTS dream_runs;
`;

exports.up = async function up(knex) {
  await knex.raw(UP);
};

exports.down = async function down(knex) {
  await knex.raw(DOWN);
};
