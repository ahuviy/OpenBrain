/**
 * Open Brain — Entry Point
 *
 * Starts both:
 * 1. Hono REST API server (port 8000)
 * 2. MCP server via Express (port 8080)
 *
 * The REST API provides direct HTTP access for testing, Slack webhooks,
 * and any non-MCP integrations.
 *
 * The MCP server is the primary interface for AI tools. It exposes the
 * Streamable HTTP transport at /mcp behind OAuth (claude.ai web + mobile) and
 * keeps the legacy SSE transport (/sse) with key auth for Desktop/Claude Code.
 */

import { serve } from "@hono/node-server";

import { initializeDatabase, closePool } from "./db/connection.js";
import { createApi } from "./api/routes.js";
import { createMcpHttpApp } from "./mcp/http-app.js";

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║           Open Brain v1.0.0              ║");
  console.log("║    Personal Semantic Memory System       ║");
  console.log("╚══════════════════════════════════════════╝");

  await initializeDatabase();

  // ── REST API Server (Hono) ──────────────────────────────────────

  const api = createApi();
  const apiPort = parseInt(process.env.API_PORT ?? "8000", 10);

  serve({ fetch: api.fetch, port: apiPort }, () => {
    console.log(`[api] REST API listening on http://0.0.0.0:${apiPort}`);
    console.log(`[api]   POST /memories         — capture thought`);
    console.log(`[api]   POST /memories/batch    — batch capture`);
    console.log(`[api]   POST /memories/search   — semantic search`);
    console.log(`[api]   POST /memories/list     — filtered listing`);
    console.log(`[api]   PUT  /memories/:id      — update thought`);
    console.log(`[api]   DELETE /memories/:id     — delete thought`);
    console.log(`[api]   GET  /stats             — brain statistics`);
    console.log(`[api]   GET  /health            — health check`);
  });

  // ── MCP Server (Express) ────────────────────────────────────────

  const mcpPort = parseInt(process.env.MCP_PORT ?? "8080", 10);
  const mcpApp = createMcpHttpApp({
    mcpAccessKey: process.env.MCP_ACCESS_KEY ?? "",
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
  });

  mcpApp.listen(mcpPort, "0.0.0.0", () => {
    console.log(`[mcp] MCP server listening on http://0.0.0.0:${mcpPort}`);
    console.log(`[mcp]   POST /mcp                — Streamable HTTP (OAuth)`);
    console.log(`[mcp]   GET  /sse                — legacy SSE (key)`);
    console.log(`[mcp]   POST /messages           — legacy JSON-RPC`);
    console.log(`[mcp]   GET  /health             — health check`);
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack : reason);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.stack ?? err.message);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[shutdown] Received SIGINT, closing...");
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[shutdown] Received SIGTERM, closing...");
  await closePool();
  process.exit(0);
});

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
