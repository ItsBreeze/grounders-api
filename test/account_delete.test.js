/**
 * Deleting an account: the tokens die at once, and fourteen days later the
 * reaper takes the stored files with the rows.
 *
 * The checks worth never deleting:
 *
 *   1. A token issued before DELETE /users/me is refused afterwards, and stays
 *      refused when the owner signs back in; a token issued after works.
 *
 *   2. The reaper deletes a user's files BEFORE the user, and keeps the user
 *      when a file would not delete: the keys live only in the rows.
 *
 *   3. It never deletes an object a surviving row still uses, and never one a
 *      post merely names outside the user's own upload prefix.
 *
 * R2 is stubbed at S3Client.prototype.send, the database at the harness; what
 * is asserted is the statement and the object key that were about to go out.
 */

const { boot, check, run } = require('./harness');
const { S3Client } = require('@aws-sdk/client-s3');
const jwt = require('jsonwebtoken');
const { reapDeletedUsers } = require('../src/jobs/reap_users');

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://media.example.invalid';

function setR2(on) {
  process.env.R2_ACCOUNT_ID = on ? 'acct' : '';
  process.env.R2_ACCESS_KEY_ID = on ? 'key' : '';
  process.env.R2_SECRET_ACCESS_KEY = on ? 'secret' : '';
  process.env.R2_BUCKET_NAME = on ? 'bucket' : '';
}

