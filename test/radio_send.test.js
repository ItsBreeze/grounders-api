/**
 * Sending on Radio through the connector.
 *
 * The whole point of the write scope is that one client can send and the rest
 * cannot, so the checks that matter most are the boundary ones and should
 * never be removed:
 *
 *   1. A grant issued by the consent page — any third-party assistant — is
 *      never offered the send tools, and calling one by name anyway is
 *      refused without touching the database.
 *
 *   2. A partner grant can send, and what it writes is the same row the app
 *      writes: kind 'text' in radio_files, owned by the sender, in a
 *      workspace they are a member of.
 *
 *   3. A conversation the user is not in is not a conversation they can send
 *      to, whatever id the model passes.
 */

const oauth = require('../src/services/mcp_oauth');
const { boot, check, run } = require('./harness');

const ME = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const WS = '44444444-4444-4444-8444-444444444444';
const OTHER_WS = '55555555-5555-4555-8555-555555555555';
const SENT = '66666666-6666-4666-8666-666666666666';

run('radio_send', async () => {
  const h = await boot();

  let inserted = null;
  h.setQueryHandler((text, params) => {
    // /mcp authenticate()
    if (/SELECT deletion_pending_at FROM users WHERE id = \$1/.test(text)) {
      return { rows: [{ deletion_pending_at: null }] };
    }
    // resolvePerson: a friend by name
    if (/FROM friendships f\s+JOIN users u ON u\.id = CASE/.test(text)) {
      return { rows: [{ id: FRIEND, display_name: 'Ben' }] };
    }
    // resolveWorkspace: the direct thread with them
    if (/FROM radio_workspaces w\s+JOIN radio_workspace_members ma/.test(text)) {
      return { rows: [{ id: WS }] };
    }
    // membership, for a workspace_id passed straight in
    if (/SELECT 1 FROM radio_workspace_members WHERE workspace_id = \$1 AND user_id = \$2/.test(text)) {
      return { rows: params[0] === WS ? [{ '?column?': 1 }] : [] };
    }
    if (/INSERT INTO radio_files/.test(text)) {
      inserted = { text, params };
      return { rows: [{ id: SENT, workspace_id: params[1], owner_id: params[2], kind: 'text', text_content: params[3], created_at: new Date().toISOString() }] };
    }
    // recipients() for the push
    if (/SELECT user_id FROM radio_workspace_members WHERE workspace_id = \$1 AND user_id != \$2/.test(text)) {
      return { rows: [{ user_id: FRIEND }] };
    }
    if (/SELECT display_name FROM users WHERE id = \$1/.test(text)) return { rows: [{ display_name: 'Sam' }] };
    if (/SELECT name FROM radio_workspaces WHERE id = \$1/.test(text)) return { rows: [{ name: '' }] };
    // memberNames()
    if (/FROM radio_workspace_members m\s+JOIN users u ON u\.id = m\.user_id/.test(text)) {
      return { rows: [{ display_name: 'Ben' }] };
    }
    return { rows: [], rowCount: 0 };
  });

  const tokenFor = async (clientId) => (await oauth.issueTokens({ userId: ME, clientId })).access_token;
  const rpc = (token, method, params, id = 1) =>
    h.request('POST', '/mcp', {
      headers: { Authorization: `Bearer ${token}` },
      body: { jsonrpc: '2.0', id, method, params },
    });
  const callTool = (token, name, args) => rpc(token, 'tools/call', { name, arguments: args }, 7);
  const payload = (res) => JSON.parse(res.json.result.content[0].text);

  const readToken = await tokenFor('gc_third_party');
  const writeToken = await tokenFor('offhand');

  // ── A read grant cannot send ───────────────────────────────────────────
  const readList = await rpc(readToken, 'tools/list', {}, 2);
  const readNames = readList.json.result.tools.map((t) => t.name);
  check('a consent-page grant is offered no send tools',
    !readNames.some((n) => n.startsWith('radio_send')), readNames);

  const before = h.queries.length;
  const refused = await callTool(readToken, 'radio_send_message', { to: 'Ben', text: 'hi' });
  check('naming a send tool anyway is an isError result, not a send',
    refused.status === 200 && refused.json.result.isError === true
      && /cannot? .*write|not write/i.test(payload(refused).error),
    payload(refused));
  check('the refusal never reached the database',
    !h.queries.slice(before).some((q) => /INSERT INTO radio_files/.test(q.text)));

  const readInit = await rpc(readToken, 'initialize', { protocolVersion: '2025-06-18' }, 3);
  check('initialize with a read token says read-only',
    /read-only/.test(readInit.json.result.instructions)
      && !/radio_send/.test(readInit.json.result.instructions),
    readInit.json.result.instructions);

  // ── A partner grant can ────────────────────────────────────────────────
  const writeList = await rpc(writeToken, 'tools/list', {}, 4);
  const writeNames = writeList.json.result.tools.map((t) => t.name);
  check('a partner grant is offered the read tools and the send tools',
    writeNames.includes('radio_messages') && writeNames.includes('radio_send_message')
      && writeNames.includes('radio_send_file') && writeNames.includes('radio_delete_message'),
    writeNames);

  const writeInit = await rpc(writeToken, 'initialize', { protocolVersion: '2025-06-18' }, 5);
  check('initialize with a write token says sending is immediate, and Grounders stays read-only',
    /immediately/.test(writeInit.json.result.instructions)
      && /Grounders itself stays read-only/.test(writeInit.json.result.instructions),
    writeInit.json.result.instructions);

  const sent = await callTool(writeToken, 'radio_send_message', { to: 'Ben', text: '  on my way  ' });
  const body = payload(sent);
  check('sending to a friend by name resolves their direct thread and returns the message id',
    sent.status === 200 && !sent.json.result.isError && body.sent === true
      && body.message_id === `message:${SENT}` && body.workspace_id === WS,
    body);
  check('the row written is a text message owned by the sender, in that workspace',
    !!inserted && /INSERT INTO radio_files/.test(inserted.text) && /'text'/.test(inserted.text)
      && inserted.params[1] === WS && inserted.params[2] === ME && inserted.params[3] === 'on my way',
    inserted && inserted.params);
  check('the answer names who it went to, so the assistant can say so',
    Array.isArray(body.delivered_to) && body.delivered_to.includes('Ben'), body.delivered_to);

  // ── Bounds ─────────────────────────────────────────────────────────────
  const empty = await callTool(writeToken, 'radio_send_message', { to: 'Ben', text: '   ' });
  check('an empty message is refused', empty.json.result.isError === true, payload(empty));

  const notMine = await callTool(writeToken, 'radio_send_message', { workspace_id: OTHER_WS, text: 'hello' });
  check('a workspace the user is not in cannot be sent to',
    notMine.json.result.isError === true && /not a member/i.test(payload(notMine).error),
    payload(notMine));

  const noTarget = await callTool(writeToken, 'radio_send_message', { text: 'hello' });
  check('a send with no recipient is refused rather than guessed at',
    noTarget.json.result.isError === true, payload(noTarget));

  const httpUrl = await callTool(writeToken, 'radio_send_file', { to: 'Ben', url: 'http://example.com/a.jpg' });
  check('radio_send_file takes https only', httpUrl.json.result.isError === true
    && /https/i.test(payload(httpUrl).error), payload(httpUrl));

  const localUrl = await callTool(writeToken, 'radio_send_file', { to: 'Ben', url: 'https://localhost/secret' });
  check('radio_send_file will not fetch an address inside the network',
    localUrl.json.result.isError === true && /not reachable/i.test(payload(localUrl).error),
    payload(localUrl));

  const notFriend = await callTool(writeToken, 'radio_add_member', { workspace_id: WS, person: STRANGER });
  check('only a friend can be added to a conversation',
    notFriend.json.result.isError === true, payload(notFriend));

  check('no rate-limit misconfiguration or tool crash was logged',
    !h.consoleLines.some((l) => /ERR_ERL_|failed:/.test(l)), h.consoleLines);

  await h.close();
});
