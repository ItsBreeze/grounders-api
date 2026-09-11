/**
 * The Offhand partner link at the wire: a shared key, a verified phone, and
 * out comes a connector grant that is exactly what the consent page issues —
 * no more privileged, no less bounded.
 *
 * Two families of check matter most and should never be removed:
 *
 *   1. The key is the whole gate. No key, a wrong key, or an unset server
 *      key must all refuse, and the server must never fall open when the
 *      variable is missing.
 *
 *   2. What comes out is a connector token, not an app session. It opens
 *      /mcp and is refused by /users/me, carries the connector audience, and
 *      is not signed with JWT_SECRET. Linking is a SELECT — it never creates
 *      an account — and nothing in the response identifies the user beyond
 *      their display name.
 *
 *   3. The account holder's switch is honoured: users.partner_link_enabled
 *      false is 403 link_disabled with no token issued at all — on any row
 *      holding that number, not just the one the ordering picks — true still
 *      links, and an account that has never touched the switch — including
 *      a row older than the column — links as before.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const KEY = 'partner-test-key-partner-test-key-partner-test-key';
process.env.OFFHAND_PARTNER_KEY = KEY;

const { boot, check, run } = require('./harness');

const ME = '11111111-1111-4111-8111-111111111111';
const CLOSING = '99999999-9999-4999-8999-999999999999';
const PHONE = '+16045550101';
const CLOSING_PHONE = '+16045550199';
// One person's number written the other way: a second row, same digits.
const TWIN = '22222222-2222-4222-8222-222222222222';
// An account that has turned partner links off, and one so old its row
// predates the column entirely.
const REFUSED = '33333333-3333-4333-8333-333333333333';
const REFUSED_PHONE = '+16045550133';
const LEGACY = '44444444-4444-4444-8444-444444444444';
const LEGACY_PHONE = '+16045550144';
// One number, two rows: the refusal is on the row its owner is signed in to,
// and the busier row — the one the ordering picks — never touched the switch.
const TWIN_OFF = '55555555-5555-4555-8555-555555555555';
const TWIN_BUSY = '66666666-6666-4666-8666-666666666666';
const TWIN_OFF_PHONE = '+16045550155';

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');

run('partner', async () => {
  const h = await boot();

  // token_hash -> { client_id, user_id, revoked }
  const refreshRows = new Map();
  const users = {
    [ME]: { id: ME, display_name: 'Sam', deletion_pending_at: null, phone: PHONE, last_post_at: new Date(), partner_link_enabled: true },
    [CLOSING]: { id: CLOSING, display_name: 'Gone', deletion_pending_at: new Date(), phone: CLOSING_PHONE },
    [REFUSED]: { id: REFUSED, display_name: 'Nope', deletion_pending_at: null, phone: REFUSED_PHONE, partner_link_enabled: false },
    // No partner_link_enabled key at all: the row a server reads before the
    // migration has added the column. Absent must read as "not refused".
    [LEGACY]: { id: LEGACY, display_name: 'Old', deletion_pending_at: null, phone: LEGACY_PHONE },
    [TWIN_OFF]: { id: TWIN_OFF, display_name: '', deletion_pending_at: null, phone: TWIN_OFF_PHONE, partner_link_enabled: false },
    [TWIN_BUSY]: { id: TWIN_BUSY, display_name: 'Sam', deletion_pending_at: null, phone: TWIN_OFF_PHONE.replace(/D/g, ''), last_post_at: new Date() },
    // The same number written two ways is two rows: `phone` is UNIQUE on the
    // text, and the match is on digits. The empty one must never be the one
    // that gets linked — connecting to it looks like success and then every
    // read comes back empty.
    [TWIN]: { id: TWIN, display_name: '', deletion_pending_at: null, phone: PHONE.replace(/\D/g, '') },
  };

  h.setQueryHandler((text, params) => {
    if (/INSERT INTO oauth_clients/.test(text)) return { rows: [], rowCount: 1 };
    // Matched on shape, not on the exact SELECT list: the route orders the
    // matches now, and a stub that pins the column list turns a reordering
    // into a silent "no account".
    if (/FROM users/.test(text) && /regexp_replace/.test(text)) {
      const digits = String(params[0]).replace(/\D/g, '');
      const matches = Object.values(users)
        .filter((x) => x.phone.replace(/\D/g, '') === digits)
        // The route asks for the account in use first; the stub answers in
        // that order so the ordering is what the test is really checking.
        .sort((a, b) => (b.last_post_at ? 1 : 0) - (a.last_post_at ? 1 : 0));
      return {
        rows: matches.map((u) => {
          const row = {
            id: u.id,
            display_name: u.display_name,
            deletion_pending_at: u.deletion_pending_at,
          };
          // Only the fixtures that have the column get the column.
          if ('partner_link_enabled' in u) row.partner_link_enabled = u.partner_link_enabled;
          return row;
        }),
      };
    }
    if (/INSERT INTO oauth_refresh_tokens/.test(text)) {
      refreshRows.set(params[0], { client_id: params[1], user_id: params[2], revoked: false });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE oauth_refresh_tokens SET revoked_at = NOW\(\)\s+WHERE token_hash = \$1 AND revoked_at IS NULL AND client_id = \$2\s+RETURNING/.test(text)) {
      const row = refreshRows.get(params[0]);
      if (!row || row.revoked || row.client_id !== params[1]) return { rows: [] };
      row.revoked = true;
      // The stored value is deliberately the old read-only one: a link made
      // before write existed must come back write-capable anyway, because the
      // scope is recomputed from the client id on every refresh.
      return { rows: [{ user_id: row.user_id, scope: 'grounders.read' }] };
    }
    if (/UPDATE oauth_refresh_tokens SET revoked_at = NOW\(\)\s+WHERE token_hash = \$1 AND client_id = \$2 AND revoked_at IS NULL/.test(text)) {
      const row = refreshRows.get(params[0]);
      if (row && row.client_id === params[1]) row.revoked = true;
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    // /mcp authenticate()
    if (/SELECT deletion_pending_at FROM users WHERE id = \$1/.test(text)) {
      const u = users[params[0]];
      return { rows: u ? [{ deletion_pending_at: u.deletion_pending_at }] : [] };
    }
    return { rows: [], rowCount: 0 };
  });

  const link = (body, headers = { Authorization: `Bearer ${KEY}` }) =>
    h.request('POST', '/partner/offhand/link', { headers, body });

  // ── The key is the gate ────────────────────────────────────────────────
  const noKey = await link({ phone: PHONE }, {});
  check('link without a key is 401', noKey.status === 401, noKey.status);
  const wrongKey = await link({ phone: PHONE }, { Authorization: `Bearer ${KEY.slice(0, -1)}x` });
  check('link with a wrong key is 401', wrongKey.status === 401, wrongKey.status);

  process.env.OFFHAND_PARTNER_KEY = '';
  const unset = await link({ phone: PHONE });
  check('with no server key configured the endpoint is 503, never open', unset.status === 503 && unset.json.error === 'partner_unconfigured', unset.json);
  process.env.OFFHAND_PARTNER_KEY = 'short';
  const shortKey = await link({ phone: PHONE }, { Authorization: 'Bearer short' });
  check('a placeholder-length server key is treated as unset', shortKey.status === 503, shortKey.status);
  process.env.OFFHAND_PARTNER_KEY = KEY;

  // ── Inputs ─────────────────────────────────────────────────────────────
  const noPhone = await link({});
  check('link without a phone is 400', noPhone.status === 400 && noPhone.json.error === 'invalid_phone', noPhone.json);
  const junk = await link({ phone: 'call me' });
  check('link with an unusable phone is 400', junk.status === 400, junk.status);

  const before = h.queries.length;
  const unknown = await link({ phone: '+16045550000' });
  check('an unknown phone is 404 no_account', unknown.status === 404 && unknown.json.error === 'no_account', unknown.json);
  check('linking never creates an account (no INSERT INTO users)',
    !h.queries.slice(before).some((q) => /INSERT INTO users/.test(q.text)));

  const closing = await link({ phone: CLOSING_PHONE });
  check('an account pending deletion is 403 account_closing and gets no token',
    closing.status === 403 && closing.json.error === 'account_closing' && !('refresh_token' in closing.json), closing.json);

  // ── A good link ────────────────────────────────────────────────────────
  const start = h.queries.length;
  const ok = await link({ phone: '604 555 0101' });
  check('a verified phone, in any formatting, links: 200 with access + refresh tokens for client offhand',
    ok.status === 200 && ok.json.token_type === 'Bearer' && typeof ok.json.access_token === 'string'
      && typeof ok.json.refresh_token === 'string' && ok.json.client_id === 'offhand'
      && ok.json.scope === 'grounders.read grounders.write',
    ok.json);
  check('the response carries the display name and nothing else about the user',
    ok.json.user && ok.json.user.display_name === 'Sam' && !('id' in ok.json.user) && !/"(phone|email)"/.test(ok.text),
    ok.json.user);
  const clientUpsert = h.queries.slice(start).find((q) => /INSERT INTO oauth_clients/.test(q.text));
  check('the offhand client row is ensured with no redirect URIs (ON CONFLICT DO NOTHING)',
    !!clientUpsert && clientUpsert.params[0] === 'offhand' && /ON CONFLICT \(client_id\) DO NOTHING/.test(clientUpsert.text) && /'\[\]'::jsonb/.test(clientUpsert.text),
    clientUpsert && clientUpsert.text);
  const stored = h.queries.slice(start).find((q) => /INSERT INTO oauth_refresh_tokens/.test(q.text));
  check('the refresh token is stored hashed, under client offhand',
    !!stored && stored.params[0] === sha256(ok.json.refresh_token) && stored.params[1] === 'offhand' && stored.params[2] === ME,
    stored && stored.params);

  // ── The account holder's switch ────────────────────────────────────────
  // The endpoint issues a grant on Offhand's word alone, so the account has
  // to be able to refuse it. Off stops a new link and nothing else: an
  // existing grant is not revoked here (that is unlink's job).
  const offStart = h.queries.length;
  const off = await link({ phone: REFUSED_PHONE });
  check('an account with the switch off is 403 link_disabled',
    off.status === 403 && off.json.error === 'link_disabled', off.json);
  check('a refused link issues no token: nothing in the body, nothing stored',
    !('access_token' in off.json) && !('refresh_token' in off.json)
      && !h.queries.slice(offStart).some((q) => /INSERT INTO oauth_refresh_tokens/.test(q.text)),
    off.json);
  const stillOn = await link({ phone: PHONE });
  check('the switch on still links',
    stillOn.status === 200 && typeof stillOn.json.refresh_token === 'string', stillOn.status);
  const legacy = await link({ phone: LEGACY_PHONE });
  check('a row from before the column existed still links — absent is not refused',
    legacy.status === 200 && typeof legacy.json.refresh_token === 'string', legacy.status);
  const twinOff = await link({ phone: TWIN_OFF_PHONE });
  check('a refusal on either row holding one number refuses the link',
    twinOff.status === 403 && twinOff.json.error === 'link_disabled', twinOff.json);
  const migration = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrate.js'), 'utf8');
  check('the column is added idempotently and defaults every existing row to TRUE',
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_link_enabled\s+BOOLEAN NOT NULL DEFAULT TRUE;/.test(migration));

  // ── It is a connector token, not an app session ────────────────────────
  const bearer = { Authorization: `Bearer ${ok.json.access_token}` };
  const list = await h.request('POST', '/mcp', { headers: bearer, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  const partnerTools = list.status === 200 ? list.json.result.tools.map((t) => t.name) : [];
  check('the access token opens /mcp, and the partner grant sees the send tools the consent page does not',
    list.status === 200 && partnerTools.includes('radio_messages')
      && partnerTools.includes('radio_send_message') && partnerTools.includes('radio_send_file'),
    partnerTools);
  const app = await h.request('GET', '/users/me', { headers: bearer });
  check('the access token is refused by the app\'s own routes (401)', app.status === 401, app.status);
  const claims = jwt.decode(ok.json.access_token);
  check('the token carries aud=grounders-mcp, sub=user, client_id=offhand',
    claims.aud === 'grounders-mcp' && claims.sub === ME && claims.client_id === 'offhand', claims);
  let rawSecretVerifies = false;
  try { jwt.verify(ok.json.access_token, process.env.JWT_SECRET); rawSecretVerifies = true; } catch (_) { /* expected */ }
  check('the token is NOT signed with JWT_SECRET itself', !rawSecretVerifies);

  // ── Refresh at the ordinary token endpoint ─────────────────────────────
  const wrongClient = await h.request('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: ok.json.refresh_token, client_id: 'gc_someone_else' } });
  check('the refresh token is bound to client offhand (another client_id is invalid_grant)',
    wrongClient.status === 400 && wrongClient.json.error === 'invalid_grant', wrongClient.json);
  const refreshed = await h.request('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: ok.json.refresh_token, client_id: 'offhand' } });
  check('Offhand refreshes at /oauth/token with client_id offhand and gets a rotated pair',
    refreshed.status === 200 && typeof refreshed.json.access_token === 'string'
      && typeof refreshed.json.refresh_token === 'string' && refreshed.json.refresh_token !== ok.json.refresh_token,
    refreshed.json);
  const replay = await h.request('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: ok.json.refresh_token, client_id: 'offhand' } });
  check('the previous refresh token stopped working the moment it was used', replay.status === 400 && replay.json.error === 'invalid_grant', replay.json);

  // ── Unlink ─────────────────────────────────────────────────────────────
  const unlinkNoBody = await h.request('POST', '/partner/offhand/unlink', { headers: { Authorization: `Bearer ${KEY}` }, body: {} });
  check('unlink without a refresh token is 400', unlinkNoBody.status === 400, unlinkNoBody.status);
  const unlinkNoKey = await h.request('POST', '/partner/offhand/unlink', { body: { refresh_token: refreshed.json.refresh_token } });
  check('unlink without the key is 401', unlinkNoKey.status === 401, unlinkNoKey.status);

  const uStart = h.queries.length;
  const unlinked = await h.request('POST', '/partner/offhand/unlink', { headers: { Authorization: `Bearer ${KEY}` }, body: { refresh_token: refreshed.json.refresh_token } });
  const revoke = h.queries.slice(uStart).find((q) => /UPDATE oauth_refresh_tokens SET revoked_at/.test(q.text));
  check('unlink is 204 and revokes by hash under client offhand — the raw token never reaches the pool',
    unlinked.status === 204 && !!revoke && revoke.params[0] === sha256(refreshed.json.refresh_token) && revoke.params[1] === 'offhand'
      && !revoke.params.includes(refreshed.json.refresh_token),
    revoke && revoke.params);
  const afterUnlink = await h.request('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: refreshed.json.refresh_token, client_id: 'offhand' } });
  check('an unlinked refresh token is invalid_grant', afterUnlink.status === 400 && afterUnlink.json.error === 'invalid_grant', afterUnlink.json);
  const again = await h.request('POST', '/partner/offhand/unlink', { headers: { Authorization: `Bearer ${KEY}` }, body: { refresh_token: refreshed.json.refresh_token } });
  check('unlinking twice is still 204 (idempotent)', again.status === 204, again.status);

  await h.close();
});
