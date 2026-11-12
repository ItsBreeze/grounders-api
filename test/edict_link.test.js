/**
 * The Edict link at the wire: a shared key and the owner's pinned number in,
 * an app access token out — and nothing written, so the ItsRadio app's own
 * sign-in (its one refresh token) is never touched.
 *
 * The checks worth never deleting:
 *
 *   1. The key is the gate, and the pinned number is the fence. No key, a
 *      wrong key, Offhand's key, or a server missing either variable all
 *      refuse; a number other than the pinned one is refused before any
 *      account is looked up, so a leaked key reaches one account only.
 *
 *   2. Linking is a SELECT and nothing else: no INSERT, UPDATE or DELETE, and
 *      no statement that names refresh_tokens.
 *
 *   3. What comes out is an app token for client edict with a 30-day life,
 *      which the /radio routes accept.
 *
 *   4. The account holder's switch (partner_link_enabled false on any row
 *      holding the number) refuses; an account pending deletion is refused.
 */

const jwt = require('jsonwebtoken');

const { boot, check, run } = require('./harness');

const KEY = 'edict-test-key-edict-test-key-edict-test-key';
const OFFHAND_KEY = 'offhand-test-key-offhand-test-key-offhand';
const ME = '11111111-1111-4111-8111-111111111111';
const TWIN = '22222222-2222-4222-8222-222222222222';
const PHONE = '+17805550101';
const REFUSED_PHONE = '+17805550133';
const CLOSING_PHONE = '+17805550199';
const LEGACY_PHONE = '+17805550144';
const UNKNOWN_PHONE = '+17805550000';

