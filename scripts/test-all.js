#!/usr/bin/env node
/**
 * Every test in the repository, from nothing.
 *
 * Self-contained on purpose: the API suite needs a running app, which needs a
 * database and an embedder, and a script that assumed those were up would fail
 * in a way that looks like a broken test rather than a missing dependency.
 *
 * Tears down only what it started. A database you were already running is left
 * exactly as it was, because destroying a developer's container to tidy up after
 * a test run is a rude surprise.
 *
 * CI does not use this — it gets its Postgres from a service container and calls
 * prepare-database.js and run-integration-tests.js directly. Those two scripts
 * are the shared part; this one only adds "and provision a database first".
 */

import { execFileSync } from "node:child_process";

import { cli, done, run, step } from "./lib/proc.js";

const CONTAINER = "openbrain-testdb";
const PORT = process.env.DB_PORT ?? "55432";
const IMAGE = "pgvector/pgvector:pg17";

const dbEnv = {
  ...process.env,
  DB_HOST: "localhost",
  DB_PORT: PORT,
  DB_NAME: "openbrain",
  DB_USER: "openbrain",
  DB_PASSWORD: "testonly",
  EMBEDDING_DIMENSIONS: process.env.EMBEDDING_DIMENSIONS ?? "768",
};

const quiet = (command, args, env = process.env) => {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env });
  } catch {
    return "";
  }
};

const dockerAvailable = () => quiet("docker", ["info"]) !== "";
const containerRunning = () =>
  quiet("docker", ["ps", "--format", "{{.Names}}"]).split("\n").includes(CONTAINER);

async function startDatabase() {
  quiet("docker", ["rm", "-f", CONTAINER]);
  await run("docker", [
    "run", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_DB=openbrain",
    "-e", "POSTGRES_USER=openbrain",
    "-e", "POSTGRES_PASSWORD=testonly",
    "-p", `${PORT}:5432`,
    IMAGE,
  ], { stdio: "ignore" });

  // Probe over TCP from the host, not `docker exec pg_isready`. The official
  // image starts a temporary server on the unix socket to run initdb, then stops
  // it and restarts for real — an in-container probe passes against that
  // temporary server, and the next command dies with "server closed the
  // connection unexpectedly". Only a TCP connection proves the real one is up.
  const probe = { ...process.env, PGPASSWORD: "testonly" };
  for (let attempt = 1; attempt <= 60; attempt++) {
    const ok = quiet("psql", [
      "-h", "localhost", "-p", PORT, "-U", "openbrain", "-d", "openbrain",
      "-tAc", "SELECT 1",
    ], probe);
    if (ok.trim() === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${CONTAINER} did not accept TCP connections`);
}

cli(async () => {
  // Unit tests need nothing, so run them first: a syntax error fails in seconds
  // rather than after a container pull.
  step("Unit tests");
  await run("npm", ["run", "test:unit"]);

  if (!dockerAvailable()) {
    throw new Error(
      "Docker is not available, so only unit tests ran. Start Docker and re-run for full coverage.",
    );
  }

  let started = false;
  try {
    step("Database");
    if (containerRunning()) {
      console.log(`  reusing running ${CONTAINER}`);
    } else {
      await startDatabase();
      started = true;
      console.log(`  started ${CONTAINER} on :${PORT}`);
    }

    await run("node", ["scripts/prepare-database.js"], { env: dbEnv });

    step("Build");
    await run("npm", ["run", "build"]);

    await run("node", ["scripts/run-integration-tests.js"], { env: dbEnv });

    done("All suites passed");
  } finally {
    if (started) {
      quiet("docker", ["rm", "-f", CONTAINER]);
      console.log(`\n  removed ${CONTAINER}`);
    }
  }
});