run('account_delete', async () => {
  const h = await boot();
  const since = () => { const n = h.queries.length; return () => h.queries.slice(n); };
  const bearer = (claims, opts = { expiresIn: '30d' }) => (
    { Authorization: `Bearer ${jwt.sign(claims, process.env.JWT_SECRET, opts)}` });

  // ── Tokens ─────────────────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  h.setQueryHandler((text) => (/FROM users u/.test(text)
    ? { rows: [{ id: ME, display_name: 'Me', phone: '+15550000000' }] }
    : { rows: [], rowCount: 0 }));

  let q = since();
  let res = await h.request('DELETE', '/users/me', { headers: bearer({ sub: ME }) });
  const stamp = q().find((x) => /UPDATE users/.test(x.text));
  check('delete answers as it did', res.status === 200 && res.json.deleted === true && res.json.hard_delete_in_days === 14, res.text);
  check('it stamps the deletion and the token cut-off together', stamp
    && /deletion_pending_at = NOW\(\)/.test(stamp.text) && /tokens_revoked_at\s+= \$2/.test(stamp.text)
    && /AND deletion_pending_at IS NULL/.test(stamp.text), stamp && stamp.text);
  check('the cut-off is this process\'s clock, for this user', stamp && stamp.params[0] === ME
    && stamp.params[1] instanceof Date && Math.abs(stamp.params[1].getTime() / 1000 - now) < 5, stamp && stamp.params);
  check('refresh tokens go', q().some((x) => /DELETE FROM refresh_tokens WHERE user_id = \$1/.test(x.text) && x.params[0] === ME));
  check('device tokens go', q().some((x) => /DELETE FROM device_tokens WHERE user_id = \$1/.test(x.text) && x.params[0] === ME));
  check('the connector\'s refresh tokens are revoked', q().some((x) => /UPDATE oauth_refresh_tokens SET revoked_at = NOW\(\)\s+WHERE user_id = \$1 AND revoked_at IS NULL/.test(x.text) && x.params[0] === ME));

  const me = (claims, iat) => h.request('GET', '/users/me', { headers: bearer({ ...claims, iat }) });
  res = await me({ sub: ME }, now - 60);
  check('with no cut-off a token works as before', res.status === 200 && res.json.id === ME, res.text);

  h.setAccount({ tokens_revoked_at: new Date(now * 1000 + 400) });
  q = since();
  res = await me({ sub: ME }, now - 60);
  check('a token from before the delete is refused', res.status === 401 && res.json.error === 'Invalid or expired token', res.text);
  check('and the route behind it never ran', q().length === 0, q());
  res = await me({ sub: ME }, now);
  check('so is one from the same second', res.status === 401, res.status);
  res = await me({ sub: ME, client: 'edict' }, now - 60);
  check('so is the token the Edict link handed out', res.status === 401, res.status);
  res = await me({ sub: ME }, now + 1);
  check('a token from signing back in works', res.status === 200, res.text);
  // pg hands a timestamptz back as a Date; a string must not slip through as "no cut-off".
  h.setAccount({ tokens_revoked_at: new Date(now * 1000).toISOString() });
  res = await me({ sub: ME }, now - 60);
  check('the cut-off read as a string still refuses', res.status === 401, res.status);

  h.setAccount(null);
  res = await me({ sub: ME }, now + 1);
  check('a token for an account the reaper took is refused', res.status === 401, res.status);
  h.setAccount({ tokens_revoked_at: null });
  res = await h.request('GET', '/users/me', { headers: { Authorization: 'Bearer nonsense' } });
  check('a bad token is still a 401', res.status === 401 && res.json.error === 'Invalid or expired token', res.text);
  res = await h.request('GET', '/users/me');
  check('no token is still the same 401', res.status === 401 && res.json.error === 'Missing or malformed Authorization header', res.text);

  // ── Reaper ─────────────────────────────────────────────────────────────
  let due = [ME, OTHER];
  let radioKeys = {};
  let posts = {};
  let failKey = null;
  let events = [];
  let inFlight = 0;
  let peak = 0;
  S3Client.prototype.send = async (cmd) => {
    const name = cmd.constructor.name;
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight -= 1;
    events.push({ r2: name, bucket: cmd.input.Bucket, key: cmd.input.Key });
    if (cmd.input.Key === failKey) throw new Error('R2 said no');
    return {};
  };
  h.setQueryHandler((text, params) => {
    events.push({ sql: text, params });
    if (/^SELECT id FROM users WHERE/.test(text)) return { rows: due.map((id) => ({ id })) };
    if (/FROM radio_files f/.test(text)) return { rows: (radioKeys[params[0]] || []).map((r2_key) => ({ r2_key })) };
    if (/FROM posts WHERE user_id = \$1/.test(text)) return { rows: posts[params[0]] || [] };
    if (/^DELETE FROM users/.test(text)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const deleted = () => events.filter((e) => e.r2).map((e) => e.key);
  const usersDeleted = () => events.filter((e) => e.sql && /^DELETE FROM users/.test(e.sql)).map((e) => e.params[0]);
  const reap = async () => { events = []; peak = 0; h.consoleLines.length = 0; return reapDeletedUsers(); };

  setR2(true);
  radioKeys = { [ME]: ['radio/w1/a.m4a', 'radio/w1/b.jpg'], [OTHER]: [] };
  posts = {
    [ME]: [
      { media_url: `${BASE}/posts/${ME}/p1.jpg`, media_thumb_url: `${BASE}/posts/${ME}/p1_thumb.jpg` },
      { media_url: `${BASE}/posts/${ME}/p2.m4a`, media_thumb_url: null },
      { media_url: `${BASE}/posts/${OTHER}/theirs.jpg`, media_thumb_url: 'https://elsewhere.invalid/pic.jpg' },
      { media_url: 'not a url', media_thumb_url: `${BASE}/radio/w9/x.m4a` },
    ],
  };
  let n = await reap();
  check('both due users are reaped', n === 2 && usersDeleted().join() === [ME, OTHER].join(), usersDeleted());
  const first = events[0];
  check('due means pending for more than 14 days', /deletion_pending_at IS NOT NULL\s+AND deletion_pending_at < NOW\(\) - INTERVAL '14 days'/.test(first.sql), first.sql);
  check('voice messages, files and photos go, and the post media under the user\'s own prefix',
    deleted().sort().join() === ['radio/w1/a.m4a', 'radio/w1/b.jpg', `posts/${ME}/p1.jpg`, `posts/${ME}/p1_thumb.jpg`, `posts/${ME}/p2.m4a`].sort().join(), deleted());
  check('a post naming somebody else\'s file deletes nothing of theirs', !deleted().some((k) => k.includes(OTHER) || k.includes('w9') || k.includes('pic')), deleted());
  check('every delete names the bucket', events.filter((e) => e.r2).every((e) => e.r2 === 'DeleteObjectCommand' && e.bucket === 'bucket'), events.filter((e) => e.r2));
  const iDel = events.findIndex((e) => e.sql && /^DELETE FROM users/.test(e.sql) && e.params[0] === ME);
  const lastObj = events.map((e) => !!e.r2 && e.key.includes('1')).lastIndexOf(true);
  check('the files go before the user does', lastObj >= 0 && lastObj < iDel, { lastObj, iDel });
  const del = events[iDel];
  check('the user delete is one user, still due', /^DELETE FROM users WHERE id = \$1 AND deletion_pending_at IS NOT NULL\s+AND deletion_pending_at < NOW\(\) - INTERVAL '14 days'$/.test(del.sql), del.sql);
  const radioSql = events.find((e) => e.sql && /FROM radio_files f/.test(e.sql));
  check('radio keys: the user\'s own files and every file in a workspace they own',
    /f\.owner_id = \$1\s+OR f\.workspace_id IN \(SELECT id FROM radio_workspaces WHERE owner_id = \$1\)/.test(radioSql.sql) && /f\.r2_key IS NOT NULL/.test(radioSql.sql) && radioSql.params[0] === ME, radioSql.sql);
  check('radio keys: never one a surviving row still uses',
    /NOT EXISTS \(\s+SELECT 1 FROM radio_files s\s+WHERE s\.r2_key = f\.r2_key\s+AND s\.owner_id <> \$1\s+AND s\.workspace_id NOT IN \(SELECT id FROM radio_workspaces WHERE owner_id = \$1\)\)/.test(radioSql.sql), radioSql.sql);

  // A file that will not delete keeps its owner; everyone else still goes.
  failKey = 'radio/w1/b.jpg';
  n = await reap();
  check('a user whose file would not delete is kept', n === 1 && usersDeleted().join() === OTHER, usersDeleted());
  check('and the log says which user and why', h.consoleLines.some((l) => l.includes(ME) && /1 of 5 files not deleted/.test(l))
    && h.consoleLines.some((l) => /R2 delete failed: R2 said no/.test(l)), h.consoleLines);
  failKey = null;
  n = await reap();
  check('the next run finishes the job', n === 2 && deleted().length === 5 && usersDeleted().includes(ME), usersDeleted());

  radioKeys = { [ME]: Array.from({ length: 60 }, (_, i) => `radio/w1/${i}.m4a`) };
  posts = {};
  due = [ME];
  n = await reap();
  check('sixty files all go', n === 1 && deleted().length === 60, deleted().length);
  check('in batches of 25', peak === 25, peak);

  // No R2 on this deploy: the rows still go, and it says so.
  setR2(false);
  n = await reap();
  check('without R2 the user is still deleted', n === 1 && usersDeleted().join() === ME, usersDeleted());
  check('without R2 nothing is asked of R2 or of the file tables', deleted().length === 0 && !events.some((e) => e.sql && /radio_files|FROM posts/.test(e.sql)), events);
  check('without R2 the log says files were skipped', h.consoleLines.some((l) => /R2 is not configured/.test(l)), h.consoleLines);

  setR2(true);
  due = [];
  n = await reap();
  check('nobody due: one statement and nothing else', n === 0 && events.length === 1, events);

  h.setQueryHandler(() => { throw new Error('database is away'); });
  n = await reap();
  check('a database error is logged, not thrown at the scheduler', n === 0 && h.consoleLines.some((l) => /\[reap_users\] failed: database is away/.test(l)), h.consoleLines);

  await h.close();
});
