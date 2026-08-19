# Contributing to Open Brain

Thanks for your interest in contributing! Open Brain is a personal semantic memory server for AI coding agents. Here's how to get involved.

## Development Setup

### Prerequisites

- **Node.js 22+** — [Download](https://nodejs.org/)
- **Docker** — For running PostgreSQL locally
- **Ollama** — For local embeddings ([ollama.com](https://ollama.com))

### Getting Started

```bash
# Clone the repo
git clone https://github.com/srnichols/OpenBrain.git
cd OpenBrain

# Install dependencies
npm install

# Copy environment config
cp .env.example .env
# Edit .env with your settings

# Pull embedding models
ollama pull nomic-embed-text
ollama pull llama3.2

# Start PostgreSQL
docker compose up -d postgres

# Run in dev mode (hot reload)
npm run dev
```

### Verify Setup

```bash
# Type check
npm run typecheck

# Build
npm run build

# Run tests
npm test

# Health check (after starting dev server)
curl http://localhost:8000/health
```

## Project Structure

See [01-ARCHITECTURE.md](docs/01-ARCHITECTURE.md) for the full system architecture and data flows.

```
src/
├── index.ts                 # Entry point — REST + MCP servers
├── api/
│   ├── routes.ts            # Hono REST API (11 routes)
│   └── search-config.ts     # Configurable search threshold default
├── mcp/
│   ├── server.ts            # MCP server (9 tools)
│   └── http-app.ts          # MCP-over-HTTP + OAuth
├── capture/                 # Write-path enforcement, shared by both transports
│   ├── discipline.ts        # type / people / topics / project rules (pure)
│   ├── dedupe.ts            # pre-write duplicate detection (pure)
│   └── vocabulary.ts        # cached topic vocabulary
├── dream/                   # Retrospective consolidation
│   ├── index.ts             # The run — tiering behind a DreamPort seam
│   ├── port.ts              # The pg-backed DreamPort
│   ├── candidates.ts        # Watermark and run scoping
│   ├── proposal.ts          # Proposal keys, partitioning, apply
│   ├── cluster.ts           # Connected components over similarity pairs
│   └── ops/                 # vocabulary, merge, contradiction, synthesis (pure)
├── db/
│   ├── connection.ts        # PostgreSQL pool (singleton)
│   └── queries.ts           # Parameterized SQL (20 functions) — ALL SQL lives here
├── embedder/                # Provider-agnostic embedder interface
│   ├── types.ts             # Embedder interface + 13 thought types
│   ├── index.ts             # Provider factory (EMBEDDER_PROVIDER)
│   ├── ollama.ts, openrouter.ts, azure-openai.ts
├── integration-suites/      # Contract suites run against >1 implementation
└── __integration__/         # Integration tests + their harness

scripts/                     # Test orchestration + the fake embedder
db/
├── init.sql                 # Base schema (vector dim varies by deploy)
├── migrations/              # 001-003, pre-knex, applied in order
└── knex-migrations/         # 004+, tracked in knex_migrations
```

## Coding Conventions

- **TypeScript strict mode** — No `any`, explicit types on function signatures
- **Parameterized SQL** — Never interpolate user input into queries
- **Async/await** — All I/O operations are async
- **Error handling** — All catch blocks log and return structured JSON
- **Layer separation** — DB queries → MCP tools / REST routes (no business logic in routes)

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(mcp): add bulk delete tool
fix(queries): handle null project in stats query
test(api): add batch capture validation tests
docs(readme): update MCP tool reference
chore(deps): update vitest to 4.2
```

## Testing

Two commands cover everything:

```bash
npm test          # unit only — fast, no dependencies (alias: npm run test:unit)
npm run test:all  # every suite, provisioning what it needs
```

`test:all` starts a throwaway Postgres, applies the schema, builds, boots a fake embedder and the
app, runs all five suites, and tears down **only what it started** — a database you were already
running is reused and left alone. Without Docker it runs the unit tests and exits non-zero, saying
why.

### The suites

| Suite | Command | Needs |
|-------|---------|-------|
| Unit | `npm test` | nothing |
| DreamPort contract | `npm run test:db` | Postgres |
| Provenance helpers | `npm run test:provenance` | Postgres |
| MCP + OAuth | `npm run test:mcp` | nothing (builds the app in-process) |
| REST API | `npm run test:api` | Postgres + a running server |

Unit tests live beside their code in `src/**/__tests__/`; the rest in `src/__integration__/`.
Integration tests are excluded from `npm test` so the unit run stays fast, and they **skip** rather
than fail when no database is reachable — "you didn't start Docker" is not a defect, and a suite
that reds for that reason is one people learn to ignore.

Use **fakes, not mocks**. The codebase injects narrow function types (`SimilaritySearch`,
`JudgePair`, `Synthesise`) rather than mocking modules, so a unit test exercises real code paths.

### Running a suite by hand

The individual commands assume a prepared database, and `test:api` also assumes a running app:

```bash
npm run db:up && npm run db:prepare   # throwaway Postgres on :55432, full schema
DB_PORT=55432 DB_PASSWORD=testonly npm run test:db
npm run db:down
```

Against a deployment you already have, `test:api` takes any URL:

```bash
OPENBRAIN_API_URL=https://your-host npm run test:api
```

It creates and deletes real data. Fine on a dev box, not something to point at a shared brain.

### Contract suites

`src/integration-suites/` holds assertions that an *implementation* must satisfy, exported as a
function taking a driver. `dream-port-contract.suite.ts` runs twice: against the in-memory fake in
the unit suite, and against real Postgres in the integration suite.

The fake exists so unit tests are fast. The shared suite exists so the fake cannot quietly drift
from the database it stands in for — a fake that drifts turns every unit test above it into a test
of a fiction. Add an assertion and both must satisfy it.

### The fake embedder

The API suite needs a live server, which needs an embedder. `scripts/fake-embedder-server.mjs`
speaks Ollama's wire format, so the app under test is unmodified — same `OllamaEmbedder`, same
routes, real Postgres. Only the model is fake. No test-only provider ships in `src/embedder/`.

Its vectors are hashed character trigrams: lexical, not semantic. `indexing` and `indexes` overlap;
`car` and `automobile` do not. Two settings make that workable, and both narrow what is proven:

- `OPENBRAIN_REQUIRE_SPECIFIC_TYPE=false` — the fake types everything as the catch-all, which
  capture discipline rejects by design. That gate has its own unit tests.
- `OPENBRAIN_SEARCH_THRESHOLD=0.15` — trigram similarity runs far below a real embedder's.

So the suites prove the retrieval **path** — capture, embed, store, search, rank, update, delete —
end to end against real Postgres. They do **not** prove embedding quality. Nothing automated does.

### What CI runs

Everything above except a live-deployment API run: the `integration-db` job provisions Postgres as a
service container and calls the same two scripts `test:all` does.

| Script | Does |
|--------|------|
| `scripts/prepare-database.js` | `init.sql`, legacy `001-003`, knex `004+`, then verifies the schema landed |
| `scripts/run-integration-tests.js` | every integration suite, owning the fake embedder and app processes |
| `scripts/test-all.js` | the above plus provisioning a database — local only |

One implementation of "how the suites run", rather than one in YAML and one on a laptop drifting
apart. CI steps name their test files explicitly instead of globbing `src/__integration__`, so a new
test cannot silently join CI without someone deciding what it needs to run against.

Migrations `001-003` predate knex and are untracked by it, so the schema chain applies all three
layers in order. Skipping the legacy layer leaves migration 003's provenance helpers absent and the
provenance suite fails with a confusing "column does not exist".

## Pull Request Process

1. Fork the repo and create a branch from `master`
2. Make your changes
3. Ensure all checks pass:
   ```bash
   npm run typecheck
   npm run build
   npm test
   ```
4. Open a PR using the [PR template](.github/pull_request_template.md)
5. Address any review feedback

## What We're Looking For

- Bug fixes with regression tests
- New MCP tools or REST endpoints (with tests)
- Performance improvements (with benchmarks)
- Documentation improvements
- New embedding provider integrations

## What We're NOT Looking For

- UI/frontend (Open Brain is backend-only)
- Breaking changes to existing API contracts
- New database tables (extend the existing `thoughts` table)
- Changes to embedding dimensions

## Questions?

Open a [Discussion](https://github.com/srnichols/OpenBrain/discussions) or reach out on [LinkedIn](https://www.linkedin.com/in/srnichols/).
