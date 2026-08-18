# Dream — retrospective consolidation for the thought store

Status: design. Surveyed against `master` @ `f1871d2`, 2026-08-18.

## 1. Context

`src/capture/dedupe.ts` guards the **write** path: a capture whose cosine similarity to an existing
thought is `>= dedupeThreshold` (default `0.9`) is rejected rather than written twice. It is
deliberately cheap — one extra vector query, reusing the embedding the INSERT already needed.

Nothing guards the corpus **after** the write. Four things accumulate:

- near-duplicates that landed in the `0.80–0.90` band, under the rejection threshold
- thoughts that contradict each other, or that later captures made obsolete
- topic/person vocabulary drift (`market` vs `markets`) in rows written before an alias existed
- clusters of related thoughts with no higher-level statement tying them together

Dream is the retrospective counterpart to `dedupe.ts`.

**Reference pattern:** `src/capture/dedupe.ts` + `src/capture/discipline.ts`. Dream follows both —
narrow injected function types instead of a pool (`SimilaritySearch`), pure functions over
already-fetched rows, config memoised through `getDisciplineConfig()`, and the same resolvers the
write path uses. Deviations are called out inline.

## 2. Scope

In scope: the four operations above, tiered into auto-apply and propose-then-apply.
Out of scope items live in §14 — they are not mentioned anywhere else in this document.

## 3. Authority model

| Operation | Tier | Why |
|---|---|---|
| `vocabulary` | auto | Deterministic. Reuses `resolveTopics` / `resolvePeople`. No LLM. |
| `merge` | auto | Deterministic threshold. Reversible via `archived` + `supersedes`. |
| `contradiction` | propose | LLM judgment. Wrongly archiving a true thought is silent data loss. |
| `synthesis` | propose | LLM generation. Creates new content; must be read before it lands. |

Auto operations apply during the `dream` call. Propose operations are persisted as a proposal and
applied only by a subsequent `dream_apply` call naming the proposal and the accepted items.

## 4. Data model

### 4.1 Migration `006_dream.cjs`

```sql
CREATE TABLE dream_state (
    project        TEXT        PRIMARY KEY,          -- '' is the NULL-project bucket
    watermark      TIMESTAMPTZ NOT NULL,
    last_run_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_run_stats JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE dream_proposals (
    id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    project     TEXT,                                 -- NULL mirrors thoughts.project
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    applied_at  TIMESTAMPTZ,
    status      TEXT        NOT NULL DEFAULT 'open',  -- open | applied | expired | superseded
    items       JSONB       NOT NULL                  -- ProposalItem[]
);

CREATE INDEX idx_dream_proposals_open ON dream_proposals (project, status)
    WHERE status = 'open';
```

`project` is `TEXT PRIMARY KEY` on `dream_state`, so the NULL-project bucket is stored as `''`.
`thoughts.project` is nullable and dream must process those rows (see §6.1) — mapping NULL to `''`
at the state layer keeps the primary key usable. The mapping is applied in exactly one place,
`dream/candidates.ts:projectKey()`.

### 4.2 Typed constants

Every finite set is a typed constant, never a bare string:

```ts
export const DREAM_OPS = ["vocabulary", "merge", "contradiction", "synthesis"] as const;
export type DreamOp = (typeof DREAM_OPS)[number];

export const PROPOSAL_STATUSES = ["open", "applied", "expired", "superseded"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const CONTRADICTION_VERDICTS = ["contradicts", "supersedes", "independent"] as const;
export type ContradictionVerdict = (typeof CONTRADICTION_VERDICTS)[number];
```

### 4.3 Fields on `thoughts` this feature touches

| Column | Read | Written by | Notes |
|---|---|---|---|
| `id` | yes | never | |
| `content` | yes | `merge`, `synthesis` | merge writes merged text; synthesis writes a new row |
| `embedding` | yes | `merge`, `synthesis` | **must be regenerated** whenever `content` changes (§6.2) |
| `metadata` | yes | all four | dream writes under the `metadata.dream` key only (§4.4) |
| `project` | yes | never | dream never moves a thought between projects |
| `created_by` | yes | never | preserved from the canonical source row |
| `archived` | yes | `merge`, `contradiction` | set `true` on superseded sources |
| `supersedes` | yes | `merge`, `contradiction`, `synthesis` | single FK — see §6.2 |
| `created_at` | yes | never | |
| `updated_at` | yes | trigger | `set_updated_at` fires automatically; dream never sets it. **Not exposed on `ThoughtRow`** — see below |

