/**
 * Radio's events reach Edict as data-only pushes, and nothing the Grounders
 * and ItsRadio apps receive changes.
 *
 * The checks worth never deleting:
 *
 *   1. An Edict token never gets a `notification` block (Android would draw
 *      a second, generic notification beside Edict's own), and never an event
 *      outside the list: a Grounders post or a reaction is not Edict's.
 *
 *   2. With an Edict token registered, the messages to every other token are
 *      what they were without it.
 *
 *   3. What Edict is sent never says "Radio" or "ItsRadio" in its words:
 *      Edict shows these under its own name.
 *
 * Firebase is stubbed at firebase-admin; what is asserted is the message that
 * was about to go to FCM.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'harness-secret-not-for-production';
process.env.FIREBASE_PROJECT_ID = 'stub';
process.env.FIREBASE_CLIENT_EMAIL = 'stub@example.invalid';
process.env.FIREBASE_PRIVATE_KEY = 'stub';

const admin = require('firebase-admin');
let sent = [];
Object.defineProperty(admin, 'initializeApp', { value: () => ({}), configurable: true });
Object.defineProperty(admin, 'credential', { value: { cert: () => ({}) }, configurable: true });
Object.defineProperty(admin, 'messaging', {
  configurable: true,
  value: () => ({
    sendEachForMulticast: async (m) => {
      sent.push(m);
      return { successCount: m.tokens.length, failureCount: 0, responses: m.tokens.map(() => ({ success: true })) };
    },
  }),
});

const { boot, check, run } = require('./harness');
// The harness blanks the Firebase variables so no suite can reach FCM; this
// one has replaced FCM itself, so it puts the stubs' back before the service
// reads them. app.js has already loaded it uninitialised: load it afresh.
process.env.FIREBASE_PROJECT_ID = 'stub';
process.env.FIREBASE_CLIENT_EMAIL = 'stub@example.invalid';
process.env.FIREBASE_PRIVATE_KEY = 'stub';
delete require.cache[require.resolve('../src/services/notifications')];
const notifications = require('../src/services/notifications');
const jwt = require('jsonwebtoken');

const ME = '11111111-1111-4111-8111-111111111111';
const TOKENS = [
  { token: 'grounders-android', platform: 'android', app: 'grounders' },
  { token: 'radio-android', platform: 'android', app: 'radio' },
  { token: 'radio-ios', platform: 'ios', app: 'radio' },
  { token: 'edict-android', platform: 'android', app: 'edict' },
];

run('edict_push', async () => {
  const h = await boot();
  check('the stubbed Firebase is in use', notifications.isReady());

  let withEdict = true;
  let lookup = null;
  h.setQueryHandler((text, params) => {
    if (/FROM device_tokens/.test(text) && /^\s*SELECT/.test(text)) {
      lookup = { text, params };
      // What the WHERE clause would let through, done here by hand.
      const app = params[1];
      return {
        rows: TOKENS.filter((t) => withEdict || t.app !== 'edict')
          .filter((t) => app === null || t.app === app || (t.app === 'edict' && app === 'radio')),
      };
    }
    return { rows: [], rowCount: 0 };
  });

  const push = async (payload, edict = true) => {
    withEdict = edict;
    sent = [];
    await notifications.sendToUsers([ME], payload);
    return sent;
  };
  const toEdict = (msgs) => msgs.filter((m) => m.tokens.includes('edict-android'));
  const others = (msgs) => msgs
    .map((m) => ({ ...m, tokens: m.tokens.filter((t) => t !== 'edict-android') }))
    .filter((m) => m.tokens.length);

  const EVENTS = {
    radio_text: { title: 'Sam (workspace)', body: 'On my way', app: 'radio',
      data: { type: 'radio_text', workspace_id: 'w1', file_id: 'f1', from_user_id: 'u2', sender_name: 'Sam', is_group: false } },
    radio_voice_memo: { title: 'Sam sent a voice memo', body: 'In workspace', app: 'radio',
      data: { type: 'radio_voice_memo', workspace_id: 'w1', file_id: 'f2', from_user_id: 'u2', sender_name: 'Sam' } },
    radio_file: { title: 'Sam shared a file', body: 'plan.pdf • workspace', app: 'radio',
      data: { type: 'radio_file', workspace_id: 'w1', file_id: 'f3', from_user_id: 'u2', sender_name: 'Sam' } },
    radio_call_ring: { title: 'Sam is calling', body: 'Tap to answer', app: 'radio',
      data: { type: 'radio_call_ring', call_id: 'c1', workspace_id: 'w1', from_user_id: 'u2', sender_name: 'Sam' } },
    friend_request: { title: 'New friend request', body: 'Sam wants to be friends', app: null,
      data: { type: 'friend_request', request_id: 'r1', from_user_id: 'u2' } },
  };

  for (const [type, payload] of Object.entries(EVENTS)) {
    const msgs = await push(payload);
    const mine = toEdict(msgs);
    check(`${type}: Edict gets one message`, mine.length === 1, mine.length);
    const m = mine[0] || { data: {} };
    check(`${type}: data-only, high priority`, !m.notification && !m.apns && m.android?.priority === 'high' && !m.android?.notification, m);
    check(`${type}: the type and the words ride in data`, m.data.type === type && m.data.title === payload.title && m.data.body === payload.body, m.data);
    check(`${type}: every value is a string`, Object.values(m.data).every((v) => typeof v === 'string'), m.data);
    check(`${type}: its words never say Radio`, !/radio/i.test(`${m.data.title} ${m.data.body}`), m.data);
    const before = await push(payload, false);
    check(`${type}: the other apps get what they got without Edict`, JSON.stringify(others(msgs)) === JSON.stringify(before), others(msgs));
  }

  check('a message id comes with a message', toEdict(await push(EVENTS.radio_text))[0].data.file_id === 'f1');
  check('a call id comes with a call', toEdict(await push(EVENTS.radio_call_ring))[0].data.call_id === 'c1');
  check('a request id comes with a friend request', toEdict(await push(EVENTS.friend_request))[0].data.request_id === 'r1');

  // Not Edict's: other Radio events, and everything of the Grounders app.
  for (const payload of [
    { title: 'Added to Family', body: 'Sam added you to a Radio workspace', app: 'radio', data: { type: 'radio_workspace_added', workspace_id: 'w1' } },
    { title: 'Sam is keeping this call', body: 'From the start.', app: 'radio', data: { type: 'radio_call_keep', call_id: 'c1' } },
    { title: 'Friend request accepted', body: 'You and Sam are now friends', app: null, data: { type: 'friend_accepted', user_id: 'u2' } },
    { title: 'New post', body: 'Sam just shared a photo', data: { type: 'new_post', post_id: 'p1' } },
    { title: 'New reaction', body: 'Sam reacted to your post', data: { type: 'reaction', post_id: 'p1' } },
  ]) {
    const msgs = await push(payload);
    check(`${payload.data.type}: nothing to Edict`, toEdict(msgs).length === 0, msgs);
    const before = await push(payload, false);
    check(`${payload.data.type}: the other apps unchanged`, JSON.stringify(msgs) === JSON.stringify(before), msgs);
  }

  await push({ title: 'New post', body: 'x', data: { type: 'new_post' } });
  check('a Grounders send asks for grounders tokens only', lookup.params[1] === 'grounders' && /app = 'edict' AND \$2 = 'radio'/.test(lookup.text), lookup);
  check('PushKit tokens stay out of every FCM send', /platform <> 'ios_voip'/.test(lookup.text));

  // ── Registering ────────────────────────────────────────────────────────
  // The token the Edict link hands out (routes/edict_link.js).
  const bearer = { Authorization: `Bearer ${jwt.sign({ sub: ME, client: 'edict' }, process.env.JWT_SECRET, { expiresIn: '30d' })}` };
  const fcm = 'fcm-token-with:a-colon-0123456789';
  let res = await h.request('POST', '/devices', { headers: bearer, body: { token: fcm, platform: 'android', app: 'edict' } });
  let q = h.queries.filter((x) => /INSERT INTO device_tokens/.test(x.text)).pop();
  check('Edict registers with the linked token', res.status === 201 && res.json.registered === true, res.text);
  check('the row is app edict, for the linked account', q && q.params[0] === fcm && q.params[1] === ME && q.params[2] === 'android' && q.params[3] === 'edict', q && q.params);

  res = await h.request('POST', '/devices', { headers: bearer, body: { token: fcm, platform: 'android', app: 'radio' } });
  q = h.queries.filter((x) => /INSERT INTO device_tokens/.test(x.text)).pop();
  check('ItsRadio still registers as radio', res.status === 201 && q.params[3] === 'radio', q.params);
  res = await h.request('POST', '/devices', { headers: bearer, body: { token: fcm, platform: 'android' } });
  q = h.queries.filter((x) => /INSERT INTO device_tokens/.test(x.text)).pop();
  check('an older build with no app is still grounders', res.status === 201 && q.params[3] === 'grounders', q.params);

  res = await h.request('DELETE', `/devices/${encodeURIComponent(fcm)}`, { headers: bearer });
  q = h.queries.filter((x) => /DELETE FROM device_tokens WHERE token = \$1 AND user_id = \$2/.test(x.text)).pop();
  check('Edict unregisters its own token only', res.status === 200 && q && q.params[0] === fcm && q.params[1] === ME, q && q.params);
  res = await h.request('POST', '/devices', { body: { token: fcm, platform: 'android', app: 'edict' } });
  check('no token, no registration', res.status === 401, res.status);

  await h.close();
});
