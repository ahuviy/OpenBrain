-- Migration 003: Add provenance helper columns, indexes, and RPC.
-- Adds generated columns for source_file_hash and code_hash from metadata provenance,
-- partial indexes on those columns, and a match_thoughts_by_source() lookup function.

BEGIN;

-- A. Generated columns on thoughts
ALTER TABLE thoughts
  ADD COLUMN IF NOT EXISTS source_file_hash TEXT
    GENERATED ALWAYS AS (metadata->'provenance'->>'contentHash') STORED;

ALTER TABLE thoughts
  ADD COLUMN IF NOT EXISTS code_hash TEXT
    GENERATED ALWAYS AS (metadata->'provenance'->>'codeHash') STORED;

-- B. Partial indexes
CREATE INDEX IF NOT EXISTS idx_thoughts_source_file_hash
  ON thoughts (source_file_hash)
  WHERE source_file_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_thoughts_code_hash
  ON thoughts (code_hash)
  WHERE code_hash IS NOT NULL;

-- C. RPC match_thoughts_by_source (additive — does NOT touch match_thoughts)
CREATE OR REPLACE FUNCTION match_thoughts_by_source(
    source_hash      TEXT,
    max_count        INT     DEFAULT 25,
    project_filter   TEXT    DEFAULT NULL,
    include_archived BOOLEAN DEFAULT false
)
RETURNS TABLE (
    id         UUID,
    content    TEXT,
    metadata   JSONB,
    project    TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT t.id, t.content, t.metadata, t.project, t.created_by, t.created_at
    FROM thoughts t
    WHERE t.source_file_hash = source_hash
      AND (project_filter IS NULL OR t.project = project_filter)
      AND (include_archived OR t.archived = false)
    ORDER BY t.created_at DESC
    LIMIT max_count;
END;
$$;

COMMIT;
