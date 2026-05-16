# Phase-PROVENANCE: Hallmark Schema in OpenBrain — Migration 003, /health Capability, Source-Hash RPC (HARDENED)

> **Status**: Hardened, ready for execution (Step 3)
> **Repo**: `srnichols/OpenBrain` — this plan lives here, executed by Plan Forge.
> **Tracks**: SQL (`db/migrations/003-add-provenance-helpers.sql`) + API (`src/api/routes.ts`) + DB queries (`src/db/queries.ts`) + Tests + Docs
> **Estimated cost**: $3.00–$6.00 (5 slices, mostly TypeScript + SQL)
> **Pipeline**: Specify ✅ → Pre-flight ✅ → **Harden ✅** → Execute → Sweep → Review → Ship
> **Source**: CocoIndex-inspired memory upgrade research (May 16, 2026). Schema published by Phase-HALLMARK-CONTRACT in `pforge-sdk`.
> **Position in chain**: 2 of 6 — depends on Phase-HALLMARK-CONTRACT (the schema), feeds Phase-ANVIL (the first writer).
> **Release target**: OpenBrain `v0.7.0`. This phase must be merged and released before Phase-ANVIL Slice 3 enables provenance writes.

---

## Scope Contract

### In Scope

- `db/migrations/003-add-provenance-helpers.sql` — new migration. Adds two **generated columns** projected from `metadata->'provenance'`, two partial indexes on those columns, and a new `match_thoughts_by_source` RPC.
- `src/db/queries.ts` — extend `ThoughtMetadata` type with optional `provenance` field; add `searchThoughtsBySource(pool, sourceHash, limit)` query that calls the new RPC.
- `src/api/routes.ts` — three changes:
  1. `GET /health` response gains `capabilities: string[]` field. Always includes `"provenance"` after this phase ships.
  2. `POST /memories` validates incoming `metadata.provenance` against the Hallmark v1 schema when present. Rejects with `400` and structured error if invalid; accepts (no-op) if absent.
  3. New `GET /memories/by-source?hash=<sha256:...>` endpoint that calls `searchThoughtsBySource` — returns at most `limit` (default 25, max 100) matches ordered by `created_at DESC`.
- `src/api/__tests__/provenance.test.ts` — new file. Covers validation, capability flag, and by-source endpoint.
- `src/db/__tests__/provenance.test.ts` — new integration test for the migration + RPC (Postgres+pgvector under Docker per existing harness in `vitest.integration.config.ts`).
- `docs/02-DATABASE-SCHEMA.md` — append "Provenance helpers (v0.7.0+)" section documenting the generated columns and the RPC.
- `docs/04-MCP-SERVER.md` — append note that `capture_thought` consumers may pass `metadata.provenance`.
- `README.md` (OpenBrain) — bump the badge and the version line; mention `provenance` capability in the integration table.
- `package.json` — version bump `0.6.x → 0.7.0`.
- `CHANGELOG.md` (OpenBrain) — new `## [0.7.0]` section.
- New dev dep: `pforge-sdk` (via workspace path or git+https) so the validator is the same function Plan-Forge writes against.

### Out of Scope

- **Writing provenance** — Plan-Forge's Phase-ANVIL is the first writer. This phase enables the server to receive, validate, and query it.
- **Changing the existing `metadata @>` filter behavior in `match_thoughts`** — the existing semantic-search RPC is untouched. The new `match_thoughts_by_source` is **additive**.
- **Removing or renaming any existing column, RPC, or endpoint.** Backward compatibility is a hard requirement.
- **Forcing existing consumers (Claude, Cursor, ChatGPT clients) to write provenance.** It stays optional forever.
- **Server-side embedding of provenance fields into the vector.** Provenance is metadata; the vector is content.
- **Migrating historical rows.** Existing rows without provenance simply have `source_file_hash IS NULL` and `code_hash IS NULL` — the partial indexes skip them.
- **Auth changes.** This phase does not introduce auth; OpenBrain's existing auth posture (whatever it is in the consumer deployment) is unchanged.
- **An MCP-tool wrapper for the new endpoint.** Plan-Forge will add `forge_hallmark_*` MCP tools in Phase-ANVIL; the MCP server in OpenBrain stays focused on `capture_thought` / `search_thoughts`.

### Forbidden Actions

