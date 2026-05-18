# Open Brain on Fly.io

A ready-to-deploy `fly.toml` for running the Open Brain MCP + REST server on a free-tier Fly.io machine. **Bring your own Postgres** (Supabase, Neon, Railway, or Fly Postgres) — see [docs/12-HOSTED-CHEAP.md](../../../docs/12-HOSTED-CHEAP.md) for the full walkthrough.

## Quick deploy

```bash
# 1. Install flyctl
#    Windows:  iwr https://fly.io/install.ps1 -useb | iex
#    macOS:    brew install flyctl
fly auth signup    # or `fly auth login`

# 2. From the repo root:
cd deploy/hosted/fly
fly launch --copy-config --no-deploy --name openbrain-<your-handle>

# 3. Set secrets (these become env vars in the container)
fly secrets set \
  DATABASE_URL='postgresql://...your hosted Postgres URL...' \
  MCP_ACCESS_KEY="$(openssl rand -hex 32)" \
  EMBEDDER_PROVIDER=openrouter \
  OPENROUTER_API_KEY='sk-or-...' \
  EMBEDDING_DIMENSIONS=1536

# 4. Deploy
fly deploy
```

Your MCP endpoint: `https://openbrain-<your-handle>.fly.dev/sse?key=<YOUR_MCP_ACCESS_KEY>`

## Cost

Stays in Fly's free allowance with the defaults:

- `shared-cpu-1x` @ 256 MB
- `auto_stop_machines = "suspend"` (suspends when idle, ~1 sec wake-up)
- `primary_region = "iad"` (change to one close to you and your DB)

## Pick a region

Set `primary_region` in `fly.toml` to one close to **both** you and your Postgres. Common picks:

| You're in | Region |
|-----------|--------|
| US East | `iad` (Ashburn) |
| US West | `sjc` (San Jose) |
| Europe | `ams` (Amsterdam) / `lhr` (London) |
| APAC | `nrt` (Tokyo) / `syd` (Sydney) |

Full list: `fly platform regions`.
