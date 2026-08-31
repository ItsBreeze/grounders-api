/**
 * Thin Google Calendar v3 client.
 *
 * Events come back shaped rather than raw: Google's start/end are either a
 * dateTime or a bare date depending on whether the event is all-day, and the
 * caller should not have to branch on that every time.
 */

const http = require('./google_http');

const BASE = 'https://www.googleapis.com/calendar/v3';
const call = http.clientFor('Calendar API', BASE);

// Event descriptions can hold an entire meeting agenda; cap them like mail bodies.
const MAX_DESCRIPTION_CHARS = 4000;

const encode = (id) => encodeURIComponent(String(id));

/** "2026-09-01T10:00:00-06:00" from a timed event, "2026-09-01" from an all-day one. */
const edge = (point) => (point || {}).dateTime || (point || {}).date || null;

function truncate(value) {
  const text = String(value || '');
  return text.length <= MAX_DESCRIPTION_CHARS
    ? text
    : `${text.slice(0, MAX_DESCRIPTION_CHARS)}\n\n[truncated — ${text.length} characters total]`;
}

/**
 * One event, flattened.
 *
 * `my_response` is the bit a scheduling question actually turns on — whether
 * *this* account has accepted — and it is buried in the attendee list under a
 * `self` flag, so it is lifted out here.
 */
function summarizeEvent(event, calendarId) {
  const attendees = event.attendees || [];
  const self      = attendees.find(a => a.self);

  return {
    id:          event.id,
    calendar_id: calendarId,
    title:       event.summary || '(no title)',
    start:       edge(event.start),
    end:         edge(event.end),
    all_day:     Boolean((event.start || {}).date),
    time_zone:   (event.start || {}).timeZone || null,
    location:    event.location || null,
    status:      event.status || null,
    organizer:   (event.organizer || {}).email || null,
    attendees:   attendees.map(a => ({
      email:    a.email,
      name:     a.displayName || null,
      response: a.responseStatus || 'needsAction',
      optional: Boolean(a.optional),
      self:     Boolean(a.self),
    })),
    my_response:  self ? self.responseStatus : null,
    recurring:    Boolean(event.recurringEventId || event.recurrence),
    // The series this occurrence belongs to. list_events expands a series into
    // its occurrences, so without this id there is no way back from "Tuesday's
    // standup" to the rule that generates every standup.
    recurring_event_id: event.recurringEventId || null,
    recurrence:         event.recurrence || null,
    conference:   event.hangoutLink || null,
    link:         event.htmlLink || null,
    description:  event.description ? truncate(event.description) : null,
    updated:      event.updated || null,
  };
}

async function listCalendars(accessToken) {
  const res = await call(accessToken, '/users/me/calendarList', {
    query: { maxResults: 250, minAccessRole: 'reader' },
  });

  return (res.items || []).map(c => ({
    id:          c.id,
    name:        c.summaryOverride || c.summary,
    description: c.description || null,
    primary:     Boolean(c.primary),
    access_role: c.accessRole,
    time_zone:   c.timeZone || null,
    selected:    Boolean(c.selected),
  }));
}

/**
 * Events in a window, optionally matching a text query.
 *
 * singleEvents expands a recurring series into its occurrences, which is what
 * "what's on Tuesday" means — without it a weekly standup comes back once, as
 * the rule that generates it.
 */
async function listEvents(accessToken, {
  calendarId = 'primary', timeMin, timeMax, query, maxResults = 10, pageToken,
} = {}) {
  const res = await call(accessToken, `/calendars/${encode(calendarId)}/events`, {
    query: {
      timeMin, timeMax, q: query, pageToken,
      maxResults:   Math.min(Math.max(maxResults, 1), 50),
      singleEvents: 'true',
      orderBy:      'startTime',
    },
  });

  return {
    events: (res.items || []).map(e => summarizeEvent(e, calendarId)),
    nextPageToken: res.nextPageToken || null,
    time_zone: res.timeZone || null,
  };
}

async function getEvent(accessToken, calendarId, eventId) {
  const event = await call(accessToken, `/calendars/${encode(calendarId)}/events/${encode(eventId)}`);
  return summarizeEvent(event, calendarId);
}

/**
 * Build Google's start/end pair from what a caller naturally passes.
 * A date with no time means all-day; anything else is a timed event.
 */