`ThoughtRow` (in `src/db/queries.ts`) does not carry `updated_at`, but the watermark logic in §5
step 7 needs it. The candidates query therefore selects it explicitly and returns a widened row:

```ts
export interface CandidateRow extends ThoughtRow {
  updated_at: Date;
}
```

`ThoughtRow` itself is left unchanged — widening it would ripple through every existing consumer of
`searchThoughts`, `listThoughts` and `hybridSearchThoughts` for the benefit of one caller.

### 4.4 The `metadata.dream` sub-document

Dream never overwrites caller metadata. It writes one reserved key:

```ts
interface DreamProvenance {
  op: DreamOp;
  run_at: string;            // ISO-8601
  merged_from?: string[];    // merge: every source id, including the one in `supersedes`
  sources?: string[];        // synthesis: the cluster this was written from
  verdict?: ContradictionVerdict;
  similarity?: number;       // merge: min pairwise similarity within the cluster
}
```

`metadata.topics` / `.people` / `.type` are rewritten in place by `vocabulary` — those are the
extractor's own fields, and vocabulary's whole job is to correct them.

## 5. Pipeline

```
dream(project?, ops?, dry_run?)
  1 load watermark          dream_state[projectKey]  (missing -> epoch, i.e. first run = full corpus)
  2 candidates              thoughts WHERE updated_at > watermark AND archived = false
  3 neighbour expansion     per candidate: searchThoughts(..., NEIGHBOUR_THRESHOLD)
  4 cluster                 connected components over the pair graph
  5 auto ops                vocabulary, merge          -> applied in a transaction
  6 propose ops             contradiction, synthesis   -> dream_proposals row
  7 advance watermark       to the max(updated_at) observed in step 2, not now()
```

Step 7 uses the observed maximum, not wall-clock: a thought written *during* the run would
otherwise be skipped forever. If step 2 returned nothing, the watermark is left unchanged.

## 6. Operation specifications

### 6.1 `vocabulary` (auto)

Input: every candidate row (neighbours not needed — this is per-row).
Algorithm: run `resolveTopics(row.metadata.topics ?? [], knownTopics, config.topicAliases)` and
`resolvePeople(row.metadata.people ?? [], config.personAliases, config.selfNames)` from
`discipline.ts` — note both take the individual config sub-fields, not the `DisciplineConfig`
object. Each returns a `TopicResolution` / `PeopleResolution` carrying `notes`, which dream discards
(they are written for the capture-time caller, not for a batch sweep). Where the resolved value differs
from the stored value, update `metadata.topics` / `metadata.people`.

`knownTopics` comes from `getTopicVocabulary(pool, project)` in `src/capture/vocabulary.ts` — the
same cached accessor the write path uses, not raw `listDistinctTopics`. It never throws (a failed
lookup returns the stale entry or `[]`), so a vocabulary sweep degrades to a no-op rather than
aborting the run. Its cache key is `project ?? "*"`. Because dream must also
process rows with `project IS NULL`, the vocabulary sweep for the `''` bucket passes `undefined` as
the project filter — matching the warning already documented in `DedupeOptions.project`, that
scoping to a defaulted namespace hides pre-default rows.

No LLM. No embedding change (`content` is untouched, so the vector is still correct).

### 6.2 `merge` (auto)

Input: clusters whose minimum pairwise similarity is `>= MERGE_THRESHOLD` (default `0.94`, above the
`0.90` write-time `dedupeThreshold` so dream is strictly more conservative than the write path).

Merging is **not** a content rewrite of an existing row. It writes a new canonical row and archives
the sources:

1. canonical `content` = longest source content, plus any source content not already a substring,
   joined by `\n\n` — deterministic, no LLM, never discards text
2. `embedding` = `embedder.generateEmbedding(canonical.content)` — **required**, because a stale
   vector would make the merged row unfindable by the very search that produced the cluster
