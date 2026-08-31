/**
 * Writes land on files you own.
 *   npm run test:ownership
 *
 * The failure this guards against is not an error — it is a successful call
 * that changed a colleague's document. So these assert on which file id the
 * write actually reached, and that the draft path issues no write at all.
 */

const drive = require('../src/services/drive_api');
const TOOLS = require('../src/mcp/tools/drive');

let fail = 0;
const check = (name, cond, extra = '') => {
  cond || fail++;
  console.log(`${cond ? ' ok  ' : 'FAIL '} ${name}${extra ? ' — ' + String(extra).slice(0, 130) : ''}`);
};

const MINE   = { id: 'mine', name: 'My Notes', mimeType: 'text/plain', ownedByMe: true, size: '10' };
const THEIRS = {
  id: 'theirs', name: 'Prep Chart', mimeType: 'text/plain', ownedByMe: false, size: '10',
  owners: [{ emailAddress: 'brooke@fourwindsbrewing.ca' }],
};
const IN_DRIVE = {
  id: 'shared', name: 'Beer Release', mimeType: 'text/plain', ownedByMe: false, driveId: 'D9', owners: [],
};

/** Capture every request; answer file lookups with `file`. */
function record(file, extra = () => ({})) {
  const seen = [];
  global.fetch = async (url, opts = {}) => {
    const parsed = new URL(String(url));
    const body   = opts.body;
    seen.push({
      method: opts.method || 'GET',
      path:   parsed.pathname,
      query:  Object.fromEntries(parsed.searchParams),
      json:   typeof body === 'string' && body.startsWith('{') ? JSON.parse(body) : null,
      text:   Buffer.isBuffer(body) ? body.toString('latin1') : (typeof body === 'string' ? body : null),
    });
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ ...file, ...extra(parsed, seen) }),
      arrayBuffer: async () => Buffer.from('old line\ncommon\n'),
    };
  };
  return seen;
}

const run = (name, args) => TOOLS.find(t => t.name === name)
  .handler({ ownerKey: 'k', args })
  .then(r => ({ ok: true, body: JSON.parse(r.content[0].text) }), e => ({ ok: false, message: e.message }));

// One account, so `account` may be omitted and tokens resolve.
const accounts = require('../src/services/gmail_accounts');
accounts.emailsFor      = async () => ['me@example.com'];
accounts.accessTokenFor = async () => 'tok';

const writes = seen => seen.filter(r => r.method !== 'GET');

