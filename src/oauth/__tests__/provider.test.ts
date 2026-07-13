import { describe, it, expect, beforeEach } from "vitest";
import type { Response } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

import { InMemoryOAuthStore } from "../store.js";
import { OpenBrainOAuthProvider } from "../provider.js";

const ISSUER = "https://brain.example.com";
const RESOURCE = "https://brain.example.com/mcp";
const OWNER = "owner-secret-key-0123456789";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

class FakeResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  redirectedTo = "";
  setHeader(key: string, value: string): void {
    this.headers[key.toLowerCase()] = String(value);
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  send(body: string): this {
    this.body = String(body);
    return this;
  }
  json(obj: unknown): this {
    this.body = JSON.stringify(obj);
    return this;
  }
  redirect(code: number, url: string): void {
    this.statusCode = code;
    this.redirectedTo = url;
  }
  end(): this {
    return this;
  }
}

const asRes = (r: FakeResponse): Response => r as unknown as Response;

describe("OpenBrainOAuthProvider", () => {
  let clock: Date;
  let store: InMemoryOAuthStore;
  let provider: OpenBrainOAuthProvider;

  beforeEach(() => {
    clock = new Date("2026-07-13T00:00:00.000Z");
    store = new InMemoryOAuthStore(() => clock);
    provider = new OpenBrainOAuthProvider(store, {
      issuer: ISSUER,
      resource: RESOURCE,
      ownerKey: OWNER,
      now: () => clock,
    });
  });

  async function registerClaude(): Promise<OAuthClientInformationFull> {
    return provider.clientsStore.registerClient!({
      redirect_uris: [CLAUDE_REDIRECT],
      token_endpoint_auth_method: "none",
      client_name: "Claude",
    } as Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">);
  }

  async function getClient(clientId: string): Promise<OAuthClientInformationFull> {
    const c = await provider.clientsStore.getClient(clientId);
    expect(c).toBeDefined();
    return c as OAuthClientInformationFull;
  }

  async function issueCode(clientId: string): Promise<string> {
    const res = new FakeResponse();
    await provider.handleLogin(
      {
        password: OWNER,
        client_id: clientId,
        redirect_uri: CLAUDE_REDIRECT,
        code_challenge: CODE_CHALLENGE,
        resource: RESOURCE,
        state: "state-xyz",
      },
      asRes(res)
    );
    expect(res.statusCode).toBe(302);
    return new URL(res.redirectedTo).searchParams.get("code") ?? "";
  }

  it("registerClient persists a client with an https redirect", async () => {
    const info = await registerClaude();
    expect(info.client_id).toBeTruthy();
    const stored = await getClient(info.client_id);
    expect(stored.redirect_uris).toEqual([CLAUDE_REDIRECT]);
  });

  it("registerClient rejects a non-loopback http redirect", async () => {
    await expect(
      provider.clientsStore.registerClient!({
        redirect_uris: ["http://evil.example.com/cb"],
      } as Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">)
    ).rejects.toThrow();
  });

  it("registerClient rejects an empty redirect_uris list", async () => {
    await expect(
      provider.clientsStore.registerClient!({
        redirect_uris: [],
      } as Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">)
    ).rejects.toThrow();
  });

  it("authorize renders a login form carrying the OAuth params as hidden fields", async () => {
    const info = await registerClaude();
    const client = await getClient(info.client_id);
    const res = new FakeResponse();
    await provider.authorize(
      client,
      { codeChallenge: CODE_CHALLENGE, redirectUri: CLAUDE_REDIRECT, resource: new URL(RESOURCE), state: "s1", scopes: [] },
      asRes(res)
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(CODE_CHALLENGE);
    expect(res.body).toContain(CLAUDE_REDIRECT);
    expect(res.body).toContain(`${ISSUER}/oauth/login`);
    expect(res.body).toContain('type="password"');
  });

  it("handleLogin issues a code and redirects with state on correct key", async () => {
    const info = await registerClaude();
    const res = new FakeResponse();
    await provider.handleLogin(
      {
        password: OWNER,
        client_id: info.client_id,
        redirect_uri: CLAUDE_REDIRECT,
        code_challenge: CODE_CHALLENGE,
        resource: RESOURCE,
        state: "state-xyz",
      },
      asRes(res)
    );
    expect(res.statusCode).toBe(302);
    const url = new URL(res.redirectedTo);
    expect(url.origin + url.pathname).toBe(CLAUDE_REDIRECT);
    expect(url.searchParams.get("code")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe("state-xyz");
  });

  it("handleLogin rejects a wrong key with 401 and re-renders the form", async () => {
    const info = await registerClaude();
    const res = new FakeResponse();
    await provider.handleLogin(
      {
        password: "wrong-key",
        client_id: info.client_id,
        redirect_uri: CLAUDE_REDIRECT,
        code_challenge: CODE_CHALLENGE,
        resource: RESOURCE,
      },
      asRes(res)
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("Incorrect key");
    expect(res.redirectedTo).toBe("");
  });

  it("handleLogin rejects an unregistered redirect_uri with 400", async () => {
    const info = await registerClaude();
    const res = new FakeResponse();
    await provider.handleLogin(
      {
        password: OWNER,
        client_id: info.client_id,
        redirect_uri: "https://claude.ai/somewhere-else",
        code_challenge: CODE_CHALLENGE,
        resource: RESOURCE,
      },
      asRes(res)
    );
    expect(res.statusCode).toBe(400);
    expect(res.redirectedTo).toBe("");
  });

  it("handleLogin rejects missing fields with 400", async () => {
    const info = await registerClaude();
    const res = new FakeResponse();
    await provider.handleLogin(
      { password: OWNER, client_id: info.client_id },
      asRes(res)
    );
    expect(res.statusCode).toBe(400);
  });

  it("challengeForAuthorizationCode returns the stored challenge", async () => {
    const info = await registerClaude();
    const client = await getClient(info.client_id);
    const code = await issueCode(info.client_id);
    await expect(provider.challengeForAuthorizationCode(client, code)).resolves.toBe(CODE_CHALLENGE);
  });

  it("challengeForAuthorizationCode throws for an unknown code", async () => {
    const info = await registerClaude();
    const client = await getClient(info.client_id);
    await expect(provider.challengeForAuthorizationCode(client, "nope")).rejects.toThrow();
  });

  it("exchangeAuthorizationCode issues bearer tokens bound to the resource audience", async () => {
    const info = await registerClaude();
    const client = await getClient(info.client_id);
    const code = await issueCode(info.client_id);
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, CLAUDE_REDIRECT, new URL(RESOURCE));
    expect(tokens.token_type).toBe("bearer");
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    const authInfo = await provider.verifyAccessToken(tokens.access_token);
    expect(authInfo.clientId).toBe(info.client_id);
    expect(authInfo.resource?.href).toBe(RESOURCE);
  });

  it("exchangeAuthorizationCode rejects a second use of the same code", async () => {
    const info = await registerClaude();
    const client = await getClient(info.client_id);
    const code = await issueCode(info.client_id);
    await provider.exchangeAuthorizationCode(client, code, undefined, CLAUDE_REDIRECT, new URL(RESOURCE));
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, CLAUDE_REDIRECT, new URL(RESOURCE))
    ).rejects.toThrow();
  });

  it("exchangeAuthorizationCode rejects a redirect_uri mismatch", async () => {
    const info = await registerClaude();
    const client = await getClient(info.client_id);
    const code = await issueCode(info.client_id);
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, "https://claude.ai/other", new URL(RESOURCE))
    ).rejects.toThrow();
  });

  it("exchangeAuthorizationCode rejects a resource mismatch", async () => {
    const info = await registerClaude();
    const client = await getClient(info.client_id);
    const code = await issueCode(info.client_id);
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, CLAUDE_REDIRECT, new URL("https://other.example.com/mcp"))
    ).rejects.toThrow();
  });

  it("exchangeRefreshToken rotates: old refresh dies, new access works", async () => {
    const info = await registerClaude();
    const client = await getClient(info.client_id);
    const code = await issueCode(info.client_id);
    const first = await provider.exchangeAuthorizationCode(client, code, undefined, CLAUDE_REDIRECT, new URL(RESOURCE));
    const second = await provider.exchangeRefreshToken(client, first.refresh_token ?? "", undefined, new URL(RESOURCE));
    expect(second.access_token).toBeTruthy();
    expect(second.access_token).not.toBe(first.access_token);
    await expect(provider.verifyAccessToken(second.access_token)).resolves.toBeDefined();
    await expect(provider.exchangeRefreshToken(client, first.refresh_token ?? "", undefined, new URL(RESOURCE))).rejects.toThrow();
  });

  it("exchangeRefreshToken rejects a resource mismatch", async () => {
    const info = await registerClaude();
    const client = await getClient(info.client_id);
    const code = await issueCode(info.client_id);
    const first = await provider.exchangeAuthorizationCode(client, code, undefined, CLAUDE_REDIRECT, new URL(RESOURCE));
    await expect(
      provider.exchangeRefreshToken(client, first.refresh_token ?? "", undefined, new URL("https://other.example.com/mcp"))
    ).rejects.toThrow();
  });

  it("verifyAccessToken throws once the token has expired", async () => {
    const info = await registerClaude();
    const client = await getClient(info.client_id);
    const code = await issueCode(info.client_id);
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, CLAUDE_REDIRECT, new URL(RESOURCE));
    clock = new Date(clock.getTime() + 3601 * 1000);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it("verifyAccessToken throws for an unknown token", async () => {
    await expect(provider.verifyAccessToken("not-a-real-token")).rejects.toThrow();
  });

  it("revokeToken invalidates an access token", async () => {
    const info = await registerClaude();
    const client = await getClient(info.client_id);
    const code = await issueCode(info.client_id);
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, CLAUDE_REDIRECT, new URL(RESOURCE));
    await provider.revokeToken(client, { token: tokens.access_token });
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });
});
