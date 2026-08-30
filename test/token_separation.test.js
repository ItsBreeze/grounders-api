/**
 * MCP connector tokens and Grounders user tokens must never validate
 * each other, despite both deriving from JWT_SECRET.
 *   npm run test:tokens
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Dummy secret — never the real one.
process.env.JWT_SECRET = 'dummy-test-secret-not-a-real-key-000000';
process.env.PUBLIC_BASE_URL = 'https://grounders-api-production.up.railway.app';

const o = require('../src/services/mcp_oauth.js');
const derived = crypto.createHmac('sha256', process.env.JWT_SECRET)
  .update('grounders-mcp-oauth-v1').digest('base64');

const mcpTok = jwt.sign({ sub: 'owner' }, derived,
  { audience: 'mcp', issuer: process.env.PUBLIC_BASE_URL, expiresIn: '1h' });
const userTok = jwt.sign({ sub: '11111111-1111-1111-1111-111111111111' },
  process.env.JWT_SECRET, { expiresIn: '30d' });

const accepts = (fn) => { try { fn(); return true; } catch { return false; } };

// requireAuth's exact check: jwt.verify(token, JWT_SECRET), no audience.
const asUser = (t) => accepts(() => jwt.verify(t, process.env.JWT_SECRET));

let fail = 0;
const check = (n, c) => { c || fail++; console.log(`${c ? ' ok  ' : 'FAIL '} ${n}`); };

check('MCP token is NOT accepted as a Grounders user token', !asUser(mcpTok));
check('user token is NOT accepted by the MCP guard', !accepts(() => o.verifyAccessToken(userTok)));
check('MCP guard still accepts its own token', accepts(() => o.verifyAccessToken(mcpTok)) && o.verifyAccessToken(mcpTok).sub === 'owner');
check('real user token still works as a user token', asUser(userTok));

console.log(fail ? `\n${fail} FAILED` : '\nkey separation holds in both directions');
process.exit(fail ? 1 : 0);
