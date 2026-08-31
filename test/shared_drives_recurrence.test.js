/**
 * Shared drives, and repeating events.
 *   npm run test:reach
 *
 * Both features are ones where the wrong request does not fail — it quietly
 * answers about a smaller world. A Drive call without `supportsAllDrives` says
 * "File not found" for a file that plainly exists, and an edit to a recurring
 * event lands on one Tuesday when the user meant every Tuesday. So these
 * assert the parameters and the target id, not just that a call was made.
 */

const drive    = require('../src/services/drive_api');
const calendar = require('../src/services/calendar_api');

let fail = 0;
const check = (name, cond, extra = '') => {
  cond || fail++;
  console.log(`${cond ? ' ok  ' : 'FAIL '} ${name}${extra ? ' — ' + String(extra).slice(0, 120) : ''}`);
};

/** Capture every request, answering with whatever the test needs back. */
function record(reply = () => ({})) {
  const seen = [];
  global.fetch = async (url, opts = {}) => {
    const parsed = new URL(String(url));
    const body   = opts.body;
    seen.push({
      method: opts.method || 'GET',
      path:   parsed.pathname,
      query:  Object.fromEntries(parsed.searchParams),
      json:   typeof body === 'string' && body.startsWith('{') ? JSON.parse(body) : null,
    });
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify(reply(parsed, seen)),
      arrayBuffer: async () => Buffer.from('BYTES'),
    };
  };
  return seen;
}

const caught = async (run) => { try { await run(); return ''; } catch (e) { return e.message; } };

