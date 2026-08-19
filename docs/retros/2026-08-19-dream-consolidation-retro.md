# Implementation Retro: Dream Consolidation

**Date:** 2026-08-19
**Branch:** master (uncommitted working tree)
**Design:** `docs/plans/2026-08-18-dream-consolidation-design.md`
**Plan:** none — see Finding P2-1

## Scope note

The standard retro walks fix commits after a boundary SHA. This work is uncommitted, so there are no
fix commits to walk. The equivalent evidence is used instead: the code-review findings, the six
corrections the design records in its own §15a, and defects caught while verifying. Each finding
below cites the artifact it came from rather than a SHA.

## Quantitative Summary

Nineteen corrections, counted once each (a defect fixed in two passes counts once).

| Root Cause Category | Count | % |
|---|---|---|
| Design Gap | 6 | 32% |
| Execution Gap | 6 | 32% |
| Guideline Gap | 4 | 21% |
| Plan Gap | 2 | 11% |
| Pre-existing Bug | 1 | 5% |
| Test Coverage Gap | 0 | 0% |

Design and Execution gaps account for **two thirds**. No Test Coverage gaps: TDD held, and the tests
that existed were attributed. The gaps were in *what the design specified* and *what the code did
that no test observed*.

## Findings by Severity

### P1: Correctness

#### Merge silently dropped `source` and `provenance`
- **Source:** code review, finding F1
- **What was wrong:** `buildCanonical` rebuilt `metadata` from four list keys. `ThoughtMetadata` also
  carries `source` and `provenance`, and `searchThoughtsBySource` matches importers on exactly those.
  A merged import became invisible to its own importer, which would re-create the originals and undo
  the merge — on every subsequent import run.
- **Root Cause:** Design Gap. §4.3 enumerated the columns the feature touches and §4.4 defined the
  `metadata.dream` sub-document, but nothing said what happens to *metadata keys the feature does not
  own*.
- **What the design should have said:** "For every field on a shared type the feature rewrites,
  state explicitly whether it is preserved, merged, or dropped. A field absent from that table is a
  bug, not an omission."

#### Watermark could permanently skip a thought
- **Source:** code review, finding F7
- **What was wrong:** advancing to `max(updated_at)` of rows read. `set_updated_at` stamps when the
  statement runs, not when its transaction commits, so a write stamped before the run's snapshot can
  commit after it — invisible to the run, below the new watermark, never selected again.
