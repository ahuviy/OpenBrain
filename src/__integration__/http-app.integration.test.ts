/**
 * In-process HTTP tests for the MCP Express app wiring (no Postgres).
 *
 * Covers the contracts the OAuth flow tests don't: the OAuth-disabled fallback
 * (PUBLIC_BASE_URL unset), the legacy SSE key gate, /messages session guard,
 * and the /mcp method guards.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { InMemoryOAuthStore } from "../oauth/store.js";
import { OpenBrainOAuthProvider } from "../oauth/provider.js";
import { createMcpHttpApp } from "../mcp/http-app.js";

const OWNER = "http-app-owner-key-abcdef0123";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRaw(base: string) {
  return function raw(
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; body?: string } = {}
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, base);
      const req = http.request(
        { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: opts.headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
          );
        }
      );
      req.on("error", reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  };
}

async function listen(app: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on("request", app);
  return { server, base: `http://localhost:${port}` };
}

describe("MCP HTTP app — OAuth disabled (PUBLIC_BASE_URL unset)", () => {
  let server: http.Server;
  let raw: ReturnType<typeof makeRaw>;

  beforeAll(async () => {
    const app = createMcpHttpApp({ mcpAccessKey: OWNER });
    const started = await listen(app);
    server = started.server;
    raw = makeRaw(started.base);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("still serves health", async () => {
    const res = await raw("GET", "/health");
    expect(res.status).toBe(200);
  });

  it("does not mount OAuth discovery metadata", async () => {
    const res = await raw("GET", "/.well-known/oauth-authorization-server");
    expect(res.status).toBe(404);
  });

  it("does not mount /mcp", async () => {
    const res = await raw("POST", "/mcp", { headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(404);
  });

  it("still gates legacy /sse on the key", async () => {
    const res = await raw("GET", "/sse", { headers: { "x-brain-key": "wrong" } });
    expect(res.status).toBe(401);
  });

  it("rejects /messages without an active session", async () => {
    const res = await raw("POST", "/messages?sessionId=bogus", { headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });
});

describe("MCP HTTP app — OAuth enabled: /mcp method guards", () => {
  let server: http.Server;
  let raw: ReturnType<typeof makeRaw>;

  beforeAll(async () => {
    const server0 = http.createServer();
    await new Promise<void>((r) => server0.listen(0, "127.0.0.1", r));
    const port = (server0.address() as AddressInfo).port;
    const base = `http://localhost:${port}`;
    const provider = new OpenBrainOAuthProvider(new InMemoryOAuthStore(), {
      issuer: base,
      resource: `${base}/mcp`,
      ownerKey: OWNER,
    });
    const app = createMcpHttpApp({ mcpAccessKey: OWNER, publicBaseUrl: base, provider });
    server0.on("request", app);
    server = server0;
    raw = makeRaw(base);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("returns 405 for GET /mcp", async () => {
    const res = await raw("GET", "/mcp");
    expect(res.status).toBe(405);
  });

  it("returns 405 for DELETE /mcp", async () => {
    const res = await raw("DELETE", "/mcp");
    expect(res.status).toBe(405);
  });

  it("challenges POST /mcp with no Authorization header", async () => {
    const res = await raw("POST", "/mcp", {
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(String(res.headers["www-authenticate"])).toContain("resource_metadata");
  });
});
