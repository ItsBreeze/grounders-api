/**
 * Live smoke test — every product, against real Google data.
 *   SMOKE_BASE_URL=https://…  MCP_ADMIN_PASSWORD=…  npm run smoke
 *
 * Run this from a machine that can reach the deployment, right after
 * re-linking accounts. It signs in the same way Claude does — dynamic client
 * registration, the operator consent screen, PKCE, token exchange — then calls
 * one read tool per product and reports what came back.
 *
 * READ-ONLY BY CONSTRUCTION. Every tool it may call is on the allow-list below
 * and the runner refuses anything absent from it, so pointing this at
 * production cannot send mail, change a calendar, or touch a file.
 *
 * It reports shapes and counts, never contents: this prints to a terminal and
 * may end up in a scrollback or a CI log, and "3 messages" is all the evidence
 * needed that search worked.
 */

const crypto = require('crypto');

const BASE     = (process.env.SMOKE_BASE_URL || process.env.TEST_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const PASSWORD = process.env.MCP_ADMIN_PASSWORD;

if (!PASSWORD) {
  console.error('Set MCP_ADMIN_PASSWORD (the operator password for this deployment).');
  process.exit(2);
}

/** Nothing here writes. The runner enforces it rather than trusting the list below to stay read-only. */
const READ_ONLY = new Set([
  'list_accounts', 'search_messages', 'search_threads', 'get_message', 'get_thread', 'get_attachment',
  'list_drafts', 'list_labels',
  'list_calendars', 'list_events', 'search_events', 'get_event', 'suggest_time',
  'search_files', 'list_recent_files', 'list_shared_drives', 'get_file_metadata', 'read_file_content', 'get_file_permissions',
  'search_contacts', 'list_contacts',
  'list_task_lists', 'list_tasks',
]);

let passed = 0;
let failed = 0;
let skipped = 0;

const ok   = (label, detail = '') => { passed++; console.log(`  ok    ${label}${detail ? ' — ' + detail : ''}`); };
const bad  = (label, detail = '') => { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); };
const note = (label, detail = '') => { skipped++; console.log(`  --    ${label}${detail ? ' — ' + detail : ''}`); };

const form = (obj) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(obj).toString(),
  redirect: 'manual',
});

