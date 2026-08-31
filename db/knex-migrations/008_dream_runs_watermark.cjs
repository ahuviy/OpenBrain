/**
 * Migration 008: the watermark window each dream run actually looked at.
 *
 * `dream_runs` recorded what a run did but never what it was allowed to see, and
 * that is the column that would have exposed the bug it is being added for: for
 * four scheduled runs every project reported one candidate and applied nothing,
 * because the saved watermark was the newest row's stamp truncated to
 * milliseconds and Postgres kept comparing microseconds against it. From the
 * history alone that reads as "a quiet corpus" — indistinguishable from a
 * watermark that has been stuck since August.
 *
 * Nullable rather than defaulted: rows written before this migration did not
 * record a window, and inventing the epoch for them would claim a full-corpus
 * pass that never happened. A failed run has no window either — it threw before
 * one existed.
 */

const UP = `
ALTER TABLE dream_runs
    ADD COLUMN IF NOT EXISTS watermark_from TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS watermark_to   TIMESTAMPTZ;
`;

const DOWN = `
ALTER TABLE dream_runs
    DROP COLUMN IF EXISTS watermark_from,
    DROP COLUMN IF EXISTS watermark_to;
`;

exports.up = async function up(knex) {
  await knex.raw(UP);
};

exports.down = async function down(knex) {
  await knex.raw(DOWN);
};
