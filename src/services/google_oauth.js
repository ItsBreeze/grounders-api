/**
 * Google OAuth 2.0 — installed-app style code flow, one grant per mailbox.
 *
 * Each Gmail account the user links runs this flow once. We keep the refresh
 * token (encrypted) and mint access tokens on demand.
 */

const AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * What each linked account grants.
 *
 * gmail.modify covers read, send, label, archive and trash — but NOT permanent
 * delete, which Google gates behind the separate mail.google.com scope. That
 * omission is deliberate: nothing here can irrecoverably destroy mail.
 *
 * Drive has no equivalent middle scope. drive.file only sees files this app
 * itself created, which cannot answer "find my lease agreement", so searching
 * and editing existing files needs full drive — and full drive does permit
 * permanent deletion. There the limit is enforced by the tool surface instead:
 * trash_file trashes, and no tool passes Drive's permanent-delete endpoint.
 *
 * Contacts are read-only on purpose. They exist so "email Ann" resolves to an
 * address; nothing here needs to rewrite an address book.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

/**
 * The scope each product's tools need, for the pre-flight check that turns an
 * opaque Google 403 into "re-link this account".
 */
const PRODUCT_SCOPES = {
  gmail:    'https://www.googleapis.com/auth/gmail.modify',
  calendar: 'https://www.googleapis.com/auth/calendar',
  drive:    'https://www.googleapis.com/auth/drive',
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
  tasks:    'https://www.googleapis.com/auth/tasks',
};

/**
 * PUBLIC_BASE_URL, trimmed and validated, with trailing slashes removed.
 *
 * A stray space or a pasted "PUBLIC_BASE_URL=" prefix would otherwise flow
 * straight into the redirect URI and surface as Google's redirect_uri_mismatch
 * — an error that points at the OAuth client rather than at the real cause.
 * Returns null when unusable, so callers can report it plainly.
 */
function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return null;

  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  // A bare origin only — no path, query or fragment.
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;

  return parsed.origin;
}

function config() {
  const clientId     = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const baseUrl      = normalizeBaseUrl(process.env.PUBLIC_BASE_URL);

  if (!clientId || !clientSecret || !baseUrl) {
    throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_BASE_URL must all be set');
  }

  return { clientId, clientSecret, redirectUri: `${baseUrl}/gmail/oauth/callback` };
}

/**
 * Consent URL for one mailbox.
 *
 * access_type=offline + prompt=consent is what makes Google hand back a
 * refresh token. Without prompt=consent, a re-link of an already-granted
 * account returns an access token only and we lose long-lived access.
 */
function authUrl({ state, loginHint }) {
  const { clientId, redirectUri } = config();

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         SCOPES.join(' '),
    access_type:   'offline',
    prompt:        'consent select_account',
    include_granted_scopes: 'true',
    state,
  });

  if (loginHint) params.set('login_hint', loginHint);

  return `${AUTH_URL}?${params.toString()}`;
}

async function postToken(body) {
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams(body).toString(),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const detail = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error(`Google token endpoint: ${detail}`);
  }

  return json;
}

async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = config();
  return postToken({
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code',
  });
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = config();
  return postToken({
    refresh_token: refreshToken,
    client_id:     clientId,
    client_secret: clientSecret,
    grant_type:    'refresh_token',
  });
}

/**
 * Check GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET without a consent round-trip.
 *
 * Google validates the client credentials before it looks at the grant, so a
 * deliberately bogus authorization code separates the two failures cleanly:
 *   invalid_client → the id or the secret is wrong
 *   invalid_grant  → credentials accepted; only the code was bad, as expected
 */
async function verifyCredentials() {
  const { clientId, clientSecret, redirectUri } = config();

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'authorization_code',
      code:          'credential-probe-not-a-real-code',
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
    }).toString(),
  });

  const body = await res.json().catch(() => ({}));

  if (body.error === 'invalid_grant') {
    return { ok: true, detail: 'Client ID and secret accepted by Google.' };
  }

  if (body.error === 'invalid_client') {
    const description = body.error_description || '';
    const secretBlamed = /secret/i.test(description);
    return {
      ok: false,
      culprit: secretBlamed ? 'GOOGLE_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID',
      detail: description || 'Google rejected the client credentials.',
    };
  }

  return { ok: false, culprit: null, detail: body.error_description || body.error || `HTTP ${res.status}` };
}

async function fetchUserinfo(accessToken) {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Google userinfo: HTTP ${res.status}`);
  return res.json();
}

/** Revoke at Google's end so unlinking here also drops their side of the grant. */
async function revoke(token) {
  await fetch('https://oauth2.googleapis.com/revoke', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ token }).toString(),
  }).catch(() => {}); // best-effort — local delete still proceeds
}

module.exports = { normalizeBaseUrl, verifyCredentials, authUrl, exchangeCode, refreshAccessToken, fetchUserinfo, revoke, SCOPES, PRODUCT_SCOPES, config };
