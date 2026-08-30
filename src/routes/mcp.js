/**
 * Remote MCP endpoint (Streamable HTTP) plus the OAuth server that guards it.
 *
 * Mounted at /mcp. Add `https://<host>/mcp` as a custom connector in Claude and
 * the discovery → registration → authorize → token dance below runs itself; the
 * only human step is typing MCP_ADMIN_PASSWORD once at the consent screen.
 */

const express = require('express');
const oauth   = require('../services/mcp_oauth');
const tools   = require('../mcp/tools');

const router = express.Router();

// Spec revisions this server can speak, newest first.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'grounders-gmail-multi', version: '1.0.0' };

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─── Configuration guard ────────────────────────────────────────────────────

const REQUIRED_ENV = [
  'PUBLIC_BASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'MCP_ADMIN_PASSWORD', 'TOKEN_ENC_KEY',
];

/**
 * A half-configured deploy should say so, not throw. Names only — never values.
 * The rest of the API is unaffected either way.
 */
function requireConfigured(req, res, next) {
  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  if (!missing.length) return next();

  res.status(503).json({
    error: 'Gmail connector is not configured on this deployment',
    missing_env: missing,
  });
}

// ─── OAuth: dynamic client registration ─────────────────────────────────────

router.post('/oauth/register', express.json(), async (req, res, next) => {
  try {
    res.status(201).json(await oauth.registerClient(req.body || {}));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: 'invalid_client_metadata', error_description: err.message });
    next(err);
  }
});

// ─── OAuth: authorization (consent screen) ──────────────────────────────────

