/**
 * Database queries for thoughts: insert, search, list, stats.
 * All queries use parameterized SQL (no interpolation).
 */

import type pg from "pg";

// ─── Types ───────────────────────────────────────────────────────────

export interface ThoughtMetadata {
  type?: string;
  topics?: string[];
  people?: string[];
  action_items?: string[];
  dates?: string[];
  source?: string;
  provenance?: {
    origin: string;
    original_id?: string;
    imported_at?: string;
  };
}

export interface ThoughtRow {
  id: string;
  content: string;
  metadata: ThoughtMetadata;
  project?: string | null;
  created_by?: string | null;
  archived?: boolean;
  supersedes?: string | null;
  created_at: Date;
}

export interface SearchResult extends ThoughtRow {
  similarity: number;
}

/** Which retrieval leg surfaced a hybrid result. */
export type MatchedBy = "semantic" | "text" | "both";

export interface HybridSearchResult extends SearchResult {
  /** ts_rank_cd of the full-text leg; 0 when only the vector leg matched. */
  text_rank: number;
  /** Reciprocal-rank-fusion score the ordering is based on. */
  score: number;
  matched_by: MatchedBy;
}

export interface ThoughtStats {
  total_thoughts: number;
  types: Record<string, number>;
  top_topics: [string, number][];
  top_people: [string, number][];
  date_range: { earliest: string | null; latest: string | null };
}

export interface ListFilters {
  type?: string;
  topic?: string;
  person?: string;
  days?: number;
  project?: string;
  created_by?: string;
  include_archived?: boolean;
}

// ─── Insert ──────────────────────────────────────────────────────────

export async function insertThought(
  pool: pg.Pool,
  content: string,
  embedding: number[],
  metadata: ThoughtMetadata,
  project?: string,
  supersedes?: string,
  created_by?: string
): Promise<ThoughtRow> {
  const embeddingStr = `[${embedding.join(",")}]`;

  const { rows } = await pool.query<ThoughtRow>(
    `INSERT INTO thoughts (content, embedding, metadata, project, supersedes, created_by)
     VALUES ($1, $2::vector, $3::jsonb, $4, $5, $6)
     RETURNING id, content, metadata, project, created_by, archived, supersedes, created_at`,
    [content, embeddingStr, JSON.stringify(metadata), project ?? null, supersedes ?? null, created_by ?? null]
  );

  return rows[0]!;
}

// ─── Semantic Search ─────────────────────────────────────────────────

export async function searchThoughts(
  pool: pg.Pool,
  queryEmbedding: number[],
  limit: number = 10,
  threshold: number = 0.5,
  filter: Record<string, unknown> = {},
  project?: string,
  include_archived?: boolean,
  created_by?: string
): Promise<SearchResult[]> {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const { rows } = await pool.query<SearchResult>(
    `SELECT id, content, metadata, similarity, created_at
     FROM match_thoughts($1::vector, $2, $3, $4::jsonb, $5, $6, $7)`,
    [
      embeddingStr,
      threshold,
      limit,
      JSON.stringify(filter),
      project ?? null,
      include_archived ?? false,
      created_by ?? null,
    ]
  );

  return rows;
}

// ─── Hybrid Search ───────────────────────────────────────────────────

/** Postgres "undefined function" — the 005 migration has not been applied. */
const UNDEFINED_FUNCTION = "42883";

/**
 * Semantic search fused with full-text search over the same corpus.
 *
 * Embeddings lose rare literals — phone numbers, arXiv ids, domains, and tokens
 * in a language the embedder barely covers. The full-text leg catches exactly
 * those, and Reciprocal Rank Fusion merges the two rankings without needing
 * their scores to be on a comparable scale.
 *
 * Falls back to pure vector search when the database predates migration 005, so
 * a server deployed ahead of its migration degrades instead of failing.
 */
