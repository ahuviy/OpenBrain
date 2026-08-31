/**
 * Migration 009: dream_state — the backfill cursor.
 *
 * The watermark makes a run cost a function of activity rather than of history,
 * and that is exactly why nothing behind it was ever consolidated: the thoughts
 * that accumulated the mess sit below the watermark, which only ever moves
 * forward. Four days of scheduled runs applied three vocabulary rewrites while a
 * full-corpus pass over one project found sixteen findings sitting untouched.
 *
 * `backfill_cursor` is the second, backward-moving hand: each run consolidates
 * one bounded slice of history ending at the cursor and moves the cursor back by
 * the window. Bounded per run, so a large corpus cannot make one run unaffordable,
 * and resumable, so a failed run costs one slice rather than the whole sweep.
 *
 * NULL means "not started" and the sweep begins at the watermark — the boundary
 * between what the forward hand has already settled and what it never looked at.
 * `backfill_done_at` stamps the run that reached the oldest thought; later runs
 * skip the sweep entirely. Clearing both columns restarts it, which is what to
 * do after changing a consolidation rule that should be applied to old thoughts.
 */

const UP = `
ALTER TABLE dream_state
    ADD COLUMN IF NOT EXISTS backfill_cursor  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS backfill_done_at TIMESTAMPTZ;
`;

const DOWN = `
ALTER TABLE dream_state
    DROP COLUMN IF EXISTS backfill_cursor,
    DROP COLUMN IF EXISTS backfill_done_at;
`;

exports.up = async function up(knex) {
  await knex.raw(UP);
};

exports.down = async function down(knex) {
  await knex.raw(DOWN);
};