- **Do NOT alter the signature of `match_thoughts()` SQL function.** Existing callers (every Claude/Cursor/ChatGPT integration) depend on it byte-for-byte. The new RPC is a sibling.
- **Do NOT change the request/response shape of `POST /memories`, `POST /memories/search`, `POST /memories/batch`, `GET /stats`, or any existing endpoint.** Provenance arrives inside the existing `metadata` field that already accepts arbitrary objects.
- **Do NOT make `metadata.provenance` required.** Request bodies without it must still succeed with `200 OK` and behave identically to today.
- **Do NOT drop or rename `thoughts` columns, the GIN index, the HNSW index, or `match_thoughts()`.** Forward-only additive migrations.
- **Do NOT embed the Hallmark schema as a TypeScript literal.** Import it via `pforge-sdk/hallmark`. Single source of truth (Phase-HALLMARK-CONTRACT Forbidden Action 6).
- **Do NOT bump to v1.0.0 in this phase.** Minor bump only — v0.7.0. Major-version semantics deferred until OpenBrain declares API stability.
- **Do NOT log the full `metadata.provenance` block at INFO level.** It may contain repo-relative source paths — log at DEBUG only, scrub the `sourceFile` field at INFO.

---

## Required Decisions

| # | Decision | Status | Resolution |
|---|---|---|---|
| 1 | Migration numbering | RESOLVED | `003-add-provenance-helpers.sql` — follows existing convention (`001-dev-ready-upgrade.sql`, `002-add-created-by.sql`). |
| 2 | Generated column type | RESOLVED | `STORED` (not `VIRTUAL`) so partial indexes can be built on them. Disk cost is ~80 bytes per row — negligible. |
| 3 | Column names | RESOLVED | `source_file_hash` and `code_hash` — snake_case to match the existing schema (`created_by`, `created_at`). |
| 4 | New RPC name | RESOLVED | `match_thoughts_by_source(source_hash TEXT, max_count INT DEFAULT 25, project_filter TEXT DEFAULT NULL, include_archived BOOLEAN DEFAULT false)` — mirrors `match_thoughts` ordering/filtering conventions. |
| 5 | Capability flag transport | RESOLVED | `GET /health` response gains `capabilities: string[]`. Avoid a separate `/capabilities` endpoint — keeps the probe to one round trip. |
| 6 | Validator dependency | RESOLVED | Import `validateProvenance` from `pforge-sdk/hallmark`. The SDK ships zero deps so OpenBrain inherits zero new transitive deps from this. |
| 7 | New endpoint shape | RESOLVED | `GET /memories/by-source?hash=sha256:<hex>&limit=<n>&project=<p>`. Query string keeps it cacheable; matches REST conventions used elsewhere. |
| 8 | Invalid-provenance HTTP code | RESOLVED | `400 Bad Request` with body `{ error: "Invalid provenance", details: [...] }`. The whole request is rejected — partial writes are forbidden. |
| 9 | `limit` cap on by-source endpoint | RESOLVED | Default 25, max 100. Matches `/memories/list` conventions and prevents accidental table scans through the API. |
| 10 | Pgvector dimension | RESOLVED | Unchanged — `VECTOR(768)`. This phase touches no embeddings. |
| 11 | Migration idempotency | RESOLVED | All `CREATE` statements use `IF NOT EXISTS`; the `ALTER TABLE ... ADD COLUMN` uses `IF NOT EXISTS`. Migration runner can re-apply safely. |
| 12 | Rollback strategy | RESOLVED | A sibling `003-add-provenance-helpers.down.sql` drops the two indexes, the RPC, and the two generated columns. Documented but not auto-applied. |

---

## Acceptance Criteria

### Migration

- **MUST**: `db/migrations/003-add-provenance-helpers.sql` applies cleanly against a fresh Postgres+pgvector container loaded with `init.sql` + `001` + `002`.
- **MUST**: Re-applying the migration on a database where it already ran is a no-op (idempotency via `IF NOT EXISTS`).
- **MUST**: After migration: `\d thoughts` shows `source_file_hash text` and `code_hash text` as `GENERATED ALWAYS AS (...) STORED`.
- **MUST**: After migration: `\di idx_thoughts_source_file_hash` and `\di idx_thoughts_code_hash` exist with `WHERE` clauses excluding NULL.
- **MUST**: After migration: `\df match_thoughts_by_source` shows the function with the exact signature in Decision 4.
- **MUST**: `match_thoughts(...)` is unchanged — same `\df` output as before the migration.
- **MUST**: An existing row inserted before the migration (no `metadata.provenance`) has `source_file_hash IS NULL` and `code_hash IS NULL`. The partial indexes do not reference it.
- **MUST**: A row inserted after the migration with `metadata: { provenance: { contentHash: "sha256:abcd...", codeHash: "sha256:efgh..." } }` has the generated columns auto-populated and is indexed.