export async function hybridSearchThoughts(
  pool: pg.Pool,
  queryEmbedding: number[],
  queryText: string,
  limit: number = 10,
  threshold: number = 0.5,
  filter: Record<string, unknown> = {},
  project?: string,
  include_archived?: boolean,
  created_by?: string
): Promise<HybridSearchResult[]> {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  try {
    const { rows } = await pool.query<HybridSearchResult>(
      `SELECT id, content, metadata, similarity, text_rank, score, matched_by, created_at
       FROM hybrid_match_thoughts($1::vector, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        embeddingStr,
        queryText,
        limit,
        threshold,
        JSON.stringify(filter),
        project ?? null,
        include_archived ?? false,
        created_by ?? null,
      ]
    );
    return rows;
  } catch (error) {
    if ((error as { code?: string }).code !== UNDEFINED_FUNCTION) throw error;

    console.warn(
      "[search] hybrid_match_thoughts is missing — run `npm run db:migrate`. Falling back to semantic-only search."
    );
    const semantic = await searchThoughts(
      pool, queryEmbedding, limit, threshold, filter, project, include_archived, created_by
    );
    return semantic.map((r) => ({ ...r, text_rank: 0, score: r.similarity, matched_by: "semantic" as const }));
  }
}

// ─── Filtered List ───────────────────────────────────────────────────

export async function listThoughts(
  pool: pg.Pool,
  filters: ListFilters,
  limit: number = 50
): Promise<ThoughtRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 0;

  if (filters.type) {
    idx++;
    conditions.push(`metadata->>'type' = $${idx}`);
    params.push(filters.type);
  }

  if (filters.topic) {
    idx++;
    conditions.push(`metadata->'topics' ? $${idx}`);
    params.push(filters.topic);
  }

  if (filters.person) {
    idx++;
    conditions.push(`metadata->'people' ? $${idx}`);
    params.push(filters.person);
  }

  if (filters.days) {
    idx++;
    const since = new Date();
    since.setDate(since.getDate() - filters.days);
    conditions.push(`created_at >= $${idx}`);
    params.push(since.toISOString());
  }

  if (filters.project) {
    idx++;
    conditions.push(`project = $${idx}`);
    params.push(filters.project);
  }

  if (filters.created_by) {
    idx++;
    conditions.push(`created_by = $${idx}`);
    params.push(filters.created_by);
  }

  if (!filters.include_archived) {
    conditions.push(`(archived = false OR archived IS NULL)`);
  }

  idx++;
  params.push(limit);

  const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "TRUE";

  const { rows } = await pool.query<ThoughtRow>(
    `SELECT id, content, metadata, created_by, created_at
     FROM thoughts
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    params
  );

  return rows;
}

// ─── Statistics ──────────────────────────────────────────────────────

export async function getThoughtStats(
  pool: pg.Pool,
  project?: string,
  created_by?: string
): Promise<ThoughtStats> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 0;

  if (project) {
    idx++;
    conditions.push(`project = $${idx}`);
    params.push(project);
  }
  if (created_by) {
    idx++;
    conditions.push(`created_by = $${idx}`);
    params.push(created_by);
  }

  const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  // Build the AND clause for joined queries (use t. prefix)
  const joinConditions = [];
  let jIdx = 0;
  if (project) {
    jIdx++;
    joinConditions.push(`t.project = $${jIdx}`);
  }
  if (created_by) {
    jIdx++;
    joinConditions.push(`t.created_by = $${jIdx}`);
  }
  const joinAndClause = joinConditions.length > 0 ? "AND " + joinConditions.join(" AND ") : "";

  // Total count
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM thoughts ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  // Type distribution
  const typeResult = await pool.query<{ thought_type: string; count: string }>(
    `SELECT metadata->>'type' AS thought_type, COUNT(*)::text AS count
     FROM thoughts t
     WHERE TRUE ${joinAndClause}
     GROUP BY metadata->>'type'
     ORDER BY COUNT(*) DESC`,
    params
  );
  const types: Record<string, number> = {};
  for (const row of typeResult.rows) {
    types[row.thought_type ?? "unknown"] = parseInt(row.count, 10);
  }

  // Top topics
  const topicResult = await pool.query<{ topic: string; count: string }>(
    `SELECT topic, COUNT(*)::text AS count
     FROM thoughts t, jsonb_array_elements_text(t.metadata->'topics') AS topic
     WHERE TRUE ${joinAndClause}
     GROUP BY topic
     ORDER BY COUNT(*) DESC
     LIMIT 10`,
    params
  );
  const topTopics: [string, number][] = topicResult.rows.map((r) => [
    r.topic,
    parseInt(r.count, 10),
  ]);

  // Top people
  const peopleResult = await pool.query<{ person: string; count: string }>(
    `SELECT person, COUNT(*)::text AS count
     FROM thoughts t, jsonb_array_elements_text(t.metadata->'people') AS person
     WHERE TRUE ${joinAndClause}
     GROUP BY person
     ORDER BY COUNT(*) DESC
     LIMIT 10`,
    params
  );
  const topPeople: [string, number][] = peopleResult.rows.map((r) => [
    r.person,
    parseInt(r.count, 10),
  ]);

  // Date range
  const rangeResult = await pool.query<{ earliest: Date | null; latest: Date | null }>(
    `SELECT MIN(created_at) AS earliest, MAX(created_at) AS latest FROM thoughts ${whereClause}`,
    params
  );
  const range = rangeResult.rows[0];

  return {
    total_thoughts: total,
    types,
    top_topics: topTopics,
    top_people: topPeople,
    date_range: {
      earliest: range?.earliest?.toISOString() ?? null,
      latest: range?.latest?.toISOString() ?? null,
    },
  };
}