3. `metadata` = union of source topics/people/action_items/dates; `type` = the most frequent source
   type, ties broken by the earliest `created_at`
4. `project`, `created_by` = taken from the earliest source row
5. `supersedes` = the id of the earliest source
6. `metadata.dream.merged_from` = **all** source ids
7. every source row: `archived = true`

Step 5–6 exist because `supersedes` is a single `UUID REFERENCES thoughts(id)` and cannot express an
N-way merge. Rather than change the column (which every existing consumer reads), the FK keeps its
current one-to-one meaning and the full set lives in provenance. Any consumer wanting the complete
lineage reads `metadata.dream.merged_from`.

### 6.3 `contradiction` (propose)

Input: clusters in the `CONTRADICTION_BAND` (`0.80 <= sim < MERGE_THRESHOLD`) — similar enough to be
about the same subject, different enough not to be a duplicate.

For each pair, `embedder.judgeContradiction(a, b)` returns a `ContradictionVerdict` plus a reason.
Only `contradicts` and `supersedes` become proposal items; `independent` is discarded.

Applying an accepted item sets `archived = true` on the losing thought and `supersedes` on the
winner. Nothing is deleted — `delete_thought` exists as a separate explicit tool and dream never
calls it.

### 6.4 `synthesis` (propose)

Input: clusters of `>= MIN_SYNTHESIS_CLUSTER` (default 3) thoughts that produced no merge.

`embedder.synthesise(contents)` returns a summary. The proposal item carries the proposed content and
its source ids. Applying inserts a **new** thought (`type: "observation"`, `metadata.dream.sources` =
cluster ids, `supersedes = NULL`) and leaves every source row untouched and unarchived — synthesis
adds a layer, it does not replace what it summarises.

## 7. Embedder interface change

```ts
export interface ContradictionJudgment {
  verdict: ContradictionVerdict;
  reason: string;
  /** Which id the model considers obsolete. Required iff verdict is "supersedes". */
  obsolete_id?: string;
}

export interface Embedder {
  generateEmbedding(text: string): Promise<number[]>;
  extractMetadata(content: string): Promise<ThoughtMetadataExtracted>;
  judgeContradiction(a: ThoughtRow, b: ThoughtRow): Promise<ContradictionJudgment>;
  synthesise(contents: string[]): Promise<string>;
}
```

**Blast radius** — every implementation must gain both methods:

| File | Change |
|---|---|
| `src/embedder/types.ts` | interface + `ContradictionJudgment` + two prompt constants |
| `src/embedder/ollama.ts` | implement both against the existing chat endpoint |
| `src/embedder/openrouter.ts` | implement both against `chat/completions` |
| `src/embedder/azure-openai.ts` | implement both against the deployment URL |
| `src/embedder/index.ts` | no signature change; re-verify the factory return type |
| test fakes | see §12 |

All three providers already implement `extractMetadata` via chat completion, so both methods follow
an existing call shape rather than introducing a new client.

## 8. MCP tools

Both responses are **objects**, never bare arrays, so fields can be added without breaking consumers.

### `dream`

```ts
{ project?: string; ops?: DreamOp[]; dry_run?: boolean }
```

```jsonc
{
  "applied":  { "vocabulary": 12, "merge": 4 },
  "proposed": { "contradiction": 2, "synthesis": 3 },
  "proposal_id": "uuid-or-null",       // null when nothing was proposed
  "watermark": { "from": "...", "to": "..." },
  "candidates": 37,
  "clusters": 8
}
```

`dry_run: true` runs every read and judgment, applies nothing, persists no proposal, and does not
advance the watermark. `proposal_id` is `null` in that mode.

### `dream_apply`

```ts
{ proposal_id: string; accept: string[] }   // item keys, e.g. "contradiction:1"
```

```jsonc
{ "applied": ["contradiction:1"], "rejected": ["synthesis:2"], "status": "applied" }
```

Items not named in `accept` are rejected, and the proposal moves to `applied` regardless — a
proposal is reviewed exactly once. Re-applying an already-applied proposal is an error (§11).

Both tools return `{ content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }`,
matching every existing tool in `server.ts`.