(async () => {
  // ─── A file you own is untouched by any of this ───────────────────────────
  console.log('\nFiles you own');

  let seen = record(MINE);
  let res  = await run('update_file', { file_id: 'mine', name: 'Renamed' });
  check('renaming your own file just happens', res.ok && res.body.updated === true, res.message);
  check('no copy is made', !seen.some(r => r.path.includes('/copy')));
  check('the write lands on the file itself', writes(seen)[0].path.endsWith('/mine'), writes(seen)[0].path);
  check('and it is not flagged as someone else\'s', res.body.edited_a_private_copy === undefined);

  // ─── Someone else's file: the default is a private copy ───────────────────
  console.log('\nSomeone else\'s file — the default');

  seen = record(THEIRS, (parsed) => (parsed.pathname.endsWith('/copy') ? { id: 'copy1', name: 'Prep Chart (copy)' } : {}));
  res  = await run('update_file', { file_id: 'theirs', content: 'new text', replace_content: true });

  check('a copy is made', seen.some(r => r.path.includes('/copy') && r.method === 'POST'));
  const copyCall = seen.find(r => r.path.includes('/copy'));
  check('the copy goes to YOUR My Drive, not back into their space',
    JSON.stringify((copyCall.json || {}).parents) === '["root"]', JSON.stringify(copyCall.json));
  const edits = writes(seen).filter(r => r.method === 'PATCH' || r.path.includes('/upload/'));
  check('the edit lands on the copy', edits.every(r => r.path.includes('copy1')), edits.map(r => r.path).join(', '));
  check('their file is never written to', !writes(seen).some(r => r.path.endsWith('/theirs')));
  check('the result says a copy was edited', res.body.edited_a_private_copy === true);
  check('and names the owner it protected', String(res.body.note).includes('brooke@fourwindsbrewing.ca'), res.body.note);
  check('the original is reported so it can still be found', res.body.original.file_id === 'theirs');

  // ─── Asking for the original returns a draft, and writes nothing ──────────
  console.log('\nAsking for the original');

  seen = record(THEIRS);
  res  = await run('update_file', { file_id: 'theirs', name: 'Renamed', edit_original: true });
  check('nothing is written', writes(seen).length === 0, writes(seen).map(r => r.method + ' ' + r.path).join(', '));
  check('the answer is a draft', res.body.applied === false && String(res.body.status).startsWith('DRAFT'));
  check('it names whose file it is', String(res.body.reason).includes('brooke@fourwindsbrewing.ca'), res.body.reason);
  check('it states the change precisely',
    res.body.changes[0].field === 'name' && res.body.changes[0].from === 'Prep Chart' && res.body.changes[0].to === 'Renamed',
    JSON.stringify(res.body.changes));
  check('and says approval is the user\'s to give',
    String(res.body.to_apply).includes('user') && String(res.body.to_apply).includes('confirm_edit'), res.body.to_apply);

  seen = record(THEIRS);
  res  = await run('update_file', { file_id: 'theirs', content: 'new line\ncommon\n', replace_content: true, edit_original: true });
  check('a content draft shows the line that changes',
    res.body.content.diff.added[0] === 'new line' && res.body.content.diff.removed[0] === 'old line',
    JSON.stringify(res.body.content.diff));
  check('it reports the size either side', res.body.content.size_after === 'new line\ncommon\n'.length);
  check('still nothing written', writes(seen).length === 0);

  seen = record(THEIRS);
  res  = await run('update_file', { file_id: 'theirs', content_base64: 'YWJj', replace_content: true, edit_original: true });
  check('a binary draft says a preview is impossible rather than faking one',
    String(res.body.content.note).includes('Binary'), res.body.content.note);

  // ─── Confirming applies it to the original ────────────────────────────────
  console.log('\nAfter the user approves');

  seen = record(THEIRS);
  res  = await run('update_file', { file_id: 'theirs', name: 'Renamed', edit_original: true, confirm_edit: true });
  check('the write finally lands on their file', writes(seen).some(r => r.path.endsWith('/theirs')));
  check('no copy is made once confirmed', !seen.some(r => r.path.includes('/copy')));
  check('and the result does not hide whose file it was',
    res.body.edited_someone_elses_file === 'brooke@fourwindsbrewing.ca', JSON.stringify(res.body.edited_someone_elses_file));

  // ─── Shared drives count as not yours ─────────────────────────────────────
  console.log('\nShared drives');

  seen = record(IN_DRIVE);
  res  = await run('update_file', { file_id: 'shared', name: 'x', edit_original: true });
  check('a shared-drive file is never "yours", even with no owner listed', res.body.applied === false);
  check('the refusal explains why there is no owner to name',
    String(res.body.reason).includes('organisation'), res.body.reason);

  // ─── Trashing and sharing draft too; undo never does ──────────────────────
  console.log('\nRemoving, sharing, and the undos');

  seen = record(THEIRS);
  res  = await run('trash_file', { file_id: 'theirs' });
  check('trashing someone else\'s file drafts instead', res.body.applied === false);
  check('nothing is trashed', writes(seen).length === 0);
  check('the draft says who else it affects', String(res.body.would).includes('everyone who uses it'), res.body.would);

  seen = record(THEIRS);
  res  = await run('trash_file', { file_id: 'theirs', confirm_edit: true });
  check('confirmed, it trashes', writes(seen).some(r => r.method === 'PATCH'), res.message);

  seen = record(THEIRS);
  res  = await run('share_file', { file_id: 'theirs', email: 'x@y.com', role: 'writer' });
  check('sharing someone else\'s file drafts instead', res.body.applied === false);
  check('the draft names who would get what', String(res.body.would).includes('x@y.com') && String(res.body.would).includes('writer'), res.body.would);
  check('no permission is created', writes(seen).length === 0);

  seen = record(THEIRS);
  res  = await run('unshare_file', { file_id: 'theirs', permission_id: 'p1' });
  check('REVOKING is never gated — the brake must always work', res.ok && res.body.applied === undefined, res.message);
  check('and it really did revoke', writes(seen).some(r => r.method === 'DELETE'), writes(seen).map(r => r.method).join(','));

  seen = record({ ...THEIRS, trashed: false });
  res  = await run('untrash_file', { file_id: 'theirs' });
  check('RESTORING is never gated either', res.ok && res.body.applied === undefined, res.message);

  // ─── Naming a shared drive you are not a member of ────────────────────────
  console.log('\nNaming shared drives');

  seen = [];
  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.pathname + '?' + parsed.searchParams.get('pageToken'));
    return { ok: true, status: 200, text: async () => JSON.stringify({ drives: [{ id: 'D1', name: 'Taproom' }] }) };
  };

  const named = await drive.nameSharedDrives('tok', [
    { id: 'a', shared_drive_id: 'D1' },
    { id: 'b', shared_drive_id: 'D2' },
  ]);
  check('a drive you are a member of is named', named[0].shared_drive === 'Taproom');
  check('one you are not a member of says so, rather than showing a bare id',
    named[1].shared_drive_member === false && named[1].shared_drive === undefined, JSON.stringify(named[1]));
  check('and it keeps the id, which is still true', named[1].shared_drive_id === 'D2');
  check('naming never asks about a drive it cannot read — that answers "File not found"',
    !seen.some(p => p.includes('/files/')), seen.join(', '));

  // Membership beyond one page must not look like non-membership.
  let page = 0;
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(page++ === 0
      ? { drives: [{ id: 'D1', name: 'First' }], nextPageToken: 'p2' }
      : { drives: [{ id: 'D2', name: 'Hundred and first' }] }),
  });
  const paged = await drive.nameSharedDrives('tok', [{ id: 'b', shared_drive_id: 'D2' }]);
  check('a drive past the first page of memberships is still named',
    paged[0].shared_drive === 'Hundred and first', JSON.stringify(paged[0]));

  global.fetch = async () => ({ ok: false, status: 403, text: async () => '{"error":{"message":"nope"}}' });
  const stubborn = await drive.nameSharedDrives('tok', [{ id: 'a', shared_drive_id: 'D3' }]);
  check('failing to list drives never fails the search that found the files',
    stubborn[0].shared_drive_id === 'D3' && stubborn[0].id === 'a');

  console.log(fail ? `\n${fail} FAILED` : '\nwrites stay on files you own');
  process.exit(fail ? 1 : 0);
})();
