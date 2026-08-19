#!/usr/bin/env node
/**
 * Ollama-wire-compatible embedder, for integration tests and CI.
 *
 * The API integration suite exercises capture, search and stats — all of which
 * need an embedder. Pointing CI at a real provider would make the suite cost
 * money, need a secret, and fail whenever someone else's service is down. A real
 * model is also the wrong dependency to test against: these tests assert HTTP
 * contracts and SQL behaviour, not embedding quality.
 *
 * It speaks Ollama's wire format rather than exposing a "stub" provider inside
 * src/embedder, so no test-only code path ships in production and the provider
 * abstraction stays honest — the app runs the SAME OllamaEmbedder it always does.
 *
 * The vector is hashed character trigrams, so texts sharing substrings land near
 * each other — "indexing" and "indexes" overlap, which whole-token hashing misses.
 * That is LEXICAL, not semantic: "car" and "automobile" are orthogonal here where
 * a real model puts them together, and absolute similarities run far lower than a
 * real embedder's. CI therefore lowers OPENBRAIN_SEARCH_THRESHOLD. What that buys
 * is a real test of the PLUMBING — capture, embed, store, retrieve, rank — and it
 * is deterministic, so a pass is reproducible rather than lucky. It is NOT a test
 * of embedding quality, and a test needing true synonym matching must not use it.
 *
 * Usage: node scripts/fake-embedder-server.mjs [--port 11434] [--dimensions 768]
 */

import http from "node:http";
import { createHash } from "node:crypto";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const PORT = Number(arg("port", process.env.FAKE_EMBEDDER_PORT ?? 11434));
const DIMENSIONS = Number(arg("dimensions", process.env.EMBEDDING_DIMENSIONS ?? 768));

const TRIGRAM = 3;

/** Stable dimension index for a substring. */
function dimensionFor(gram) {
  return createHash("sha256").update(gram).digest().readUInt32BE(0) % DIMENSIONS;
}

/** Unit-norm hashed character trigrams, so cosine tracks substring overlap. */
function embed(text) {
  const normalised = ` ${String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const raw = new Array(DIMENSIONS).fill(0);

  for (let i = 0; i + TRIGRAM <= normalised.length; i++) {
    raw[dimensionFor(normalised.slice(i, i + TRIGRAM))] += 1;
  }

  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

const readJson = (req) =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
    });
  });

const send = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, { status: "fake-embedder ok", dimensions: DIMENSIONS });
  }

  if (req.method === "POST" && url.pathname === "/api/embed") {
    const { input } = await readJson(req);
    const inputs = Array.isArray(input) ? input : [input ?? ""];
    return send(res, 200, { embeddings: inputs.map(embed) });
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const { messages = [] } = await readJson(req);
    const system = messages.find((m) => m.role === "system")?.content ?? "";

    // Metadata extraction and dream's judgments share this endpoint; the system
    // prompt is what distinguishes them.
    if (system.includes("verdict")) {
      return send(res, 200, {
        message: { content: JSON.stringify({ verdict: "independent", reason: "fake embedder" }) },
      });
    }
    if (system.includes("single statement") || system.includes("ties them together")) {
      return send(res, 200, { message: { content: "fake synthesis" } });
    }
    return send(res, 200, {
      message: {
        content: JSON.stringify({
          type: "observation", topics: [], people: [], action_items: [], dates: [],
        }),
      },
    });
  }

  send(res, 404, { error: `no fake route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, () => {
  console.log(`[fake-embedder] listening on :${PORT} (${DIMENSIONS} dimensions)`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