### 8.3 REST equivalents (required)

`AGENTS.md`: *"every MCP tool has a REST equivalent"*. Dream is no exception — two Hono routes in
`src/api/routes.ts`, alongside the existing nine:

| Route | Body | Returns |
|---|---|---|
| `POST /dream` | `{ project?, ops?, dry_run? }` | the §8.1 object |
| `POST /dream/apply` | `{ proposal_id, accept }` | the §8.2 object |

Both delegate to the identical `src/dream/index.ts` entry point the MCP tools call. Neither
transport owns any dream logic — this follows the existing rule that write-path enforcement lives in
`src/capture/` so it binds on every transport, and for the same reason: a client that skips the
rules must not be able to skip them by choosing a different port.

Validation happens at both boundaries (`ops` values, `accept` keys, `proposal_id` shape) per the
"errors at boundaries only" convention; `src/dream/index.ts` trusts its inputs.

## 9. Concurrency and atomicity

Dream writes multiple rows per logical operation, so each is wrapped in one transaction:

| Unit | Must be atomic | Invariant if the process dies mid-write |
|---|---|---|
| One merge cluster | insert canonical + archive all N sources | Never a canonical row whose sources are still unarchived (they would both surface in search, doubling the result) |
| One vocabulary row | single UPDATE | Trivially atomic |
| Watermark advance | after all auto ops commit | Crash before advance = ops re-run next dream. Re-running is safe: merge re-detects an already-merged cluster as a single archived-excluded row, so it is idempotent |
| One `dream_apply` item | archive + supersedes together | Never an archived thought with no surviving winner |

Two concurrent `dream` runs on the same project are prevented by
`SELECT ... FROM dream_state WHERE project = $1 FOR UPDATE` at step 1, held for the run. A second
run blocks, then observes the advanced watermark and finds no candidates. This is a lock on a
one-row-per-project table, not on `thoughts`.

Dream introduces **no async/fire-and-forget execution** — the MCP call runs to completion before
responding. There is no goroutine-equivalent to synchronise in tests.

## 10. Partial and missing data

| Situation | Behaviour |
|---|---|
| `thoughts.project IS NULL` | Processed under the `''` bucket. Never rewritten to a default. |
| `thoughts.embedding IS NULL` | Excluded from candidates and neighbours. Counted in the response as `skipped_no_embedding`. Cannot cluster without a vector. |
| `metadata` is `{}` | Vocabulary is a no-op for that row. Not an error. |
| `metadata.topics` missing / not an array | Treated as `[]`. Never throws. |
| Cluster of size 1 | No op applies. Not proposed. |
| First run (no `dream_state` row) | Watermark = epoch, so the first dream processes the whole corpus. Documented as intentionally expensive, once. |
| Candidate set empty | Returns zeroed counts, `proposal_id: null`, watermark unchanged. |
| `supersedes` already set on a source | Preserved on that row; the canonical's `supersedes` points at the earliest source regardless. Chains are not collapsed. |

## 11. Failure modes

| Operation | Condition | Expected behaviour |
|---|---|---|
| `searchThoughts` | Postgres unavailable | Run aborts, transaction rolls back, watermark unchanged, tool returns an error. Next run retries the same candidates. |
| `generateEmbedding` (merge) | Embedder errors or times out | That cluster is skipped and counted in `skipped_embed_failed`. Other clusters still commit. Never writes a row with a stale vector. |
| `judgeContradiction` | Embedder errors | Pair skipped, counted in `skipped_judge_failed`, run continues. A failed judgment is not a verdict. |
| `judgeContradiction` | Returns a verdict outside `CONTRADICTION_VERDICTS` | Discarded as if `independent`; logged at warn. |
| `judgeContradiction` | Verdict is `supersedes` but `obsolete_id` is absent or names neither input | Item discarded, logged at warn. Never guesses which thought lost. |
| `synthesise` | Returns empty/whitespace | Item discarded, counted in `skipped_empty_synthesis`. |
| `dream_apply` | `proposal_id` unknown | Error: `proposal not found`. |
| `dream_apply` | Proposal `status != 'open'` | Error naming the current status. Prevents double-apply. |
| `dream_apply` | `expires_at` in the past | Status set to `expired`, error returned. The corpus has moved since the proposal was computed. |
| `dream_apply` | An accepted item's thought was deleted since proposal | That item is skipped and reported in `rejected`; the rest apply. |
| `dream_apply` | `accept` names an unknown item key | Error before any write. All-or-nothing on key validation. |
| Any op | `ops` names an op outside `DREAM_OPS` | Error before any read. |
| Config | `getDisciplineConfig()` throws on a malformed config file | Propagates. Dream must not run with a half-loaded alias table — that would write wrong vocabulary corpus-wide. |

