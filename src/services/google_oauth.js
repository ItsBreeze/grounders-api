/**
 * Google OAuth 2.0 — installed-app style code flow, one grant per mailbox.
 *
 * Each Gmail account the user links runs this flow once. We keep the refresh
 * token (encrypted) and mint access tokens on demand.
 */

const AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

// gmail.modify covers read, send, label, archive and trash — but NOT permanent
// delete, which Google gates behind the separate mail.google.com scope. That
// omission is deliberate: nothing here can irrecoverably destroy mail.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

function config() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const baseUrl      = process.env.PUBLIC_BASE_URL;

  if (!clientId || !clientSecret || !baseUrl) {
    throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_BASE_URL must all be set');
  }

  return { clientId, clientSecret, redirectUri: `${baseUrl.replace(/\/+$/, '')}/gmail/oauth/callback` };
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

module.exports = { authUrl, exchangeCode, refreshAccessToken, fetchUserinfo, revoke, SCOPES, config };
