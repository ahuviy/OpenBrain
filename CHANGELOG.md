# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `dream_review` (REST: `GET /dream/proposals/:id`) reads a proposal back without
  deciding anything — every item with its key, the thoughts behind it, and what
  applying it would change. `dream_apply` closes a proposal whichever way it is
  called, so a proposal whose items were never seen had no safe move.
- `dream` now returns the proposed `items` in full, not just counts, keyed exactly
  as `dream_apply` takes them.

### Fixed
- Knex migrations (004+) are applied at startup. Nothing on the hosted path ever
  ran them — no release command, no entrypoint step — so production was missing
  every table from migration 004 onward, and `dream` failed with
  `relation "dream_state" does not exist`. They run in the background: blocking
  the port on a migration fails the platform health check on every cold boot.
  This makes backwards/forwards compatibility a standing rule for migrations —
  expand, deploy, contract.

### Changed
- `dream` screens every merge cluster through the contradiction judge before
  applying it. Similarity cannot tell agreement from negation, so two flatly
  incompatible thoughts phrased alike sat above the merge threshold and were
  merged immediately and unreviewably, while the same disagreement phrased
  differently went through the proposal gate. What the judge refuses is proposed;
  what it cannot judge is left alone and counted in `skipped.merge_unscreened`.
- `dream` returns `applied_items`: what each merge collapsed, with the source
  thoughts. A merge archives rows with no review step and nothing else recorded
  what it did.
- The vocabulary pass now folds spelling variants it infers from the project's
  own vocabulary (`Bert Dohmen`/`Dohmen`, `Market Analysis`/`market-analysis`),
  keeping the spelling the brain uses most, and sweeps the thoughts the watermark
  excludes — the rows carrying an old spelling are the old ones. Related but
  distinct tags (`markets` vs `market-analysis`) are left alone. Configured
  aliases still win over inferred ones.
- The watermark no longer advances past thoughts left in an unreviewed proposal,
  which had made an expired or superseded proposal unreconstructable.
- `dream`'s description states that one run covers one project, and that a bare
  call covers only thoughts with no project.

## [0.7.4] - 2026-05-18

### Added
- Embedding-truncation warning: captures whose content exceeds the embedder's
  context window now return a `warnings[]` entry with reason `embedding_truncated`
  and tag `metadata.embedding_truncated = true` + `metadata.embedding_indexed_bytes`
  + `metadata.content_bytes`. Full content is still stored — only the embedding is
  truncated by the model. Callers know up-front that semantic search will not
  match passages past the cutoff and can choose to split into smaller captures.
- New `OPENBRAIN_EMBED_SAFE_BYTES` env var (default `6000`, tuned for Ollama
  `nomic-embed-text` 2048-token context) so deployments with larger-context
  embedders can raise the threshold.
- `/health` advertises new capability `embed-truncation-warning`.

## [0.7.3] - 2026-05-18

### Changed
- Ollama embedder now surfaces the upstream response body in error messages
  (previously only `400 Bad Request` was shown), making embed failures diagnosable end-to-end.
- Ollama embed requests send `truncate: true` explicitly to prevent oversized-content failures.
- Empty-vector responses from Ollama now throw a clear `no vector for this content` error
  instead of the opaque `Ollama returned empty embedding`. Includes `content_bytes` for debugging.

## [0.7.0] - 2026-05-16

### Added
- Provenance helpers: generated columns `source_file_hash` and `code_hash` on `thoughts`,
  partial indexes (`idx_thoughts_source_file_hash`, `idx_thoughts_code_hash`), and the
  `match_thoughts_by_source(source_hash, max_count, project_filter, include_archived)` RPC
  (migration `003-add-provenance-helpers.sql`).
- REST endpoint `GET /memories/by-source` for retrieving thoughts by source/origin
  (supports `source`, `project`, `created_by`, `include_archived`, `limit`).
- `created_by` user-attribution filter across list/search endpoints.
- `metadata.provenance` sub-object (`origin`, `original_id`, `imported_at`) for imported thoughts.

### Changed
- Documentation refresh: `docs/02-DATABASE-SCHEMA.md` (Provenance helpers section),
  `docs/04-MCP-SERVER.md`, and `README.md` updated for source-based lookup surface.
- Version bumped to `0.7.0` (pre-1.0 release line).