- **Root Cause:** Design Gap. §5 step 7 reasoned about one direction (don't use `now()`) and stopped.
- **What the design should have said:** "For any watermark or cursor, state the commit-visibility
  race explicitly: which writes can be stamped before the read snapshot and committed after it."

#### Two open proposals could coexist
- **Source:** code review, finding F5
- **What was wrong:** the partial index was not UNIQUE, so `dream_apply` could resolve an item key
  against whichever open proposal it happened to load.
- **Root Cause:** Design Gap. §4.1 described the lookup as singular in prose; the DDL did not enforce it.
- **What the design should have said:** "Every invariant stated in prose names the constraint that
  enforces it, or is marked unenforced."

### P2: Architecture / Testability

#### No implementation plan was written
- **Source:** process
- **What was wrong:** the flow went brainstorming → design → implementation, skipping `writing-plans`.
  The design's own file manifest listed ~20 files; without a plan there was no task-and-test matrix,
  and the build order was improvised.
- **Root Cause:** Plan Gap. The user asked to go "straight to implementation" and that was taken
  literally.
- **Consequence:** two of the P1 findings (F1, F7) are exactly the kind a plan's per-file test matrix
  surfaces — "which fields does `buildCanonical` write, and what test covers each?"

#### Cross-project clusters would have been silently re-homed
- **Source:** code review, finding F2
- **Root Cause:** Design Gap. §6.2 described merging a cluster without ever asking what the sources
  might disagree on.
- **What the design should have said:** "For an operation that collapses N records into one, list
  every field where the sources may differ and state the behaviour for each."

#### The verdict set was declared three times
- **Source:** code review, finding F8
- **Root Cause:** Execution Gap. §4.2 named typed constants as the mechanism; the implementation then
  added a second literal union in `embedder/types.ts` and a third interface copy in `ops/`.

#### TDD violated twice
- **Source:** self-caught (`judgePayload`, `applyProposal`)
- **What was wrong:** production code and its tests written in the same step, so no RED was observed.
  Attribution was proven afterwards by removing each guard and watching it red — weaker evidence.
- **Root Cause:** Execution Gap. Both happened while batching several files into one tool call.
- **Lesson:** batching edits is where TDD discipline breaks, not complexity.

### P3: Quality / Standards

#### `typecheck` red while `build` and tests were green
- **Source:** self-caught, twice
- **What was wrong:** `tsconfig.build.json` excludes tests, so `npm run build` cannot see a type error
  in a test file. Both times the suite was green and the build was green.
- **Root Cause:** Guideline Gap — now fixed in `AGENTS.md`.

#### Documented data that rots
- **Source:** user correction
- **What was wrong:** having just removed a stale "27 tests" claim from three docs, the consolidation
  wrote five fresh per-suite counts into a table — the identical failure, one step later.
- **Root Cause:** Guideline Gap. Nothing said which facts belong in docs.
- **Rule:** document what is stable (which suite covers what, what it needs). Never document what a
  test run prints.

#### Shell orchestration failed silently
- **Source:** self-caught
- **What was wrong:** `readonly DB_PORT` collided with a later `export`; the trap swallowed it and the
  script exited **0** having run only the unit tests. The JS rewrite hit the next bug and failed loudly.
- **Root Cause:** Execution Gap.

#### A documented command that silently did nothing
- **Source:** self-caught in the sibling `dream` skill
- **What was wrong:** BSD `sed` does not support `\|` alternation in BRE, so a documented cluster
  command no-opped and printed useless output with exit 0.
- **Root Cause:** Execution Gap — shipped prose containing code that was never executed.

#### Postgres readiness race
- **Source:** self-caught
- **What was wrong:** `docker exec pg_isready` answers against the temporary initdb server on the unix
  socket; the real server then restarts and the next command dies with "server closed the connection
  unexpectedly". Would have been an intermittent CI failure.
- **Root Cause:** Guideline Gap.

#### Pre-existing: `pforge-sdk` dependency pointed at a path that no longer exists
- **Source:** discovered while wiring CI
- **Root Cause:** Pre-existing Bug. Outside this feature. `npm ci` never failed on it because npm
  creates a `file:` symlink without checking the target, so it only ever surfaced at import.

## Recommendations

### Design process
1. **Shared-type field disposition table.** For every field on a type the feature rewrites, state
   preserve / merge / drop. Would have caught F1, the only data-loss defect.
2. **Collapse operations enumerate disagreement.** For any N→1 operation, list the fields sources may
   differ on. Would have caught F2.
3. **Every prose invariant names its enforcing constraint.** Would have caught F5.
4. **Cursor and watermark designs state the commit-visibility race.** Would have caught F7.

### Planning process
5. **Do not skip `writing-plans` because the user said "straight to implementation".** They named a
   destination, not a process. A per-file test matrix is where F1 and F7 surface.

### Execution process
6. **Never batch a production edit with its own test in one step.** Both TDD violations happened
   inside a batched call.
7. **Execute every command a document contains, against real data, before shipping the document.**

### Codebase guidelines
8. `AGENTS.md`: `typecheck` is stricter than `build` — check both. *(landed)*
9. `AGENTS.md`: document what is stable, never what a test run prints. *(landed)*
10. `AGENTS.md`: probe a containerised Postgres over TCP, never `docker exec pg_isready`. *(landed)*

## Summary Observations

**Design gaps dominate, and they share one shape.** Five of six are the same omission: the design
specified what the feature *does* and not what it *preserves*. F1 (metadata), F2 (cross-project), F5
(uniqueness), F7 (watermark) are all "the design said what happens in the expected case." Adding the
three design-process items above would have caught four of six design gaps and the only data-loss bug.

**No test coverage gaps, and that is the interesting result.** TDD held; every guard was attributed by
removal. Yet a HIGH-severity data-loss defect shipped to review anyway, because **the tests never
constructed a thought with `provenance`** — the field simply did not exist in the fixtures. Coverage
measures the branches you wrote, not the fields you forgot. Attribution proves a line is needed; it
cannot prove a line is missing.

**Verification found more than review did.** Nine defects were caught by *running* things — `typecheck`
against green tests, the `sed` no-op, the shell exit-0, the Postgres race, the two search-test failures
that forced the fake embedder rewrite. Only one was caught by reading. The lesson is not "review less"
— review found the data-loss bug — it is that a document, a command, and a fake are all untested code
until executed.

**Five findings I reported were wrong.** Retracted after reading: two path-drift claims, a lost-detail
claim, "32% link rot" (the auto-memory spec explicitly sanctions dangling links), and an
`applied_at=null` scare (my probe read a column the query does not select). Every one came from
trusting a grep before reading what it pointed at. Retraction is cheap; acting on a grep is not.

## Postscript: the lesson found two more bugs

Applying this retro's own top recommendation — "state what you preserve, not just what you write" —
to the remaining write paths immediately surfaced two more instances of the same defect, both
design-versus-implementation mismatches that every test and the code review had missed:

1. **Synthesis dropped its sources.** §6.4 requires `metadata.dream.sources`; the port wrote
   `{ type, topics, people }` and only *logged* the ids. A summary that cannot name what it was
   written from is an unattributable claim, and synthesis archives nothing, so there is no
   `supersedes` edge to follow instead.
2. **Merge dropped its lineage.** §4.4 requires `metadata.dream.merged_from`, and §6.2 explicitly
   justified leaving `supersedes` as a single FK because "any consumer wanting the complete lineage
   reads `metadata.dream.merged_from`". That field was computed, returned, and never persisted —
   `grep` found it only in `merge.ts`.

Both are now written and attributed. That the lesson paid out twice within minutes of being written
is the strongest evidence in this report that the Design Gap category is the real leverage point,
and that "what does this preserve?" belongs in the design template rather than in a reviewer's head.

## Follow-up Items

- [x] `AGENTS.md`: `typecheck` is stricter than `build` — addresses "typecheck red while build green"
- [x] `AGENTS.md`: document stable facts, never test-run output — addresses "documented data that rots"
- [x] `AGENTS.md`: TCP probe for containerised Postgres — addresses "Postgres readiness race"
- [x] Docs consolidated to one source of truth — addresses three-way testing-doc drift
- [ ] **Open, needs owner:** `pforge-sdk` was removed with the test that used it; if Plan-Forge is
      revived, the hallmark round-trip test needs restoring — pre-existing, outside this feature
- [x] The `docker` CI job failed on `ghcr.io/<owner>/OpenBrain` — registry names must be lowercase,
      but `github.repository` preserves the repo's casing. Fixed by lowercasing the whole slug, which
      holds for any owner and any fork. Pre-existing; it had failed on every run since the fork.
      Superseded: the job was then removed entirely — nothing in the repository pulls the image, and
      the one path that would (Azure) is not used here
