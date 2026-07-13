/**
 * Persistence for the OAuth authorization server.
 *
 * Backed by the oauth_clients / oauth_auth_codes / oauth_tokens tables
 * (migration 004). All identifiers are opaque random strings minted here,
 * never in the database. The provider depends on the OAuthStore interface so
 * it can be exercised against an in-memory fake in unit tests.
 */

import crypto from "node:crypto";
import type pg from "pg";

import { getPool } from "../db/connection.js";

export interface OAuthClientRow {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  grantTypes: string[];
}

export interface AuthCodeRow {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope?: string;
  expiresAt: Date;
}

export type TokenKind = "access" | "refresh";

export interface TokenRow {
  token: string;
  kind: TokenKind;
  clientId: string;
  audience: string;
  scope?: string;
  refreshParent?: string;
  expiresAt: Date;
}

export interface OAuthStore {
  insertClient(client: OAuthClientRow): Promise<void>;
  getClient(clientId: string): Promise<OAuthClientRow | undefined>;

  insertCode(code: AuthCodeRow): Promise<void>;
  /** Non-consuming read of a still-valid (unconsumed, unexpired) code. */
  getActiveCode(code: string): Promise<AuthCodeRow | undefined>;
  /** Atomic single-use: marks consumed and returns the row only if it was still valid. */
  consumeCode(code: string): Promise<AuthCodeRow | undefined>;

  insertToken(token: TokenRow): Promise<void>;
  getActiveToken(token: string, kind: TokenKind): Promise<TokenRow | undefined>;
  revokeToken(token: string): Promise<void>;

  deleteExpired(): Promise<void>;
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export class PgOAuthStore implements OAuthStore {
  private get db(): pg.Pool {
    return getPool();
  }

  async insertClient(client: OAuthClientRow): Promise<void> {
    await this.db.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, grant_types)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id) DO UPDATE SET
         client_name = EXCLUDED.client_name,
         redirect_uris = EXCLUDED.redirect_uris,
         token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
         grant_types = EXCLUDED.grant_types`,
      [
        client.clientId,
        client.clientName ?? null,
        client.redirectUris,
        client.tokenEndpointAuthMethod,
        client.grantTypes,
      ]
    );
  }

  async getClient(clientId: string): Promise<OAuthClientRow | undefined> {
    const { rows } = await this.db.query(
      `SELECT client_id, client_name, redirect_uris, token_endpoint_auth_method, grant_types
       FROM oauth_clients WHERE client_id = $1`,
      [clientId]
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      clientId: row.client_id,
      clientName: row.client_name ?? undefined,
      redirectUris: row.redirect_uris,
      tokenEndpointAuthMethod: row.token_endpoint_auth_method,
      grantTypes: row.grant_types,
    };
  }

  async insertCode(code: AuthCodeRow): Promise<void> {
    await this.db.query(
      `INSERT INTO oauth_auth_codes (code, client_id, redirect_uri, code_challenge, resource, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        code.code,
        code.clientId,
        code.redirectUri,
        code.codeChallenge,
        code.resource,
        code.scope ?? null,
        code.expiresAt,
      ]
    );
  }

  async getActiveCode(code: string): Promise<AuthCodeRow | undefined> {
    const { rows } = await this.db.query(
      `SELECT code, client_id, redirect_uri, code_challenge, resource, scope, expires_at
       FROM oauth_auth_codes
       WHERE code = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [code]
    );
    return mapCode(rows[0]);
  }

  async consumeCode(code: string): Promise<AuthCodeRow | undefined> {
    const { rows } = await this.db.query(
      `UPDATE oauth_auth_codes SET consumed_at = now()
       WHERE code = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING code, client_id, redirect_uri, code_challenge, resource, scope, expires_at`,
      [code]
    );
    return mapCode(rows[0]);
  }

  async insertToken(token: TokenRow): Promise<void> {
    await this.db.query(
      `INSERT INTO oauth_tokens (token, kind, client_id, audience, scope, refresh_parent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        token.token,
        token.kind,
        token.clientId,
        token.audience,
        token.scope ?? null,
        token.refreshParent ?? null,
        token.expiresAt,
      ]
    );
  }

  async getActiveToken(token: string, kind: TokenKind): Promise<TokenRow | undefined> {
    const { rows } = await this.db.query(
      `SELECT token, kind, client_id, audience, scope, refresh_parent, expires_at
       FROM oauth_tokens
       WHERE token = $1 AND kind = $2 AND revoked_at IS NULL AND expires_at > now()`,
      [token, kind]
    );
    return mapToken(rows[0]);
  }

  async revokeToken(token: string): Promise<void> {
    await this.db.query(
      `UPDATE oauth_tokens SET revoked_at = now() WHERE token = $1 AND revoked_at IS NULL`,
      [token]
    );
  }

  async deleteExpired(): Promise<void> {
    await this.db.query(`DELETE FROM oauth_auth_codes WHERE expires_at <= now()`);
    await this.db.query(`DELETE FROM oauth_tokens WHERE expires_at <= now()`);
  }
}

