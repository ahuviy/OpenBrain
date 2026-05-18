# Open Brain — Easy Setup Prompts

Paste any one of these prompts into **any** AI chat (VS Code Copilot Agent Mode, Claude Code, Claude Desktop, Cursor, ChatGPT with terminal/Codex, Gemini Code Assist, etc.) and it will install and configure Open Brain for you. **Zero manual steps** — the AI checks prerequisites, asks the few questions it needs, runs the commands, and verifies the result.

> 🆕 We now have a prompt for every supported deployment path. Pick the one that matches what you want.

---

## Pick your path

| If you want to… | Use this prompt | Time |
|-----------------|-----------------|------|
| Try Open Brain on your Win/Mac laptop, fully local | [🖥️ Docker Desktop dev box](#-docker-desktop-dev-box-prompt) | ~10 min |
| Run it on a Linux server / NAS / Pi | [🐳 Docker Compose (any Linux)](#-docker-compose-prompt-original) | ~10 min |
| Have it always-on in the cloud, $0–5/mo | [☁️ Cheap hosted (Fly + Supabase)](#-cheap-hosted-fly--supabase-prompt) | ~30 min |
| Deploy a homelab Kubernetes setup | [☸️ Kubernetes](#-kubernetes-prompt) | ~1 hour |
| Get a managed Azure deployment | [🚀 Azure](#-azure-prompt) | ~20 min |
| Have the AI pick for you | [🤔 Help me decide](#-help-me-decide-prompt) | ~2 min Q&A |

**Not sure which to use?** Start with the **🤔 Help me decide** prompt — it'll ask 3 questions and route you to the right path.

---

## 🤔 Help me decide prompt

```
I want to set up Open Brain (https://github.com/srnichols/OpenBrain) — a persistent
semantic memory backend for AI tools. Before we install anything, help me pick the
right deployment path by asking me these 3 questions ONE AT A TIME:

  1. Where will the AI tools you use live? (laptop only / multiple devices / phone too)
  2. Are you OK with your data on a managed cloud (Supabase / Azure), or does it
     need to stay on your own hardware?
  3. What's your monthly budget? ($0 only / $0-5 / $5-25)

Based on my answers, recommend ONE of these paths and link to its guide:
  - 🖥️ Docker Desktop dev box     → docs/11-DOCKER-DESKTOP-DEVBOX.md
  - 🐳 Docker Compose (Linux)     → README "Quick Start (Docker Compose)"
  - ☁️ Cheap hosted (Fly+Supabase) → docs/12-HOSTED-CHEAP.md
  - ☸️ Kubernetes                  → docs/09-SELF-HOSTED-K8S.md
  - 🚀 Azure                       → docs/10-AZURE-DEPLOYMENT.md

Then ask if I want you to proceed with the install for the recommended path. If yes,
follow the prompt from EASY-SETUP.md for that path exactly.
```

---

## 🖥️ Docker Desktop dev box prompt

For Windows or macOS laptops with Docker Desktop. Everything runs locally; Ollama is on the host. **Recommended starting point for most people.**

```
I want to set up Open Brain on my Docker Desktop laptop (Win or Mac), following
docs/11-DOCKER-DESKTOP-DEVBOX.md. Clone https://github.com/srnichols/OpenBrain.git
if not already present.

Steps — follow exactly, don't skip:

1. Check prerequisites:
   - Docker Desktop installed and running (docker info succeeds)
   - Ollama installed and running on host (curl http://localhost:11434/api/tags)
   - Node.js (for tests / mcp-remote)
   If Ollama is missing, tell me to install from https://ollama.com and pause.

2. Pull Ollama models (only if not already pulled):
   - ollama pull nomic-embed-text
   - ollama pull llama3.2

3. Ask me ONE question: which AI client to configure?
   (VS Code Copilot / Claude Desktop / Claude Code / Cursor / Windsurf / Skip)

4. Create .env from .env.example with:
   - MCP_ACCESS_KEY = 64-char hex (openssl rand -hex 32, or PowerShell equivalent)
   - DB_PASSWORD = random 32-char string
   - EMBEDDER_PROVIDER=ollama
   - EMBEDDING_DIMENSIONS=768
   - OLLAMA_ENDPOINT=http://host.docker.internal:11434
   - OLLAMA_EMBED_MODEL=nomic-embed-text
   - OLLAMA_LLM_MODEL=llama3.2

5. Start the stack: docker compose up -d --build

6. Verify health:
   - Poll http://localhost:8000/health every 2 sec until {"status":"healthy"} (timeout 60s)
   - curl http://localhost:8080/health → must also be healthy
   - If available, run: scripts/verify.ps1 http://localhost:8000  (or scripts/verify.sh)

7. Configure the AI client I chose, using http://localhost:8080/sse?key=<MCP_KEY>.
   Use the exact config snippets from README "Client Configuration".

8. Show me a summary: MCP URL (key masked), what's running, and a sample first prompt
   like: "Save this thought: I just set up Open Brain on my laptop."

If anything fails, show the error, suggest a fix from docs/TROUBLESHOOTING.md, and ask
how I want to proceed.
```

---

## 🐳 Docker Compose prompt (original)

For any Linux host (server, NAS, Raspberry Pi, VPS). Same shape as the dev box prompt but with no host-Ollama assumption.

```
I want to set up Open Brain via Docker Compose on a Linux host. Clone
https://github.com/srnichols/OpenBrain.git (or use the existing repo if already cloned).

Follow these steps exactly:

1. Check prerequisites: Docker, Docker Compose plugin, the daemon is running, and
   Node.js (needed for mcp-remote / integration tests).

2. Ask me these questions (wait for my answers before proceeding):
   - Which embedding provider? (ollama = free/local, openrouter = cloud/paid, azure-openai = Azure)
   - If openrouter: your API key
   - If azure-openai: your endpoint, key, embed deployment, LLM deployment
   - If ollama: where Ollama is reachable from inside the container (default
     http://host.docker.internal:11434, but on a Linux server it might be a LAN IP)
   - Which AI client should I configure? (VS Code Copilot / Claude Desktop / Claude Code / Skip)

3. Generate .env from .env.example:
   - MCP_ACCESS_KEY via openssl rand -hex 32
   - DB_PASSWORD via openssl rand -hex 16
   - DB_HOST=postgres
   - Embedder settings based on answers
   - EMBEDDING_DIMENSIONS=768 for ollama, 1536 for openrouter/azure

4. Start: docker compose up -d --build

5. Wait and verify health:
   - Poll http://localhost:8000/health until {"status":"healthy"} (timeout 60s)
   - Poll http://localhost:8080/health for the MCP server
   - Run scripts/verify.sh http://localhost:8000 if present

6. Configure the client I chose using the exact snippet from README "Client Configuration".

7. Verify end-to-end: tell me to ask the AI for "thought_stats" and confirm I see a
   stats response.

8. Show a summary: MCP URL (key masked), running containers, next steps.

If anything fails, show the error and suggest a fix from docs/TROUBLESHOOTING.md.
```

---

## ☁️ Cheap hosted (Fly + Supabase) prompt

Always-on, accessible from anywhere, ~$0–5/mo. Follows [docs/12-HOSTED-CHEAP.md](docs/12-HOSTED-CHEAP.md).

```
I want to deploy Open Brain to the cheap-hosted path (Supabase Postgres + Fly.io
for the MCP server + OpenRouter for embeddings), following docs/12-HOSTED-CHEAP.md.

Step 1 — Supabase Postgres:
  - Walk me through creating a free Supabase project (I'll click through the UI).
  - Once I have the project URL and password, modify db/init.sql so the vector
    column is vector(1536) instead of vector(768) (OpenRouter dims).
  - Have me paste init.sql into Supabase SQL Editor and run it. Then the files
    in db/migrations/ in order.
  - Have me copy the **pooled** connection string (port 6543) from Settings → Database.

Step 2 — Fly.io MCP server:
  - Check that flyctl is installed. If not, give me the install command for my OS.
  - From deploy/hosted/fly/, run: fly launch --copy-config --no-deploy --name openbrain-<my-handle>
    (ask me for <my-handle>).
  - Set secrets with `fly secrets set`:
      DATABASE_URL = the Supabase pooled URL from Step 1
      MCP_ACCESS_KEY = openssl rand -hex 32
      EMBEDDER_PROVIDER = openrouter
      OPENROUTER_API_KEY = <ask me; if I don't have one, link openrouter.ai/keys>
      EMBEDDING_DIMENSIONS = 1536
  - Run: fly deploy
  - Show me the URL fly assigned and curl https://<that-url>/health to verify.

Step 3 — AI client config:
  - Ask which client (VS Code Copilot / Claude Desktop / Claude Code / Skip).
  - Configure it with https://<fly-url>/sse?key=<MCP_KEY>.

Step 4 — End-to-end verification:
  - Run scripts/verify.sh https://<fly-url>  (or scripts/verify.ps1 on Windows).
  - Confirm all four checks pass.

Step 5 — Summary:
  - Show me: MCP URL (key masked), Fly app dashboard link, Supabase project link,
    estimated cost, and one example prompt to try.

If anything fails, show the error and suggest a fix from docs/TROUBLESHOOTING.md.
```

---

## ☸️ Kubernetes prompt

For homelabs and on-prem clusters. Follows [docs/09-SELF-HOSTED-K8S.md](docs/09-SELF-HOSTED-K8S.md).

```
I want to deploy Open Brain to my Kubernetes cluster, following
docs/09-SELF-HOSTED-K8S.md.

1. Check prerequisites: kubectl reachable, current context is the cluster I want
   (show me `kubectl config current-context` and confirm).

2. Ask me:
   - Storage class for the Postgres PVC (default: standard or whatever the cluster uses)
   - Should we expose via Tailscale Funnel, MetalLB, or ClusterIP only?
   - Will Ollama run inside the cluster, on the LAN, or use OpenRouter / Azure OpenAI?

3. Create deploy/on-prem/k8s/openbrain-secrets-actual.yaml from
   openbrain-secrets.yaml.example with:
     - MCP_ACCESS_KEY = 64-char hex (do not print to stdout)
     - DB_PASSWORD = random 32-char (do not print to stdout)
     - Any embedder API keys I provided

4. Apply manifests in this order:
     kubectl apply -f deploy/on-prem/k8s/namespace.yaml
     kubectl apply -f deploy/on-prem/k8s/openbrain-secrets-actual.yaml
     kubectl apply -f deploy/on-prem/k8s/postgres-statefulset.yaml
     kubectl rollout status statefulset/postgres -n openbrain
     kubectl apply -f deploy/on-prem/k8s/openbrain-api-deployment.yaml
     # plus the chosen service / Tailscale manifest

5. Wait for pods: kubectl get pods -n openbrain -w (until both Running and Ready).

6. Port-forward and verify: kubectl port-forward -n openbrain svc/openbrain-api 8080:8080
   then curl http://localhost:8080/health.

7. Tell me the public URL (Tailscale Funnel hostname, MetalLB IP, or "use port-forward").

8. Configure my AI client and show a one-line summary.

If anything fails, show kubectl logs / describe for the failing pod and suggest a fix.
```

---

## 🚀 Azure prompt

For managed cloud. Follows [docs/10-AZURE-DEPLOYMENT.md](docs/10-AZURE-DEPLOYMENT.md).

```
I want to deploy Open Brain to Azure using the Bicep IaC at deploy/azure/.
Follow docs/10-AZURE-DEPLOYMENT.md exactly.

1. Check prerequisites: Azure CLI installed and logged in (az account show),
   PowerShell 7+, psql client.

2. Ask me:
   - Resource group name (default: rg-openbrain)
   - Region (default: eastus2)
   - Subscription ID (default: current)
   - Container image (default: ghcr.io/srnichols/openbrain:latest)

3. Run the deploy script:
     .\deploy\azure\deploy.ps1 -ResourceGroup <rg> -Location <region> ...

   This generates secrets, deploys Bicep (~5-15 min), seeds the DB, and prints
   the MCP endpoint + key. Show me the script output as it runs.

4. Verify health: Invoke-RestMethod https://<app>.azurecontainerapps.io/health

5. Run integration tests:
     $env:OPENBRAIN_API_URL = "https://<app>.azurecontainerapps.io"
     npm run test:integration

6. Ask which AI client to configure and apply the config from README
   "Client Configuration" using the Azure URL.

7. Summary: MCP URL (key masked), Azure portal link, estimated monthly cost,
   one example prompt to try.

If deployment fails, show the Azure error message and suggest a fix from
docs/TROUBLESHOOTING.md → Azure section.
```

---

## Tips for getting the most out of these prompts

- **Run them in agent mode.** VS Code Copilot, Claude Code, Cursor agent — they can actually run the shell commands. Chat-only modes (Claude Desktop without MCP terminal, plain ChatGPT) will have you copy-paste commands manually.
- **Stay in the same chat.** If something fails halfway, fix it and keep going in the same conversation — the AI has all the context from earlier steps.
- **Pin the prompt.** In VS Code, save it as a `.prompt.md` file. In Cursor, drop it in `.cursorrules`. In Claude Projects, paste it as a project instruction.
- **After install, run `scripts/verify.{ps1,sh}` against your endpoint** for a 60-second sanity check. See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) if anything in the verify script fails.
