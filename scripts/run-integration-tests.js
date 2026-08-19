#!/usr/bin/env node
/**
 * Every integration suite, against a database that is already prepared.
 *
 * Assumes `prepare-database.js` has run. Owns the two processes the API suite
 * needs — a fake embedder and the app itself — and stops them on the way out,
 * whether the suites passed, failed, or the run was interrupted.
 *
 * Used by CI and by `npm run test:all`, so there is one implementation of "how
 * the integration suites are run" rather than one in YAML and one on a laptop
 * that drift apart.
 *
 * Suites are named explicitly rather than globbing src/__integration__, so a new
 * test cannot silently join the run without someone deciding what it needs.
 */

import { cli, done, run, start, step, waitForHttp } from "./lib/proc.js";

const EMBEDDER_PORT = process.env.FAKE_EMBEDDER_PORT ?? "11434";
const APP_PORT = process.env.API_PORT ?? "8000";

/**
 * The fake types every capture as the catch-all, which capture discipline
 * rejects by design, and its trigram similarities run below the stock search
 * threshold. Both gates have their own unit tests; relaxing them here keeps the
 * retrieval PATH under test instead of asserting the fake's opinions.
 */
const appEnv = {
  ...process.env,
  EMBEDDER_PROVIDER: "ollama",
  OLLAMA_ENDPOINT: `http://localhost:${EMBEDDER_PORT}`,
  OLLAMA_EMBED_MODEL: "fake",
  OLLAMA_LLM_MODEL: "fake",
  API_PORT: APP_PORT,
  MCP_PORT: process.env.MCP_PORT ?? "8080",
  MCP_ACCESS_KEY: process.env.MCP_ACCESS_KEY ?? "test-not-a-secret",
  LOG_LEVEL: "error",
  OPENBRAIN_REQUIRE_SPECIFIC_TYPE: "false",
  OPENBRAIN_SEARCH_THRESHOLD: "0.15",
};

const running = [];

function stopAll() {
  while (running.length > 0) running.pop().stop();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopAll();
    process.exit(1);
  });
}

cli(async () => {
  try {
    step("Database integration tests");
    await run("npm", ["run", "test:db"]);

    step("Provenance integration tests");
    await run("npm", ["run", "test:provenance"]);

    // In-process: these build the Hono/MCP app themselves and need no server.
    step("MCP + OAuth integration tests");
    await run("npm", ["run", "test:mcp"]);

    step("Fake embedder");
    running.push(start("node", ["scripts/fake-embedder-server.mjs", "--port", EMBEDDER_PORT]));
    await waitForHttp("fake embedder", `http://localhost:${EMBEDDER_PORT}/`);

    step("Open Brain");
    running.push(start("node", ["dist/index.js"], { env: appEnv }));
    await waitForHttp("app", `http://localhost:${APP_PORT}/health`);

    step("API integration tests");
    await run("npm", ["run", "test:api"], {
      env: { ...process.env, OPENBRAIN_API_URL: `http://localhost:${APP_PORT}` },
    });

    done("All integration suites passed");
  } finally {
    stopAll();
  }
});
