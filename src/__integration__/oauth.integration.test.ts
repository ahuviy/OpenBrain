/**
 * End-to-end OAuth flow for the MCP server, exercised in-process over real HTTP.
 *
 * Uses the actual Express app, the SDK's authorize/token/register handlers, and
 * the Streamable HTTP transport. The provider is backed by the in-memory store
 * (injected), so this runs WITHOUT Postgres — it validates the protocol wiring:
 * discovery → DCR → owner login → PKCE token exchange → Bearer-gated /mcp.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pkceChallenge from "pkce-challenge";

import { InMemoryOAuthStore } from "../oauth/store.js";
import { OpenBrainOAuthProvider } from "../oauth/provider.js";
import { createMcpHttpApp } from "../mcp/http-app.js";

const OWNER = "integration-owner-key-abcdef0123";

let server: http.Server;
let base: string;
let resource: string;
let redirectUri: string;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function raw(
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
}

const form = (obj: Record<string, string>): string => new URLSearchParams(obj).toString();

beforeAll(async () => {
  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://localhost:${port}`;
  resource = `${base}/mcp`;
  redirectUri = `${base}/callback`;

  const store = new InMemoryOAuthStore();
  const provider = new OpenBrainOAuthProvider(store, { issuer: base, resource, ownerKey: OWNER });
  const app = createMcpHttpApp({ mcpAccessKey: OWNER, publicBaseUrl: base, provider });
  server.on("request", app);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function registerClient(): Promise<string> {
  const res = await raw("POST", "/register", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", client_name: "Integration Test" }),
  });
  expect(res.status).toBe(201);
  return (JSON.parse(res.body) as { client_id: string }).client_id;
}

describe("MCP OAuth discovery", () => {
  it("serves RFC 9728 protected resource metadata", async () => {
    const res = await raw("GET", "/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    const meta = JSON.parse(res.body) as { resource: string; authorization_servers: string[] };
    expect(meta.resource).toBe(resource);
    expect(meta.authorization_servers).toContain(`${base}/`);
  });

  it("serves RFC 8414 authorization server metadata with S256 + DCR", async () => {
    const res = await raw("GET", "/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const meta = JSON.parse(res.body) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(meta.authorization_endpoint).toBe(`${base}/authorize`);
    expect(meta.token_endpoint).toBe(`${base}/token`);
    expect(meta.registration_endpoint).toBe(`${base}/register`);
    expect(meta.code_challenge_methods_supported).toContain("S256");
  });
});

describe("MCP resource server", () => {
  it("challenges an unauthenticated /mcp request with WWW-Authenticate", async () => {
    const res = await raw("POST", "/mcp", {
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(String(res.headers["www-authenticate"])).toContain("resource_metadata");
  });
});

describe("MCP OAuth authorization code flow", () => {
  it("completes DCR → login → token → authorized /mcp initialize", async () => {
    const clientId = await registerClient();
    const { code_verifier, code_challenge } = await pkceChallenge();

    const login = await raw("POST", "/oauth/login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        password: OWNER,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge,
        resource,
        state: "state-123",
      }),
    });
    expect(login.status).toBe(302);
    const location = new URL(String(login.headers.location));
    expect(location.searchParams.get("state")).toBe("state-123");
    const code = location.searchParams.get("code") ?? "";
    expect(code).toBeTruthy();

    const token = await raw("POST", "/token", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code,
        code_verifier,
        redirect_uri: redirectUri,
        resource,
        client_id: clientId,
      }),
    });
    expect(token.status).toBe(200);
    const tokens = JSON.parse(token.body) as { access_token: string; token_type: string; refresh_token: string };
    expect(tokens.token_type).toBe("bearer");
    expect(tokens.access_token).toBeTruthy();

    const mcp = await raw("POST", "/mcp", {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "itest", version: "1" } },
      }),
    });
    expect(mcp.status).toBe(200);
    expect(mcp.body).toContain("open-brain");
  });

  it("rejects the wrong owner key at the consent screen", async () => {
    const clientId = await registerClient();
    const { code_challenge } = await pkceChallenge();
    const login = await raw("POST", "/oauth/login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        password: "totally-wrong",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge,
        resource,
      }),
    });
    expect(login.status).toBe(401);
    expect(login.body).toContain("Incorrect key");
  });

  it("rejects a PKCE verifier that does not match the challenge", async () => {
    const clientId = await registerClient();
    const { code_challenge } = await pkceChallenge();
    const login = await raw("POST", "/oauth/login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ password: OWNER, client_id: clientId, redirect_uri: redirectUri, code_challenge, resource }),
    });
    const code = new URL(String(login.headers.location)).searchParams.get("code") ?? "";
    const token = await raw("POST", "/token", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        code,
        code_verifier: "wrong-verifier-that-will-not-hash-to-the-challenge-000",
        redirect_uri: redirectUri,
        resource,
        client_id: clientId,
      }),
    });
    expect(token.status).toBe(400);
  });
});