function timePair(value, timeZone) {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? { date: value }
    : { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

/** The RFC 5545 properties Google accepts in `recurrence`. */
const RECURRENCE_PROPERTIES = ['RRULE', 'RDATE', 'EXDATE', 'EXRULE'];

const FREQUENCIES = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

/** What `repeat` means, for the ordinary cases that should not need RFC 5545. */
const REPEATS = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };

/**
 * Check and tidy raw recurrence lines.
 *
 * Property names are case-insensitive in RFC 5545 but Google is stricter, so
 * they are upper-cased here; parameter values are left exactly as given, since
 * a TZID like `America/Vancouver` is case-sensitive and upper-casing the line
 * would break it.
 *
 * A rule with no FREQ is the failure worth catching early: Google rejects it
 * with a generic 400, which says nothing about which line was wrong.
 */
function normalizeRecurrence(lines) {
  return lines.map((line, i) => {
    if (typeof line !== 'string' || !line.trim()) {
      throw new Error(`recurrence[${i}] is empty — each entry is one line, e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO".`);
    }

    const raw   = line.trim();
    const colon = raw.indexOf(':');
    if (colon < 1) throw new Error(`recurrence[${i}] "${raw}" has no ":" — expected e.g. "RRULE:FREQ=WEEKLY".`);

    const head   = raw.slice(0, colon);
    const semi   = head.indexOf(';');
    const name   = (semi >= 0 ? head.slice(0, semi) : head).toUpperCase();
    const params = semi >= 0 ? head.slice(semi) : '';
    const value  = raw.slice(colon + 1);

    if (name === 'DTSTART' || name === 'DTEND') {
      throw new Error(`${name} does not belong in recurrence — the event's own start and end fields carry it.`);
    }
    if (!RECURRENCE_PROPERTIES.includes(name)) {
      throw new Error(`recurrence[${i}] starts with "${name}" — expected one of ${RECURRENCE_PROPERTIES.join(', ')}.`);
    }
    if ((name === 'RRULE' || name === 'EXRULE')) {
      const freq = /(?:^|;)FREQ=([A-Za-z]+)(?:;|$)/.exec(value);
      if (!freq) throw new Error(`recurrence[${i}] is a ${name} with no FREQ= part, e.g. "FREQ=WEEKLY".`);
      if (!FREQUENCIES.includes(freq[1].toUpperCase())) {
        throw new Error(`recurrence[${i}] has FREQ=${freq[1]} — expected one of ${FREQUENCIES.join(', ')}.`);
      }
    }

    return `${name}${params}:${value}`;
  });
}

/**
 * RFC 5545 wants UNTIL as a UTC stamp for a timed event and a bare date for an
 * all-day one; mixing the two is rejected.
 */
function untilStamp(value, allDay) {
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`repeat_until "${value}" should be a plain YYYY-MM-DD date on an all-day event.`);
    }
    return value.replace(/-/g, '');
  }

  const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59Z` : value);
  if (Number.isNaN(at.getTime())) throw new Error(`repeat_until "${value}" is not a date I can read — use ISO 8601.`);
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Turn what a caller passes into Google's `recurrence` array.
 *
 * `repeat` covers the cases anyone actually asks for out loud — every day, every
 * week — without making the caller compose RFC 5545 correctly; `recurrence`
 * stays available for everything else (every second Tuesday, weekdays only).
 */
function buildRecurrence({ recurrence, repeat, repeatCount, repeatUntil }, { allDay } = {}) {
  if (recurrence !== undefined && repeat !== undefined) {
    throw new Error('Pass `recurrence` or `repeat`, not both — `repeat` is the shorthand for a simple rule.');
  }
  if (repeat === undefined && (repeatCount !== undefined || repeatUntil !== undefined)) {
    throw new Error('repeat_count and repeat_until describe a `repeat` — pass one, or put COUNT/UNTIL in a `recurrence` rule.');
  }

  if (recurrence !== undefined) {
    const lines = Array.isArray(recurrence) ? recurrence : [recurrence];
    if (!lines.length) return [];
    return normalizeRecurrence(lines);
  }

  if (repeat === undefined) return undefined;

  const freq = REPEATS[String(repeat).toLowerCase()];
  if (!freq) {
    throw new Error(`Unknown repeat "${repeat}". Available: ${Object.keys(REPEATS).join(', ')} — or pass \`recurrence\` for anything else.`);
  }
  if (repeatCount !== undefined && repeatUntil !== undefined) {
    throw new Error('Pass repeat_count or repeat_until, not both — a rule ends one way or the other.');
  }

  let rule = `RRULE:FREQ=${freq}`;
  if (repeatCount !== undefined) {
    if (!Number.isInteger(repeatCount) || repeatCount < 1) {
      throw new Error('repeat_count is a whole number of occurrences, 1 or more.');
    }
    rule += `;COUNT=${repeatCount}`;
  }
  if (repeatUntil !== undefined) rule += `;UNTIL=${untilStamp(repeatUntil, allDay)}`;

  return [rule];
}

