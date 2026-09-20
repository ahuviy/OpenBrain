-- How far has the corpus drifted from evidence?
--
-- A synthesis records the ids it was written from in metadata.dream.sources.
-- A synthesis whose sources include another synthesis is two generations from
-- anything the user actually wrote; one of those in ITS sources is three, and
-- so on. Those rows are the least anchored text in the brain and the first
-- place to look for a claim nobody made.
--
-- Read-only. Returns counts and ids, never content.
-- Run before applying migration 010 to see whether the loop already ran, or
-- after, to confirm nothing new is accumulating.

WITH RECURSIVE derived AS (
    SELECT
        id,
        created_at,
        ARRAY(
            SELECT jsonb_array_elements_text(metadata->'dream'->'sources')
        )::uuid[] AS sources
    FROM thoughts
    WHERE metadata->'dream'->>'op' = 'synthesis'
),
depth(id, generation, root) AS (
    -- Generation 1: written only from captured thoughts.
    SELECT d.id, 1, d.id
    FROM derived d
    WHERE NOT EXISTS (
        SELECT 1 FROM derived s WHERE s.id = ANY(d.sources)
    )

    UNION ALL

    -- Generation n+1: one of its sources is itself a synthesis.
    SELECT d.id, dep.generation + 1, dep.root
    FROM derived d
    JOIN depth dep ON dep.id = ANY(d.sources)
    WHERE dep.generation < 20          -- cycle guard; depth should never approach this
)
SELECT
    generation,
    count(*)                       AS thoughts,
    min(created_at)::date          AS first_seen,
    max(created_at)::date          AS last_seen,
    (array_agg(id ORDER BY created_at DESC))[1:5] AS sample_ids
FROM (
    SELECT DISTINCT ON (d.id) d.id, dep.generation, d.created_at
    FROM derived d
    JOIN depth dep ON dep.id = d.id
    ORDER BY d.id, dep.generation DESC   -- deepest path wins
) ranked
GROUP BY generation
ORDER BY generation;

-- Anything with generation >= 2 is a summary of a summary.
-- Expected healthy result after migration 010 + the code change: one row,
-- generation 1. Rows at 2+ predate the fix and are worth reading (and probably
-- archiving) by hand.
