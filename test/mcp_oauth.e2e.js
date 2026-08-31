/**
 * End-to-end OAuth 2.1 + MCP protocol suite.
 * Start the API first, then:
 *   TEST_BASE_URL=http://127.0.0.1:3999 npm run test:mcp
 */

const crypto = require('crypto');
const b64url = b => b.toString('base64url');

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3999';
const OPERATOR_PW = process.env.MCP_ADMIN_PASSWORD || 'test-operator-pw';
let pass = 0, fail = 0;
const check = (name, cond, extra='') => {
  (cond ? pass++ : fail++);
  console.log(`${cond ? ' ok  ' : 'FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
};

(async () => {
  // 1. discovery
  const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource`).then(r => r.json());
  check('PRM advertises resource', prm.resource === `${BASE}/mcp`, prm.resource);
  const asm = await fetch(`${BASE}/.well-known/oauth-authorization-server/mcp`).then(r => r.json());
  check('ASM advertises S256 PKCE', asm.code_challenge_methods_supported.includes('S256'));

  // 2. unauthenticated MCP call is challenged
  const unauth = await fetch(`${BASE}/mcp`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}) });
  check('unauthenticated /mcp → 401', unauth.status === 401, `got ${unauth.status}`);
  check('401 carries WWW-Authenticate hint',
    (unauth.headers.get('www-authenticate')||'').includes('resource_metadata'));

  // 3. dynamic client registration
  const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await fetch(`${BASE}/mcp/oauth/register`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({client_name:'Claude', redirect_uris:[REDIRECT]}) });
  const client = await reg.json();
  check('DCR returns client_id', reg.status === 201 && !!client.client_id, client.client_id);

  const badReg = await fetch(`${BASE}/mcp/oauth/register`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({client_name:'Evil', redirect_uris:['http://evil.example.com/cb']}) });
  check('DCR rejects non-TLS redirect_uri', badReg.status === 400);

  // 4. authorize
  const verifier  = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT,
    response_type:'code', code_challenge: challenge, code_challenge_method:'S256', state:'xyz' });

  const consent = await fetch(`${BASE}/mcp/oauth/authorize?${q}`);
  check('consent screen renders', consent.status === 200 && (await consent.text()).includes('Operator password'));

  const mismatch = await fetch(`${BASE}/mcp/oauth/authorize?${new URLSearchParams({...Object.fromEntries(q), redirect_uri:'https://evil.example.com/cb'})}`);
  check('unregistered redirect_uri rejected', mismatch.status === 400);

  const noPkce = await fetch(`${BASE}/mcp/oauth/authorize?${new URLSearchParams({client_id:client.client_id, redirect_uri:REDIRECT, response_type:'code'})}`);
  check('missing PKCE rejected', noPkce.status === 400);

  const form = (obj) => ({ method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams(obj).toString(), redirect:'manual' });

  const wrongPw = await fetch(`${BASE}/mcp/oauth/authorize`, form({
    client_id:client.client_id, redirect_uri:REDIRECT, response_type:'code',
    code_challenge:challenge, code_challenge_method:'S256', state:'xyz', password:'wrong' }));
  check('wrong operator password → 401', wrongPw.status === 401);

  const okPw = await fetch(`${BASE}/mcp/oauth/authorize`, form({
    client_id:client.client_id, redirect_uri:REDIRECT, response_type:'code',
    code_challenge:challenge, code_challenge_method:'S256', state:'xyz', password: OPERATOR_PW }));
  const loc = new URL(okPw.headers.get('location'));
  const code = loc.searchParams.get('code');
  check('correct password redirects with code', okPw.status === 302 && !!code);
  check('state round-trips', loc.searchParams.get('state') === 'xyz');

  // 5. token exchange
  const badVerifier = await fetch(`${BASE}/mcp/oauth/token`, form({
    grant_type:'authorization_code', code, client_id:client.client_id,
    redirect_uri:REDIRECT, code_verifier:'not-the-verifier' }));
  check('wrong PKCE verifier rejected', badVerifier.status === 400);

  // that failed attempt consumed the code — get a fresh one
  const okPw2 = await fetch(`${BASE}/mcp/oauth/authorize`, form({
    client_id:client.client_id, redirect_uri:REDIRECT, response_type:'code',
    code_challenge:challenge, code_challenge_method:'S256', password: OPERATOR_PW }));
  const code2 = new URL(okPw2.headers.get('location')).searchParams.get('code');

  const tok = await fetch(`${BASE}/mcp/oauth/token`, form({
    grant_type:'authorization_code', code: code2, client_id:client.client_id,
    redirect_uri:REDIRECT, code_verifier:verifier }));
  const tokens = await tok.json();
  check('token exchange succeeds', tok.status === 200 && !!tokens.access_token);

  const replay = await fetch(`${BASE}/mcp/oauth/token`, form({
    grant_type:'authorization_code', code: code2, client_id:client.client_id,
    redirect_uri:REDIRECT, code_verifier:verifier }));
  check('auth code is single-use', replay.status === 400);

  // 6. MCP protocol
  const rpc = async (body, accept='application/json') => {
    const r = await fetch(`${BASE}/mcp`, { method:'POST', headers:{
      'Content-Type':'application/json', Accept: accept,
      Authorization:`Bearer ${tokens.access_token}` }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, ctype: r.headers.get('content-type'), text,
             json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };

  const init = await rpc({jsonrpc:'2.0', id:1, method:'initialize',
    params:{protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{name:'test',version:'1'}}});
  check('initialize negotiates version',
    init.json?.result?.protocolVersion === '2025-06-18', init.json?.result?.serverInfo?.name);

  const initOld = await rpc({jsonrpc:'2.0', id:1, method:'initialize', params:{protocolVersion:'2024-11-05'}});
  check('initialize honours older protocol', initOld.json?.result?.protocolVersion === '2024-11-05');

  const notif = await fetch(`${BASE}/mcp`, { method:'POST', headers:{
    'Content-Type':'application/json', Authorization:`Bearer ${tokens.access_token}` },
    body: JSON.stringify({jsonrpc:'2.0', method:'notifications/initialized'}) });
  check('notification → 202 no body', notif.status === 202);

  const list = await rpc({jsonrpc:'2.0', id:2, method:'tools/list'});
  const names = (list.json?.result?.tools || []).map(t => t.name);
  check('tools/list returns 54 tools', names.length === 54, `got ${names.length}`);
  for (const required of [
    'search_messages','search_threads','create_draft','get_attachment','forward_message','untrash_message','mark_spam',
    'list_calendars','list_events','search_events','create_event','respond_to_event','suggest_time',
    'search_files','read_file_content','share_file','unshare_file','trash_file','untrash_file','comment_on_file',
    'search_contacts','list_tasks','create_task',
  ]) {
    check(`tool ${required} present`, names.includes(required));
  }
  check('every product is represented',
    ['get_message','get_event','get_file_metadata','search_contacts','list_task_lists'].every(n => names.includes(n)));

  const sse = await rpc({jsonrpc:'2.0', id:3, method:'ping'}, 'text/event-stream');
  check('SSE-only client gets event-stream', (sse.ctype||'').includes('text/event-stream') && sse.text.startsWith('event: message'));

  const call = await rpc({jsonrpc:'2.0', id:4, method:'tools/call',
    params:{name:'list_accounts', arguments:{}}});
  check('tools/call list_accounts works',
    call.json?.result?.content?.[0]?.text?.includes('No mailboxes linked'),
    call.json?.result?.content?.[0]?.text);

  const missing = await rpc({jsonrpc:'2.0', id:5, method:'tools/call',
    params:{name:'search_messages', arguments:{query:'is:unread'}}});
  check('search with no mailboxes is a hard error, not an empty result',
    missing.json?.result?.isError === true && !missing.json?.error,
    missing.json?.result?.content?.[0]?.text);

  const missingThreads = await rpc({jsonrpc:'2.0', id:5.1, method:'tools/call',
    params:{name:'search_threads', arguments:{query:'is:unread'}}});
  check('thread search with no mailboxes is a hard error too',
    missingThreads.json?.result?.isError === true && !missingThreads.json?.error,
    missingThreads.json?.result?.content?.[0]?.text);

  const badPage = await rpc({jsonrpc:'2.0', id:5.2, method:'tools/call',
    params:{name:'search_threads', arguments:{query:'is:unread', page_token:'abc'}}});
  check('thread page_token without an account is rejected',
    (badPage.json?.result?.content?.[0]?.text || '').includes('page_token requires'),
    badPage.json?.result?.content?.[0]?.text);

  // Every product must fail the same way with nothing linked — a Calendar or
  // Drive call must not look like "you have no events" when it means "no accounts".
  for (const [id, name, args] of [
    [5.3, 'list_events',    {}],
    [5.4, 'search_files',   {query:'lease'}],
    [5.5, 'search_contacts',{query:'ann'}],
    [5.6, 'list_tasks',     {}],
    [5.7, 'suggest_time',   {duration_minutes:30}],
  ]) {
    const res = await rpc({jsonrpc:'2.0', id, method:'tools/call', params:{name, arguments:args}});
    check(`${name} with no accounts is a hard error`,
      res.json?.result?.isError === true &&
      (res.json?.result?.content?.[0]?.text || '').includes('No accounts are linked'),
      res.json?.result?.content?.[0]?.text);
  }

  const badShare = await rpc({jsonrpc:'2.0', id:5.8, method:'tools/call',
    params:{name:'share_file', arguments:{file_id:'abc'}}});
  check('share_file demands to know who it is sharing with',
    (badShare.json?.result?.content?.[0]?.text || '').includes('who is this being shared with'),
    badShare.json?.result?.content?.[0]?.text);

  const badRsvp = await rpc({jsonrpc:'2.0', id:5.9, method:'tools/call',
    params:{name:'respond_to_event', arguments:{event_id:'e1', response:'maybe'}}});
  check('respond_to_event rejects a response Google does not have',
    (badRsvp.json?.result?.content?.[0]?.text || '').includes('response must be one of'),
    badRsvp.json?.result?.content?.[0]?.text);

  const unknown = await rpc({jsonrpc:'2.0', id:6, method:'nonsense/method'});
  check('unknown method → -32601', unknown.json?.error?.code === -32601);

  const batch = await rpc([{jsonrpc:'2.0',id:7,method:'ping'},{jsonrpc:'2.0',id:8,method:'tools/list'}]);
  check('batch request returns array of 2', Array.isArray(batch.json) && batch.json.length === 2);

  // 7. refresh rotation
  const ref = await fetch(`${BASE}/mcp/oauth/token`, form({
    grant_type:'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }));
  const refreshed = await ref.json();
  check('refresh grant issues new tokens', ref.status === 200 && !!refreshed.access_token);
  check('refresh token rotated', refreshed.refresh_token !== tokens.refresh_token);

  const reuse = await fetch(`${BASE}/mcp/oauth/token`, form({
    grant_type:'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }));
  check('old refresh token rejected after rotation', reuse.status === 400);

  // 8. gmail link gate
  const linkPage = await fetch(`${BASE}/gmail/connect`);
  const linkHtml = await linkPage.text();
  check('link page renders', linkPage.status === 200 && linkHtml.includes('Link a Google account'));
  check('link page discloses what the grant covers',
    ['Gmail', 'Calendar', 'Drive', 'Contacts', 'Tasks'].every(p => linkHtml.includes(`<strong>${p}</strong>`)));

  const linkWrong = await fetch(`${BASE}/gmail/connect`, form({ password:'nope' }));
  check('link flow rejects wrong password', linkWrong.status === 401);

  const linkOk = await fetch(`${BASE}/gmail/connect`, form({ password: OPERATOR_PW }));
  const g = linkOk.headers.get('location') || '';
  check('link flow redirects to Google with offline access',
    g.startsWith('https://accounts.google.com/') && g.includes('access_type=offline') && g.includes('prompt=consent'));
  const scopes = decodeURIComponent(g);
  check('requests gmail.modify scope', scopes.includes('auth/gmail.modify'));
  check('requests the calendar, drive, contacts and tasks scopes',
    ['auth/calendar', 'auth/drive', 'auth/contacts.readonly', 'auth/tasks'].every(sc => scopes.includes(sc)));
  check('never requests the permanent-delete mail scope', !scopes.includes('mail.google.com'));

  const badState = await fetch(`${BASE}/gmail/oauth/callback?code=x&state=forged`);
  check('forged OAuth state rejected', badState.status === 400);

  // Must be LAST: tripping the password limiter would break the checks above.
  let sawLimit = false, attempts = 0;
  for (let i = 0; i < 14; i++) {
    const r = await fetch(`${BASE}/mcp/oauth/authorize`, form({
      client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', password: `guess-${i}` }));
    attempts++;
    if (r.status === 429) { sawLimit = true; break; }
  }
  check('password guessing is rate-limited', sawLimit, `throttled after ${attempts} attempts`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
