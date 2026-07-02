# My Deployment — Hosted Open Brain + Monitoring + Alerting

Personal always-on deployment of this fork: **Fly.io** (server) + **Supabase** (Postgres/pgvector) + **OpenRouter** (embeddings), with proactive monitoring and loud phone alerts.

> **Public repo — no secrets here.** Every credential lives as a Fly secret or in a password manager. This doc uses placeholders (`<...>`). Never commit the real connection string, API keys, `MCP_ACCESS_KEY`, or the ntfy topic.

## Architecture

```
Any AI client (phone / laptop / ChatGPT)
        │  HTTPS + MCP SSE  (…/sse?key=<MCP_ACCESS_KEY>)
        ▼
Fly.io machine  "openbrain-ahuvi"  (region lhr, suspends when idle)
   ├── pgvector queries ─────────▶ Supabase Postgres (eu-west-1)
   ├── embeddings + metadata ────▶ OpenRouter (text-embedding-3-small, gpt-4o-mini)
   └── failure push ─────────────▶ ntfy → phone

GitHub Actions cron (ahuviy/openbrain-monitor, every 30 min)
        │  GET /health?deep=1
        ▼  200 = ok · 503 = down → workflow fails → GitHub emails
Fly machine (deep probe also pushes ntfy on failure)
```

Costs ~$0/mo: Fly suspends between uses (pennies), Supabase + OpenRouter + GitHub Actions on free tiers, OpenRouter usage ~$0.15/mo.

## Components

| Piece | Value | Notes |
|---|---|---|
| Fly app | `openbrain-ahuvi` | region `lhr`, `shared-cpu-1x@256`, `auto_stop=suspend`, `min_machines_running=0` |
| Fly config | `deploy/hosted/fly/fly.toml` | single service (MCP 8080 → https 443); REST 8000 stays internal |
| Dockerfile | root `Dockerfile` | `fly.toml` points at it via `dockerfile = '../../../Dockerfile'` |
| DB | Supabase Postgres, `eu-west-1` | schema from `db/init-openrouter-1536.sql` (vector 1536 for OpenRouter) |
| Embeddings | OpenRouter | `text-embedding-3-small` (1536-dim), metadata via `gpt-4o-mini` |
| Monitor | `ahuviy/openbrain-monitor` | GH Actions cron, `curl -f` deep health every 30 min |
| Alerts | ntfy | server pushes on failure; subscribe the topic in the ntfy app |

## Secrets (Fly + password manager)

Set as Fly secrets (`fly secrets set … --app openbrain-ahuvi`); never in files:

| Secret | Purpose |
|---|---|
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` `DB_SSL=true` | Supabase connection (this code reads discrete vars, **not** `DATABASE_URL`) |
| `EMBEDDER_PROVIDER=openrouter` `OPENROUTER_API_KEY` `OPENROUTER_EMBED_MODEL` `OPENROUTER_LLM_MODEL` `EMBEDDING_DIMENSIONS=1536` | Embeddings |
| `MCP_ACCESS_KEY` | Client auth (`…/sse?key=<MCP_ACCESS_KEY>`) |
| `NTFY_URL` | `https://ntfy.sh/<secret-topic>` — enables failure push (unset = no-op) |

Keep in a password manager (Fly can't show them again): `MCP_ACCESS_KEY`, Supabase DB password, `OPENROUTER_API_KEY`, ntfy topic.

## Health endpoints (`src/index.ts`)

- `GET /health` — shallow: process alive. Used by Fly's liveness check (kept cheap).
- `GET /health?deep=1` — probes DB (`SELECT 1`) + OpenRouter credit. Returns `200` healthy or `503` with a per-component breakdown, e.g.:

  ```json
  {"status":"unhealthy","service":"open-brain-mcp",
   "checks":{"db":"ok","openrouter":"error: no credit remaining"}}
  ```

  Flags `low: $X remaining` (still 200) when OpenRouter credit < $1. On `unhealthy` it also fires an ntfy push. No auth (booleans only, no secrets).

## Alerting (`src/notify.ts`)

`notifyFailure(title, message)` POSTs to `NTFY_URL` with `Priority: urgent` → loud phone notification. Fire-and-forget; failures swallowed so alerting never breaks the request. The `Title` header is ASCII-sanitized (HTTP headers are Latin-1; emoji would make undici throw); the emoji title is preserved in the body.

Wired at three choke points:
- **MCP tool error** — `src/mcp/server.ts` CallTool outer catch (also returns `❌ OPEN BRAIN DOWN — <reason>` so any client, incl. phone, shows a clear message).
- **REST error** — `src/api/routes.ts` `app.onError`.
- **Deep health unhealthy** — `src/index.ts`. Driven proactively by the cron, so alerts fire even with no client active.

Server→ntfy→phone is the only app-independent way to get a *loud* phone alert; the Claude app itself can't be forced to play a sound by the server.

### Subscribe your phone
1. Install the **ntfy** app (iOS/Android).
2. Subscribe to the topic (the one in `NTFY_URL`; server `ntfy.sh`).
3. The topic is the only secret — anyone who knows it can read alert text (error strings only, no data/keys).

## Extra: Claude Code loud alert (local, this machine only)

`~/.claude/settings.json` has `PostToolUse` + `PostToolUseFailure` hooks matching `mcp__open-brain__.*` that play a macOS sound + banner when an open-brain MCP call fails in Claude Code. Reactive (only on use), Mac-only — complements the server-side push.

## Deploy / update

```bash
# from repo root
npm ci && npm run build            # typecheck locally first
fly deploy . --config deploy/hosted/fly/fly.toml --app openbrain-ahuvi
```

Set/rotate a secret (triggers a rolling restart):

```bash
fly secrets set MCP_ACCESS_KEY="$(openssl rand -hex 32)" --app openbrain-ahuvi
# rotating MCP_ACCESS_KEY → update every client's ?key=… too
```

Verify:

```bash
curl -s "https://openbrain-ahuvi.fly.dev/health?deep=1"   # expect 200 + checks:ok
```

## Recovery (lost laptop)

Nothing critical is laptop-only. Re-clone this fork, restore the secrets from your password manager (`fly secrets set …`), `fly deploy`. Data lives in Supabase; the running service is unaffected by losing the laptop.

## Staying current with upstream

```bash
git fetch upstream && git merge upstream/master
```

`origin` = this fork, `upstream` = `srnichols/OpenBrain`.
