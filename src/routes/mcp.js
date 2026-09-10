/**
 * The MCP server: Grounders and Radio, inside whatever assistant the user
 * already uses.
 *
 * One endpoint serves Claude, ChatGPT and Gemini — that is the point of the
 * protocol. Streamable HTTP, one JSON-RPC request per POST, which is all these
 * clients send. The model doing the reasoning is the user's own subscription;
 * this server answers database reads, and — for a token that carries
 * grounders.write — sends what the user dictates on Radio.
 *
 * Auth is a connector access token from routes/mcp_oauth.js. An app session
 * token is refused here (different signing key and audience), and a
 * connector token is refused by the app's requireAuth — see
 * services/mcp_oauth.js for why that separation matters.
 */

const express = require('express');
const pool = require('../db/pool');
const oauth = require('../services/mcp_oauth');
const { toolsForScope, callTool } = require('../mcp/tools');

const router = express.Router();

// Spec revisions this server can speak, newest first. A client asking for one
// of these gets it back; anything else gets the newest.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'grounders', version: '1.0.0' };

const BASE_INSTRUCTIONS =
  'This connector reads one user\'s Grounders (a location-based photo/video feed '
  + 'shared with friends) and Radio (voice-note, message and file threads with '
  + 'those same friends). Posts carry coordinates, not '
  + 'place names — interpret the location yourself. Voice notes are never '
  + 'available; say so rather than guessing what one contained. When you '
  + 'describe a photo, call fetch on the post first so you have actually seen it.';

const READ_ONLY_INSTRUCTIONS = ' Everything here is read-only.';

const WRITE_INSTRUCTIONS =
  ' This connection can also send on Radio: the radio_send_* tools put a message '
  + 'or a file into a conversation, and it reaches the other people in it '
  + 'immediately. Nothing is a draft and there is no outbox. Confirm the '
  + 'recipient and the exact wording with the user before sending, and say what '
  + 'was sent afterwards. Grounders itself stays read-only — posts are made from '
  + 'the camera, in the app.';

/**
 * `initialize` is answered before any token is read, so it carries the general
 * description. The scope-accurate one rides on tools/list, alongside the tools
 * it describes.
 */
const INSTRUCTIONS = BASE_INSTRUCTIONS + READ_ONLY_INSTRUCTIONS;

const instructionsFor = (canWrite) =>
  BASE_INSTRUCTIONS + (canWrite ? WRITE_INSTRUCTIONS : READ_ONLY_INSTRUCTIONS);

/**
 * Bearer token → user. A token outlives the account only in the window
 * between deletion being requested and the reaper running, so the account
 * state is checked on every call — one indexed read.
 */
async function authenticate(req) {
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return { error: 'missing_token' };

  let claims;
  try {
    claims = oauth.verifyAccessToken(header.slice(7));
  } catch {
    return { error: 'invalid_token' };
  }

  const { rows } = await pool.query(
    'SELECT deletion_pending_at FROM users WHERE id = $1', [claims.userId],
  );
  if (!rows[0]) return { error: 'invalid_token' };
  if (rows[0].deletion_pending_at) return { error: 'account_closing', userId: claims.userId };

  return { userId: claims.userId, canWrite: oauth.hasScope(claims.scope, oauth.SCOPE_WRITE) };
}

/** RFC 9728: point an unauthenticated client at the authorization server. */
function challenge(req, res, description) {
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`)
    .replace(/\/$/, '');
  res.set('WWW-Authenticate',
    `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
  return res.status(401).json({ error: 'unauthorized', error_description: description });
}

const rpcError = (id, code, message) => ({
  jsonrpc: '2.0', id: id ?? null, error: { code, message },
});

const toolFailure = (message) => ({
  content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
  isError: true,
});

// POST /mcp — Streamable HTTP. Notifications get 202 and no body.
router.post('/mcp', express.json({ limit: '1mb' }), async (req, res, next) => {
  try {
    const { id, method, params } = req.body || {};

    // `initialize` is answered before auth so a client can discover the
    // server and be told where to authenticate. A client that already holds a
    // token sends it here too, and then the instructions can describe the
    // tools it is actually about to get rather than the cautious default.
    if (method === 'initialize') {
      const asked = params && params.protocolVersion;
      const early = await authenticate(req).catch(() => ({ error: 'invalid_token' }));
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: early.error ? INSTRUCTIONS : instructionsFor(early.canWrite),
        },
      });
    }

    if (method === 'notifications/initialized') return res.status(202).end();
    if (method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} });

    const auth = await authenticate(req);
    if (auth.error === 'account_closing') {
      return res.status(403).json(rpcError(
        id, -32002,
        'This Grounders account is being deleted, so nothing can be read. '
        + 'Signing in to the app keeps the account; the connection itself stays set up.',
      ));
    }
    if (auth.error) return challenge(req, res, 'A valid access token is required');

    if (method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { tools: toolsForScope(auth.canWrite) },
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      try {
        const out = await callTool(auth.userId, name, args || {}, { canWrite: auth.canWrite });
        return res.json({ jsonrpc: '2.0', id, result: out });
      } catch (err) {
        console.error(`mcp tool ${name} failed:`, err);
        return res.json({ jsonrpc: '2.0', id, result: toolFailure('That lookup failed.') });
      }
    }

    return res.status(404).json(rpcError(id, -32601, `Unknown method: ${method}`));
  } catch (err) { next(err); }
});

// A GET here means a client is probing for auth; answer with the challenge
// rather than a 404 (or, worse, the app's own 401) it cannot act on.
router.get('/mcp', (req, res) => challenge(req, res, 'Authenticate to use this MCP server'));

module.exports = router;
