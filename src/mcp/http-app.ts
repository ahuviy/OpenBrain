/**
 * Express application for the MCP server (port 8080, the public Fly surface).
 *
 * Serves three concerns:
 *   1. /health                       — liveness (shallow) + deep dependency probe
 *   2. OAuth 2.1 + Streamable HTTP    — /mcp behind Bearer auth, plus the SDK's
 *      authorize/token/register/revoke + discovery metadata (claude.ai web/mobile)
 *   3. Legacy SSE (/sse + /messages) — key auth, kept for Desktop/Claude Code/ChatGPT
 *
 * OAuth is mounted only when PUBLIC_BASE_URL and MCP_ACCESS_KEY are both set;
 * otherwise the server still runs with health + legacy SSE.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import express from "express";
import { rateLimit } from "express-rate-limit";

import { getPool } from "../db/connection.js";
import { notifyFailure } from "../notify.js";
import { createMcpServer } from "./server.js";
import { handleStreamableRequest } from "./streamable.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { PgOAuthStore } from "../oauth/store.js";
import { OpenBrainOAuthProvider } from "../oauth/provider.js";

export interface McpAppOptions {
  mcpAccessKey: string;
  publicBaseUrl?: string;
  provider?: OpenBrainOAuthProvider;
}

export function createMcpHttpApp(options: McpAppOptions): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-brain-key, Mcp-Session-Id, Mcp-Protocol-Version"
    );
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  registerHealth(app);
  registerOAuth(app, options);
  registerLegacySse(app, options.mcpAccessKey);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

function registerHealth(app: express.Express): void {
  app.get("/health", async (req, res) => {
    if (req.query.deep === undefined) {
      res.status(200).json({ status: "healthy", service: "open-brain-mcp" });
      return;
    }

    const checks: Record<string, string> = {};

    try {
      await getPool().query("SELECT 1");
      checks.db = "ok";
    } catch (err) {
      checks.db = err instanceof Error ? `error: ${err.message}` : "error";
    }

    try {
      const orRes = await fetch("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` },
        signal: AbortSignal.timeout(4000),
      });
      const orJson = (await orRes.json()) as {
        data?: { total_credits?: number; total_usage?: number };
      };
      const remaining =
        (orJson.data?.total_credits ?? 0) - (orJson.data?.total_usage ?? 0);
      if (!orRes.ok) checks.openrouter = `error: http ${orRes.status}`;
      else if (remaining <= 0) checks.openrouter = "error: no credit remaining";
      else if (remaining < 1) checks.openrouter = `low: $${remaining.toFixed(2)} remaining`;
      else checks.openrouter = `ok: $${remaining.toFixed(2)} remaining`;
    } catch (err) {
      checks.openrouter = err instanceof Error ? `error: ${err.message}` : "error";
    }

    const healthy = Object.values(checks).every((v) => !v.startsWith("error"));
    if (!healthy) {
      notifyFailure(
        "⚠️ Open Brain DOWN",
        Object.entries(checks)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      );
    }
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "healthy" : "unhealthy",
      service: "open-brain-mcp",
      checks,
    });
  });
}

function registerOAuth(app: express.Express, options: McpAppOptions): void {
  const { mcpAccessKey, publicBaseUrl } = options;

  if (!publicBaseUrl) {
    console.warn(
      "[mcp] PUBLIC_BASE_URL unset — OAuth + /mcp disabled (legacy /sse still available)"
    );
    return;
  }
  if (!mcpAccessKey) {
    console.warn("[mcp] MCP_ACCESS_KEY unset — OAuth + /mcp disabled");
    return;
  }

  const issuer = publicBaseUrl.replace(/\/+$/, "");
  const resource = `${issuer}/mcp`;

  try {
    const provider =
      options.provider ??
      new OpenBrainOAuthProvider(new PgOAuthStore(), {
        issuer,
        resource,
        ownerKey: mcpAccessKey,
      });

    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL(issuer),
        resourceServerUrl: new URL(resource),
        resourceName: "Open Brain",
      })
    );

    const loginRateLimit = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 15,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "too_many_requests" },
    });

    app.post(
      "/oauth/login",
      loginRateLimit,
      express.urlencoded({ extended: false }),
      async (req, res) => {
        await provider.handleLogin(req.body, res);
      }
    );

    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(resource));
    const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

    app.post("/mcp", bearer, async (req, res) => {
      try {
        await handleStreamableRequest(
          req as IncomingMessage & { auth?: AuthInfo },
          res as unknown as ServerResponse
        );
      } catch (err) {
        console.error("[mcp] request error:", err instanceof Error ? err.message : err);
        if (!res.headersSent) res.status(500).json({ error: "internal_error" });
      }
    });
    app.get("/mcp", (_req, res) => res.status(405).json({ error: "method_not_allowed" }));
    app.delete("/mcp", (_req, res) => res.status(405).json({ error: "method_not_allowed" }));

    const pruneTimer = setInterval(() => {
      provider.pruneExpired().catch((err) =>
        console.error("[oauth] prune error:", err instanceof Error ? err.message : err)
      );
    }, 60 * 60 * 1000);
    pruneTimer.unref();

    console.log(`[mcp] OAuth + Streamable HTTP enabled — resource ${resource}`);
  } catch (err) {
    console.error(
      "[mcp] OAuth disabled — misconfiguration:",
      err instanceof Error ? err.message : err
    );
  }
}

function registerLegacySse(app: express.Express, mcpAccessKey: string): void {
  const transports = new Map<string, SSEServerTransport>();

  app.get("/sse", async (req, res) => {
    const key = (req.headers["x-brain-key"] as string | undefined) ?? (req.query.key as string | undefined);
    if (mcpAccessKey && key !== mcpAccessKey) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const transport = new SSEServerTransport("/messages", res as unknown as ServerResponse);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    res.on("close", () => {
      transports.delete(sessionId);
      console.log(`[mcp] SSE session ${sessionId} closed`);
    });

    const server = createMcpServer();
    await server.connect(transport);
    console.log(`[mcp] SSE session ${sessionId} connected`);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({ error: "No active session. Connect to /sse first." });
      return;
    }
    await transport.handlePostMessage(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse
    );
  });
}
