/**
 * Minimal OAuth 2.1 authorization server for the MCP endpoint.
 *
 * Claude's custom-connector flow expects: protected-resource metadata,
 * authorization-server metadata, dynamic client registration (RFC 7591),
 * and an authorization-code grant with PKCE. That is what this implements —
 * nothing more.
 *
 * This guards the *connector*, not the mailboxes. A single operator proves
 * identity once with MCP_ADMIN_PASSWORD at the consent screen; the resulting
 * tokens carry sub='owner', which is the owner_key every mailbox row hangs off.
 */

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const pool   = require('../db/pool');

const OWNER_KEY          = 'owner';
const ACCESS_TOKEN_TTL   = '1h';
const AUTH_CODE_TTL_MS   = 5 * 60 * 1000;
const REFRESH_TTL_DAYS   = 90;

const sha256 = (input) => crypto.createHash('sha256').update(input).digest();
const b64url = (buf) => buf.toString('base64url');

function baseUrl() {
  const url = process.env.PUBLIC_BASE_URL;
  if (!url) throw new Error('PUBLIC_BASE_URL must be set');
  return url.replace(/\/+$/, '');
}

/**
 * Signing key for MCP tokens — derived from JWT_SECRET, never JWT_SECRET itself.
 *
 * middleware/auth.js verifies Grounders user tokens with jwt.verify(token,
 * JWT_SECRET) and no audience check. Signing connector tokens with that same
 * key would make every MCP access token a valid user bearer token as well.
 * Domain separation via HMAC keeps the two from ever validating each other,
 * and needs no new env var or reissuing of existing user sessions.
 */
function secret() {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error('JWT_SECRET must be set');
  return crypto.createHmac('sha256', base).update('grounders-mcp-oauth-v1').digest('base64');
}

// ─── Metadata documents ─────────────────────────────────────────────────────

const protectedResourceMetadata = () => ({
  resource: `${baseUrl()}/mcp`,
  authorization_servers: [baseUrl()],
  scopes_supported: ['mcp'],
  bearer_methods_supported: ['header'],
});

const authorizationServerMetadata = () => ({
  issuer: baseUrl(),
  authorization_endpoint: `${baseUrl()}/mcp/oauth/authorize`,
  token_endpoint: `${baseUrl()}/mcp/oauth/token`,
  registration_endpoint: `${baseUrl()}/mcp/oauth/register`,
  scopes_supported: ['mcp'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
});

// ─── Dynamic client registration ────────────────────────────────────────────

async function registerClient({ redirect_uris, client_name }) {
  if (!Array.isArray(redirect_uris) || !redirect_uris.length) {
    throw Object.assign(new Error('redirect_uris is required'), { status: 400 });
  }

  for (const uri of redirect_uris) {
    let parsed;
    try { parsed = new URL(uri); } catch {
      throw Object.assign(new Error(`Invalid redirect_uri: ${uri}`), { status: 400 });
    }
    // Loopback http is allowed for local clients; everything else must be TLS.
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !loopback) {
      throw Object.assign(new Error(`redirect_uri must use https: ${uri}`), { status: 400 });
    }
  }

  const clientId = `mcp_${b64url(crypto.randomBytes(18))}`;

  await pool.query(
    `INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris)
     VALUES ($1, $2, $3)`,
    [clientId, client_name || 'MCP client', JSON.stringify(redirect_uris)],
  );

  return {
    client_id: clientId,
    client_name: client_name || 'MCP client',
    redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}

async function getClient(clientId) {
  const { rows } = await pool.query(
    'SELECT client_id, client_name, redirect_uris FROM mcp_oauth_clients WHERE client_id = $1',
    [clientId],
  );
  if (!rows.length) return null;

  const row = rows[0];
  return {
    ...row,
    redirect_uris: typeof row.redirect_uris === 'string' ? JSON.parse(row.redirect_uris) : row.redirect_uris,
  };
}

// ─── Authorization codes ────────────────────────────────────────────────────

async function issueAuthCode({ clientId, redirectUri, codeChallenge, scope }) {
  const code = b64url(crypto.randomBytes(32));

  await pool.query(
    `INSERT INTO mcp_auth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [b64url(sha256(code)), clientId, redirectUri, codeChallenge, scope || 'mcp',
     new Date(Date.now() + AUTH_CODE_TTL_MS)],
  );

  return code;
}

/** Single-use: the DELETE..RETURNING makes replay impossible even under a race. */
async function consumeAuthCode({ code, clientId, redirectUri, codeVerifier }) {
  const { rows } = await pool.query(
    `DELETE FROM mcp_auth_codes
      WHERE code_hash = $1
      RETURNING client_id, redirect_uri, code_challenge, scope, expires_at`,
    [b64url(sha256(code))],
  );

  if (!rows.length) throw Object.assign(new Error('invalid_grant'), { status: 400 });

  const row = rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error('invalid_grant'), { status: 400, detail: 'code expired' });
  }
  if (row.client_id !== clientId) {
    throw Object.assign(new Error('invalid_grant'), { status: 400, detail: 'client mismatch' });
  }
  if (row.redirect_uri !== redirectUri) {
    throw Object.assign(new Error('invalid_grant'), { status: 400, detail: 'redirect_uri mismatch' });
  }

  if (row.code_challenge) {
    if (!codeVerifier) {
      throw Object.assign(new Error('invalid_grant'), { status: 400, detail: 'code_verifier required' });
    }
    if (b64url(sha256(codeVerifier)) !== row.code_challenge) {
      throw Object.assign(new Error('invalid_grant'), { status: 400, detail: 'PKCE verification failed' });
    }
  }

  return row;
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

async function issueTokens({ clientId, scope }) {
  const accessToken = jwt.sign(
    { sub: OWNER_KEY, scope: scope || 'mcp', client_id: clientId },
    secret(),
    { expiresIn: ACCESS_TOKEN_TTL, audience: 'mcp', issuer: baseUrl() },
  );

  const refreshToken = b64url(crypto.randomBytes(32));

  await pool.query(
    `INSERT INTO mcp_refresh_tokens (token_hash, client_id, scope, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [b64url(sha256(refreshToken)), clientId, scope || 'mcp',
     new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000)],
  );

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: scope || 'mcp',
  };
}