// ─── Update ──────────────────────────────────────────────────────────

export async function updateThought(
  pool: pg.Pool,
  id: string,
  content: string,
  embedding: number[],
  metadata: ThoughtMetadata
): Promise<ThoughtRow> {
  const embeddingStr = `[${embedding.join(",")}]`;

  const { rows, rowCount } = await pool.query<ThoughtRow>(
    `UPDATE thoughts
     SET content = $2, embedding = $3::vector, metadata = $4::jsonb
     WHERE id = $1
     RETURNING id, content, metadata, project, archived, supersedes, created_at`,
    [id, content, embeddingStr, JSON.stringify(metadata)]
  );

  if (!rowCount || rowCount === 0) {
    throw new Error(`Thought not found: ${id}`);
  }

  return rows[0]!;
}

// ─── Delete ──────────────────────────────────────────────────────────

export async function deleteThought(
  pool: pg.Pool,
  id: string
): Promise<{ deleted: boolean; id: string }> {
  // Clear supersedes references pointing to this thought first
  await pool.query(
    `UPDATE thoughts SET supersedes = NULL WHERE supersedes = $1`,
    [id]
  );

  const { rowCount } = await pool.query(
    `DELETE FROM thoughts WHERE id = $1`,
    [id]
  );

  return { deleted: (rowCount ?? 0) > 0, id };
}

// ─── Search by Source / Provenance ───────────────────────────────────

