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

async function createEvent(accessToken, calendarId, {
  title, start, end, timeZone, description, location, attendees, sendUpdates,
}) {
  const body = {
    summary:     title,
    start:       timePair(start, timeZone),
    end:         timePair(end, timeZone),
    ...(description ? { description } : {}),
    ...(location    ? { location }    : {}),
    ...(attendees && attendees.length ? { attendees: attendees.map(email => ({ email })) } : {}),
  };

  const event = await call(accessToken, `/calendars/${encode(calendarId)}/events`, {
    method: 'POST',
    query:  { sendUpdates: sendUpdates || 'none' },
    body,
  });

  return summarizeEvent(event, calendarId);
}

async function updateEvent(accessToken, calendarId, eventId, {
  title, start, end, timeZone, description, location, attendees, sendUpdates,
}) {
  // PATCH, not PUT: a field the caller did not mention must keep its value.
  const body = {
    ...(title       !== undefined ? { summary: title }      : {}),
    ...(description !== undefined ? { description }         : {}),
    ...(location    !== undefined ? { location }            : {}),
    ...(start       !== undefined ? { start: timePair(start, timeZone) } : {}),
    ...(end         !== undefined ? { end:   timePair(end, timeZone) }   : {}),
    ...(attendees   !== undefined ? { attendees: attendees.map(email => ({ email })) } : {}),
  };

  if (!Object.keys(body).length) throw new Error('Nothing to update — pass at least one field to change.');

  const event = await call(accessToken, `/calendars/${encode(calendarId)}/events/${encode(eventId)}`, {
    method: 'PATCH',
    query:  { sendUpdates: sendUpdates || 'none' },
    body,
  });

  return summarizeEvent(event, calendarId);
}

async function deleteEvent(accessToken, calendarId, eventId, { sendUpdates } = {}) {
  await call(accessToken, `/calendars/${encode(calendarId)}/events/${encode(eventId)}`, {
    method: 'DELETE',
    query:  { sendUpdates: sendUpdates || 'none' },
  });
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
  respondToEvent, freeBusy, freeSlots,
  MAX_DESCRIPTION_CHARS,
  _internal: { summarizeEvent, timePair, edge, truncate },
};
