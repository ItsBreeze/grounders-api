/**
 * Google Calendar tools.
 *
 * The reading tools fan out: "what does my week look like" spans every linked
 * account at once, which is the question a single-account connector cannot
 * answer. The writing tools always act on exactly one named account, because
 * "create this event" must never be ambiguous about whose calendar it lands in.
 */

const calendar = require('../../services/calendar_api');
const {
  text, tokenFor, fanOut, mergeSearch, ACCOUNT_PROP, SEARCH_PROPS, checkPageToken,
} = require('../shared');

const CALENDAR_PROP = {
  calendar_id: {
    type: 'string',
    description: 'Calendar to act on. Defaults to the account\'s primary calendar; list_calendars shows the rest.',
  },
};

const SEND_UPDATES_PROP = {
  send_updates: {
    type: 'string',
    enum: ['all', 'externalOnly', 'none'],
    description: 'Who gets an email about this change. Defaults to "none" — pass "all" to actually notify attendees.',
  },
};

const RESPONSES = ['accepted', 'declined', 'tentative'];

/** Default window for "what's coming up": now through a week out. */
function defaultWindow(args) {
  const from = args.time_min || new Date().toISOString();
  const to   = args.time_max || new Date(new Date(from).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

const TOOLS = [
  {
    name: 'list_calendars',
    description:
      'List the calendars on one account, or on every linked account when `account` is omitted — ' +
      'primary, shared, and subscribed, with the access level held on each.',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string', description: 'Account to list. Omit for all linked accounts.' } },
    },
    handler: async ({ ownerKey, args }) => {
      const { targets, ok, failed } = await fanOut(ownerKey, args.account, 'calendar', token =>
        calendar.listCalendars(token));

      const calendars = ok.flatMap(({ email, value }) => value.map(c => ({ account: email, ...c })));

      if (!calendars.length && failed.length) throw new Error(`All accounts failed — ${failed.join('; ')}`);

      return text({
        searched: targets,
        ...(failed.length ? { errors: failed } : {}),
        count: calendars.length,
        calendars,
      });
    },
  },

  {
    name: 'list_events',
    description:
      'Events in a time window, sorted by start. Omit `account` to merge EVERY linked calendar into one ' +
      'timeline — the cross-account view of a day or week that a single-account connector cannot produce. ' +
      'Defaults to the next 7 days. Recurring series are expanded into their actual occurrences.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SEARCH_PROPS,
        ...CALENDAR_PROP,
        time_min: { type: 'string', description: 'ISO 8601 start of the window. Defaults to now.' },
        time_max: { type: 'string', description: 'ISO 8601 end of the window. Defaults to 7 days after time_min.' },
      },
    },
    handler: async ({ ownerKey, args }) => {
      checkPageToken(args);
      const { from, to } = defaultWindow(args);

      const fanned = await fanOut(ownerKey, args.account, 'calendar', token =>
        calendar.listEvents(token, {
          calendarId: args.calendar_id,
          timeMin:    from,
          timeMax:    to,
          maxResults: args.max_results || 10,
          pageToken:  args.page_token,
        }));

      const merged = mergeSearch(fanned, { key: 'events' });
      // Chronological, not newest-first: a schedule reads forwards.
      merged.events.sort((a, b) => new Date(a.start || 0) - new Date(b.start || 0));

      return text({ window: { from, to }, ...merged });
    },
  },

  {
    name: 'search_events',
    description:
      'Find events by free text — title, description, location or attendee. Omit `account` to search every ' +
      'linked calendar at once. Searches the next year by default; pass time_min/time_max to look further back.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to match.' },
        ...SEARCH_PROPS,
        ...CALENDAR_PROP,
        time_min: { type: 'string', description: 'ISO 8601 earliest start. Defaults to now.' },
        time_max: { type: 'string', description: 'ISO 8601 latest start. Defaults to a year out.' },
      },
      required: ['query'],
    },
    handler: async ({ ownerKey, args }) => {
      checkPageToken(args);
      const from = args.time_min || new Date().toISOString();
      const to   = args.time_max || new Date(new Date(from).getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();

      const fanned = await fanOut(ownerKey, args.account, 'calendar', token =>
        calendar.listEvents(token, {
          calendarId: args.calendar_id,
          query:      args.query,
          timeMin:    from,
          timeMax:    to,
          maxResults: args.max_results || 10,
          pageToken:  args.page_token,
        }));

      const merged = mergeSearch(fanned, { key: 'events' });
      merged.events.sort((a, b) => new Date(a.start || 0) - new Date(b.start || 0));

      return text({ window: { from, to }, ...merged });
    },
  },

  {
    name: 'get_event',
    description: 'One event in full: attendees with their RSVPs, conference link, description, and this account\'s own response.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, ...CALENDAR_PROP, event_id: { type: 'string' } },
      required: ['event_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'calendar');
      return text({
        account: email,
        ...(await calendar.getEvent(token, args.calendar_id || 'primary', args.event_id)),
      });
    },
  },

  {
    name: 'create_event',
    description:
      'Create an event on one account\'s calendar. Times are ISO 8601 ("2026-09-01T14:00:00-06:00"); ' +
      'a bare date ("2026-09-01") makes it all-day. Attendees are NOT emailed unless send_updates says so.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...CALENDAR_PROP,
        ...SEND_UPDATES_PROP,
        title:       { type: 'string' },
        start:       { type: 'string', description: 'ISO 8601 datetime, or YYYY-MM-DD for all-day.' },
        end:         { type: 'string', description: 'ISO 8601 datetime, or YYYY-MM-DD for all-day (exclusive).' },
        time_zone:   { type: 'string', description: 'IANA zone, e.g. "America/Denver". Only needed when start/end carry no offset.' },
        description: { type: 'string' },
        location:    { type: 'string' },
        attendees:   { type: 'array', items: { type: 'string' }, description: 'Email addresses to invite.' },
      },
      required: ['title', 'start', 'end'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'calendar');
      const event = await calendar.createEvent(token, args.calendar_id || 'primary', {
        title:       args.title,
        start:       args.start,
        end:         args.end,
        timeZone:    args.time_zone,
        description: args.description,
        location:    args.location,
        attendees:   args.attendees,
        sendUpdates: args.send_updates,
      });
      return text({ account: email, created: true, ...event });
    },
  },

  {
    name: 'update_event',
    description:
      'Change an existing event. Only the fields you pass are touched — everything else keeps its value. ' +
      'Passing `attendees` REPLACES the guest list rather than adding to it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...CALENDAR_PROP,
        ...SEND_UPDATES_PROP,
        event_id:    { type: 'string' },
        title:       { type: 'string' },
        start:       { type: 'string' },
        end:         { type: 'string' },
        time_zone:   { type: 'string' },
        description: { type: 'string' },
        location:    { type: 'string' },
        attendees:   { type: 'array', items: { type: 'string' }, description: 'Replaces the whole guest list.' },
      },
      required: ['event_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'calendar');
      const event = await calendar.updateEvent(token, args.calendar_id || 'primary', args.event_id, {
        title:       args.title,
        start:       args.start,
        end:         args.end,
        timeZone:    args.time_zone,
        description: args.description,
        location:    args.location,
        attendees:   args.attendees,
        sendUpdates: args.send_updates,
      });
      return text({ account: email, updated: true, ...event });
    },
  },

  {
    name: 'delete_event',
    description:
      'Delete an event. It goes to the calendar\'s trash and is restorable for 30 days. ' +
      'If it has guests, deleting cancels the meeting for them — pass send_updates: "all" to tell them.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, ...CALENDAR_PROP, ...SEND_UPDATES_PROP, event_id: { type: 'string' } },
      required: ['event_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'calendar');
      const calendarId = args.calendar_id || 'primary';

      // Read it first so the result can say what was deleted, not just "ok".
      const event = await calendar.getEvent(token, calendarId, args.event_id).catch(() => null);
      await calendar.deleteEvent(token, calendarId, args.event_id, { sendUpdates: args.send_updates });

      return text({
        account: email,
        event_id: args.event_id,
        deleted: event ? event.title : true,
        status: 'moved to the calendar trash — restorable for 30 days',
      });
    },
  },

  {
    name: 'respond_to_event',
    description:
      'RSVP to an invitation as the account that received it: accepted, declined or tentative. ' +
      'The organiser is notified by default, since an RSVP nobody sees is not an RSVP.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...CALENDAR_PROP,
        ...SEND_UPDATES_PROP,
        event_id: { type: 'string' },
        response: { type: 'string', enum: RESPONSES },
      },
      required: ['event_id', 'response'],
    },
    handler: async ({ ownerKey, args }) => {
      if (!RESPONSES.includes(args.response)) {
        throw new Error(`response must be one of ${RESPONSES.join(', ')}.`);
      }
      const { email, token } = await tokenFor(ownerKey, args.account, 'calendar');
      const event = await calendar.respondToEvent(
        token, args.calendar_id || 'primary', args.event_id, args.response,
        { sendUpdates: args.send_updates },
      );
      return text({ account: email, responded: args.response, ...event });
    },
  },

  {
    name: 'suggest_time',
    description:
      'Find open slots of a given length. Omit `account` to require the slot be free on EVERY linked ' +
      'calendar at once — the cross-account availability question, answered in one call. ' +
      'Returns the free gaps themselves, so a 3-hour gap comes back once rather than as six half-hour slots.',
    inputSchema: {
      type: 'object',
      properties: {
        account:          { type: 'string', description: 'Account to check. Omit to require free on all linked accounts.' },
        duration_minutes: { type: 'number', description: 'How long the slot needs to be. Default 30.' },
        time_min:         { type: 'string', description: 'ISO 8601 start of the search window. Defaults to now.' },
        time_max:         { type: 'string', description: 'ISO 8601 end of the window. Defaults to 7 days out.' },
        calendar_ids:     { type: 'array', items: { type: 'string' }, description: 'Calendars to treat as busy. Defaults to each account\'s primary.' },
        limit:            { type: 'number', description: 'Max slots to return. Default 10.' },
      },
    },
    handler: async ({ ownerKey, args }) => {
      const { from, to }   = defaultWindow(args);
      const durationMs     = (args.duration_minutes || 30) * 60 * 1000;

      if (new Date(to).getTime() - new Date(from).getTime() < durationMs) {
        throw new Error('The search window is shorter than the requested duration.');
      }

      const { targets, ok, failed } = await fanOut(ownerKey, args.account, 'calendar', token =>
        calendar.freeBusy(token, {
          timeMin: from,
          timeMax: to,
          calendarIds: args.calendar_ids && args.calendar_ids.length ? args.calendar_ids : ['primary'],
        }));

      if (!ok.length) throw new Error(`All accounts failed — ${failed.join('; ')}`);

      // Busy anywhere means busy: pooling the intervals is what makes a slot
      // safe to offer across several accounts.
      const busy         = ok.flatMap(({ value }) => value.busy);
      const lookupErrors = ok.flatMap(({ email, value }) => value.errors.map(e => `${email}: ${e}`));

      const slots = calendar.freeSlots(busy, { from, to, durationMs, limit: args.limit || 10 });

      return text({
        checked: targets,
        ...(failed.length       ? { errors: failed }              : {}),
        ...(lookupErrors.length ? { calendar_errors: lookupErrors } : {}),
        window: { from, to },
        duration_minutes: args.duration_minutes || 30,
        busy_blocks: busy.length,
        count: slots.length,
        free_slots: slots,
        note: 'Slots are the whole free gap; any sub-range of one that fits the duration works.',
      });
    },
  },
];

module.exports = TOOLS;