### API — validation

- **MUST**: `POST /memories` with body `{ content: "x", metadata: { provenance: { schemaVersion: "hallmark/v1", toolName: "forge_x", capturedAt: "2026-05-16T07:28:45Z" } } }` returns `200` and stores the provenance.
- **MUST**: `POST /memories` with body `{ content: "x", metadata: { provenance: { schemaVersion: "hallmark/v2", toolName: "x", capturedAt: "..." } } }` returns `400` with body containing `error: "Invalid provenance"` and a `details` array.
- **MUST**: `POST /memories` with body `{ content: "x" }` (no `metadata.provenance`) returns `200` and behaves identically to today (regression-protected).
- **MUST**: `POST /memories/batch` validates each thought's provenance independently. If any is invalid, the whole batch returns `400` and **nothing is inserted** (transactional).
- **MUST**: Validation is performed by `validateProvenance` from `pforge-sdk/hallmark`. The validator function is not re-implemented in OpenBrain.

### API — capability flag

- **MUST**: `GET /health` response body contains `{ status: "healthy", service: "open-brain-api", capabilities: ["provenance"] }`. The `capabilities` array is sorted alphabetically and stable across calls.
- **MUST**: Future capabilities (e.g., `"lattice-bulk-upsert"`) are added by appending to the array, never by versioning the endpoint.

### API — by-source endpoint

- **MUST**: `GET /memories/by-source?hash=sha256:<64-hex>` returns `200` with an array of matches. Each match has the same shape as `/memories/search` results minus the `similarity` field.
- **MUST**: `GET /memories/by-source?hash=md5:abcd` returns `400` with body explaining the hash format is wrong.
- **MUST**: `GET /memories/by-source` (no `hash` query param) returns `400`.
- **MUST**: `GET /memories/by-source?hash=sha256:...&limit=50` returns at most 50.
- **MUST**: `GET /memories/by-source?hash=sha256:...&limit=500` returns at most 100 (cap from Decision 9).
- **MUST**: Results are ordered `created_at DESC` (newest first) — verified by inserting two rows with the same `contentHash` and the second appearing first in the response.

### Tests

- **MUST**: `src/api/__tests__/provenance.test.ts` covers every API MUST above. Uses the existing test harness.
- **MUST**: `src/db/__tests__/provenance.test.ts` runs under `vitest.integration.config.ts` against a real Postgres container and covers every Migration MUST above.
- **MUST**: All existing tests (`src/api/__tests__/*.test.ts`, `src/db/__tests__/*.test.ts`, `src/mcp/__tests__/*.test.ts`) still pass — backward-compat regression net.

### Docs

- **MUST**: `docs/02-DATABASE-SCHEMA.md` has a "Provenance helpers (v0.7.0+)" section documenting the generated columns, indexes, RPC signature, and Hallmark schema link.
- **MUST**: `docs/04-MCP-SERVER.md` mentions that `metadata.provenance` is now validated.
- **MUST**: `CHANGELOG.md` has a `## [0.7.0]` section noting the new capability flag, the additive endpoint, and "no breaking changes for existing consumers".
- **MUST**: `README.md` version-line/badge reflects `0.7.0`.

---

## Execution Slices

### Slice 1: Migration 003 + rollback file [sequential]

**Goal**: Land the SQL migration + its rollback companion. Verified against a fresh container before any TypeScript touches it.

**Files**:
- `db/migrations/003-add-provenance-helpers.sql` (new)
- `db/migrations/003-add-provenance-helpers.down.sql` (new)

**Depends On**: nothing.

**Validation Gate**:
```bash
grep -q 'source_file_hash' db/migrations/003-add-provenance-helpers.sql && grep -q 'match_thoughts_by_source' db/migrations/003-add-provenance-helpers.sql && grep -q 'GENERATED ALWAYS' db/migrations/003-add-provenance-helpers.sql && echo ok
```

---

### Slice 2: Wire `pforge-sdk/hallmark` into `package.json` + integration test for the migration [sequential]

**Goal**: Declare the SDK dep and prove the migration + RPC behave correctly against a real Postgres container.

**Files**:
- `package.json` (modify — add `pforge-sdk` to `devDependencies` via workspace/git path)
- `src/__integration__/provenance.test.ts` (new)