interface CodeDbRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string | null;
  expires_at: Date;
}

interface TokenDbRow {
  token: string;
  kind: TokenKind;
  client_id: string;
  audience: string;
  scope: string | null;
  refresh_parent: string | null;
  expires_at: Date;
}

function mapCode(row: CodeDbRow | undefined): AuthCodeRow | undefined {
  if (!row) return undefined;
  return {
    code: row.code,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    scope: row.scope ?? undefined,
    expiresAt: row.expires_at,
  };
}

function mapToken(row: TokenDbRow | undefined): TokenRow | undefined {
  if (!row) return undefined;
  return {
    token: row.token,
    kind: row.kind,
    clientId: row.client_id,
    audience: row.audience,
    scope: row.scope ?? undefined,
    refreshParent: row.refresh_parent ?? undefined,
    expiresAt: row.expires_at,
  };
}

/**
 * In-memory OAuthStore for unit tests — a real store over Maps, not a mock.
 * Mirrors the Postgres semantics: atomic single-use codes, expiry, revocation.
 */
export class InMemoryOAuthStore implements OAuthStore {
  private clients = new Map<string, OAuthClientRow>();
  private codes = new Map<string, AuthCodeRow & { consumed: boolean }>();
  private tokens = new Map<string, TokenRow & { revoked: boolean }>();
  private readonly now: () => Date;

  constructor(now?: () => Date) {
    this.now = now ?? (() => new Date());
  }

  async insertClient(client: OAuthClientRow): Promise<void> {
    this.clients.set(client.clientId, { ...client });
  }

  async getClient(clientId: string): Promise<OAuthClientRow | undefined> {
    const c = this.clients.get(clientId);
    return c ? { ...c } : undefined;
  }

  async insertCode(code: AuthCodeRow): Promise<void> {
    this.codes.set(code.code, { ...code, consumed: false });
  }

  async getActiveCode(code: string): Promise<AuthCodeRow | undefined> {
    const row = this.codes.get(code);
    if (!row || row.consumed || row.expiresAt <= this.now()) return undefined;
    return stripCode(row);
  }

  async consumeCode(code: string): Promise<AuthCodeRow | undefined> {
    const row = this.codes.get(code);
    if (!row || row.consumed || row.expiresAt <= this.now()) return undefined;
    row.consumed = true;
    return stripCode(row);
  }

  async insertToken(token: TokenRow): Promise<void> {
    this.tokens.set(token.token, { ...token, revoked: false });
  }

  async getActiveToken(token: string, kind: TokenKind): Promise<TokenRow | undefined> {
    const row = this.tokens.get(token);
    if (!row || row.revoked || row.kind !== kind || row.expiresAt <= this.now()) return undefined;
    return stripToken(row);
  }

  async revokeToken(token: string): Promise<void> {
    const row = this.tokens.get(token);
    if (row) row.revoked = true;
  }

  async deleteExpired(): Promise<void> {
    const now = this.now();
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k);
    for (const [k, v] of this.tokens) if (v.expiresAt <= now) this.tokens.delete(k);
  }

  /** Test-only: physical row counts, so tests can assert pruning actually deletes. */
  totalRows(): { clients: number; codes: number; tokens: number } {
    return { clients: this.clients.size, codes: this.codes.size, tokens: this.tokens.size };
  }
}

function stripCode(row: AuthCodeRow & { consumed: boolean }): AuthCodeRow {
  const { consumed: _consumed, ...rest } = row;
  return { ...rest };
}

function stripToken(row: TokenRow & { revoked: boolean }): TokenRow {
  const { revoked: _revoked, ...rest } = row;
  return { ...rest };
}