## 12. Observability

The codebase logs via `console.error` with a bracketed prefix (`[mcp] Tool "x" failed:`). Dream uses
`[dream]` and the same mechanism — no new logging dependency.

| Level | Event | Fields |
|---|---|---|
| info | run start | `project: projectKey(project)`, `watermark: state.watermark`, `ops: ops.join(",")` |
| info | run end | `candidates: candidates.length`, `clusters: clusters.length`, `applied: JSON.stringify(applied)`, `proposed: JSON.stringify(proposed)`, `ms: Date.now() - startedAt` |
| info | merge applied | `canonical_id: inserted.id`, `merged_from: sources.map(s => s.id).join(",")`, `similarity: minPairwise` |
| info | contradiction proposed | `a: pair[0].id`, `b: pair[1].id`, `verdict: judgment.verdict` |
| info | apply decision | `proposal_id`, `accepted: accept.join(",")`, `rejected: rejected.join(",")` |
| warn | judgment discarded | `pair: \`${a.id},${b.id}\``, `reason: "unknown_verdict" \| "missing_obsolete_id"`, `raw: judgment.verdict` |
| warn | cluster skipped | `cluster: ids.join(",")`, `reason: "embed_failed" \| "empty_synthesis"`, `error: String(err)` |
| warn | thought skipped | `id: row.id`, `reason: "no_embedding"` |
| error | run aborted | `project`, `error: String(err)`, `stage: "candidates" \| "auto" \| "propose"` |

Logging never throws into the main flow: every log call is a plain `console.error`, which cannot
fail in a way that matters. There is no external notification path in this feature, so there is no
"observability system down" branch to handle.

There is no phased rollout — dream is inert until a client calls the tool, so no intermediate
deployment state produces misleading logs.

## 13. Tests

Vitest, `src/dream/__tests__/`, matching the existing `__tests__` convention. Every branch above has
a named test.

**Pure units (no pool, no embedder):**
- `SubTestCluster_SinglePairAboveThreshold`
- `SubTestCluster_TransitiveChainFormsOneComponent`
- `SubTestCluster_BelowThresholdStaysSeparate`
- `SubTestMerge_LongestContentWins`
- `SubTestMerge_DisjointContentIsConcatenated`
- `SubTestMerge_MetadataUnionDedupes`
- `SubTestMerge_TypeTieBrokenByEarliestCreatedAt`
- `SubTestMerge_MergedFromCarriesEveryId`
- `SubTestVocabulary_TopicAliasApplied`
- `SubTestVocabulary_MissingTopicsArrayTreatedAsEmpty`
- `SubTestWatermark_AdvancesToMaxObservedNotNow`
- `SubTestWatermark_UnchangedWhenNoCandidates`

**Against a fake embedder:**
- `SubTestContradiction_UnknownVerdictDiscarded`
- `SubTestContradiction_SupersedesWithoutObsoleteIdDiscarded`
- `SubTestContradiction_IndependentNotProposed`
- `SubTestSynthesis_EmptyOutputDiscarded`
- `SubTestMerge_EmbedFailureSkipsClusterOnly`

**Apply path:**
- `SubTestApply_UnknownProposalErrors`
- `SubTestApply_AlreadyAppliedErrors`
- `SubTestApply_ExpiredMarksExpiredAndErrors`
- `SubTestApply_UnknownItemKeyErrorsBeforeAnyWrite`
- `SubTestApply_DeletedThoughtSkippedOthersApply`

