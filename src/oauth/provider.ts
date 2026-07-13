/**
 * Self-contained OAuth 2.1 authorization server for Open Brain.
 *
 * Implements the MCP SDK's OAuthServerProvider so the SDK's audited
 * authorize/token/register/revoke handlers drive the protocol (PKCE S256,
 * DCR, metadata). This class owns only the Open-Brain-specific policy:
 *   - single owner, gated by MCP_ACCESS_KEY at the consent screen,
 *   - opaque Postgres-backed tokens bound to the MCP resource (RFC 8707),
 *   - rotating refresh tokens.
 *
 * The interactive login lives outside the SDK's authorize handler (which does
 * not forward form fields): authorize() renders a password form that POSTs to
 * /oauth/login, and handleLogin() validates the owner key and issues the code.
 */

import crypto from "node:crypto";
import type { Response } from "express";

import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
  InvalidTargetError,
  InvalidClientMetadataError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import {
  type OAuthStore,
  type OAuthClientRow,
  randomToken,
} from "./store.js";

const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL_SECONDS = 60; // short-lived, single-use

export interface ProviderConfig {
  /** OAuth issuer + AS origin, e.g. https://openbrain.fly.dev */
  issuer: string;
  /** Canonical MCP resource identifier / token audience, e.g. https://openbrain.fly.dev/mcp */
  resource: string;
  /** Owner secret required at the consent screen (MCP_ACCESS_KEY). */
  ownerKey: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  /** Clock injection for tests. */
  now?: () => Date;
}

export interface LoginFields {
  password?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  resource?: string;
  state?: string;
  scope?: string;
}

export class OpenBrainOAuthProvider implements OAuthServerProvider {
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly now: () => Date;
  private readonly resource: string;

