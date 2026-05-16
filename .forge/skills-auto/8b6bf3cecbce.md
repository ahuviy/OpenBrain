---
sha256Prefix: 8b6bf3cecbce
summary: "Wire `pforge-sdk/hallmark` into `package.json` + integration test for the migration"
createdAt: 2026-05-16T13:48:59.063Z
reuseCount: 0
contextSignature:
  sliceType: test
  titleHash: 23678c3c
  planBasename: Phase-PROVENANCE-PLAN
  domainKeywords: ["database migration patterns", "testing patterns conventions"]
commands:
  - "npx vitest run --config vitest.integration.config.ts src/__integration__/provenance.test.ts --reporter=dot && echo ok"
---

# Auto-skill: Wire `pforge-sdk/hallmark` into `package.json` + integration test for the migration

Captured by Plan-Forge Phase-25 auto-skill library (L2).
Reuse this recipe when a future slice matches the domain keywords above.

## Commands that worked

```
npx vitest run --config vitest.integration.config.ts src/__integration__/provenance.test.ts --reporter=dot && echo ok
```
