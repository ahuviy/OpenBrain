/**
 * Migration 005: hybrid search — vector similarity fused with full-text.
 *
 * Cosine similarity is bad at rare literals. A phone number, an arXiv id, a
 * domain, a proper noun in a language the embedder barely covers — all of them
 * live in the content but do not survive the trip through an embedding. That is
 * what an inverted index is for, and Postgres already has one.
 *
 * The generated tsvector concatenates two configurations on purpose:
 *   - 'english' stems, so "disputes" finds "dispute"
 *   - 'simple' does not, so "03-5340199", "gaya.org.il" and Hebrew tokens
 *     survive verbatim (Postgres ships no Hebrew stemmer, and 'english'
 *     would otherwise be the only lens on that text)
 * Both are IMMUTABLE with an explicit regconfig, which a STORED generated
 * column requires.
 *
 * Fusion is Reciprocal Rank Fusion: score = Σ 1/(k + rank) over each list the
 * row appears in. RRF needs no score calibration between the two legs — cosine
 * similarity and ts_rank_cd are not on comparable scales, and any weighted sum
 * of them would be a tuning knob that silently rots.
 *
 * `match_thoughts` is left alone: the pre-write duplicate check wants pure
 * vector similarity with a meaningful threshold, not a fused rank.
 *
 * Knex wraps each migration in a transaction, so no explicit BEGIN/COMMIT.
 */

const UP = `
ALTER TABLE thoughts
    ADD COLUMN IF NOT EXISTS content_tsv tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(content, '')) ||
        to_tsvector('simple',  coalesce(content, ''))
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_thoughts_content_tsv
    ON thoughts USING gin (content_tsv);

-- Dimension-agnostic on purpose: deployments run vector(768) (Ollama) or
-- vector(1536) (OpenRouter/Azure) and an untyped vector parameter accepts both.
CREATE OR REPLACE FUNCTION hybrid_match_thoughts(
    query_embedding  vector,
    query_text       TEXT,
    match_count      INT     DEFAULT 10,
    match_threshold  FLOAT   DEFAULT 0.5,
    filter           JSONB   DEFAULT '{}'::jsonb,
    project_filter   TEXT    DEFAULT NULL,
    include_archived BOOLEAN DEFAULT false,
    user_filter      TEXT    DEFAULT NULL,
    rrf_k            INT     DEFAULT 60,
    candidate_pool   INT     DEFAULT 50
)
RETURNS TABLE (
    id            UUID,
    content       TEXT,
    metadata      JSONB,
    similarity    FLOAT,
    text_rank     FLOAT,
    score         FLOAT,
    matched_by    TEXT,
    created_at    TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
    ts_query tsquery;
BEGIN
    -- websearch_to_tsquery never raises on junk input, unlike to_tsquery.
    -- Both configurations are OR-ed so a stemmed and a verbatim hit both count.
    ts_query := websearch_to_tsquery('english', coalesce(query_text, '')) ||
                websearch_to_tsquery('simple',  coalesce(query_text, ''));

    RETURN QUERY
    WITH visible AS (
        SELECT t.*
        FROM thoughts t
        WHERE t.metadata @> filter
          AND (project_filter IS NULL OR t.project = project_filter)
          AND (include_archived OR t.archived = false)
          AND (user_filter IS NULL OR t.created_by = user_filter)
    ),
    vector_hits AS (
        SELECT
            v.id,
            1 - (v.embedding <=> query_embedding) AS similarity,
            ROW_NUMBER() OVER (ORDER BY v.embedding <=> query_embedding ASC) AS rank
        FROM visible v
        WHERE v.embedding IS NOT NULL
          AND 1 - (v.embedding <=> query_embedding) >= match_threshold
          -- NaN >= anything is TRUE in Postgres, and cosine distance against a
          -- degenerate (all-zero) stored embedding is NaN. Without this bound
          -- one poisoned row would match every query at every threshold.
          AND 1 - (v.embedding <=> query_embedding) <= 1.0
        ORDER BY v.embedding <=> query_embedding ASC
        LIMIT candidate_pool
    ),
    text_hits AS (
        SELECT
            v.id,
            ts_rank_cd(v.content_tsv, ts_query) AS text_rank,
            ROW_NUMBER() OVER (ORDER BY ts_rank_cd(v.content_tsv, ts_query) DESC) AS rank
        FROM visible v
        WHERE ts_query IS NOT NULL
          AND v.content_tsv @@ ts_query
        ORDER BY ts_rank_cd(v.content_tsv, ts_query) DESC
        LIMIT candidate_pool
    ),
    fused AS (
        SELECT
            COALESCE(vh.id, th.id) AS id,
            COALESCE(vh.similarity, 0)::FLOAT AS similarity,
            COALESCE(th.text_rank, 0)::FLOAT AS text_rank,
            (
                COALESCE(1.0 / (rrf_k + vh.rank), 0) +
                COALESCE(1.0 / (rrf_k + th.rank), 0)
            )::FLOAT AS score,
            CASE
                WHEN vh.id IS NOT NULL AND th.id IS NOT NULL THEN 'both'
                WHEN vh.id IS NOT NULL THEN 'semantic'
                ELSE 'text'
            END AS matched_by
        FROM vector_hits vh
        FULL OUTER JOIN text_hits th ON th.id = vh.id
    )
    SELECT
        t.id,
        t.content,
        t.metadata,
        f.similarity,
        f.text_rank,
        f.score,
        f.matched_by,
        t.created_at
    FROM fused f
    JOIN thoughts t ON t.id = f.id
    ORDER BY f.score DESC, t.created_at DESC
    LIMIT match_count;
END;
$$;
`;

const DOWN = `
DROP FUNCTION IF EXISTS hybrid_match_thoughts(vector, TEXT, INT, FLOAT, JSONB, TEXT, BOOLEAN, TEXT, INT, INT);
DROP INDEX IF EXISTS idx_thoughts_content_tsv;
ALTER TABLE thoughts DROP COLUMN IF EXISTS content_tsv;
`;

exports.up = async function up(knex) {
  await knex.raw(UP);
};

exports.down = async function down(knex) {
  await knex.raw(DOWN);
};
