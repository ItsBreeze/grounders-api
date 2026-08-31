/**
 * Drive write guards.
 *   npm run test:drive-safety
 *
 * Two places where this server could be more dangerous than Claude's
 * first-party Drive connector, which shares only with a named email address
 * and whose update_file changes only the title and parent:
 *
 *   1. publishing a file to anyone with the link
 *   2. overwriting a document's contents
 *
 * Both are one-way and neither looks alarming in a tool result, so this asserts
 * the guards rather than trusting the tool descriptions to hold the line.
 */

let fail = 0;
const check = (name, cond, extra = '') => {
  cond || fail++;
  console.log(`${cond ? ' ok  ' : 'FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
};

/**
 * Load the drive module fresh under a given env — the schema is built at load —
 * with the account store stubbed empty, so a call that gets past the guards
 * stops at "no accounts linked" instead of reaching for a database.
 */
function loadDrive(publicSharing) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/mcp/') || key.includes('/src/services/')) delete require.cache[key];
  }
  if (publicSharing) process.env.DRIVE_ALLOW_PUBLIC_SHARING = 'true';
  else delete process.env.DRIVE_ALLOW_PUBLIC_SHARING;

  const tools = require('../src/mcp/tools/drive');
  require('../src/services/gmail_accounts').emailsFor = async () => [];
  return tools;
}

const call = async (tools, name, args) => {
  const tool = tools.find(t => t.name === name);
  try { await tool.handler({ ownerKey: 'owner', args }); return { ok: true }; }
  catch (e) { return { ok: false, message: e.message }; }
};

(async () => {
  // ─── Default: named people only, like the first-party connector ───────────
  const locked = loadDrive(false);
  const share  = locked.find(t => t.name === 'share_file');

  check('public sharing is off by default', !('anyone' in share.inputSchema.properties));
  check('domain sharing is off by default', !('domain' in share.inputSchema.properties));
  check('sharing with a person is still offered', 'email' in share.inputSchema.properties);
  check('the description says publishing is disabled',
    /disabled on this server/.test(share.description), share.description);

  const publicAttempt = await call(locked, 'share_file', { file_id: 'f1', anyone: true });
  check('a public-link share is refused, not quietly narrowed',
    !publicAttempt.ok && publicAttempt.message.includes('named people only'), publicAttempt.message);

  const domainAttempt = await call(locked, 'share_file', { file_id: 'f1', domain: 'example.com' });
  check('a domain-wide share is refused too',
    !domainAttempt.ok && domainAttempt.message.includes('named people only'), domainAttempt.message);

  check('the refusal names the switch that would allow it',
    publicAttempt.message.includes('DRIVE_ALLOW_PUBLIC_SHARING'), publicAttempt.message);

  const noTarget = await call(locked, 'share_file', { file_id: 'f1' });
  check('sharing with nobody is still an error',
    !noTarget.ok && noTarget.message.includes('who is this being shared with'), noTarget.message);

  // The guard must come before anything that could touch Google.
  check('the refusal happens before any account lookup',
    !publicAttempt.message.includes('No accounts are linked'), publicAttempt.message);

  // ─── Content replacement needs a second, explicit signal ──────────────────
  const overwrite = await call(locked, 'update_file', { file_id: 'f1', content: 'new text' });
  check('content without replace_content is refused',
    !overwrite.ok && overwrite.message.includes('replace_content: true'), overwrite.message);
  check('the refusal points at the safe alternative',
    overwrite.message.includes('rename'), overwrite.message);

  // A rename must not be blocked by the content guard — it has to reach the
  // account lookup, which is as far as it gets with nothing linked.
  const rename = await call(locked, 'update_file', { file_id: 'f1', name: 'Renamed' });
  check('a plain rename passes the guard',
    !rename.ok && rename.message.includes('No accounts are linked'), rename.message);

  const confirmed = await call(locked, 'update_file', { file_id: 'f1', content: 'x', replace_content: true });
  check('an acknowledged overwrite passes the guard',
    !confirmed.ok && confirmed.message.includes('No accounts are linked'), confirmed.message);

  // ─── Opt-in restores the wider surface ────────────────────────────────────
  const opened     = loadDrive(true);
  const openShare  = opened.find(t => t.name === 'share_file');

  check('the env flag restores public sharing to the schema', 'anyone' in openShare.inputSchema.properties);
  check('the env flag restores domain sharing', 'domain' in openShare.inputSchema.properties);
  check('the opened description warns rather than denies',
    /publishes it/.test(openShare.description), openShare.description);

  const nowAllowed = await call(opened, 'share_file', { file_id: 'f1', anyone: true });
  check('with the flag on, a public share is no longer refused outright',
    !nowAllowed.ok && nowAllowed.message.includes('No accounts are linked'), nowAllowed.message);

  loadDrive(false);

  console.log(fail ? `\n${fail} FAILED` : '\ndrive write guards hold');
  process.exit(fail ? 1 : 0);
})();
