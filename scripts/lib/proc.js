/**
 * Small helpers shared by the test scripts.
 *
 * These exist so the CI workflow can stay a list of `node scripts/x.js` calls
 * rather than a shell program embedded in YAML. YAML has no functions and no
 * error handling worth the name, and it is only ever exercised on a runner —
 * a bad place to discover a typo. The shell version of this orchestration
 * silently exited 0 on a `readonly` collision; that is the failure mode being
 * designed out.
 */

import { spawn } from "node:child_process";

/** Run a command, streaming its output. Rejects on any non-zero exit. */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

/** Start a long-running process and hand back a handle that can stop it. */
export function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  child.on("error", (error) => {
    console.error(`[start] ${command} failed: ${error.message}`);
  });
  return {
    child,
    stop() {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

/** Poll a URL until it answers, so a slow boot is not a flaky failure. */
export async function waitForHttp(label, url, attempts = 30, delayMs = 1000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${label} did not answer at ${url} after ${attempts} attempts`);
}

const BOLD = "\u001b[1m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const RESET = "\u001b[0m";

export function step(message) {
  console.log(`\n${BOLD}> ${message}${RESET}`);
}

export function done(message) {
  console.log(`\n${GREEN}> ${message}${RESET}`);
}

/** Run main(), reporting a failure as one clear line rather than a stack. */
export function cli(main) {
  main().catch((error) => {
    console.error(`\n${RED}x ${error.message}${RESET}`);
    process.exit(1);
  });
}
