/**
 * The MCP connector at the wire: OAuth discovery → registration → consent →
 * code → token, then the tools behind the bearer token.
 *
 * Two families of check matter most here and should never be removed:
 *
 *   1. Token separation in both directions. A connector token must not open
 *      the app's routes, and an app token must not open /mcp. The app's
 *      requireAuth verifies with JWT_SECRET and no audience check, so this is
 *      the only thing standing between "read my posts" and "post as me".
 *
 *   2. Visibility on the wire. Every post query the tools run must carry the
 *      same exclusions the app applies — archived, blocked either way,
 *      deletion pending — and the friend scope. The stubbed pool records the
 *      SQL, so the checks read it rather than trusting the JSON.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { boot, check, run } = require('./harness');

const ME = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const POST = '44444444-4444-4444-8444-444444444444';
const WS = '55555555-5555-4555-8555-555555555555';
const MSG = '66666666-6666-4666-8666-666666666666';

const CLIENT = { client_id: 'gc_test', client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] };
const REDIRECT = CLIENT.redirect_uris[0];
const VERIFIER = 'verifier-verifier-verifier-verifier-verifier-1234';
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url');
const OTP = '123456';
const OTP_HASH = bcrypt.hashSync(OTP, 4);

const PHONE = '+16045550101';
const NOW = new Date();
const ago = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

const POST_ROW = {
  id: POST, user_id: FRIEND, display_name: 'Sam', type: 'photo',
  media_url: 'https://media.test/posts/full.jpg', media_thumb_url: 'https://media.test/posts/thumb.jpg',
  description: 'Sunset at Kits', audio_title: null, lat: 49.2734, lng: -123.1554,
  visibility: 'friends', captured_at: ago(30), posted_at: ago(29), reaction_count: 2,
  archived_at: null, deletion_pending_at: null,
};

const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

run('mcp', async () => {
  const h = await boot();

  // The consent pages post real HTML forms (urlencoded, with redirects the
  // client must not follow). The harness's request helper speaks JSON only
  // and hides its port, so listen the same app once more for these.
  const formServer = await new Promise((resolve) => {
    const s = h.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const formPort = formServer.address().port;
  async function postForm(path, body) {
    const res = await fetch(`http://127.0.0.1:${formPort}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body), redirect: 'manual',
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  const state = { otpRows: [], codeRow: null, users: { [ME]: { id: ME, deletion_pending_at: null } } };

  h.setQueryHandler((text, params) => {
    // ── OAuth tables ──
    if (/SELECT \* FROM oauth_clients/.test(text)) return { rows: params[0] === CLIENT.client_id ? [CLIENT] : [] };
    if (/INSERT INTO oauth_clients/.test(text)) return { rows: [], rowCount: 1 };
    if (/INSERT INTO oauth_codes/.test(text)) {
      state.codeRow = {
        code: params[0], client_id: params[1], user_id: params[2], redirect_uri: params[3],
        code_challenge: params[4], scope: params[5], consumed_at: null,
      };
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE oauth_codes SET consumed_at/.test(text)) {
      if (state.codeRow && state.codeRow.code === params[0] && !state.codeRow.consumed_at) {
        state.codeRow.consumed_at = new Date();
        return { rows: [state.codeRow] };
      }
      return { rows: [] };
    }
    if (/INSERT INTO oauth_refresh_tokens/.test(text)) return { rows: [], rowCount: 1 };
    // ── OTP + user lookup at consent ──
    if (/UPDATE otps SET used = true WHERE target/.test(text)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO otps/.test(text)) { state.otpRows.push({ id: params[0], target: params[1], code_hash: params[2] }); return { rows: [], rowCount: 1 }; }
    if (/SELECT id, code_hash FROM otps/.test(text)) {
      const r = state.otpRows.filter((o) => o.target === params[0]).pop();
      return { rows: r ? [{ id: r.id, code_hash: OTP_HASH }] : [] };
    }
    if (/UPDATE otps SET used = true WHERE id/.test(text)) return { rows: [], rowCount: 1 };
    if (/SELECT id, deletion_pending_at FROM users\s+WHERE regexp_replace/.test(text)) {
      return { rows: params[0] === PHONE ? [state.users[ME]] : [] };
    }
    // ── authenticate() ──
    if (/SELECT deletion_pending_at FROM users WHERE id = \$1/.test(text)) {
      const u = state.users[params[0]];
      return { rows: u ? [{ deletion_pending_at: u.deletion_pending_at }] : [] };
    }
    // ── tools ──
    if (/^SELECT 1 FROM posts WHERE id = \$1$/.test(text)) return { rows: params[0] === POST ? [{ 1: 1 }] : [] };
    if (/AS friend_id\s+FROM friendships/.test(text)) return { rows: [{ friend_id: FRIEND }] };
    if (/FROM posts p JOIN users u ON u\.id = p\.user_id\s+WHERE p\.id = \$1/.test(text)) {
      return { rows: params[0] === POST ? [POST_ROW] : [] };
    }
    if (/FROM posts p JOIN users u/.test(text)) return { rows: [POST_ROW] };
    if (/SELECT 1 FROM friendships WHERE user_id_a/.test(text)) {
      const pair = [params[0], params[1]];
      return { rows: pair.includes(ME) && pair.includes(FRIEND) ? [{ 1: 1 }] : [] };
    }
    if (/SELECT 1 FROM blocks/.test(text)) return { rows: [] };
    if (/FROM reactions r/.test(text)) return { rows: [{ post_id: POST, emoji: '🔥', user_id: ME, display_name: 'Me' }] };
    if (/SELECT 1 FROM radio_workspace_members WHERE workspace_id = \$1 AND user_id = \$2/.test(text)) {
      return { rows: params[0] === WS && params[1] === ME ? [{ 1: 1 }] : [] };
    }
    if (/FROM radio_files f JOIN users u ON u\.id = f\.owner_id\s+WHERE f\.workspace_id/.test(text)) {
      return { rows: [
        { id: MSG, workspace_id: WS, kind: 'text', owner_id: FRIEND, owner_name: 'Sam', text_content: 'see you at 7', created_at: ago(2) },
      ] };
    }
    if (/COUNT\(\*\)::int AS n FROM radio_files f/.test(text)) return { rows: [{ n: 3 }] };
    return { rows: [], rowCount: 0 };
  });

  // ── Discovery ──────────────────────────────────────────────────────────
  const as = await h.request('GET', '/.well-known/oauth-authorization-server');
  check('authorization-server metadata is 200 JSON',
    as.status === 200 && as.json && /\/oauth\/authorize$/.test(as.json.authorization_endpoint)
      && /\/oauth\/token$/.test(as.json.token_endpoint) && /\/oauth\/register$/.test(as.json.registration_endpoint),
    { status: as.status, body: as.json });
  check('only S256 PKCE and public clients are advertised',
    as.json && as.json.code_challenge_methods_supported.join() === 'S256'
      && as.json.token_endpoint_auth_methods_supported.join() === 'none');

  const pr = await h.request('GET', '/.well-known/oauth-protected-resource');
  const prMcp = await h.request('GET', '/.well-known/oauth-protected-resource/mcp');
  check('protected-resource metadata names /mcp, at both discovery paths',
    pr.status === 200 && /\/mcp$/.test(pr.json.resource) && prMcp.status === 200 && prMcp.json.resource === pr.json.resource,
    { root: pr.json, suffixed: prMcp.json });

  // ── Unauthenticated probes ─────────────────────────────────────────────
  const probeGet = await h.request('GET', '/mcp');
  check('GET /mcp without a token is 401 with a WWW-Authenticate resource_metadata challenge',
    probeGet.status === 401 && /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/.test(probeGet.headers.get('www-authenticate') || ''),
    { status: probeGet.status, hdr: probeGet.headers.get('www-authenticate') });

  const init = await h.request('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } } });
  check('initialize answers before auth and echoes a supported protocol version',
    init.status === 200 && init.json.result.protocolVersion === '2025-03-26' && init.json.result.serverInfo.name === 'grounders',
    init.json);

  const anonList = await h.request('POST', '/mcp', { body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  check('tools/list without a token is 401 (not the app\'s 401 — carries the challenge)',
    anonList.status === 401 && /resource_metadata/.test(anonList.headers.get('www-authenticate') || ''),
    { status: anonList.status, hdr: anonList.headers.get('www-authenticate') });

  // ── Registration ───────────────────────────────────────────────────────
  const reg = await h.request('POST', '/oauth/register', { body: { client_name: 'Claude', redirect_uris: [REDIRECT] } });
  check('dynamic registration returns 201 with a client_id and no secret',
    reg.status === 201 && /^gc_/.test(reg.json.client_id) && reg.json.token_endpoint_auth_method === 'none' && !('client_secret' in reg.json),
    { status: reg.status, body: reg.json });
  const badReg = await h.request('POST', '/oauth/register', { body: { redirect_uris: ['http://evil.example/cb'] } });
  check('registration refuses a non-loopback http redirect', badReg.status === 400 && badReg.json.error === 'invalid_client_metadata', badReg.json);

  // ── Consent page ───────────────────────────────────────────────────────
  const authQs = `client_id=${CLIENT.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz&code_challenge=${CHALLENGE}&code_challenge_method=S256`;
  const consent = await h.request('GET', `/oauth/authorize?${authQs}`);
  check('authorize renders the phone form for a known client', consent.status === 200 && /name="phone"/.test(consent.text) && /Grounders/.test(consent.text), consent.status);
  check('consent HTML is never cached', consent.headers.get('cache-control') === 'no-store, must-revalidate', consent.headers.get('cache-control'));
  // Both apps' real icons, inlined from their generators' SVG output: the
  // Grounders map tile (its ink streets) and the Radio (its ON AIR sign).
  check('the consent page carries both apps\' marks, ground rects stripped',
    (consent.text.match(/<svg class="mark"/g) || []).length === 2
      && /ON AIR/.test(consent.text) && /rx="64" fill="#FBF9F5"/.test(consent.text)
      && !/<rect width="1024" height="1024"/.test(consent.text),
    (consent.text.match(/<svg class="mark"/g) || []).length);

  const badRedirect = await h.request('GET', `/oauth/authorize?client_id=${CLIENT.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${CHALLENGE}`);
  check('authorize with an unregistered redirect renders an error, never redirects', badRedirect.status === 400 && /Bad redirect/.test(badRedirect.text), badRedirect.status);
  const unknownClient = await h.request('GET', `/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}`);
  check('authorize with an unknown client is a 400 page', unknownClient.status === 400 && /Unknown app/.test(unknownClient.text), unknownClient.status);

  // ── Phone → code ───────────────────────────────────────────────────────
  const flow = { client_id: CLIENT.client_id, redirect_uri: REDIRECT, state: 'xyz', code_challenge: CHALLENGE, code_challenge_method: 'S256' };
  const before = h.queries.length;
  const sent = await postForm('/oauth/authorize/code', { ...flow, cc: '+1', phone: '604 555 0101' });
  check('submitting the phone renders the code form', sent.status === 200 && /name="code"/.test(sent.text), sent.status);
  const otpInsert = h.queries.slice(before).find((q) => /INSERT INTO otps/.test(q.text));
  check('an OTP row was inserted for the E.164 phone, with a bcrypt hash, not the code',
    !!otpInsert && otpInsert.params[1] === PHONE && /^\$2[aby]\$/.test(otpInsert.params[2]),
    otpInsert && otpInsert.params);
  check('DEV_MODE shows the code on the page (no SMS sender configured)', /Dev code/.test(sent.text));
  check('the code form carries the grant text and says read-only, no voice, no phone numbers',
    /read-only/.test(sent.text) && /Voice notes stay/.test(sent.text) && /phone number/.test(sent.text));

  // ── Code → redirect with auth code ─────────────────────────────────────
  const wrong = await postForm('/oauth/authorize/approve', { ...flow, phone: PHONE, code: '000000' });
  check('a wrong code re-renders the code form with 401', wrong.status === 401 && /wrong or has expired/.test(wrong.text), wrong.status);

  const approved = await postForm('/oauth/authorize/approve', { ...flow, phone: PHONE, code: OTP });
  const location = approved.headers.get('location') || '';
  check('the right code redirects to the registered redirect_uri with code and state',
    approved.status === 302 && location.startsWith(REDIRECT) && /[?&]code=/.test(location) && /[?&]state=xyz/.test(location),
    { status: approved.status, location });
  const userLookup = h.queries.find((q) => /SELECT id, deletion_pending_at FROM users/.test(q.text));
  check('the account lookup matched on digits and was a SELECT — connecting never creates an account',
    !!userLookup && !h.queries.some((q) => /INSERT INTO users/.test(q.text)));
  const authCode = new URL(location).searchParams.get('code');

  // ── Token exchange ─────────────────────────────────────────────────────
  const badVerifier = await h.request('POST', '/oauth/token', { body: { grant_type: 'authorization_code', code: authCode, client_id: CLIENT.client_id, redirect_uri: REDIRECT, code_verifier: 'not-the-verifier' } });
  check('a wrong PKCE verifier is invalid_grant — and consumed the code',
    badVerifier.status === 400 && badVerifier.json.error === 'invalid_grant', badVerifier.json);

  // The code is single-use; mint a fresh one for the good exchange.
  const approved2 = await postForm('/oauth/authorize/code', { ...flow, cc: '+1', phone: '6045550101' })
    .then(() => postForm('/oauth/authorize/approve', { ...flow, phone: PHONE, code: OTP }));
  const authCode2 = new URL(approved2.headers.get('location')).searchParams.get('code');
  const tok = await h.request('POST', '/oauth/token', { body: { grant_type: 'authorization_code', code: authCode2, client_id: CLIENT.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER } });
  check('the right verifier returns a bearer access token, refresh token and scope',
    tok.status === 200 && tok.json.token_type === 'Bearer' && typeof tok.json.access_token === 'string' && typeof tok.json.refresh_token === 'string' && tok.json.scope === 'grounders.read',
    tok.json);
  const replay = await h.request('POST', '/oauth/token', { body: { grant_type: 'authorization_code', code: authCode2, client_id: CLIENT.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER } });
  check('replaying the code is invalid_grant', replay.status === 400 && replay.json.error === 'invalid_grant', replay.json);
  const refreshInsert = h.queries.find((q) => /INSERT INTO oauth_refresh_tokens/.test(q.text));
  check('the refresh token was stored as a hash, not the token',
    !!refreshInsert && refreshInsert.params[0] !== tok.json.refresh_token && refreshInsert.params[0].length >= 40);

  const mcpToken = tok.json.access_token;
  const bearer = { Authorization: `Bearer ${mcpToken}` };

  // ── Token separation, both directions ──────────────────────────────────
  const appWithMcp = await h.request('GET', '/users/me', { headers: bearer });
  check('a connector token is refused by the app\'s own routes (401)', appWithMcp.status === 401, appWithMcp.status);
  const appToken = jwt.sign({ sub: ME }, process.env.JWT_SECRET);
  const mcpWithApp = await h.request('POST', '/mcp', { headers: { Authorization: `Bearer ${appToken}` }, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } });
  check('an app session token is refused at /mcp (401)', mcpWithApp.status === 401, mcpWithApp.status);
  const claims = jwt.decode(mcpToken);
  check('the connector token carries aud=grounders-mcp and sub=user', claims.aud === 'grounders-mcp' && claims.sub === ME, claims);
  let rawSecretVerifies = false;
  try { jwt.verify(mcpToken, process.env.JWT_SECRET); rawSecretVerifies = true; } catch (_) { /* expected */ }
  check('the connector token is NOT signed with JWT_SECRET itself', !rawSecretVerifies);

  // ── tools/list ─────────────────────────────────────────────────────────
  const list = await h.request('POST', '/mcp', { headers: bearer, body: { jsonrpc: '2.0', id: 4, method: 'tools/list' } });
  const names = list.status === 200 ? list.json.result.tools.map((t) => t.name) : [];
  check('tools/list returns the seven read tools',
    names.join() === 'search,fetch,feed,friends,me,radio_workspaces,radio_messages', names);
  check('a consent-page grant is read-only: no send tools are offered',
    !names.some((n) => /^radio_(send|start|add|rename|mark|delete)/.test(n)), names);
  check('search and fetch exist by exactly those names (ChatGPT connector contract)',
    names.includes('search') && names.includes('fetch'));

  const call = (name, args, id = 10) => h.request('POST', '/mcp', { headers: bearer, body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } } });
  const payload = (res) => JSON.parse(res.json.result.content[0].text);

  // ── feed: visibility on the wire ───────────────────────────────────────
  const feedStart = h.queries.length;
  const fd = await call('feed', { days: 7 });
  const feedSql = h.queries.slice(feedStart).find((q) => /FROM posts p JOIN users u/.test(q.text));
  check('feed is 200 with posts and a per-person summary',
    fd.status === 200 && !fd.json.result.isError && payload(fd).count === 1 && payload(fd).by_person[0].name === 'Sam',
    fd.json);
  // The whole reason the app can render a photo with "Ben and Dana liked this"
  // under it without fetching every post one at a time.
  check('feed posts carry who reacted, resolved in one query for the page',
    payload(fd).posts[0].reactions?.[0]?.by === 'Me'
      && h.queries.filter((q) => /FROM reactions r/.test(q.text)).length === 1,
    payload(fd).posts[0].reactions);
  check('feed SQL excludes archived posts', !!feedSql && /p\.archived_at IS NULL/.test(feedSql.text));
  check('feed SQL excludes accounts pending deletion', !!feedSql && /u\.deletion_pending_at IS NULL/.test(feedSql.text));
  check('feed SQL excludes blocks in either direction', !!feedSql && /blocker_id = \$1 AND b\.blocked_id = p\.user_id/.test(feedSql.text) && /blocked_id = \$1 AND b\.blocker_id = p\.user_id/.test(feedSql.text));
  check('feed SQL scopes to the user and their friends by default (no public)',
    !!feedSql && /p\.user_id = ANY\(\$2\)/.test(feedSql.text) && !/visibility = 'public'/.test(feedSql.text)
      && Array.isArray(feedSql.params[1]) && feedSql.params[1].includes(ME) && feedSql.params[1].includes(FRIEND));
  check('feed result never carries a phone or email', !/"(phone|email)"/.test(fd.json.result.content[0].text));

  const pubStart = h.queries.length;
  await call('feed', { include_public: true, friend: 'me' });
  const pubSql = h.queries.slice(pubStart).find((q) => /FROM posts p JOIN users u/.test(q.text));
  check('include_public widens the scope to public posts; friend:"me" narrows to the user',
    !!pubSql && /visibility = 'public'/.test(pubSql.text) && pubSql.params.includes(ME) && /p\.user_id = \$\d+/.test(pubSql.text));

  const nearRes = await call('feed', { near: { lat: 49.2734, lng: -123.1554, radius_m: 1000 } });
  check('near filters by distance and reports distance_m', payload(nearRes).count === 1 && payload(nearRes).posts[0].distance_m === 0, payload(nearRes));
  const farRes = await call('feed', { near: { lat: 51.05, lng: -114.07, radius_m: 1000 } });
  check('a post outside the radius is dropped by the exact haversine pass', payload(farRes).count === 0, payload(farRes));

  // ── fetch post: image block from the thumbnail ─────────────────────────
  const realFetch = global.fetch;
  const fetched = [];
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.startsWith('https://media.test/')) {
      fetched.push(url);
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '6' } });
    }
    return realFetch(url, opts);
  };
  try {
    const fp = await call('fetch', { id: `post:${POST}` });
    const blocks = fp.json.result.content;
    check('fetch post returns the post JSON plus an image content block',
      blocks.length === 2 && blocks[1].type === 'image' && blocks[1].mimeType === 'image/jpeg' && blocks[1].data === Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]).toString('base64'),
      blocks.map((b) => b.type));
    check('the image came from the thumbnail URL by default', fetched[fetched.length - 1] === POST_ROW.media_thumb_url, fetched);
    check('fetch post includes the caption, and who reacted by name rather than a bare count',
    payload(fp).caption === 'Sunset at Kits' && payload(fp).reactions.length === 1
      && payload(fp).reactions[0].by === 'Me' && payload(fp).reactions[0].emoji === '🔥',
    payload(fp));

    await call('fetch', { id: `post:${POST}`, image: 'full' });
    check('image:"full" downloads the full media URL', fetched[fetched.length - 1] === POST_ROW.media_url, fetched);

    const none = await call('fetch', { id: POST, image: 'none' });
    check('a bare uuid is resolved to its kind; image:"none" attaches nothing', none.json.result.content.length === 1 && payload(none).id === `post:${POST}`);

    // A post made before thumbnails shipped carries a media_thumb_url that
    // 404s. The Grounders app has always fallen back to the full photo; this
    // did not, and reported "could not be downloaded" for a picture that was
    // sitting right there. That was the whole of "the assistant can't see my
    // photos", so it gets a test.
    fetched.length = 0;
    global.fetch = async (url, opts) => {
      if (typeof url === 'string' && url === POST_ROW.media_thumb_url) {
        fetched.push(url);
        return new Response('missing', { status: 404 });
      }
      if (typeof url === 'string' && url.startsWith('https://media.test/')) {
        fetched.push(url);
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '6' } });
      }
      return realFetch(url, opts);
    };
    const stale = await call('fetch', { id: `post:${POST}` });
    check('a 404 thumbnail falls back to the full photo rather than reporting no image',
      stale.json.result.content.length === 2 && stale.json.result.content[1].type === 'image'
        && payload(stale).image.attached === true && payload(stale).image.source === 'full'
        && fetched[0] === POST_ROW.media_thumb_url && fetched[1] === POST_ROW.media_url,
      { image: payload(stale).image, fetched });
  } finally {
    global.fetch = realFetch;
  }

  // ── radio_messages: membership gate, voice notes out ───────────────────
  const notMember = await call('radio_messages', { workspace_id: '77777777-7777-4777-8777-777777777777' });
  check('radio_messages for a workspace the user is not in is a tool error', notMember.json.result.isError === true && /not a member/.test(payload(notMember).error), payload(notMember));

  const rmStart = h.queries.length;
  const rm = await call('radio_messages', { workspace_id: WS });
  const rmSql = h.queries.slice(rmStart).find((q) => /FROM radio_files f JOIN users u ON u\.id = f\.owner_id/.test(q.text));
  check('radio_messages reads the thread in order with full text',
    rm.status === 200 && payload(rm).messages[0].text === 'see you at 7' && payload(rm).messages[0].from === 'Sam', payload(rm));
  check('radio_messages SQL leaves voice notes out by default', !!rmSql && /kind <> 'voice_note'/.test(rmSql.text));
  check('the number of omitted voice notes is reported', payload(rm).voice_notes_omitted === 3, payload(rm));
  check('no read marker was written (reading via the connector is side-effect free)',
    !h.queries.some((q) => /UPDATE radio_workspace_members|radio_enabled = true/.test(q.text)));

  const vStart = h.queries.length;
  await call('radio_messages', { workspace_id: WS, include_voice_notes: true });
  const vSql = h.queries.slice(vStart).find((q) => /FROM radio_files f JOIN users u ON u\.id = f\.owner_id/.test(q.text));
  check('include_voice_notes lifts the kind filter', !!vSql && !/kind <> 'voice_note'/.test(vSql.text));

  // ── search shape ───────────────────────────────────────────────────────
  const sr = await call('search', { query: 'sunset' });
  check('search returns {id,title,text,url} results with kinds', sr.status === 200 && payload(sr).results.every((r) => r.id && r.title && 'text' in r && r.url && r.kind), payload(sr));

  // ── Unknown tool / method ──────────────────────────────────────────────
  const unk = await call('nope', {});
  check('an unknown tool is an isError result, not a crash', unk.status === 200 && unk.json.result.isError === true);
  const unkMethod = await h.request('POST', '/mcp', { headers: bearer, body: { jsonrpc: '2.0', id: 9, method: 'resources/list' } });
  check('an unknown method is a JSON-RPC -32601', unkMethod.status === 404 && unkMethod.json.error.code === -32601);

  // ── Account closing after connecting ───────────────────────────────────
  state.users[ME].deletion_pending_at = new Date();
  const closing = await h.request('POST', '/mcp', { headers: bearer, body: { jsonrpc: '2.0', id: 11, method: 'tools/list' } });
  check('a token for an account pending deletion is 403 with an explanation, not a silent empty feed',
    closing.status === 403 && /being deleted/.test(closing.json.error.message), closing.json);

  // ── Nothing unexpected was logged ──────────────────────────────────────
  const erl = h.consoleLines.filter((l) => /ERR_ERL_|mcp tool .* failed/.test(l));
  check('no rate-limit misconfiguration or tool crash was logged', erl.length === 0, erl);

  await new Promise((r) => formServer.close(r));
  await h.close();
});
