/**
 * Migration 004: OAuth 2.1 authorization server tables.
 *
 * Backs the self-contained MCP OAuth flow (RFC 6749/7591/7636/8707) used by
 * claude.ai native connectors (web + mobile). All primary keys are opaque
 * random strings minted in Node (node:crypto), never in the database.
 *
 * Knex wraps each migration in a transaction, so no explicit BEGIN/COMMIT.
 */

const UP = `
CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id                   TEXT PRIMARY KEY,
    client_name                 TEXT,
    redirect_uris               TEXT[]      NOT NULL,
    token_endpoint_auth_method  TEXT        NOT NULL DEFAULT 'none',
    grant_types                 TEXT[]      NOT NULL DEFAULT ARRAY['authorization_code','refresh_token'],
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code           TEXT PRIMARY KEY,
    client_id      TEXT        NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    redirect_uri   TEXT        NOT NULL,
    code_challenge TEXT        NOT NULL,
    resource       TEXT        NOT NULL,
    scope          TEXT,
    expires_at     TIMESTAMPTZ NOT NULL,
    consumed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_client ON oauth_auth_codes(client_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
    token          TEXT PRIMARY KEY,
    kind           TEXT        NOT NULL CHECK (kind IN ('access','refresh')),
    client_id      TEXT        NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    audience       TEXT        NOT NULL,
    scope          TEXT,
    refresh_parent TEXT,
    expires_at     TIMESTAMPTZ NOT NULL,
    revoked_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_kind_expiry ON oauth_tokens(kind, expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
`;

const DOWN = `
DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS oauth_auth_codes;
DROP TABLE IF EXISTS oauth_clients;
`;

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(UP);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(DOWN);
};
