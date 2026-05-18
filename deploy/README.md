# Deploy

Configurations and scripts for every supported Open Brain deployment path.

| Folder | Path | Guide |
|--------|------|-------|
| [`devbox/`](devbox/) | Docker Desktop on a Win/Mac dev laptop | [docs/11-DOCKER-DESKTOP-DEVBOX.md](../docs/11-DOCKER-DESKTOP-DEVBOX.md) |
| [`hosted/`](hosted/) | Cheap hosted PaaS (Fly · Render · Railway) + managed Postgres | [docs/12-HOSTED-CHEAP.md](../docs/12-HOSTED-CHEAP.md) |
| [`on-prem/docker/`](on-prem/docker/) | Docker Compose on a Linux server / NAS / Pi | [README — Quick Start](../README.md#quick-start-docker-compose) |
| [`on-prem/k8s/`](on-prem/k8s/) | Kubernetes manifests (homelab) | [docs/09-SELF-HOSTED-K8S.md](../docs/09-SELF-HOSTED-K8S.md) |
| [`azure/`](azure/) | Bicep IaC + `deploy.ps1` | [docs/10-AZURE-DEPLOYMENT.md](../docs/10-AZURE-DEPLOYMENT.md) |

> **AWS / GCP?** No native IaC yet, but the application code is provider-agnostic. See [docs/10-AZURE-DEPLOYMENT.md → Equivalents on AWS & GCP](../docs/10-AZURE-DEPLOYMENT.md#equivalents-on-aws--gcp) for a service-by-service mapping. PRs welcome.

See [README — Choose Your Deployment Path](../README.md#choose-your-deployment-path) for help picking one.
