/**
 * OAuth 2.1 for the MCP connector (Grounders + Radio).
 *
 * Same shape as Offhand's connector, on purpose: every MCP client that matters
 * — Claude, ChatGPT, Gemini — authenticates this way, and Claude Desktop
 * performs Dynamic Client Registration on every connect with no fallback. So
 * registration is open and the security rests on PKCE plus the user's explicit
 * approval at the consent page, not on a pre-shared client secret.
 *
 * Deliberate choices:
 *   - PKCE is REQUIRED, S256 only. These are public clients; plain would make
 *     an intercepted code usable.
 *   - Access tokens are short-lived JWTs, never stored. Refresh tokens are
 *     stored only as hashes, so a database read yields nothing usable.
 *   - Redirect URIs are matched exactly, never by prefix. Prefix matching is
 *     how open redirects happen.
 *   - Connector tokens are signed with a key DERIVED from JWT_SECRET, never
 *     JWT_SECRET itself, and carry an audience claim. middleware/auth.js
 *     verifies app tokens with jwt.verify(token, JWT_SECRET) and no audience
 *     check, so a connector token signed with the raw secret would also be a
 *     valid — and fully privileged — app session. Domain separation keeps the
 *     two from ever validating each other, in both directions. test/mcp.test.js
 *     asserts both directions and should never be deleted.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const ACCESS_TOKEN_TTL_SECONDS = 3600;

/**
 * Two scopes. Reading is what the consent page offers and what every
 * third-party assistant gets: Claude, ChatGPT and Gemini connect through
 * dynamic registration, so their grant must stay the safe one — nobody's
 * Radio should gain a "send" button because they added a connector.
 *
 * Writing is granted only to a partner client whose grants come from the
 * partner key (routes/partner.js), where Offhand's own server has already
 * verified the phone and the user is acting inside their own app. The scope
 * is decided here, from the client id, and never from anything a client asks
 * for — an `offhand` grant is write-capable because it was minted behind the
 * key, not because a request said so.
 */
const SCOPE_READ = 'grounders.read';
const SCOPE_WRITE = 'grounders.write';
const SCOPE = SCOPE_READ;

/** Clients whose grants carry write. Everything else reads. */
const WRITE_CLIENTS = new Set(['offhand']);

/**
 * The scope a client's grant carries, recomputed on every issue and every
 * refresh. Deliberately not read from the stored row: when write arrived,
 * every existing Offhand link held a read-only grant, and a user should not
 * have to disconnect and reconnect to get a capability their app just grew.
 */
function scopeFor(clientId) {
  return WRITE_CLIENTS.has(clientId) ? `${SCOPE_READ} ${SCOPE_WRITE}` : SCOPE_READ;
}

/** Does this token's scope string carry `wanted`? */
function hasScope(scope, wanted) {
  return String(scope || '').split(/\s+/).includes(wanted);
}

/** The audience claim: an app token can never be replayed at /mcp. */
const MCP_AUDIENCE = 'grounders-mcp';