function consentPage({ params, error }) {
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'response_type']
    .filter(k => params[k])
    .map(k => `<input type="hidden" name="${k}" value="${escapeHtml(params[k])}">`)
    .join('\n      ');

  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Gmail connector</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0;
         display: grid; place-items: center; min-height: 100dvh; padding: 24px; }
  .card { width: 100%; max-width: 380px; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.25rem; opacity: .75; font-size: .95rem; }
  input[type=password] { width: 100%; padding: .8rem; font-size: 1rem; box-sizing: border-box;
    border: 1px solid rgba(128,128,128,.5); border-radius: 10px; background: transparent; color: inherit; }
  button { width: 100%; padding: .85rem; font-size: 1rem; font-weight: 600; margin-top: .75rem;
    border: 0; border-radius: 10px; background: #2563eb; color: #fff; }
  .err { color: #dc2626; font-size: .9rem; margin-bottom: .75rem; }
</style></head>
<body><div class="card">
  <h1>Authorize Gmail connector</h1>
  <p>Claude is asking to connect to your multi-account Gmail server.</p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  <form method="POST" action="/mcp/oauth/authorize">
      ${hidden}
    <input type="password" name="password" placeholder="Operator password" autofocus required autocomplete="current-password">
    <button type="submit">Authorize</button>
  </form>
</div></body></html>`;
}

/** Shared validation for both GET (render) and POST (submit). */
async function validateAuthRequest(params) {
  const { client_id, redirect_uri, code_challenge, code_challenge_method, response_type } = params;

  if (response_type && response_type !== 'code') throw new Error('unsupported_response_type');
  if (!client_id)    throw new Error('client_id is required');
  if (!redirect_uri) throw new Error('redirect_uri is required');

  const client = await oauth.getClient(client_id);
  if (!client) throw new Error('Unknown client_id');

  // Exact-match the registered URI — prefix matching is how open redirectors happen.
  if (!client.redirect_uris.includes(redirect_uri)) throw new Error('redirect_uri does not match registration');

  if (!code_challenge) throw new Error('PKCE code_challenge is required');
  if (code_challenge_method && code_challenge_method !== 'S256') throw new Error('only S256 PKCE is supported');

  return client;
}

router.get('/oauth/authorize', async (req, res) => {
  try {
    await validateAuthRequest(req.query);
    res.type('html').send(consentPage({ params: req.query }));
  } catch (err) {
    res.status(400).type('html').send(consentPage({ params: req.query, error: err.message }));
  }
});

router.post('/oauth/authorize', express.urlencoded({ extended: false }), async (req, res, next) => {
  const params = req.body || {};
  try {
    await validateAuthRequest(params);

    if (!oauth.checkAdminPassword(params.password)) {
      return res.status(401).type('html').send(consentPage({ params, error: 'Incorrect password.' }));
    }

    const code = await oauth.issueAuthCode({
      clientId:      params.client_id,
      redirectUri:   params.redirect_uri,
      codeChallenge: params.code_challenge,
      scope:         params.scope,
    });

    const target = new URL(params.redirect_uri);
    target.searchParams.set('code', code);
    if (params.state) target.searchParams.set('state', params.state);

    res.redirect(302, target.toString());
  } catch (err) {
    if (err.message === 'MCP_ADMIN_PASSWORD is not set — refusing to authorize') return next(err);
    res.status(400).type('html').send(consentPage({ params, error: err.message }));
  }
});

// ─── OAuth: token ───────────────────────────────────────────────────────────

router.post('/oauth/token', express.urlencoded({ extended: false }), express.json(), async (req, res, next) => {
  const body = req.body || {};
  try {
    if (body.grant_type === 'authorization_code') {
      const granted = await oauth.consumeAuthCode({
        code:         body.code,
        clientId:     body.client_id,
        redirectUri:  body.redirect_uri,
        codeVerifier: body.code_verifier,
      });
      return res.json(await oauth.issueTokens({ clientId: body.client_id, scope: granted.scope }));
    }

    if (body.grant_type === 'refresh_token') {
      return res.json(await oauth.redeemRefreshToken({
        refreshToken: body.refresh_token,
        clientId:     body.client_id,
      }));
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, error_description: err.detail });
    next(err);
  }
});

// ─── Bearer guard ───────────────────────────────────────────────────────────

function requireMcpAuth(req, res, next) {
  const header = req.headers.authorization || '';

  // The resource_metadata hint is how the client discovers where to authorize.
  const challenge = `Bearer resource_metadata="${oauth.baseUrl()}/.well-known/oauth-protected-resource"`;

  if (!header.startsWith('Bearer ')) {
    res.set('WWW-Authenticate', challenge);
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    req.mcp = { ownerKey: oauth.verifyAccessToken(header.slice(7)).sub };
    next();
  } catch {
    res.set('WWW-Authenticate', `${challenge}, error="invalid_token"`);
    res.status(401).json({ error: 'invalid_token' });
  }
}

// ─── JSON-RPC dispatch ──────────────────────────────────────────────────────

async function handleRpc(message, ownerKey) {
  const { method, params, id } = message;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }

    case 'ping':
      return reply({});

    case 'tools/list':
      return reply({ tools: tools.descriptors() });

    case 'tools/call': {
      try {
        const result = await tools.callTool(params?.name, params?.arguments, ownerKey);
        return reply(result);
      } catch (err) {
        // Tool failures are results, not protocol errors — the model needs to
        // read the message and adapt (e.g. "re-link that account").
        return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

router.post('/', requireMcpAuth, async (req, res, next) => {
  try {
    const body     = req.body;
    const messages = Array.isArray(body) ? body : [body];

    // Notifications and responses carry no id and expect no reply.
    const requests = messages.filter(m => m && m.method && m.id !== undefined && m.id !== null);
    if (!requests.length) return res.status(202).end();

    const results = await Promise.all(requests.map(m => handleRpc(m, req.mcp.ownerKey)));
    const payload = Array.isArray(body) ? results : results[0];

    // Streamable HTTP lets the server answer with JSON or an SSE stream; honour
    // whichever the client said it accepts, preferring plain JSON.
    const accept = String(req.headers.accept || '');
    if (!accept.includes('application/json') && accept.includes('text/event-stream')) {
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      return res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    }

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// No server-initiated stream: say so rather than hanging the client open.
router.get('/', requireMcpAuth, (req, res) => res.status(405).json({ error: 'SSE stream not supported' }));
router.delete('/', requireMcpAuth, (req, res) => res.status(204).end());

module.exports = { router, requireMcpAuth, requireConfigured };
