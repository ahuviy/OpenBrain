# Open Brain on Railway

Railway's strength is putting the Postgres database and the MCP server side-by-side in the same project — *one* dashboard, *one* bill, lowest possible latency between the two.

**👉 Full walkthrough:** [docs/12-HOSTED-CHEAP.md](../../../docs/12-HOSTED-CHEAP.md)

## Quick deploy

### Option A — From the UI (easiest)

1. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → pick your fork of OpenBrain.
2. Railway auto-detects the `Dockerfile`. The `railway.json` here sets the health check path and start command.
3. In the same project: **+ New → Database → PostgreSQL**.
4. Open the Postgres service → **Data** → run [`db/init.sql`](../../../db/init.sql) and the files in [`db/migrations/`](../../../db/migrations/).
5. On the Open Brain service → **Variables**, set:
   - `DATABASE_URL` — click **Add Reference** → pick the Postgres service's `DATABASE_URL`
   - `MCP_ACCESS_KEY` — paste output of `openssl rand -hex 32`
   - `EMBEDDER_PROVIDER` — `openrouter`
   - `OPENROUTER_API_KEY` — from [openrouter.ai/keys](https://openrouter.ai/keys)
   - `EMBEDDING_DIMENSIONS` — `1536`
   - `MCP_PORT` — `8080`
6. **Settings → Networking → Generate Domain** → pick port `8080`. That's your MCP endpoint.

### Option B — From the CLI

```bash
npm i -g @railway/cli
railway login
railway init                  # creates a project
railway add --database postgres
railway up                    # deploys this directory
railway variables --set DATABASE_URL='${{Postgres.DATABASE_URL}}' \
                  --set MCP_ACCESS_KEY="$(openssl rand -hex 32)" \
                  --set EMBEDDER_PROVIDER=openrouter \
                  --set OPENROUTER_API_KEY='sk-or-...' \
                  --set EMBEDDING_DIMENSIONS=1536 \
                  --set MCP_PORT=8080
railway domain
```

## Cost

- $5 trial credit, then ~$5/mo with the **Hobby** plan for the smallest Postgres + a small Open Brain instance.
- No cold starts — always-on. This is what you're paying for vs. Render free / Fly suspended.

## Notes

- Railway's default Postgres image now includes pgvector. If `CREATE EXTENSION vector` fails, switch the service's source image to `pgvector/pgvector:pg17` in **Settings → Source**.
- Reference variables (`${{Postgres.DATABASE_URL}}`) are recomputed on deploy — you don't need to copy/paste the URL when the password rotates.