**Integration (`src/__integration__/`, real Postgres + pgvector):**
- `SubTestDream_FirstRunProcessesWholeCorpus`
- `SubTestDream_SecondRunProcessesOnlyNewThoughts`
- `SubTestDream_NullProjectRowsAreProcessed`
- `SubTestDream_MergeIsIdempotentAcrossRuns`
- `SubTestDream_DryRunWritesNothing`

**Fake embedder** — `src/dream/__tests__/fake-embedder.ts`:

```ts
export class FakeEmbedder implements Embedder {
  ForceEmbeddingError?: Error;
  ForceJudgeError?: Error;
  ForceSynthesiseEmpty = false;
  JudgmentByPair = new Map<string, ContradictionJudgment>();
  // ...
}
```

Every forced-error field is reset in `beforeEach` — leaked forced state across tests is a standard
flake source. A single `resetFake()` helper does it, asserted by `SubTestFake_ResetClearsForcedState`.

## 14. Out of scope

These are deliberately absent from every section above.

1. **Scheduled/background execution.** Dream is MCP-invoked only. A cron trigger is a follow-up.
2. **Cross-project consolidation.** Dream never merges thoughts from different projects.
3. **Collapsing existing `supersedes` chains.** Pre-existing chains are preserved as-is.
4. **Changing `supersedes` to a many-to-many table.** §6.2 works within the current single FK.
5. **Re-embedding on vocabulary change.** Vocabulary touches metadata only; content is unchanged.
6. **A UI.** There is no frontend in this repo.

## 15. File manifest

| File | Change |
|---|---|
| `db/knex-migrations/006_dream.cjs` | new — `dream_state`, `dream_proposals`, partial index. Knex is the live system (`npm run db:migrate` → `knexfile.cjs` → `db/knex-migrations`); the `db/migrations/*.sql` set referenced in `AGENTS.md` predates it |
| `src/dream/constants.ts` | new — `DREAM_OPS`, `PROPOSAL_STATUSES`, `CONTRADICTION_VERDICTS`, thresholds |
| `src/dream/candidates.ts` | new — `projectKey()`, watermark load/advance, candidate + neighbour queries |
| `src/dream/cluster.ts` | new — connected components over the pair graph |
| `src/dream/ops/vocabulary.ts` | new — pure vocabulary resolution |
| `src/dream/ops/merge.ts` | new — pure canonical-row construction |
| `src/dream/ops/contradiction.ts` | new — pair judgment + item construction |
| `src/dream/ops/synthesis.ts` | new — cluster summary + item construction |
| `src/dream/proposal.ts` | new — persist / load / apply |
| `src/dream/index.ts` | new — orchestrator, the only pool-touching file |
| `src/embedder/types.ts` | add `judgeContradiction`, `synthesise`, `ContradictionJudgment`, 2 prompts |
| `src/embedder/ollama.ts` | implement both methods |
| `src/embedder/openrouter.ts` | implement both methods |
| `src/embedder/azure-openai.ts` | implement both methods |
| `src/mcp/server.ts` | register `dream` + `dream_apply` in the tools array; two `case` branches |
| `src/api/routes.ts` | add `POST /dream` and `POST /dream/apply` delegating to `src/dream/index.ts` |
| `src/db/queries.ts` | add `insertMergedThought`, `archiveThoughts(ids)`, `listCandidatesSince()` returning `CandidateRow[]`; export `CandidateRow`; reuse existing search fns |
| `src/dream/__tests__/*.test.ts` | new — unit tests per §13 |
| `src/dream/__tests__/fake-embedder.ts` | new — fake with forced-error fields |
| `src/__integration__/dream.test.ts` | new — integration tests per §13 |
| `.env.example` | add `DREAM_MERGE_THRESHOLD`, `DREAM_NEIGHBOUR_THRESHOLD`, `DREAM_PROPOSAL_TTL_HOURS` |
| `README.md` | document both tools |

## 16. Open questions

None blocking. Every persisted shape (`dream_state`, `dream_proposals`, `metadata.dream`) and every
wire shape (both tool request/response objects) is fixed above.

Non-blocking: the default `MERGE_THRESHOLD` of `0.94` is a starting value; it should be tuned against
the real corpus after the first dry run, and the tuning does not change any shape.