export async function searchThoughtsBySource(
  pool: pg.Pool,
  source: string,
  options: {
    project?: string;
    created_by?: string;
    include_archived?: boolean;
    limit?: number;
  } = {}
): Promise<ThoughtRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 0;

  // Match on metadata.source OR metadata.provenance.origin
  idx++;
  conditions.push(
    `(metadata->>'source' = $${idx} OR metadata->'provenance'->>'origin' = $${idx})`
  );
  params.push(source);

  if (options.project) {
    idx++;
    conditions.push(`project = $${idx}`);
    params.push(options.project);
  }

  if (options.created_by) {
    idx++;
    conditions.push(`created_by = $${idx}`);
    params.push(options.created_by);
  }

  if (!options.include_archived) {
    conditions.push(`(archived = false OR archived IS NULL)`);
  }

  const limit = options.limit ?? 50;
  idx++;
  params.push(limit);

  const whereClause = conditions.join(" AND ");

  const { rows } = await pool.query<ThoughtRow>(
    `SELECT id, content, metadata, project, created_by, archived, supersedes, created_at
     FROM thoughts
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    params
  );

  return rows;
}

// ─── Batch Insert ────────────────────────────────────────────────────

export interface BatchThoughtInput {
  content: string;
  embedding: number[];
  metadata: ThoughtMetadata;
  project?: string;
  created_by?: string;
}

export async function batchInsertThoughts(
  pool: pg.Pool,
  thoughts: BatchThoughtInput[]
): Promise<ThoughtRow[]> {
  const client = await pool.connect();
  const results: ThoughtRow[] = [];

  try {
    await client.query("BEGIN");

    for (const thought of thoughts) {
      const embeddingStr = `[${thought.embedding.join(",")}]`;

      const { rows } = await client.query<ThoughtRow>(
        `INSERT INTO thoughts (content, embedding, metadata, project, created_by)
         VALUES ($1, $2::vector, $3::jsonb, $4, $5)
         RETURNING id, content, metadata, project, created_by, archived, supersedes, created_at`,
        [
          thought.content,
          embeddingStr,
          JSON.stringify(thought.metadata),
          thought.project ?? null,
          thought.created_by ?? null,
        ]
      );

      results.push(rows[0]!);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return results;
}

// ─── Topic Vocabulary ────────────────────────────────────────────────

/**
 * Distinct topic tags already used in the brain, most-used first. Feeds the
 * capture-discipline vocabulary gate, which keeps near-duplicate tags
 * (`markets` / `market-analysis`) from accumulating.
 */
export async function listDistinctTopics(
  pool: pg.Pool,
  project?: string,
  limit: number = 500
): Promise<string[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 0;

  if (project) {
    idx++;
    conditions.push(`t.project = $${idx}`);
    params.push(project);
  }

  idx++;
  params.push(limit);

  const whereClause = conditions.length > 0 ? "AND " + conditions.join(" AND ") : "";

  const { rows } = await pool.query<{ topic: string }>(
    `SELECT topic
     FROM thoughts t, jsonb_array_elements_text(t.metadata->'topics') AS topic
     WHERE TRUE ${whereClause}
     GROUP BY topic
     ORDER BY COUNT(*) DESC
     LIMIT $${idx}`,
    params
  );

  return rows.map((r) => r.topic);
}

// ─── Dream: consolidation state, candidates, proposals ───────────────

/** `ThoughtRow` plus the column the watermark needs. Not folded into
 *  `ThoughtRow` — widening that would ripple through every existing consumer
 *  for the benefit of one caller. */
export interface CandidateRow extends ThoughtRow {
  updated_at: Date;
}

export interface DreamStateRow {
  project: string;
  watermark: Date;
  last_run_at: Date;
}

/**
 * Rows changed since the watermark. Archived rows are excluded: a merge archives
 * its sources, and re-selecting them would re-cluster what was just consolidated.
 */
export async function listCandidatesSince(
  pool: pg.Pool,
  watermark: Date,
  project: string,
  limit: number = 500
): Promise<CandidateRow[]> {
  const { rows } = await pool.query<CandidateRow>(
    `SELECT id, content, metadata, project, created_by, archived, supersedes, created_at, updated_at
     FROM thoughts
     WHERE updated_at > $1
       AND archived = false
       AND embedding IS NOT NULL
       AND COALESCE(project, '') = $2
     ORDER BY updated_at ASC
     LIMIT $3`,
    [watermark, project, limit]
  );

  return rows;
}

/**
 * Loads the watermark and takes a row lock for the duration of the run, so two
 * concurrent dreams on one project cannot both consolidate the same candidates.
 * Locks one row of a per-project table, never `thoughts`.
 */
export async function lockDreamState(
  client: pg.PoolClient,
  project: string,
  epoch: Date
): Promise<DreamStateRow> {
  const { rows } = await client.query<DreamStateRow>(
    `INSERT INTO dream_state (project, watermark)
     VALUES ($1, $2)
     ON CONFLICT (project) DO UPDATE SET project = EXCLUDED.project
     RETURNING project, watermark, last_run_at`,
    [project, epoch]
  );

  const { rows: locked } = await client.query<DreamStateRow>(
    `SELECT project, watermark, last_run_at FROM dream_state WHERE project = $1 FOR UPDATE`,
    [project]
  );

  return locked[0] ?? rows[0]!;
}

export async function saveDreamState(
  client: pg.PoolClient,
  project: string,
  watermark: Date,
  stats: Record<string, unknown>
): Promise<void> {
  await client.query(
    `UPDATE dream_state
     SET watermark = $2, last_run_at = now(), last_run_stats = $3::jsonb
     WHERE project = $1`,
    [project, watermark, JSON.stringify(stats)]
  );
}

/** Writes the canonical row and archives its sources in one transaction: a
 *  canonical whose sources are still live would double every search result. */
export async function insertMergedThought(
  client: pg.PoolClient,
  content: string,
  embedding: number[],
  metadata: ThoughtMetadata,
  project: string | null,
  created_by: string | null,
  supersedes: string,
  sourceIds: string[]
): Promise<ThoughtRow> {
  const { rows } = await client.query<ThoughtRow>(
    `INSERT INTO thoughts (content, embedding, metadata, project, created_by, supersedes)
     VALUES ($1, $2::vector, $3::jsonb, $4, $5, $6)
     RETURNING id, content, metadata, project, created_by, archived, supersedes, created_at`,
    [content, `[${embedding.join(",")}]`, JSON.stringify(metadata), project, created_by, supersedes]
  );

  await client.query(`UPDATE thoughts SET archived = true WHERE id = ANY($1::uuid[])`, [sourceIds]);

  return rows[0]!;
}

export async function archiveThought(client: pg.PoolClient, id: string): Promise<void> {
  await client.query(`UPDATE thoughts SET archived = true WHERE id = $1`, [id]);
}

export async function setSupersedes(
  client: pg.PoolClient,
  id: string,
  supersedes: string
): Promise<void> {
  await client.query(`UPDATE thoughts SET supersedes = $2 WHERE id = $1`, [id, supersedes]);
}

/**
 * Merges keys into `metadata` rather than replacing it: the vocabulary sweep
 * owns `topics` and `people` and must not clobber `source` or `provenance`.
 */
export async function mergeThoughtMetadata(
  pool: pg.Pool,
  id: string,
  patch: Record<string, unknown>
): Promise<void> {
  await pool.query(`UPDATE thoughts SET metadata = metadata || $2::jsonb WHERE id = $1`, [
    id,
    JSON.stringify(patch),
  ]);
}

export interface ProposalRow {
  id: string;
  project: string;
  created_at: Date;
  expires_at: Date;
  status: string;
  items: unknown[];
}

/** Supersedes any open proposal for the project first — the UNIQUE partial
 *  index allows exactly one, and a stale plan must not block a fresh run. */
export async function insertProposal(
  pool: pg.Pool,
  project: string,
  items: unknown[],
  ttlHours: number
): Promise<ProposalRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE dream_proposals SET status = 'superseded' WHERE project = $1 AND status = 'open'`,
      [project]
    );
    const { rows } = await client.query<ProposalRow>(
      `INSERT INTO dream_proposals (project, expires_at, items)
       VALUES ($1, now() + ($2 || ' hours')::interval, $3::jsonb)
       RETURNING id, project, created_at, expires_at, status, items`,
      [project, String(ttlHours), JSON.stringify(items)]
    );
    await client.query("COMMIT");
    return rows[0]!;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function loadProposal(pool: pg.Pool, id: string): Promise<ProposalRow | undefined> {
  const { rows } = await pool.query<ProposalRow>(
    `SELECT id, project, created_at, expires_at, status, items FROM dream_proposals WHERE id = $1`,
    [id]
  );

  return rows[0];
}

export async function setProposalStatus(
  client: pg.PoolClient,
  id: string,
  status: string
): Promise<void> {
  await client.query(
    `UPDATE dream_proposals
     SET status = $2, applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END
     WHERE id = $1`,
    [id, status]
  );
}
