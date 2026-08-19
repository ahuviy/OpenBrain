/**
 * Migration 006: dream — retrospective consolidation state.
 *
 * Two tables, both deliberately small.
 *
 * `dream_state` is one row per project holding a watermark. The corpus only
 * grows, so a run that re-examined everything would cost a function of history
 * rather than of activity. `project` is the primary key and cannot be NULL,
 * while `thoughts.project` is nullable — the NULL bucket is stored as '' and
 * every mapping between the two goes through `projectKey()` in
 * src/dream/candidates.ts, so the bucket has exactly one spelling.
 *
 * `dream_proposals` holds the judgments dream will not apply on its own.
 * Contradiction and synthesis are a model's opinion; applying one unreviewed can
 * silently archive a true thought. `items` is JSONB rather than a child table
 * because a proposal is written once, read once, and never queried by its
 * contents — a join would buy nothing.
 *
 * The partial index covers the only hot lookup: "is there an open proposal for
 * this project". Applied and expired rows are dead weight to that query and are
 * excluded from the index rather than from the table, so the history survives.
 * It is UNIQUE because that lookup is singular by design — see the index comment.
 * `project` is NOT NULL DEFAULT '' for the same reason `dream_state.project` is:
 * `project = ''` never matches a NULL, so a raw NULL would be invisible to the
 * very lookup meant to prevent a second open proposal.
 */

const UP = `
CREATE TABLE IF NOT EXISTS dream_state (
    project        TEXT        PRIMARY KEY,
    watermark      TIMESTAMPTZ NOT NULL,
    last_run_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_run_stats JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS dream_proposals (
    id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    project    TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    applied_at TIMESTAMPTZ,
    status     TEXT        NOT NULL DEFAULT 'open',
    items      JSONB       NOT NULL,
    CONSTRAINT dream_proposals_status_known
        CHECK (status IN ('open', 'applied', 'expired', 'superseded'))
);

-- UNIQUE, not just an index: two open proposals for one project let dream_apply
-- resolve an item key like "synthesis:1" against whichever row it happens to
-- pick, applying an item the caller never reviewed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dream_proposals_open
    ON dream_proposals (project)
    WHERE status = 'open';
`;

const DOWN = `
DROP INDEX IF EXISTS idx_dream_proposals_open;
DROP TABLE IF EXISTS dream_proposals;
DROP TABLE IF EXISTS dream_state;
`;

exports.up = async function up(knex) {
  await knex.raw(UP);
};

exports.down = async function down(knex) {
  await knex.raw(DOWN);
};