async function signIn() {
  const registration = await fetch(`${BASE}/mcp/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'smoke test', redirect_uris: ['https://example.com/callback'] }),
  });
  if (!registration.ok) throw new Error(`Dynamic client registration failed: HTTP ${registration.status}`);
  const client = await registration.json();

  const verifier  = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const consent = await fetch(`${BASE}/mcp/oauth/authorize`, form({
    client_id: client.client_id,
    redirect_uri: 'https://example.com/callback',
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'smoke',
    password: PASSWORD,
  }));

  if (consent.status === 401) throw new Error('The operator password was rejected.');
  const location = consent.headers.get('location');
  if (!location) throw new Error(`Consent did not redirect (HTTP ${consent.status}) — is this the right deployment?`);

  const code = new URL(location).searchParams.get('code');
  const granted = await fetch(`${BASE}/mcp/oauth/token`, form({
    grant_type: 'authorization_code',
    code,
    client_id: client.client_id,
    redirect_uri: 'https://example.com/callback',
    code_verifier: verifier,
  }));
  if (!granted.ok) throw new Error(`Token exchange failed: HTTP ${granted.status}`);

  return (await granted.json()).access_token;
}

function rpc(token) {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });

    const body = await res.text();
    const json = body.startsWith('event:')
      ? JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1))
      : JSON.parse(body || '{}');

    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  };
}

/** Call one read tool and report on the shape of what came back. */
async function probe(send, label, name, args, describe) {
  if (!READ_ONLY.has(name)) { bad(label, `${name} is not on the read-only allow-list — refusing to call it`); return null; }

  try {
    const result  = await send('tools/call', { name, arguments: args });
    const payload = result?.content?.[0]?.text ?? '';

    if (result?.isError) {
      // A grant that predates a product is the expected failure right after an
      // upgrade, and it has a specific fix — call it out rather than lumping it
      // in with real breakage.
      if (/was linked before/.test(payload)) {
        note(label, 'account needs re-linking for this product — visit /gmail/connect again');
      } else if (/No accounts are linked/.test(payload)) {
        note(label, 'no accounts linked yet');
      } else {
        bad(label, payload.split('\n')[0].slice(0, 160));
      }
      return null;
    }

    let parsed = null;
    try { parsed = JSON.parse(payload); } catch { /* a plain-text result is fine */ }

    ok(label, describe ? describe(parsed, payload) : '');
    return parsed;
  } catch (err) {
    bad(label, err.message.slice(0, 160));
    return null;
  }
}

(async () => {
  console.log(`\nSmoke test against ${BASE}\n`);

  let token;
  try {
    token = await signIn();
    ok('signed in', 'registration, consent, PKCE and token exchange');
  } catch (err) {
    bad('sign-in', err.message);
    console.log('\nCannot continue without a token.\n');
    process.exit(1);
  }

  const send = rpc(token);

  const listed = await send('tools/list');
  const names  = (listed.tools || []).map(t => t.name);
  console.log(`\nTool surface: ${names.length} tools\n`);

  // ─── Accounts ─────────────────────────────────────────────────────────────
  const accounts = await probe(send, 'list_accounts', 'list_accounts', {},
    (parsed) => (Array.isArray(parsed) ? `${parsed.length} account(s): ${parsed.map(a => a.email).join(', ')}` : 'none linked'));

  if (!Array.isArray(accounts) || !accounts.length) {
    console.log('\nNo accounts are linked, so there is nothing to read. Visit /gmail/connect first.\n');
    process.exit(1);
  }

  // ─── One read per product, fanned across every account ────────────────────
  console.log('\nGmail');
  await probe(send, 'search_messages', 'search_messages', { query: 'newer_than:7d', max_results: 3 },
    (p) => `${p.count} message(s) across ${p.searched.length} account(s)`);
  await probe(send, 'search_threads', 'search_threads', { query: 'newer_than:7d', max_results: 3 },
    (p) => `${p.count} thread(s); first has ${p.threads?.[0]?.message_count ?? 0} message(s) and ${p.threads?.[0]?.participants?.length ?? 0} participant(s)`);
  await probe(send, 'list_labels', 'list_labels', {}, () => 'labels readable');

  console.log('\nCalendar');
  await probe(send, 'list_calendars', 'list_calendars', {},
    (p) => `${p.count} calendar(s) across ${p.searched.length} account(s)`);
  await probe(send, 'list_events', 'list_events', { max_results: 5 },
    (p) => `${p.count} event(s) in the next 7 days`);
  await probe(send, 'suggest_time', 'suggest_time', { duration_minutes: 30 },
    (p) => `${p.count} free slot(s) from ${p.busy_blocks} busy block(s) across ${p.checked.length} account(s)`);

  console.log('\nDrive');
  const recent = await probe(send, 'list_recent_files', 'list_recent_files', { max_results: 5 },
    (p) => `${p.count} file(s) across ${p.searched.length} account(s)`);
  await probe(send, 'search_files', 'search_files', { query: 'a', max_results: 3 },
    (p) => `${p.count} match(es)`);
  await probe(send, 'list_shared_drives', 'list_shared_drives', {},
    (p) => `${p.count} shared drive(s) across ${p.searched.length} account(s)`);

  // Prove text extraction on whatever real document is nearest to hand.
  const readable = (recent?.files || []).find(f =>
    /\.(pdf|docx|xlsx|pptx|odt)$/i.test(f.name || '') ||
    /google-apps\.(document|spreadsheet|presentation)/.test(f.mime_type || ''));

  if (readable) {
    await probe(send, `read_file_content (${readable.name})`, 'read_file_content',
      { account: readable.account, file_id: readable.id },
      (p) => `${(p.content || '').length} characters${p.pages ? `, ${p.pages} page(s)` : ''}${p.read_as ? `, via ${p.read_as}` : ''}`);
  } else {
    note('read_file_content', 'no PDF, Office or Google-native file among the recent ones to try');
  }

  console.log('\nContacts and Tasks');
  await probe(send, 'search_contacts', 'search_contacts', { query: 'a', max_results: 3 },
    (p) => `${p.count} person/people`);
  await probe(send, 'list_task_lists', 'list_task_lists', {},
    (p) => `${p.count} task list(s)`);
  await probe(send, 'list_tasks', 'list_tasks', { max_results: 5 },
    (p) => `${p.count} open task(s)`);

  console.log(`\n${passed} ok, ${failed} failed, ${skipped} skipped\n`);
  if (failed) console.log('Anything marked "needs re-linking" is fixed by visiting /gmail/connect again for that account.\n');
  process.exit(failed ? 1 : 0);
})();