  constructor(
    private readonly store: OAuthStore,
    private readonly config: ProviderConfig
  ) {
    this.accessTtl = config.accessTtlSeconds ?? ACCESS_TTL_SECONDS;
    this.refreshTtl = config.refreshTtlSeconds ?? REFRESH_TTL_SECONDS;
    this.now = config.now ?? (() => new Date());
    this.resource = new URL(config.resource).href;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const store = this.store;
    return {
      getClient: async (clientId: string) => {
        const row = await store.getClient(clientId);
        return row ? toClientInfo(row) : undefined;
      },
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        const clientId = full.client_id ?? crypto.randomUUID();
        const redirectUris = full.redirect_uris ?? [];
        if (redirectUris.length === 0) {
          throw new InvalidClientMetadataError("At least one redirect_uri is required");
        }
        for (const uri of redirectUris) {
          if (!isSafeRedirectUri(uri)) {
            throw new InvalidClientMetadataError(
              `redirect_uri must be https or a loopback address: ${uri}`
            );
          }
        }
        await store.insertClient({
          clientId,
          clientName: full.client_name,
          redirectUris,
          tokenEndpointAuthMethod: full.token_endpoint_auth_method ?? "none",
          grantTypes: full.grant_types ?? ["authorization_code", "refresh_token"],
        });
        return { ...full, client_id: clientId };
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const resource = params.resource?.href ?? this.resource;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(
      renderLoginForm(`${this.config.issuer}/oauth/login`, {
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        resource,
        state: params.state,
        scope: params.scopes?.join(" "),
      })
    );
  }

  /**
   * Handles the owner-password submission from the consent screen, then
   * mints an authorization code and redirects back to the client. Not part of
   * the SDK provider interface — mounted directly as POST /oauth/login.
   */
  async handleLogin(fields: LoginFields, res: Response): Promise<void> {
    try {
      await this.completeLogin(fields, res);
    } catch (err) {
      console.error("[oauth] login error:", err instanceof Error ? err.message : err);
      if (!res.headersSent) res.status(500).send(renderError("Internal error."));
    }
  }

  private async completeLogin(fields: LoginFields, res: Response): Promise<void> {
    const clientId = fields.client_id ?? "";
    const client = await this.store.getClient(clientId);

    if (!client || !fields.redirect_uri || !fields.code_challenge) {
      res.status(400).send(renderError("Malformed authorization request."));
      return;
    }
    if (!client.redirectUris.includes(fields.redirect_uri)) {
      res.status(400).send(renderError("Unregistered redirect_uri."));
      return;
    }
    if (fields.resource !== undefined && fields.resource !== this.resource) {
      res.status(400).send(renderError("Invalid resource."));
      return;
    }
    if (!this.checkOwnerKey(fields.password ?? "")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(401).send(
        renderLoginForm(`${this.config.issuer}/oauth/login`, {
          client_id: clientId,
          client_name: client.clientName,
          redirect_uri: fields.redirect_uri,
          code_challenge: fields.code_challenge,
          resource: fields.resource ?? this.resource,
          state: fields.state,
          scope: fields.scope,
          error: "Incorrect key. Try again.",
        })
      );
      return;
    }

    const code = randomToken();
    await this.store.insertCode({
      code,
      clientId,
      redirectUri: fields.redirect_uri,
      codeChallenge: fields.code_challenge,
      resource: fields.resource ?? this.resource,
      scope: fields.scope,
      expiresAt: this.expiry(CODE_TTL_SECONDS),
    });

    const target = new URL(fields.redirect_uri);
    target.searchParams.set("code", code);
    if (fields.state) target.searchParams.set("state", fields.state);
    res.redirect(302, target.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const row = await this.store.getActiveCode(authorizationCode);
    if (!row || row.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return row.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const row = await this.store.consumeCode(authorizationCode);
    if (!row || row.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (redirectUri !== undefined && redirectUri !== row.redirectUri) {
      throw new InvalidGrantError("redirect_uri mismatch");
    }
    if (resource !== undefined && resource.href !== row.resource) {
      throw new InvalidTargetError("resource does not match authorization request");
    }
    return this.issueTokens(client.client_id, row.resource, row.scope);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const row = await this.store.getActiveToken(refreshToken, "refresh");
    if (!row || row.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (resource !== undefined && resource.href !== row.audience) {
      throw new InvalidTargetError("resource does not match refresh token");
    }
    await this.store.revokeToken(refreshToken);
    if (row.refreshParent) await this.store.revokeToken(row.refreshParent);
    const scope = scopes?.join(" ") ?? row.scope;
    return this.issueTokens(client.client_id, row.audience, scope);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = await this.store.getActiveToken(token, "access");
    if (!row) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    if (row.audience !== this.resource) {
      throw new InvalidTokenError("Token audience mismatch");
    }
    return {
      token,
      clientId: row.clientId,
      scopes: row.scope ? row.scope.split(" ") : [],
      expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
      resource: new URL(row.audience),
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    await this.store.revokeToken(request.token);
  }

  async pruneExpired(): Promise<void> {
    await this.store.deleteExpired();
  }

  private async issueTokens(
    clientId: string,
    audience: string,
    scope?: string
  ): Promise<OAuthTokens> {
    const accessToken = randomToken();
    const refreshTokenValue = randomToken();
    await this.store.insertToken({
      token: accessToken,
      kind: "access",
      clientId,
      audience,
      scope,
      expiresAt: this.expiry(this.accessTtl),
    });
    await this.store.insertToken({
      token: refreshTokenValue,
      kind: "refresh",
      clientId,
      audience,
      scope,
      refreshParent: accessToken,
      expiresAt: this.expiry(this.refreshTtl),
    });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.accessTtl,
      refresh_token: refreshTokenValue,
      scope,
    };
  }

  private checkOwnerKey(candidate: string): boolean {
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.config.ownerKey);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  private expiry(seconds: number): Date {
    return new Date(this.now().getTime() + seconds * 1000);
  }
}

function toClientInfo(row: OAuthClientRow): OAuthClientInformationFull {
  return {
    client_id: row.clientId,
    client_name: row.clientName,
    redirect_uris: row.redirectUris,
    token_endpoint_auth_method: row.tokenEndpointAuthMethod,
    grant_types: row.grantTypes,
  } as OAuthClientInformationFull;
}

function isSafeRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  ) {
    return true;
  }
  return false;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface FormValues {
  client_id: string;
  client_name?: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  state?: string;
  scope?: string;
  error?: string;
}

function hiddenField(name: string, value: string | undefined): string {
  if (value === undefined) return "";
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`;
}

function renderLoginForm(action: string, values: FormValues): string {
  const clientLabel = escapeHtml(values.client_name ?? values.client_id);
  const redirectHost = escapeHtml(safeHost(values.redirect_uri));
  const errorHtml = values.error
    ? `<p class="error">${escapeHtml(values.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Open Brain — Authorize</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  .card { background: #191c22; padding: 2rem; border-radius: 12px; width: 320px; box-shadow: 0 8px 30px rgba(0,0,0,.4); }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  p { font-size: .85rem; color: #9aa0aa; margin: .25rem 0 1rem; }
  .grant { color: #cbd2dc; }
  label { display: block; font-size: .8rem; margin-bottom: .35rem; }
  input[type=password] { width: 100%; padding: .6rem; border-radius: 8px; border: 1px solid #333; background: #0f1115; color: #e6e6e6; box-sizing: border-box; }
  button { width: 100%; margin-top: 1rem; padding: .6rem; border: 0; border-radius: 8px; background: #4f7cff; color: #fff; font-weight: 600; cursor: pointer; }
  .error { color: #ff6b6b; }
</style>
</head>
<body>
  <form class="card" method="post" action="${escapeHtml(action)}">
    <h1>Authorize Open Brain</h1>
    <p class="grant"><strong>${clientLabel}</strong> wants access to your brain.<br />Code returns to <strong>${redirectHost}</strong>.</p>
    ${errorHtml}
    <label for="password">Access key</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus />
    ${hiddenField("client_id", values.client_id)}
    ${hiddenField("redirect_uri", values.redirect_uri)}
    ${hiddenField("code_challenge", values.code_challenge)}
    ${hiddenField("resource", values.resource)}
    ${hiddenField("state", values.state)}
    ${hiddenField("scope", values.scope)}
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

function renderError(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8" /><title>Open Brain — Error</title></head><body style="font-family:system-ui;background:#0f1115;color:#e6e6e6;padding:2rem"><h1>Authorization error</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export const __testing = { isSafeRedirectUri, escapeHtml };