async function createEvent(accessToken, calendarId, {
  title, start, end, timeZone, description, location, attendees, sendUpdates,
  recurrence, repeat, repeatCount, repeatUntil,
}) {
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(String(start || ''));
  const rules  = buildRecurrence({ recurrence, repeat, repeatCount, repeatUntil }, { allDay });

  const body = {
    summary:     title,
    start:       timePair(start, timeZone),
    end:         timePair(end, timeZone),
    ...(description ? { description } : {}),
    ...(location    ? { location }    : {}),
    ...(attendees && attendees.length ? { attendees: attendees.map(email => ({ email })) } : {}),
    ...(rules ? { recurrence: rules } : {}),
  };

  const event = await call(accessToken, `/calendars/${encode(calendarId)}/events`, {
    method: 'POST',
    query:  { sendUpdates: sendUpdates || 'none' },
    body,
  });

  return summarizeEvent(event, calendarId);
}

const SCOPES = ['this_event', 'series'];

/**
 * Decide which event a write actually lands on.
 *
 * `list_events` expands a series into occurrences, so the id in hand is almost
 * always one Tuesday rather than the standup itself. Editing that id changes
 * that Tuesday — right for "move tomorrow's standup", wrong for "make it 10am
 * from now on", and Google offers no flag to say which was meant.
 *
 * The event is read first so the answer can be reported rather than assumed:
 * an id naming a series master changes every occurrence even under
 * `this_event`, because that is what patching a master does, and a result that
 * did not say so would be the quiet kind of surprise.
 */
async function resolveTarget(accessToken, calendarId, eventId, scope = 'this_event') {
  if (!SCOPES.includes(scope)) {
    throw new Error(`Unknown scope "${scope}" — use "this_event" for one occurrence or "series" for the whole repeating event.`);
  }

  const event      = await call(accessToken, `/calendars/${encode(calendarId)}/events/${encode(eventId)}`);
  const isInstance = Boolean(event.recurringEventId);
  const isSeries   = Boolean(event.recurrence);

  if (scope === 'series') {
    if (isInstance) return { id: event.recurringEventId, appliesTo: 'series', event };
    if (isSeries)   return { id: event.id, appliesTo: 'series', event };
    throw new Error(`"${event.summary || '(no title)'}" is a one-off event, not part of a repeating series — repeat the call without scope: "series".`);
  }

  return {
    id: event.id,
    appliesTo: isSeries ? 'series' : isInstance ? 'this_occurrence' : 'event',
    event,
  };
}

async function updateEvent(accessToken, calendarId, eventId, {
  title, start, end, timeZone, description, location, attendees, sendUpdates,
  recurrence, repeat, repeatCount, repeatUntil, scope,
}) {
  const target = await resolveTarget(accessToken, calendarId, eventId, scope);
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(String(start !== undefined ? start : (target.event.start || {}).date || ''));
  const rules  = buildRecurrence({ recurrence, repeat, repeatCount, repeatUntil }, { allDay });

  // Recurrence rules live on the series, never on one occurrence. Writing them
  // to an instance is silently dropped by Google, so refuse instead.
  if (rules !== undefined && target.appliesTo === 'this_occurrence') {
    throw new Error('A repeat rule belongs to the series, not to one occurrence — repeat the call with scope: "series".');
  }

  // PATCH, not PUT: a field the caller did not mention must keep its value.
  const body = {
    ...(title       !== undefined ? { summary: title }      : {}),
    ...(description !== undefined ? { description }         : {}),
    ...(location    !== undefined ? { location }            : {}),
    ...(start       !== undefined ? { start: timePair(start, timeZone) } : {}),
    ...(end         !== undefined ? { end:   timePair(end, timeZone) }   : {}),
    ...(attendees   !== undefined ? { attendees: attendees.map(email => ({ email })) } : {}),
    ...(rules       !== undefined ? { recurrence: rules }   : {}),
  };

  if (!Object.keys(body).length) throw new Error('Nothing to update — pass at least one field to change.');

  const event = await call(accessToken, `/calendars/${encode(calendarId)}/events/${encode(target.id)}`, {
    method: 'PATCH',
    query:  { sendUpdates: sendUpdates || 'none' },
    body,
  });

  return { ...summarizeEvent(event, calendarId), applies_to: target.appliesTo };
}