**Depends On**: Slice 1, and Phase-HALLMARK-CONTRACT Slice 3 published.

**Validation Gate**:
```bash
npx vitest run --config vitest.integration.config.ts src/__integration__/provenance.test.ts --reporter=dot && echo ok
```

---

### Slice 3: Extend `queries.ts` — `ThoughtMetadata.provenance` + `searchThoughtsBySource` [sequential]

**Goal**: Surface the RPC as a typed function. Pure DB layer — no HTTP yet.

**Files**:
- `src/db/queries.ts` (modify)

**Depends On**: Slice 2.

**Validation Gate**:
```bash
grep -q 'searchThoughtsBySource' src/db/queries.ts && grep -q 'provenance' src/db/queries.ts && npx tsc --noEmit && echo ok
```

---

### Slice 4: API surface — validation on POST, `capabilities` on /health, GET /memories/by-source [sequential]

**Goal**: Three API changes in one slice — they form a single capability-negotiation contract that consumers see atomically.

**Files**:
- `src/api/routes.ts` (modify)
- `src/api/__tests__/provenance.test.ts` (new)

**Depends On**: Slice 3.

**Validation Gate**:
```bash
npx vitest run src/api/__tests__/provenance.test.ts --reporter=dot && echo ok
```

---

### Slice 5: Docs + CHANGELOG + version bump to 0.7.0 [sequential]

**Goal**: Ship the release artifacts so Phase-ANVIL can target a published version.

**Files**:
- `docs/02-DATABASE-SCHEMA.md` (modify — append section)
- `docs/04-MCP-SERVER.md` (modify — append note)
- `README.md` (modify — version + capability mention)
- `package.json` (modify — version bump)
- `CHANGELOG.md` (modify — new `## [0.7.0]` section)

**Depends On**: Slice 4.

**Validation Gate**:
```bash
grep -q '0.7.0' package.json && grep -q '## \[0.7.0\]' CHANGELOG.md && grep -q 'Provenance helpers' docs/02-DATABASE-SCHEMA.md && echo ok
```

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Existing consumers (Claude, Cursor, ChatGPT) accidentally break | Forbidden Action set prohibits any change to existing endpoints, RPCs, or columns. Regression test suite asserts `POST /memories` without provenance still returns 200. |
| Migration fails mid-rollout against a busy production DB | `ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS STORED` does require a rewrite on Postgres ≤ 16; on 17 it's metadata-only. Schedule during low-traffic window; rollback file is ready. |
| Generated-column expression mismatches the validator | Slice 2 integration test inserts the exact JSON shape the validator accepts and asserts the columns populate. |
| `pforge-sdk` workspace/git dep fails on `npm ci` in CI | Pin to a tagged commit; document the install pattern in CONTRIBUTING. If pforge-sdk publishes to npm later (future phase), swap to a registry version then. |
| Capability flag misused as a version selector | Document that `capabilities` is the contract, not `serverVersion`. Phase-ANVIL Slice 3 spec-checks the capability string, not the version number. |
| `GET /memories/by-source` becomes a scraping vector | The 100-row cap (Decision 9) + the partial index keep both server and DB cheap. No auth change — relies on the deployment's existing auth posture. |
| The Down migration is run in production by mistake | The `.down.sql` file lives next to the up, but the runner does not auto-apply. Documented as manual-only. |

---

## Definition of Done

- All five slices pass their validation gates.
- All existing OpenBrain tests pass; the two new test files pass.
- `package.json` version is `0.7.0`; `CHANGELOG.md` has the `[0.7.0]` section.
- A fresh `docker-compose up` produces a healthy container; `curl http://localhost:8000/health` returns `capabilities: ["provenance"]`.
- A `git diff` shows: 2 new SQL files, 2 new test files, 1 modified `queries.ts`, 1 modified `routes.ts`, 1 modified `package.json`, 1 modified `README.md`, 2 modified docs, 1 modified `CHANGELOG.md`. Nothing else.
- A canary call from a current Claude-Code MCP client that does NOT send `metadata.provenance` returns `200` and behaves identically to v0.6.x (manual smoke check before tagging release).

---

## Post-Mortem

_To be filled in after execution. Capture:_
- Did Postgres 17's faster-path `ADD COLUMN GENERATED STORED` actually land without table rewrite in the target environment?
- Any consumer integration that broke despite the Forbidden Actions — and what gap in our regression set let it through?
- Was the workspace/git dep on `pforge-sdk` painful in CI? If so, evaluate publishing the SDK to npm before Phase-ANVIL ships.