(async () => {
  // ─── Drive: every method that takes supportsAllDrives gets it ─────────────
  console.log('\nShared drives');

  let seen = record(() => ({ id: 'f1', name: 'thing', mimeType: 'text/plain', files: [], permissions: [], comments: [] }));

  await drive.searchFiles('tok', { query: 'budget' });
  await drive.getMetadata('tok', 'f1');
  await drive.updateFile('tok', 'f1', { name: 'renamed' });
  await drive.copyFile('tok', 'f1', { name: 'copy' });
  await drive.listPermissions('tok', 'f1');
  await drive.share('tok', 'f1', { email: 'a@b.com' });
  await drive.unshare('tok', 'f1', { permissionId: 'p1' });
  await drive.trashFile('tok', 'f1');
  await drive.untrashFile('tok', 'f1');
  await drive.createFile('tok', { name: 'new', content: 'hi' });

  const missing = seen.filter(r => r.query.supportsAllDrives !== 'true');
  check('every files.* and permissions.* call carries supportsAllDrives',
    missing.length === 0, missing.map(r => `${r.method} ${r.path}`).join(', '));
  check('the multipart upload carries it too — a shared-drive folder is a valid parent',
    seen.some(r => r.path.includes('/upload/drive/v3/files') && r.query.supportsAllDrives === 'true'));

  // Export and comments do not accept the parameter; sending it risks a 400.
  seen = record(() => ({ id: 'f1', name: 'doc', mimeType: 'application/vnd.google-apps.document', comments: [] }));
  await drive.getContent('tok', 'f1');
  await drive.listComments('tok', 'f1');
  await drive.addComment('tok', 'f1', { content: 'hi' });

  const overreach = seen.filter(r =>
    (r.path.includes('/export') || r.path.includes('/comments')) && r.query.supportsAllDrives);
  check('export and comments do NOT get it — they do not accept it',
    overreach.length === 0, overreach.map(r => r.path).join(', '));

  // ─── Drive: the search actually looks in shared drives ────────────────────
  seen = record(() => ({ files: [] }));
  await drive.searchFiles('tok', { query: 'q' });
  check('a search includes items from all drives', seen[0].query.includeItemsFromAllDrives === 'true');
  check('and its corpora spans them — the default of "user" would miss every shared drive',
    seen[0].query.corpora === 'allDrives', seen[0].query.corpora);
  check('no driveId is sent when none was asked for', seen[0].query.driveId === undefined);

  seen = record(() => ({ files: [] }));
  await drive.searchFiles('tok', { query: 'q', driveId: 'D9' });
  check('naming a drive narrows the corpora to it', seen[0].query.corpora === 'drive', seen[0].query.corpora);
  check('and passes the drive id', seen[0].query.driveId === 'D9');

  seen = record(() => ({ files: [] }));
  await drive.listRecent('tok', { driveId: 'D9' });
  check('list_recent_files can be confined to one shared drive too', seen[0].query.driveId === 'D9');
  check('recency ordering survives the all-drives search', seen[0].query.orderBy === 'modifiedTime desc');

  // ─── Drive: results say which drive a file lives in ───────────────────────
  const summarize = drive._internal.summarizeFile;
  check('a shared-drive file reports its drive', summarize({ id: 'a', driveId: 'D9' }).shared_drive_id === 'D9');
  check('a My Drive file reports none', summarize({ id: 'a' }).shared_drive_id === null);

  seen = record((parsed) => (parsed.pathname.endsWith('/drives')
    ? { drives: [{ id: 'D9', name: 'Marketing' }] }
    : { files: [] }));

  const named = await drive.nameSharedDrives('tok', [{ id: 'a', shared_drive_id: 'D9' }, { id: 'b', shared_drive_id: null }]);
  check('a bare drive id is replaced by the drive name', named[0].shared_drive === 'Marketing', JSON.stringify(named[0]));
  check('a My Drive file is left alone', named[1].shared_drive === undefined);

  seen = record(() => ({ files: [] }));
  await drive.nameSharedDrives('tok', [{ id: 'a', shared_drive_id: null }]);
  check('no shared-drive files means no extra call at all', seen.length === 0, `${seen.length} calls`);

  global.fetch = async () => ({ ok: false, status: 403, text: async () => '{"error":{"message":"nope"}}' });
  const survived = await drive.nameSharedDrives('tok', [{ id: 'a', shared_drive_id: 'D9' }]);
  check('failing to name a drive never fails the search that found the files',
    survived[0].id === 'a' && survived[0].shared_drive === undefined);

  // ─── Calendar: recurrence rules ───────────────────────────────────────────
  console.log('\nRecurring events');

  const build = calendar._internal.buildRecurrence;

  check('weekly becomes a weekly rule', build({ repeat: 'weekly' })[0] === 'RRULE:FREQ=WEEKLY', build({ repeat: 'weekly' })[0]);
  check('a count ends the series after n occurrences',
    build({ repeat: 'daily', repeatCount: 5 })[0] === 'RRULE:FREQ=DAILY;COUNT=5');
  check('an until date becomes a UTC stamp, as RFC 5545 requires',
    build({ repeat: 'weekly', repeatUntil: '2026-12-31T17:00:00Z' })[0] === 'RRULE:FREQ=WEEKLY;UNTIL=20261231T170000Z',
    build({ repeat: 'weekly', repeatUntil: '2026-12-31T17:00:00Z' })[0]);
  check('an all-day series takes a bare date instead — the two forms cannot be mixed',
    build({ repeat: 'weekly', repeatUntil: '2026-12-31' }, { allDay: true })[0] === 'RRULE:FREQ=WEEKLY;UNTIL=20261231');
  check('nothing asked for means no rule at all', build({}) === undefined);

  check('a raw rule passes through', build({ recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=2TU'] })[0] === 'RRULE:FREQ=MONTHLY;BYDAY=2TU');
  check('a lower-case property name is upper-cased for Google',
    build({ recurrence: ['rrule:FREQ=WEEKLY'] })[0] === 'RRULE:FREQ=WEEKLY');
  check('a TZID parameter keeps its case — America/Vancouver is not AMERICA/VANCOUVER',
    build({ recurrence: ['EXDATE;TZID=America/Vancouver:20260901T090000'] })[0]
      === 'EXDATE;TZID=America/Vancouver:20260901T090000',
    build({ recurrence: ['EXDATE;TZID=America/Vancouver:20260901T090000'] })[0]);

  check('a rule with no FREQ is refused here rather than as a generic 400',
    (await caught(async () => build({ recurrence: ['RRULE:COUNT=3'] }))).includes('FREQ='));
  check('an unknown FREQ is named', (await caught(async () => build({ recurrence: ['RRULE:FREQ=FORTNIGHTLY'] }))).includes('FORTNIGHTLY'));
  check('DTSTART is refused, pointing at the fields that carry it',
    (await caught(async () => build({ recurrence: ['DTSTART:20260901T090000Z'] }))).includes('start and end'));
  check('a line with no colon is refused', (await caught(async () => build({ recurrence: ['FREQ=WEEKLY'] }))).includes('no ":"'));
  check('an unknown repeat lists the ones that work',
    (await caught(async () => build({ repeat: 'fortnightly' }))).includes('daily, weekly, monthly, yearly'));
  check('both forms at once is refused', (await caught(async () => build({ repeat: 'daily', recurrence: ['RRULE:FREQ=DAILY'] }))).includes('not both'));
  check('count and until at once is refused',
    (await caught(async () => build({ repeat: 'daily', repeatCount: 2, repeatUntil: '2026-01-01' }))).includes('not both'));
  check('a count with no repeat is refused rather than ignored',
    (await caught(async () => build({ repeatCount: 3 }))).includes('repeat'));

  seen = record(() => ({ id: 'e1', summary: 'Standup', start: {}, end: {} }));
  await calendar.createEvent('tok', 'primary', { title: 'Standup', start: '2026-09-01T09:00:00Z', end: '2026-09-01T09:15:00Z', repeat: 'weekly' });
  check('creating a repeating event sends the rule', (seen[0].json.recurrence || [])[0] === 'RRULE:FREQ=WEEKLY', JSON.stringify(seen[0].json.recurrence));

  // ─── Calendar: reads carry the series id ──────────────────────────────────
  const summarizeEvent = calendar._internal.summarizeEvent;
  const occurrence = summarizeEvent({ id: 'e1_20260901T090000Z', recurringEventId: 'e1', start: {}, end: {} }, 'primary');
  check('an occurrence names the series it belongs to', occurrence.recurring_event_id === 'e1');
  check('and is still flagged as recurring', occurrence.recurring === true);
  const master = summarizeEvent({ id: 'e1', recurrence: ['RRULE:FREQ=WEEKLY'], start: {}, end: {} }, 'primary');
  check('the series itself reports its rules', master.recurrence[0] === 'RRULE:FREQ=WEEKLY');
  check('a one-off event names no series', summarizeEvent({ id: 'x', start: {}, end: {} }, 'primary').recurring_event_id === null);

  // ─── Calendar: which event a write lands on ───────────────────────────────
  const INSTANCE = { id: 'e1_20260901T090000Z', recurringEventId: 'e1', summary: 'Standup', start: {}, end: {} };
  const MASTER   = { id: 'e1', recurrence: ['RRULE:FREQ=WEEKLY'], summary: 'Standup', start: {}, end: {} };
  const ONE_OFF  = { id: 'z1', summary: 'Lunch', start: {}, end: {} };

  seen = record(() => INSTANCE);
  let updated = await calendar.updateEvent('tok', 'primary', INSTANCE.id, { title: 'Later' });
  check('by default an occurrence is edited in place',
    seen[1].path.endsWith(encodeURIComponent(INSTANCE.id)), seen[1].path);
  check('and the result says so', updated.applies_to === 'this_occurrence', updated.applies_to);

  seen = record(() => INSTANCE);
  updated = await calendar.updateEvent('tok', 'primary', INSTANCE.id, { title: 'Later', scope: 'series' });
  check('scope "series" redirects the write to the series, not the occurrence',
    seen[1].path.endsWith('/e1') && seen[1].method === 'PATCH', seen[1].path);

  seen = record(() => MASTER);
  updated = await calendar.updateEvent('tok', 'primary', 'e1', { title: 'Later' });
  check('editing the series master reports that it changed every occurrence',
    updated.applies_to === 'series', updated.applies_to);

  seen = record(() => ONE_OFF);
  check('asking for "series" on a one-off event says so plainly',
    (await caught(() => calendar.updateEvent('tok', 'primary', 'z1', { title: 'x', scope: 'series' }))).includes('one-off'));

  seen = record(() => INSTANCE);
  check('a repeat rule cannot be written to a single occurrence',
    (await caught(() => calendar.updateEvent('tok', 'primary', INSTANCE.id, { repeat: 'daily' }))).includes('scope: "series"'));

  seen = record(() => INSTANCE);
  check('an unknown scope is rejected before anything is written',
    (await caught(() => calendar.updateEvent('tok', 'primary', INSTANCE.id, { title: 'x', scope: 'all' }))).includes('this_event'));

  seen = record(() => INSTANCE);
  let gone = await calendar.deleteEvent('tok', 'primary', INSTANCE.id, {});
  check('deleting defaults to the single occurrence',
    seen[1].method === 'DELETE' && seen[1].path.endsWith(encodeURIComponent(INSTANCE.id)), seen[1].path);
  check('the delete reports what went, by name', gone.title === 'Standup' && gone.applies_to === 'this_occurrence');

  seen = record(() => MASTER);
  const stopped = await calendar.updateEvent('tok', 'primary', 'e1', { recurrence: [] });
  check('an empty recurrence clears the rules, leaving a single event',
    Array.isArray(seen[1].json.recurrence) && seen[1].json.recurrence.length === 0, JSON.stringify(seen[1].json));
  check('and it is still reported as having touched the series', stopped.applies_to === 'series');

  seen = record(() => INSTANCE);
  gone = await calendar.deleteEvent('tok', 'primary', INSTANCE.id, { scope: 'series' });
  check('scope "series" cancels the whole series instead', seen[1].path.endsWith('/e1'), seen[1].path);
  check('and the result does not pretend it was one occurrence', gone.applies_to === 'series');

  console.log(fail ? `\n${fail} FAILED` : '\nshared drives and recurrence hold');
  process.exit(fail ? 1 : 0);
})();