/** Rotates the refresh token — the presented one is consumed on use. */
async function redeemRefreshToken({ refreshToken, clientId }) {
  const { rows } = await pool.query(
    `DELETE FROM mcp_refresh_tokens
      WHERE token_hash = $1
      RETURNING client_id, scope, expires_at`,
    [b64url(sha256(refreshToken))],
  );

  if (!rows.length) throw Object.assign(new Error('invalid_grant'), { status: 400 });

  const row = rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error('invalid_grant'), { status: 400, detail: 'refresh token expired' });
  }
  if (clientId && row.client_id !== clientId) {
    throw Object.assign(new Error('invalid_grant'), { status: 400, detail: 'client mismatch' });
  }

  return issueTokens({ clientId: row.client_id, scope: row.scope });
}

function verifyAccessToken(token) {
  return jwt.verify(token, secret(), { audience: 'mcp', issuer: baseUrl() });
}

/**
 * Constant-time operator password check.
 * Refuses to authorize at all when MCP_ADMIN_PASSWORD is unset, rather than
 * silently leaving the connector open to anyone who finds the URL.
 */
function checkAdminPassword(supplied) {
  const expected = process.env.MCP_ADMIN_PASSWORD;
  if (!expected) throw new Error('MCP_ADMIN_PASSWORD is not set — refusing to authorize');
  if (typeof supplied !== 'string' || !supplied) return false;

  // Trim both sides. Copying a passphrase out of a chat or a dashboard field
  // routinely picks up a trailing newline or space, and a mobile keyboard can
  // append one on its own. Surrounding whitespace carries no entropy worth
  // defending, and rejecting it produces an "incorrect password" that no
  // amount of careful retyping can fix.
  const given = supplied.trim();
  const want  = expected.trim();

  if (!given || !want) return false;

  const match = crypto.timingSafeEqual(sha256(given), sha256(want));

  if (!match) {
    // Lengths only — never the values. Enough to tell a wrong passphrase from
    // a stray character in the stored variable, from the server's own logs.
    console.warn(`[mcp_oauth] password mismatch (supplied ${given.length} chars, expected ${want.length})`);
  }

  return match;
}

/** Housekeeping for expired codes and refresh tokens. */
async function purgeExpired() {
  await pool.query('DELETE FROM mcp_auth_codes WHERE expires_at < NOW()');
  await pool.query('DELETE FROM mcp_refresh_tokens WHERE expires_at < NOW()');
}

module.exports = {
  OWNER_KEY,
  protectedResourceMetadata, authorizationServerMetadata,
  registerClient, getClient,
  issueAuthCode, consumeAuthCode,
  issueTokens, redeemRefreshToken, verifyAccessToken,
  checkAdminPassword, purgeExpired, baseUrl,
};