async function deleteEvent(accessToken, calendarId, eventId, { sendUpdates, scope } = {}) {
  const target = await resolveTarget(accessToken, calendarId, eventId, scope);

  await call(accessToken, `/calendars/${encode(calendarId)}/events/${encode(target.id)}`, {
    method: 'DELETE',
    query:  { sendUpdates: sendUpdates || 'none' },
  });

  return { id: target.id, applies_to: target.appliesTo, title: target.event.summary || '(no title)' };
}

/**
 * RSVP as this account.
 *
 * Google has no "respond" endpoint: you patch the attendee list, and only the
 * entry flagged `self` is yours to change. Sending the whole list back with one
 * status altered is the documented way, so the event is read first.
 */
async function respondToEvent(accessToken, calendarId, eventId, response, { sendUpdates } = {}) {
  const event     = await call(accessToken, `/calendars/${encode(calendarId)}/events/${encode(eventId)}`);
  const attendees = event.attendees || [];
  const self      = attendees.find(a => a.self);

  if (!self) {
    throw new Error('This account is not an attendee on that event, so there is nothing to respond to.');
  }

  const updated = await call(accessToken, `/calendars/${encode(calendarId)}/events/${encode(eventId)}`, {
    method: 'PATCH',
    query:  { sendUpdates: sendUpdates || 'all' },
    body:   { attendees: attendees.map(a => (a.self ? { ...a, responseStatus: response } : a)) },
  });

  return summarizeEvent(updated, calendarId);
}

/** Busy intervals for one or more calendars, as [{start, end}]. */
async function freeBusy(accessToken, { timeMin, timeMax, calendarIds = ['primary'] }) {
  const res = await call(accessToken, '/freeBusy', {
    method: 'POST',
    body:   { timeMin, timeMax, items: calendarIds.map(id => ({ id })) },
  });

  const busy   = [];
  const errors = [];

  for (const [id, entry] of Object.entries(res.calendars || {})) {
    for (const e of entry.errors || []) errors.push(`${id}: ${e.reason}`);
    for (const b of entry.busy   || []) busy.push({ start: b.start, end: b.end });
  }

  return { busy, errors };
}

/**
 * Gaps of at least `durationMs` left over once every busy interval is removed
 * from [from, to].
 *
 * Pure, and separated from the API call on purpose: overlapping and
 * out-of-order busy blocks from several calendars are exactly where slot
 * arithmetic goes wrong, and that deserves a test rather than a live calendar.
 */
function freeSlots(busy, { from, to, durationMs, limit = 10 }) {
  const windowStart = new Date(from).getTime();
  const windowEnd   = new Date(to).getTime();
  if (!(windowEnd > windowStart)) throw new Error('The search window ends before it starts.');

  // Clip to the window, drop anything outside it, then merge overlaps.
  const blocks = busy
    .map(b => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
    .filter(b => b.end > windowStart && b.start < windowEnd)
    .map(b => ({ start: Math.max(b.start, windowStart), end: Math.min(b.end, windowEnd) }))
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    if (last && block.start <= last.end) last.end = Math.max(last.end, block.end);
    else merged.push({ ...block });
  }

  const slots = [];
  let cursor  = windowStart;
  for (const block of [...merged, { start: windowEnd, end: windowEnd }]) {
    if (block.start - cursor >= durationMs) {
      slots.push({ start: new Date(cursor).toISOString(), end: new Date(block.start).toISOString() });
      if (slots.length >= limit) return slots;
    }
    cursor = Math.max(cursor, block.end);
  }

  return slots;
}

module.exports = {
  listCalendars, listEvents, getEvent, createEvent, updateEvent, deleteEvent,
  respondToEvent, freeBusy, freeSlots, resolveTarget,
  MAX_DESCRIPTION_CHARS, SCOPES,
  _internal: { summarizeEvent, timePair, edge, truncate, buildRecurrence, normalizeRecurrence, untilStamp },
};
