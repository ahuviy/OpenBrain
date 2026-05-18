# Open Brain on Render

A `render.yaml` blueprint for one-click deploy to Render's free tier. **Bring your own Postgres** — see [docs/12-HOSTED-CHEAP.md](../../../docs/12-HOSTED-CHEAP.md) for the full walkthrough.

## Quick deploy

1. **Fork** [`srnichols/OpenBrain`](https://github.com/srnichols/OpenBrain) on GitHub.
2. Go to [render.com](https://render.com) → **New → Blueprint** → connect your fork.
3. Render reads `deploy/hosted/render/render.yaml` and provisions the service.
4. In the service settings, fill in the three `sync: false` env vars:
   - `DATABASE_URL` — connection string from Supabase / Neon / Render Postgres
   - `MCP_ACCESS_KEY` — generate with `openssl rand -hex 32`
   - `OPENROUTER_API_KEY` — get one at [openrouter.ai/keys](https://openrouter.ai/keys)
5. Trigger deploy. ~3 minutes later you have an HTTPS URL.

Your MCP endpoint: `https://openbrain-<unique>.onrender.com/sse?key=<YOUR_MCP_ACCESS_KEY>`

## Caveats

- **Free tier sleeps after 15 minutes of inactivity** — first request after a nap takes ~30 seconds. For an always-warm service, upgrade to **Starter** (~$7/mo).
- Render's free Postgres **expires after 90 days**. Use Supabase or Neon for the database to avoid this.
- The blueprint exposes the MCP port (8080) as the primary HTTPS endpoint. The REST API (8000) is only reachable from inside the same Render service — fine for personal use, since AI clients only need MCP.
