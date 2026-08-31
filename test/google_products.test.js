/**
 * Calendar, Drive, Contacts and Tasks shaping.
 *   npm run test:products
 *
 * No network and no database: the transport is stubbed, so what this asserts
 * is the arithmetic and the shaping — free-slot merging, Drive query quoting,
 * multipart upload framing, RSVP patching, scope gating — the parts that stay
 * wrong silently rather than throwing.
 */

const calendar = require('../src/services/calendar_api');
const drive    = require('../src/services/drive_api');
const tasks    = require('../src/services/tasks_api');
const people   = require('../src/services/people_api');

let fail = 0;
const check = (name, cond, extra = '') => {
  cond || fail++;
  console.log(`${cond ? ' ok  ' : 'FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
};

const HOUR = 60 * 60 * 1000;
const day  = (h, m = 0) => new Date(Date.UTC(2026, 8, 1, h, m)).toISOString();

// ─── Calendar: free-slot arithmetic ─────────────────────────────────────────

const window = { from: day(9), to: day(17), durationMs: HOUR };

check('an empty calendar is one long slot',
  JSON.stringify(calendar.freeSlots([], window)) === JSON.stringify([{ start: day(9), end: day(17) }]));

const overlapping = calendar.freeSlots([
  { start: day(10), end: day(11) },
  { start: day(10, 30), end: day(12) },   // overlaps the first
  { start: day(12), end: day(13) },       // abuts the second
], window);
check('overlapping and abutting busy blocks merge into one',
  overlapping.length === 2 && overlapping[0].end === day(10) && overlapping[1].start === day(13),
  JSON.stringify(overlapping));

const unsorted = calendar.freeSlots([
  { start: day(14), end: day(15) },
  { start: day(10), end: day(11) },
], window);
check('busy blocks arriving out of order still work',
  unsorted.length === 3 && unsorted[0].start === day(9) && unsorted[2].end === day(17),
  JSON.stringify(unsorted));

check('a gap shorter than the duration is not offered',
  calendar.freeSlots([{ start: day(10), end: day(11) }], { ...window, durationMs: 2 * HOUR })
    .every(s => new Date(s.end) - new Date(s.start) >= 2 * HOUR));

check('busy blocks outside the window are ignored',
  calendar.freeSlots([{ start: day(3), end: day(5) }], window).length === 1);

check('a block overhanging the window is clipped, not dropped',
  calendar.freeSlots([{ start: day(8), end: day(10) }], window)[0].start === day(10));

check('a fully booked window yields nothing',
  calendar.freeSlots([{ start: day(9), end: day(17) }], window).length === 0);

check('the limit is respected',
  calendar.freeSlots(
    [{ start: day(10), end: day(10, 30) }, { start: day(12), end: day(12, 30) }, { start: day(14), end: day(14, 30) }],
    { ...window, durationMs: 15 * 60 * 1000, limit: 2 },
  ).length === 2);

let threw = '';
try { calendar.freeSlots([], { from: day(17), to: day(9), durationMs: HOUR }); } catch (e) { threw = e.message; }
check('a backwards window is rejected', threw.includes('ends before it starts'), threw);

// ─── Calendar: event shaping ────────────────────────────────────────────────

const summarize = calendar._internal.summarizeEvent;

const timed = summarize({
  id: 'e1',
  summary: 'Roof quote',
  start: { dateTime: '2026-09-01T10:00:00-06:00', timeZone: 'America/Denver' },
  end:   { dateTime: '2026-09-01T11:00:00-06:00' },
  attendees: [
    { email: 'ann@x.com', responseStatus: 'accepted' },
    { email: 'me@y.com', responseStatus: 'tentative', self: true },
  ],
  htmlLink: 'https://cal/e1',
}, 'primary');

check('timed event start is the dateTime', timed.start === '2026-09-01T10:00:00-06:00', timed.start);
check('timed event is not all-day', timed.all_day === false);
check('my own RSVP is lifted out of the attendee list', timed.my_response === 'tentative', String(timed.my_response));
check('attendee responses are kept', timed.attendees.length === 2 && timed.attendees[0].response === 'accepted');
check('calendar id is carried on the event', timed.calendar_id === 'primary');

const allDay = summarize({ id: 'e2', start: { date: '2026-09-01' }, end: { date: '2026-09-02' } }, 'primary');
check('all-day event uses the bare date', allDay.start === '2026-09-01' && allDay.all_day === true);
check('an event with no title says so', allDay.title === '(no title)', allDay.title);
check('no attendees means no RSVP, not a crash', allDay.my_response === null);

const pair = calendar._internal.timePair;
check('a bare date builds an all-day pair', JSON.stringify(pair('2026-09-01')) === '{"date":"2026-09-01"}');
check('a datetime builds a timed pair with the zone',
  JSON.stringify(pair('2026-09-01T10:00:00', 'America/Denver'))
    === '{"dateTime":"2026-09-01T10:00:00","timeZone":"America/Denver"}');

// ─── Drive: query building ──────────────────────────────────────────────────

const q = drive._internal.buildQuery;

check('free text searches full text', q({ query: 'lease' }) === "fullText contains 'lease' and trashed = false", q({ query: 'lease' }));
check("an apostrophe is escaped, not left to break the query",
  q({ query: "Ann's lease" }) === "fullText contains 'Ann\\'s lease' and trashed = false", q({ query: "Ann's lease" }));
check('a raw filter is ANDed and parenthesised',
  q({ query: 'x', filter: "mimeType='application/pdf'" })
    === "fullText contains 'x' and (mimeType='application/pdf') and trashed = false");
check('a filter mentioning trashed suppresses the default exclusion',
  q({ filter: 'trashed = true' }) === '(trashed = true)', q({ filter: 'trashed = true' }));
check('a backslash is escaped too', q({ query: 'a\\b' }).includes("'a\\\\b'"), q({ query: 'a\\b' }));

// ─── Drive: multipart upload framing ────────────────────────────────────────

const body = drive._internal.multipartBody({ name: 'notes.txt' }, 'hello', 'text/plain', 'BOUND');
const raw  = body.toString('utf8');

check('upload body is a Buffer, not a re-encoded string', Buffer.isBuffer(body));
check('metadata part is JSON', raw.includes('Content-Type: application/json') && raw.includes('"name":"notes.txt"'));
check('content part declares its type', raw.includes('Content-Type: text/plain'));
check('parts are separated by the boundary', raw.split('--BOUND').length === 4, String(raw.split('--BOUND').length));
check('body is closed with the terminating boundary', raw.trimEnd().endsWith('--BOUND--'));

const binary = drive._internal.multipartBody({ name: 'x.bin' }, Buffer.from([0xff, 0x00, 0xfe]), 'application/octet-stream', 'B');
check('binary bytes survive the upload framing intact',
  binary.includes(Buffer.from([0xff, 0x00, 0xfe])));

// ─── Tasks: due-date handling ───────────────────────────────────────────────

const due = tasks._internal.dueStamp;
check('a bare date becomes an RFC 3339 stamp', due('2026-09-01') === '2026-09-01T00:00:00.000Z', String(due('2026-09-01')));
check('a full timestamp is left alone', due('2026-09-01T15:00:00Z') === '2026-09-01T15:00:00Z');
check('no due date stays undefined', due(undefined) === undefined);

const shaped = tasks._internal.summarizeTask(
  { id: 't1', title: 'Call roofer', due: '2026-09-01T00:00:00.000Z', status: 'completed', completed: '2026-08-30T12:00:00Z' },
  'list1',
);
check('due comes back as a plain date', shaped.due === '2026-09-01', shaped.due);
check('completed status is surfaced as a boolean', shaped.completed === true);
check('list id is carried on the task', shaped.list_id === 'list1');
check('an untitled task says so', tasks._internal.summarizeTask({ id: 't2' }, 'l').title === '(untitled)');

// ─── Contacts: shaping ──────────────────────────────────────────────────────

const person = people._internal.summarizePerson({
  names: [{ displayName: 'Ann Rowe' }],
  emailAddresses: [{ value: 'ann@x.com' }, { value: 'ann@work.com' }],
  phoneNumbers: [{ value: '+1 604 555 0100' }],
  organizations: [{ name: 'Rowe Roofing', title: 'Owner' }],
});
check('every address is kept, not just the first', person.emails.length === 2, person.emails.join(','));
check('name, company and title are shaped', person.name === 'Ann Rowe' && person.company === 'Rowe Roofing' && person.title === 'Owner');
check('a bare person does not throw', people._internal.summarizePerson({}).name === null);

// ─── Contacts: a refusal is not an empty address book ───────────────────────

(async () => {

  const realFetch = global.fetch;

  global.fetch = async () => ({
    ok: false, status: 403, text: async () => '{"error":{"message":"insufficient scope"}}',
  });
  let refused = '';
  try { await people.searchContacts('tok', { query: 'ann' }); } catch (e) { refused = e.message; }
  global.fetch = realFetch;
  check('both contact sources failing throws rather than returning nobody',
    refused.includes('insufficient scope'), refused);

  // Saved contacts fail, correspondents answer: partial results, flagged.
  global.fetch = async (url) => {
    if (String(url).includes('otherContacts')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        results: [{ person: { names: [{ displayName: 'Ann Rowe' }], emailAddresses: [{ value: 'ann@x.com' }] } }],
      }) };
    }
    return { ok: false, status: 500, text: async () => '{"error":{"message":"backend error"}}' };
  };
  const partial = await people.searchContacts('tok', { query: 'ann' });
  global.fetch = realFetch;
  check('one source failing still returns the other', partial.people.length === 1, String(partial.people.length));
  check('the failed source is reported, not hidden', (partial.partial || []).length === 1, JSON.stringify(partial.partial));
  check('the surviving result is tagged with where it came from',
    partial.people[0].source === 'correspondents', partial.people[0].source);

// ─── Scope gating ───────────────────────────────────────────────────────────

const { _internal: accountsInternal } = require('../src/services/gmail_accounts');
const grantCovers = accountsInternal.grantCovers;
const GMAIL = 'https://www.googleapis.com/auth/gmail.modify';
const CAL   = 'https://www.googleapis.com/auth/calendar';

check('a grant covering the product passes', grantCovers(`${GMAIL} ${CAL}`, 'calendar'));
check('a grant predating the product is caught', grantCovers(GMAIL, 'calendar') === false);
check('a prefix match is not a match', grantCovers('https://www.googleapis.com/auth/calendar.readonly', 'calendar') === false);
check('unrecorded scopes are not treated as proof of absence', grantCovers(null, 'calendar'));
check('no product named means no gate', grantCovers(GMAIL, undefined));

// ─── Reporting what was actually granted ────────────────────────────────────

const G = 'https://www.googleapis.com/auth/';
const productAccess = require('../src/services/gmail_accounts').productAccess;

const gmailOnly = productAccess(`${G}gmail.modify`);
check('a Gmail-only grant reports gmail as granted', gmailOnly.granted.join() === 'gmail');
check('a Gmail-only grant names every product it lacks',
  gmailOnly.missing.join() === 'calendar,drive,contacts,tasks', gmailOnly.missing.join());

const full = productAccess([`${G}gmail.modify`, `${G}calendar`, `${G}drive`, `${G}contacts.readonly`, `${G}tasks`].join(' '));
check('a complete grant has nothing missing', full.missing.length === 0, full.missing.join());
check('a complete grant lists all five', full.granted.length === 5, full.granted.join());

// The case that actually bites: Google drops a scope when its API is switched
// off, so a partial grant must read as partial rather than as success.
const partialGrant = productAccess([`${G}gmail.modify`, `${G}contacts.readonly`, `${G}tasks`].join(' '));
check('a partial grant is reported as partial, not as success',
  partialGrant.missing.join() === 'calendar,drive', partialGrant.missing.join());

const unrecorded = productAccess(null);
check('an unrecorded grant claims nothing either way',
  unrecorded.recorded === false && unrecorded.granted.length === 0 && unrecorded.missing.length === 0);

// ─── The assembled tool surface ─────────────────────────────────────────────

const surface = require('../src/mcp/tools');
const names   = surface._internal.TOOLS.map(t => t.name);

check('every tool name is unique', new Set(names).size === names.length);
check('every tool has a description and a handler',
  surface._internal.TOOLS.every(t => t.description && typeof t.handler === 'function'));
check('every tool declares an object input schema',
  surface._internal.TOOLS.every(t => t.inputSchema && t.inputSchema.type === 'object'));
check('every required property is actually declared',
  surface._internal.TOOLS.every(t =>
    (t.inputSchema.required || []).every(r => Object.keys(t.inputSchema.properties || {}).includes(r))),
  surface._internal.TOOLS.filter(t =>
    (t.inputSchema.required || []).some(r => !Object.keys(t.inputSchema.properties || {}).includes(r)))
    .map(t => t.name).join(','));
check('descriptors expose no handlers',
  surface.descriptors().every(d => d.handler === undefined && d.name && d.inputSchema));

for (const [product, count] of [['calendar', 9], ['drive', 15], ['contacts', 2], ['tasks', 5], ['gmail', 23]]) {
  check(`${product} module has ${count} tools`,
    surface._internal.MODULES[product].length === count,
    String(surface._internal.MODULES[product].length));
}

  let unknown = '';
  try { await surface.callTool('nope', {}, 'owner'); } catch (e) { unknown = e.message; }
  check('an unknown tool name is rejected', unknown.includes('Unknown tool'), unknown);

  console.log(fail ? `\n${fail} FAILED` : '\ncalendar, drive, contacts and tasks shaping correct');
  process.exit(fail ? 1 : 0);
})();
