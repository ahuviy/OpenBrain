-- Open Brain Database Schema
-- PostgreSQL 17 + pgvector

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create thoughts table
CREATE TABLE IF NOT EXISTS thoughts (
    id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    content    TEXT        NOT NULL,
    embedding  VECTOR(768),
    metadata   JSONB       DEFAULT '{}'::jsonb,
    project    TEXT,
    created_by TEXT,
    archived   BOOLEAN     DEFAULT false,
    supersedes UUID        REFERENCES thoughts(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Auto-update trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at ON thoughts;
CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON thoughts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- HNSW index for vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_thoughts_embedding
    ON thoughts
    USING hnsw (embedding vector_cosine_ops);

-- GIN index for JSONB metadata queries
CREATE INDEX IF NOT EXISTS idx_thoughts_metadata
    ON thoughts
    USING gin (metadata);

-- B-tree index for date ordering
CREATE INDEX IF NOT EXISTS idx_thoughts_created_at
    ON thoughts (created_at DESC);

-- B-tree index for project scoping
CREATE INDEX IF NOT EXISTS idx_thoughts_project
    ON thoughts(project);

-- B-tree index for user scoping
CREATE INDEX IF NOT EXISTS idx_thoughts_created_by
    ON thoughts(created_by);

-- Partial index for non-archived thoughts
CREATE INDEX IF NOT EXISTS idx_thoughts_archived
    ON thoughts(archived) WHERE archived = false;

-- B-tree index for supersedes chain
CREATE INDEX IF NOT EXISTS idx_thoughts_supersedes
    ON thoughts(supersedes);

-- Semantic search function
CREATE OR REPLACE FUNCTION match_thoughts(
    query_embedding  VECTOR(768),
    match_threshold  FLOAT   DEFAULT 0.5,
    match_count      INT     DEFAULT 10,
    filter           JSONB   DEFAULT '{}'::jsonb,
    project_filter   TEXT    DEFAULT NULL,
    include_archived BOOLEAN DEFAULT false,
    user_filter      TEXT    DEFAULT NULL
)
RETURNS TABLE (
    id         UUID,
    content    TEXT,
    metadata   JSONB,
    similarity FLOAT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        t.id,
        t.content,
        t.metadata,
        1 - (t.embedding <=> query_embedding) AS similarity,
        t.created_at
    FROM thoughts t
    WHERE
        1 - (t.embedding <=> query_embedding) >= match_threshold
        AND t.metadata @> filter
        AND (project_filter IS NULL OR t.project = project_filter)
        AND (include_archived OR t.archived = false)
        AND (user_filter IS NULL OR t.created_by = user_filter)
    ORDER BY t.embedding <=> query_embedding ASC
    LIMIT match_count;
END;
$$;

-- ─── Hybrid search (see db/knex-migrations/005_hybrid_search.cjs) ────────────
-- Full-text leg alongside the vector one: embeddings lose rare literals (phone
-- numbers, ids, domains, tokens in a language the embedder barely covers).
-- Two configurations are concatenated: 'english' stems, 'simple' keeps tokens
-- verbatim. Both are IMMUTABLE, which a STORED generated column requires.

ALTER TABLE thoughts
    ADD COLUMN IF NOT EXISTS content_tsv tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(content, '')) ||
        to_tsvector('simple',  coalesce(content, ''))
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_thoughts_content_tsv
    ON thoughts USING gin (content_tsv);

-- Reciprocal Rank Fusion of the two legs. Untyped `vector` parameter so the
-- same definition serves 768- and 1536-dimension deployments.
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
    id         UUID,
    content    TEXT,
    metadata   JSONB,
    similarity FLOAT,
    text_rank  FLOAT,
    score      FLOAT,
    matched_by TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
    ts_query tsquery;
BEGIN
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
        t.id, t.content, t.metadata,
        f.similarity, f.text_rank, f.score, f.matched_by,
        t.created_at
    FROM fused f
    JOIN thoughts t ON t.id = f.id
    ORDER BY f.score DESC, t.created_at DESC
    LIMIT match_count;
END;
$$;

-- Enable Row Level Security
ALTER TABLE thoughts ENABLE ROW LEVEL SECURITY;