/** Derived signing key — see the header comment. */
function signingKey() {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error('JWT_SECRET must be set');
  return crypto.createHmac('sha256', base).update('grounders-mcp-connector-v1').digest();
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

/** RFC 7591 dynamic client registration. */
async function registerClient({ client_name, redirect_uris }) {
  if (!Array.isArray(redirect_uris) || !redirect_uris.length) {
    throw Object.assign(new Error('redirect_uris is required'), { status: 400 });
  }

  for (const uri of redirect_uris) {
    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      throw Object.assign(new Error(`Invalid redirect_uri: ${uri}`), { status: 400 });
    }
    // http is allowed only for loopback, which is how desktop clients work.
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
      || parsed.hostname === '[::1]';
    if (parsed.protocol !== 'https:' && !loopback) {
      throw Object.assign(
        new Error('redirect_uri must be https, or http on loopback'),
        { status: 400 },
      );
    }
  }

  const clientId = `gc_${randomToken(16)}`;
  await pool.query(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
     VALUES ($1, $2, $3)`,
    [clientId, (client_name || 'MCP client').slice(0, 120), JSON.stringify(redirect_uris)],
  );

  return {
    client_id: clientId,
    client_name: client_name || 'MCP client',
    redirect_uris,
    token_endpoint_auth_method: 'none',      // public client; PKCE is the proof
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}

/**
 * A fixed, first-party client row — the Offhand partner link uses one. Public
 * like every other client, with no redirect URIs: it never goes through the
 * authorization page, only /oauth/token's refresh grant.
 */
async function ensureClient({ clientId, clientName }) {
  await pool.query(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
     VALUES ($1, $2, '[]'::jsonb)
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId, clientName],
  );
}

async function getClient(clientId) {
  if (!clientId) return null;
  const { rows } = await pool.query(
    'SELECT * FROM oauth_clients WHERE client_id = $1', [clientId],
  );
  return rows[0] || null;
}

/** Exact match only. A prefix match here is an open redirect. */
function redirectAllowed(client, redirectUri) {
  const uris = Array.isArray(client.redirect_uris)
    ? client.redirect_uris
    : JSON.parse(client.redirect_uris || '[]');
  return uris.includes(redirectUri);
}

async function issueCode({ clientId, userId, redirectUri, codeChallenge, method }) {
  if ((method || 'S256') !== 'S256') {
    throw Object.assign(
      new Error('Only S256 code challenges are accepted'), { status: 400 },
    );
  }
  const code = randomToken(32);
  await pool.query(
    `INSERT INTO oauth_codes
       (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5,'S256',$6, NOW() + INTERVAL '10 minutes')`,
    [code, clientId, userId, redirectUri, codeChallenge, SCOPE],
  );
  return code;
}

/**
 * Exchange a code. Single-use: the row is claimed atomically so a replayed
 * code cannot mint a second token even under a race.
 */
async function redeemCode({ code, clientId, redirectUri, codeVerifier }) {
  if (!code) throw Object.assign(new Error('invalid_grant'), { status: 400 });
  const { rows } = await pool.query(
    `UPDATE oauth_codes SET consumed_at = NOW()
      WHERE code = $1 AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING *`,
    [code],
  );
  const row = rows[0];
  if (!row) throw Object.assign(new Error('invalid_grant'), { status: 400 });

  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
    throw Object.assign(new Error('invalid_grant'), { status: 400 });
  }
  if (!codeVerifier || sha256(codeVerifier) !== row.code_challenge) {
    throw Object.assign(new Error('invalid_grant'), { status: 400 });
  }

  return issueTokens({ userId: row.user_id, clientId, scope: row.scope });
}

async function issueTokens({ userId, clientId, scope = scopeFor(clientId) }) {
  const accessToken = jwt.sign(
    { sub: userId, scope, client_id: clientId, aud: MCP_AUDIENCE },
    signingKey(),
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  );

  const refreshToken = randomToken(40);
  await pool.query(
    `INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope)
     VALUES ($1, $2, $3, $4)`,
    [sha256(refreshToken), clientId, userId, scope],
  );

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  };
}

/** Rotates on use — the old refresh token stops working immediately. */
async function refresh({ refreshToken, clientId }) {
  if (!refreshToken) throw Object.assign(new Error('invalid_grant'), { status: 400 });
  const { rows } = await pool.query(
    `UPDATE oauth_refresh_tokens SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL AND client_id = $2
      RETURNING user_id, scope`,
    [sha256(refreshToken), clientId],
  );
  const row = rows[0];
  if (!row) throw Object.assign(new Error('invalid_grant'), { status: 400 });

  // scopeFor(), not row.scope: see the note on scopeFor. The stored value is
  // still written on every issue, so the table records what was handed out.
  return issueTokens({ userId: row.user_id, clientId });
}

/** Revoke one refresh token. Idempotent: an unknown or already-revoked token
 * is a no-op, since the caller's intent — "this grant must not work" — holds
 * either way. */
async function revokeRefreshToken({ refreshToken, clientId }) {
  await pool.query(
    `UPDATE oauth_refresh_tokens SET revoked_at = NOW()
      WHERE token_hash = $1 AND client_id = $2 AND revoked_at IS NULL`,
    [sha256(refreshToken), clientId],
  );
}

/** Verify a connector access token. Rejects app tokens by key AND audience. */
function verifyAccessToken(token) {
  const payload = jwt.verify(token, signingKey(), { audience: MCP_AUDIENCE });
  return { userId: payload.sub, scope: payload.scope, clientId: payload.client_id };
}

module.exports = {
  registerClient, ensureClient, getClient, redirectAllowed, issueCode, redeemCode,
  issueTokens, refresh, revokeRefreshToken, verifyAccessToken, randomToken, sha256,
  scopeFor, hasScope,
  SCOPE, SCOPE_READ, SCOPE_WRITE, MCP_AUDIENCE,
};
