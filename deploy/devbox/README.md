# Docker Desktop Dev Box

A compose file tuned for **Windows / macOS Docker Desktop** with **Ollama running natively on the host**. Same architecture as the root `docker-compose.yml`, but with explicit `host.docker.internal` wiring and bind mounts that work from this nested directory.

**👉 Full walkthrough:** [docs/11-DOCKER-DESKTOP-DEVBOX.md](../../docs/11-DOCKER-DESKTOP-DEVBOX.md)

## Quick start

```bash
# From repo root
cp .env.example deploy/devbox/.env
# edit deploy/devbox/.env → set MCP_ACCESS_KEY

docker compose -f deploy/devbox/docker-compose.devbox.yml up -d

curl http://localhost:8000/health
curl http://localhost:8080/health
```

## How this differs from the root `docker-compose.yml`

| | Root `docker-compose.yml` | This dev box compose |
|---|---|---|
| Audience | Generic / Linux servers | Windows & macOS laptops |
| Ollama wiring | Whatever you put in `.env` | Defaults to `host.docker.internal:11434` |
| `extra_hosts` | Not set | Adds `host.docker.internal` for cross-platform parity |
| Migrations | Not auto-applied | Mounts `db/migrations/` for first-boot apply |
| Bind mount paths | Repo root | Relative to `deploy/devbox/` |