run('edict_link', async () => {
  process.env.EDICT_PARTNER_KEY = KEY;
  process.env.EDICT_LINK_PHONE = PHONE;
  process.env.OFFHAND_PARTNER_KEY = OFFHAND_KEY;
  const h = await boot();

  const users = [
    // The empty twin of the owner's number, written without the +: never the one linked.
    { id: TWIN, display_name: '', phone: PHONE.replace(/\D/g, '') },
    { id: ME, display_name: 'Josh', phone: PHONE, last_post_at: new Date(), partner_link_enabled: true },
    { id: 'r', display_name: 'Nope', phone: REFUSED_PHONE, partner_link_enabled: false },
    { id: 'c', display_name: 'Gone', phone: CLOSING_PHONE, deletion_pending_at: new Date(), partner_link_enabled: true },
    { id: 'l', display_name: 'Old', phone: LEGACY_PHONE }, // no column at all: before the migration
  ];

  h.setQueryHandler((text, params) => {
    if (/FROM users/.test(text) && /regexp_replace/.test(text)) {
      const d = String(params[0]).replace(/\D/g, '');
      return {
        rows: users
          .filter((u) => u.phone.replace(/\D/g, '') === d)
          .sort((a, b) => (b.last_post_at ? 1 : 0) - (a.last_post_at ? 1 : 0))
          .map((u) => {
            const row = { id: u.id, display_name: u.display_name, deletion_pending_at: u.deletion_pending_at || null };
            if ('partner_link_enabled' in u) row.partner_link_enabled = u.partner_link_enabled;
            return row;
          }),
      };
    }
    if (/FROM radio_workspaces w/.test(text)) return { rows: [{ id: 'w1', name: '', members: [] }] };
    return { rows: [], rowCount: 0 };
  });

  const link = (body, headers = { Authorization: `Bearer ${KEY}` }) =>
    h.request('POST', '/partner/edict/link', { headers, body });

  // ── The key is the gate ────────────────────────────────────────────────
  const noKey = await link({ phone: PHONE }, {});
  check('link without a key is 401', noKey.status === 401, noKey.status);
  const wrongKey = await link({ phone: PHONE }, { Authorization: `Bearer ${KEY.slice(0, -1)}x` });
  check('link with a wrong key is 401', wrongKey.status === 401, wrongKey.status);
  const offhandKey = await link({ phone: PHONE }, { Authorization: `Bearer ${OFFHAND_KEY}` });
  check("Offhand's key does not open the Edict link", offhandKey.status === 401, offhandKey.status);
  const offhandRoute = await h.request('POST', '/partner/offhand/link', { headers: { Authorization: `Bearer ${KEY}` }, body: { phone: PHONE } });
  check("Edict's key does not open the Offhand link", offhandRoute.status === 401, offhandRoute.status);

  process.env.EDICT_PARTNER_KEY = '';
  const unset = await link({ phone: PHONE });
  check('with no server key the endpoint is 503, never open', unset.status === 503 && unset.json.error === 'partner_unconfigured', unset.json);
  process.env.EDICT_PARTNER_KEY = 'short';
  const short = await link({ phone: PHONE }, { Authorization: 'Bearer short' });
  check('a placeholder-length server key is treated as unset', short.status === 503, short.status);
  process.env.EDICT_PARTNER_KEY = KEY;
  process.env.EDICT_LINK_PHONE = '';
  const noPin = await link({ phone: PHONE });
  check('with no pinned number the endpoint is 503, never open to every account', noPin.status === 503, noPin.status);
  process.env.EDICT_LINK_PHONE = PHONE;

  // ── Inputs and the fence ───────────────────────────────────────────────
  const noPhone = await link({});
  check('link without a phone is 400 invalid_phone', noPhone.status === 400 && noPhone.json.error === 'invalid_phone', noPhone.json);
  const fenceStart = h.queries.length;
  const other = await link({ phone: REFUSED_PHONE });
  check('a number other than the pinned one is 403 phone_not_allowed', other.status === 403 && other.json.error === 'phone_not_allowed', other.json);
  check('... and no account is even looked up for it', h.queries.length === fenceStart, h.queries.slice(fenceStart).map((q) => q.text));

  const withPin = async (pin, body) => { process.env.EDICT_LINK_PHONE = pin; try { return await link(body); } finally { process.env.EDICT_LINK_PHONE = PHONE; } };
  const unknown = await withPin(UNKNOWN_PHONE, { phone: UNKNOWN_PHONE });
  check('a pinned number with no account is 404 no_account', unknown.status === 404 && unknown.json.error === 'no_account', unknown.json);
  const refused = await withPin(REFUSED_PHONE, { phone: REFUSED_PHONE });
  check('the account holder\'s switch off is 403 link_disabled, no token', refused.status === 403 && refused.json.error === 'link_disabled' && !('token' in refused.json), refused.json);
  const closing = await withPin(CLOSING_PHONE, { phone: CLOSING_PHONE });
  check('an account pending deletion is 403 account_closing, no token', closing.status === 403 && closing.json.error === 'account_closing' && !('token' in closing.json), closing.json);
  const legacy = await withPin(LEGACY_PHONE, { phone: LEGACY_PHONE });
  check('a row from before the column existed links (absent is not refused)', legacy.status === 200 && typeof legacy.json.token === 'string', legacy.status);
  users[0].partner_link_enabled = false;
  const twinOff = await link({ phone: PHONE });
  check('a refusal on either row holding the number refuses the link', twinOff.status === 403 && twinOff.json.error === 'link_disabled', twinOff.json);
  delete users[0].partner_link_enabled;

  // ── A good link ────────────────────────────────────────────────────────
  const start = h.queries.length;
  const before = Date.now();
  const ok = await link({ phone: '780-555-0101' });
  check('the pinned number, in any formatting, links: 200 with a token', ok.status === 200 && typeof ok.json.token === 'string', ok.json);
  const linkQueries = h.queries.slice(start);
  check('linking writes nothing: no INSERT, UPDATE or DELETE',
    linkQueries.length > 0 && !linkQueries.some((q) => /\b(INSERT|UPDATE|DELETE)\b/i.test(q.text)), linkQueries.map((q) => q.text));
  check('linking never touches refresh_tokens (the ItsRadio app stays signed in)',
    !linkQueries.some((q) => /refresh_tokens/i.test(q.text)), linkQueries.map((q) => q.text));
  check('there is no refresh token in the answer', !/refresh/i.test(ok.text), ok.json);

  let claims = null;
  try { claims = jwt.verify(ok.json.token, process.env.JWT_SECRET); } catch (_) { /* reported below */ }
  check('the token is an app token: signed with JWT_SECRET, sub = the account in use, client edict',
    !!claims && claims.sub === ME && claims.client === 'edict' && claims.aud === undefined, claims);
  const lifeDays = claims ? (claims.exp * 1000 - before) / 86400000 : 0;
  check('it lives 30 days', lifeDays > 29.99 && lifeDays < 30.01, lifeDays);
  check('expires_at is the token\'s own exp', !!claims && ok.json.expires_at === new Date(claims.exp * 1000).toISOString(), ok.json.expires_at);
  check('the answer carries the user id and display name and nothing else about the user',
    ok.json.user && ok.json.user.id === ME && ok.json.user.display_name === 'Josh' && Object.keys(ok.json.user).length === 2 && !/"(phone|email)"/.test(ok.text),
    ok.json.user);

  const radio = await h.request('GET', '/radio/workspaces', { headers: { Authorization: `Bearer ${ok.json.token}` } });
  check('the token opens /radio/workspaces', radio.status === 200 && Array.isArray(radio.json), radio.status);
  const mcp = await h.request('POST', '/mcp', { headers: { Authorization: `Bearer ${ok.json.token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  check('the token does not open /mcp (it is no connector token)', mcp.status === 401, mcp.status);

  await h.close();
});
