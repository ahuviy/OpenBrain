/**
 * Migration 010: mark which thoughts the brain wrote itself.
 *
 * Synthesis ADDS a thought (see src/dream/ops/synthesis.ts) and archives
 * nothing, so its output lands in the corpus as an ordinary row — and until now
 * nothing distinguished it from something the user actually captured. Two
 * consequences, both silent:
 *
 *   1. The next dream run selects it like any other row. A summary is by
 *      construction the most central text about its own cluster and sits right
 *      beside the sources it was written from, so it is the single row most
 *      likely to be pulled back into that same cluster — and summarised again.
 *      Generation depth is then unbounded, and the specific literals (a ticket
 *      id, a price, a phone number) are the first tokens to fall out at each
 *      pass, because they are the least predictable ones. This is the failure
 *      documented in "Useful Memories Become Faulty When Continuously Updated
 *      by LLMs": raw kept with selective deletion beat every consolidation
 *      scheme tested, and the schemes that lost were the ones whose output fed
 *      their own next input.
 *
 *   2. Pre-write dedupe searches the whole corpus, so a genuinely new capture
 *      that happens to sit near an existing summary is refused as a duplicate
 *      of it. That trades real evidence for a paraphrase of older evidence,
 *      which is the wrong way round.
 *
 * `origin` is generated rather than written, so it cannot drift from the
 * metadata it describes and needs no backfill — existing rows classify
 * themselves the moment the column exists. Same device as `source_file_hash`
 * and `code_hash` in migration 003.
 *
 * The invariant this enables, enforced in code rather than here: dream's
 * generative and destructive operations (merge, contradiction, synthesis) read
 * `captured` rows only. Vocabulary still sweeps everything — it only ever
 * touches metadata tags, never content, so it cannot drift anything.
 */

const UP = `
ALTER TABLE thoughts
    ADD COLUMN IF NOT EXISTS origin TEXT
    GENERATED ALWAYS AS (
        CASE WHEN metadata->'dream'->>'op' IS NULL THEN 'captured' ELSE 'derived' END
    ) STORED;

-- Partial rather than full: every hot path wants the captured side, and the
-- derived rows are a small minority the planner is better off seq-scanning.
CREATE INDEX IF NOT EXISTS idx_thoughts_origin_captured
    ON thoughts (created_at DESC)
    WHERE origin = 'captured';
`;

const DOWN = `
DROP INDEX IF EXISTS idx_thoughts_origin_captured;
ALTER TABLE thoughts DROP COLUMN IF EXISTS origin;
`;

exports.up = async function up(knex) {
  await knex.raw(UP);
};

exports.down = async function down(knex) {
  await knex.raw(DOWN);
};
