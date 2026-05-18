# Hosted deploy templates

Ready-to-go config for running the Open Brain MCP + REST server on cheap, hosted PaaS providers. Pair with a managed Postgres (Supabase, Neon, etc.) for a fully always-on, low-cost setup.

**👉 Full walkthrough:** [docs/12-HOSTED-CHEAP.md](../../docs/12-HOSTED-CHEAP.md)

| Host | Template | Free tier | Cold starts | Best for |
|------|----------|-----------|-------------|----------|
| **Fly.io** | [`fly/`](fly/) | ✅ 3 small VMs | ~1 sec from suspend | **Recommended** — best price/perf |
| **Render** | [`render/`](render/) | ✅ sleeps after 15 min | ~30 sec cold start | Easy UI, fine for personal use |
| **Railway** | [`railway/`](railway/) | $5 trial, then ~$5/mo | None (always-on) | One-stop deploy (PG + MCP together) |

All three templates expect you to bring your own Postgres connection string. See [docs/12-HOSTED-CHEAP.md → Step 1](../../docs/12-HOSTED-CHEAP.md#step-1--pick-a-postgres-provider) for picking a Postgres provider.
