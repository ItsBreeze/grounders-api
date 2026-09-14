/**
 * Live calls on Radio.
 *
 * The checks that matter here are not about the media — this server never
 * touches it — they are about who is allowed on a call, who is told what, and
 * what survives a cancel. They should not be removed:
 *
 *   1. With no Agora credentials the whole feature is inert: POST /radio/calls
 *      is a 503 with a sentence, nothing is written, and every other route in
 *      the repo behaves as it did before calling existed. That is the state of
 *      a fresh deploy.
 *
 *   2. A call id is a uuid, not a secret. Every route refuses someone who is
 *      not a participant, and refuses them with the same 404 it gives for a
 *      call that does not exist, so membership cannot be probed.
 *
 *   3. Everyone on a call is in the conversation it is held in — checked
 *      against the database per callee, not trusted from the client's member
 *      list, which is one refresh stale the moment somebody leaves.
 *
 *   4. The App Certificate never leaves the server. A token is minted for one
 *      uid on one channel, and the response is asserted not to contain the
 *      signing key.
 *
 *   5. never_record has teeth. If ANY participant has it set, the payload both
 *      clients read says recording is not allowed, and the keep route refuses
 *      with a reason and a name rather than an error.
 *
 *   6. kept_at survives a cancel. "Alex kept this, then stopped" is the truth
 *      and a column that erases itself cannot tell it — so the un-keep writes
 *      kept = false and leaves the stamp standing. This is the row you show
 *      the day someone disputes what happened, and it is checked as SQL text
 *      as well as behaviour, because the harness stubs pool.query and a stub
 *      cannot notice a CASE clause being deleted from the real statement.
 *
 *   7. A ringing call nobody answered becomes a missed one by being read.
 *      There is no timer on the server, so if the poll stops resolving it,
 *      a phone that never answers leaves a call ringing forever.
 *
 *   8. A kept call uploads as an ordinary voice note: the ADTS mime is
 *      honoured by upload-url (without the clause it lands under .m4a and
 *      will not play back on iOS), call_id is provenance a non-participant
 *      cannot stamp on a file, and kind stays 'voice_note' so the
 *      transcription pipeline matches it unchanged. What happens to that
 *      recording next — the push into Offhand, which is what call_id being
 *      present now triggers — is a suite of its own: test/offhand_push.test.js.
 *      It is inert here, as it is in every suite, because the harness empties
 *      OFFHAND_BASE_URL and GROUNDERS_PARTNER_KEY.
 */

// The presign in upload-url builds a URL from these; it signs locally and
// talks to nothing, but the SDK refuses to sign without credentials at all.
// Values are deliberately obvious nonsense: if one ever reaches a network,
// the failure should say so loudly rather than succeed against something.
process.env.R2_ACCOUNT_ID = 'harness-account';
process.env.R2_ACCESS_KEY_ID = 'harness-key';
process.env.R2_SECRET_ACCESS_KEY = 'harness-secret';
process.env.R2_BUCKET_NAME = 'harness-bucket';

const jwt = require('jsonwebtoken');
const { boot, check, run } = require('./harness');
const radioCall = require('../src/services/radio_call');
const apnsVoip = require('../src/services/apns_voip');

const ME = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const WS = '44444444-4444-4444-8444-444444444444';
const CALL = '55555555-5555-4555-8555-555555555555';
const FILE = '66666666-6666-4666-8666-666666666666';

const APP_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const CERTIFICATE = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3';

function tokenFor(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function auth(userId) {
  return { headers: { authorization: `Bearer ${tokenFor(userId)}` } };
}

/**
 * One place that decides what the database would have answered, so each phase
 * only says what is different about it. `state` is the world the phase is
 * describing: who is a member, what the call row looks like, who is on it.
 */
function handlerFor(state) {
  return (text, params) => {
    // radio.js stamps radio_enabled on every authenticated radio call.
    if (/UPDATE users SET radio_enabled/.test(text)) return { rows: [] };

    if (/SELECT 1 FROM radio_workspace_members WHERE workspace_id = \$1 AND user_id = \$2/.test(text)) {
      return { rows: state.members.includes(params[1]) && params[0] === WS ? [{ '?column?': 1 }] : [] };
    }
    if (/SELECT user_id FROM radio_workspace_members WHERE workspace_id = \$1 AND user_id = ANY/.test(text)) {
      const asked = params[1] || [];
      return { rows: asked.filter((u) => state.members.includes(u)).map((u) => ({ user_id: u })) };
    }
    if (/INSERT INTO radio_calls/.test(text)) {
      state.inserted = { text, params };
      return {
        rows: [{
          id: params[0], workspace_id: params[1], started_by: params[2],
          callee_id: params[3], media: params[4], channel: params[0],
          state: 'ringing', started_at: new Date().toISOString(),
          answered_at: null, ended_at: null,
        }],
      };
    }
    if (/INSERT INTO radio_call_participants/.test(text)) {
      state.participantInsert = { text, params };
      return { rows: [] };
    }
    if (/SELECT \* FROM radio_calls WHERE id = \$1/.test(text)) {
      return { rows: state.call ? [state.call] : [] };
    }
    if (/SELECT 1 FROM radio_call_participants WHERE call_id = \$1 AND user_id = \$2/.test(text)) {
      return { rows: state.onCall.includes(params[1]) ? [{ '?column?': 1 }] : [] };
    }
    if (/FROM radio_call_participants p\s+JOIN users u/.test(text)) {
      return { rows: state.participants };
    }
    if (/SELECT user_id FROM radio_call_participants WHERE call_id = \$1 AND user_id != \$2/.test(text)) {
      return { rows: state.onCall.filter((u) => u !== params[1]).map((u) => ({ user_id: u })) };
    }
    if (/UPDATE radio_call_participants/.test(text)) {
      state.participantUpdates.push({ text, params });
      return { rows: [] };
    }
    if (/UPDATE radio_calls/.test(text)) {
      state.callUpdates.push({ text, params });
      // Model the guard each statement actually carries, so the behavioural
      // checks below mean something.
      if (/state = 'missed'/.test(text)) {
        return { rows: state.call?.state === 'ringing' ? [{ ...state.call, state: 'missed' }] : [] };
      }
      if (/state = 'active'/.test(text)) {
        return {
          rows: ['ringing', 'active'].includes(state.call?.state)
            ? [{ ...state.call, state: 'active', answered_at: new Date().toISOString() }]
            : [],
        };
      }
      if (/state = 'declined'/.test(text)) {
        const someoneElseAnswered = state.answeredOthers === true;
        return {
          rows: state.call?.state === 'ringing' && !someoneElseAnswered
            ? [{ ...state.call, state: 'declined' }] : [],
        };
      }
      if (/state = 'ended'/.test(text)) {
        return { rows: state.stillOnCall ? [] : [{ ...state.call, state: 'ended' }], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT display_name FROM users WHERE id = \$1/.test(text)) {
      return { rows: [{ display_name: params[0] === ME ? 'Sam' : 'Alex' }] };
    }
    if (/SELECT name FROM radio_workspaces WHERE id = \$1/.test(text)) {
      return { rows: [{ name: 'Field Notes' }] };
    }
    if (/SELECT id, workspace_id, kind FROM radio_files/.test(text)
      || /SELECT id, workspace_id FROM radio_files/.test(text)) {
      return { rows: [{ id: FILE, workspace_id: WS, kind: 'voice_note' }] };
    }
    if (/FROM radio_call_participants p\s+JOIN radio_calls c/.test(text)) {
      return { rows: state.onCall.includes(params[1]) && params[0] === CALL ? [{ '?column?': 1 }] : [] };
    }
    if (/INSERT INTO radio_files/.test(text)) {
      state.fileInsert = { text, params };
      return { rows: [{ id: FILE, workspace_id: WS, owner_id: ME, kind: 'voice_note', r2_key: params[4], call_id: params[9] }] };
    }
    if (/UPDATE radio_files/.test(text)) {
      state.fileUpdates.push({ text, params });
      return { rows: [{ id: FILE, offhand_requested_at: params[1] === false ? null : new Date().toISOString() }] };
    }
    if (/UPDATE users SET/.test(text)) {
      state.userUpdate = { text, params };
      return { rows: [{ id: ME, display_name: 'Sam', radio_never_record: params[0] === true }] };
    }
    // recipients()/names() for the voice-note push
    if (/SELECT user_id FROM radio_workspace_members WHERE workspace_id = \$1 AND user_id != \$2/.test(text)) {
      return { rows: [{ user_id: FRIEND }] };
    }
    return { rows: [] };
  };
}

function freshState(over = {}) {
  return {
    members: [ME, FRIEND],
    onCall: [ME, FRIEND],
    participants: [
      { user_id: ME, display_name: 'Sam', radio_never_record: false, kept: false, kept_at: null, joined_at: null, left_at: null },
      { user_id: FRIEND, display_name: 'Alex', radio_never_record: false, kept: false, kept_at: null, joined_at: null, left_at: null },
    ],
    call: {
      id: CALL, workspace_id: WS, started_by: ME, callee_id: FRIEND,
      media: 'audio', channel: CALL, state: 'active',
      started_at: new Date().toISOString(), answered_at: null, ended_at: null,
    },
    callUpdates: [],
    participantUpdates: [],
    fileUpdates: [],
    ...over,
  };
}

run('radio_call', async () => {
  const h = await boot();

  // ── 1. Inert without credentials ─────────────────────────────────────────
  process.env.AGORA_APP_ID = '';
  process.env.AGORA_APP_CERTIFICATE = '';
  {
    const state = freshState();
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', '/radio/calls', {
      ...auth(ME), body: { workspace_id: WS, callee_id: FRIEND },
    });
    check('unconfigured: create answers 503', r.status === 503, r.status);
    check('unconfigured: says calling is not configured', /not configured/i.test(r.json?.error || ''), r.json);
    check('unconfigured: nothing was inserted', state.inserted === undefined);
    check('unconfigured: isConfigured() is false', radioCall.isConfigured() === false);
  }

  process.env.AGORA_APP_ID = APP_ID;
  process.env.AGORA_APP_CERTIFICATE = CERTIFICATE;
  check('configured: isConfigured() is true', radioCall.isConfigured() === true);

  // ── 2. The uid bridge ────────────────────────────────────────────────────
  {
    const a = radioCall.uidFor(ME);
    check('uid is stable for the same user', a === radioCall.uidFor(ME), a);
    check('uid differs between users', a !== radioCall.uidFor(FRIEND));
    check('uid is inside Agora\'s uint32', a > 0 && a < 2 ** 32, a);
    // 0 means "assign me one" to Agora, which would put two phones on one
    // identity and make a rejoin look like a new participant.
    check('uid is never 0', radioCall.uidFor('x') !== 0 && radioCall.uidFor(ME) !== 0);
  }

  // ── 3. Starting a call ───────────────────────────────────────────────────
  {
    const state = freshState();
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', '/radio/calls', {
      ...auth(ME), body: { workspace_id: WS, callee_id: FRIEND, media: 'audio' },
    });
    check('create: 201', r.status === 201, r.status);
    check('create: channel is the call id', r.json?.channel === r.json?.call_id, r.json?.channel);
    check('create: a token came back', typeof r.json?.token === 'string' && r.json.token.length > 20);
    check('create: token is an Agora token', /^00[67]/.test(r.json?.token || ''), (r.json?.token || '').slice(0, 4));
    check('create: app_id is returned', r.json?.app_id === APP_ID);
    check('create: uid matches the minted one', r.json?.uid === radioCall.uidFor(ME), r.json?.uid);
    // The signing key is the one thing that must never reach a phone.
    check('create: the certificate is not in the response',
      !JSON.stringify(r.json).includes(CERTIFICATE));
    check('create: state is ringing', r.json?.state === 'ringing', r.json?.state);
    check('create: recording is allowed', r.json?.recording_allowed === true);
    check('create: both people are participants', (r.json?.participants || []).length === 2);
    check('create: the call row names the callee', state.inserted?.params[3] === FRIEND);
    check('create: both participant rows are written',
      (state.participantInsert?.params[2] || []).length === 2, state.participantInsert?.params[2]);
    // The caller is in the channel already; the callee is a guest until they
    // answer, and that distinction is what "Incoming call" is drawn from.
    check('create: only the caller is joined at creation',
      /CASE WHEN u = \$2 THEN NOW\(\) ELSE NULL END/.test(state.participantInsert?.text || ''));
  }

  // ── 4. Who may be on a call ──────────────────────────────────────────────
  {
    const state = freshState();
    h.setQueryHandler(handlerFor(state));
    const notMine = await h.request('POST', '/radio/calls', {
      ...auth(STRANGER), body: { workspace_id: WS, callee_id: FRIEND },
    });
    check('create: a non-member cannot start a call', notMine.status === 403, notMine.status);

    const outsider = await h.request('POST', '/radio/calls', {
      ...auth(ME), body: { workspace_id: WS, callee_id: STRANGER },
    });
    check('create: cannot ring someone outside the conversation', outsider.status === 403, outsider.status);
    check('create: and says why', /in the conversation/i.test(outsider.json?.error || ''), outsider.json);

    const noCallee = await h.request('POST', '/radio/calls', {
      ...auth(ME), body: { workspace_id: WS },
    });
    check('create: a callee is required', noCallee.status === 400, noCallee.status);

    const crowd = await h.request('POST', '/radio/calls', {
      ...auth(ME), body: { workspace_id: WS, callee_ids: [FRIEND, STRANGER, ME, 'a', 'b'] },
    });
    check('create: a call holds at most four people', crowd.status === 400, crowd.status);
  }

  // ── 5. A group call (Phase 2) ────────────────────────────────────────────
  {
    const third = '77777777-7777-4777-8777-777777777777';
    const state = freshState({ members: [ME, FRIEND, third] });
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', '/radio/calls', {
      ...auth(ME), body: { workspace_id: WS, callee_ids: [FRIEND, third], media: 'video' },
    });
    check('group: 201', r.status === 201, r.status);
    check('group: three participant rows', (state.participantInsert?.params[2] || []).length === 3);
    // callee_id is what a 1:1 call means; a group has no single callee and
    // the participant rows are the guest list.
    check('group: callee_id is null', state.inserted?.params[3] === null, state.inserted?.params[3]);
    check('group: media is video', state.inserted?.params[4] === 'video');
  }

  // ── 6. A call id is not a key ────────────────────────────────────────────
  {
    const state = freshState({ onCall: [ME, FRIEND] });
    h.setQueryHandler(handlerFor(state));
    for (const [name, method, path] of [
      ['read', 'GET', `/radio/calls/${CALL}`],
      ['token', 'POST', `/radio/calls/${CALL}/token`],
      ['answer', 'POST', `/radio/calls/${CALL}/answer`],
      ['decline', 'POST', `/radio/calls/${CALL}/decline`],
      ['end', 'POST', `/radio/calls/${CALL}/end`],
      ['keep', 'POST', `/radio/calls/${CALL}/keep`],
    ]) {
      const r = await h.request(method, path,
        method === 'GET' ? auth(STRANGER) : { ...auth(STRANGER), body: {} });
      // The same 404 as a call that does not exist: a stranger holding an id
      // must not be able to tell "not yours" from "no such call".
      check(`${name}: a non-participant gets 404`, r.status === 404, r.status);
    }
  }

  // ── 7. Ringing resolves itself ───────────────────────────────────────────
  {
    const old = new Date(Date.now() - radioCall.RING_TIMEOUT_MS - 1000).toISOString();
    const state = freshState({ call: { ...freshState().call, state: 'ringing', started_at: old } });
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('GET', `/radio/calls/${CALL}`, auth(ME));
    check('poll: an unanswered call becomes missed', r.json?.state === 'missed', r.json?.state);
    check('poll: the expiry is guarded on the current state',
      /state = 'missed'[\s\S]*WHERE id = \$1 AND state = 'ringing'/.test(state.callUpdates[0]?.text || ''),
      state.callUpdates[0]?.text);
  }
  {
    const state = freshState({ call: { ...freshState().call, state: 'ringing' } });
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('GET', `/radio/calls/${CALL}`, auth(ME));
    check('poll: a call still inside the window keeps ringing', r.json?.state === 'ringing', r.json?.state);
    check('poll: and nothing was written', state.callUpdates.length === 0);
  }

  // ── 8. Answer, decline, end ──────────────────────────────────────────────
  {
    const state = freshState({ call: { ...freshState().call, state: 'ringing' } });
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', `/radio/calls/${CALL}/answer`, { ...auth(FRIEND), body: {} });
    check('answer: the call is active', r.json?.state === 'active', r.json?.state);
    check('answer: joined_at is stamped once',
      /joined_at = COALESCE\(joined_at, NOW\(\)\)/.test(state.participantUpdates[0]?.text || ''));
    check('answer: answered_at is stamped once',
      /answered_at = COALESCE\(answered_at, NOW\(\)\)/.test(state.callUpdates[0]?.text || ''));
    check('answer: a fresh token comes with it', typeof r.json?.token === 'string' && r.json.token.length > 20);
  }
  {
    const state = freshState({ call: { ...freshState().call, state: 'ended' } });
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', `/radio/calls/${CALL}/answer`, { ...auth(FRIEND), body: {} });
    check('answer: an ended call cannot be answered', r.status === 409, r.status);
  }
  {
    const state = freshState({ call: { ...freshState().call, state: 'ringing' } });
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', `/radio/calls/${CALL}/decline`, { ...auth(FRIEND), body: {} });
    check('decline: the call is declined', r.json?.state === 'declined', r.json?.state);
    // In a group, one person saying no must not hang up on the people who
    // are already talking.
    check('decline: only while nobody else has joined',
      /NOT EXISTS[\s\S]*p\.user_id != c\.started_by[\s\S]*p\.joined_at IS NOT NULL/.test(state.callUpdates[0]?.text || ''),
      state.callUpdates[0]?.text);
  }
  {
    const state = freshState({ call: { ...freshState().call, state: 'ringing' }, answeredOthers: true });
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', `/radio/calls/${CALL}/decline`, { ...auth(FRIEND), body: {} });
    check('decline: a call others joined stays up', r.json?.state === 'ringing', r.json?.state);
  }
  {
    const state = freshState({ stillOnCall: true });
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', `/radio/calls/${CALL}/end`, { ...auth(ME), body: {} });
    check('end: leaving is recorded', state.participantUpdates.length === 1);
    check('end: the call stands while someone is still on it', r.json?.state === 'active', r.json?.state);
    check('end: ending is guarded on nobody remaining',
      /NOT EXISTS[\s\S]*p\.joined_at IS NOT NULL AND p\.left_at IS NULL/.test(state.callUpdates[0]?.text || ''),
      state.callUpdates[0]?.text);
  }
  {
    const state = freshState();
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', `/radio/calls/${CALL}/end`, { ...auth(ME), body: {} });
    check('end: the last one out ends the call', r.json?.state === 'ended', r.json?.state);
  }

  // ── 9. Keeping, and being told about it ──────────────────────────────────
  {
    const state = freshState();
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', `/radio/calls/${CALL}/keep`, { ...auth(ME), body: { keeping: true } });
    check('keep: 200', r.status === 200, r.status);
    check('keep: kept is written true', state.participantUpdates[0]?.params[2] === true);
    const sql = state.participantUpdates[0]?.text || '';
    check('keep: kept_at is stamped on the way up', /kept_at = CASE WHEN \$3 THEN NOW\(\)/.test(sql), sql);
    // The whole point of the record: a cancel must not erase the fact that
    // it was once kept.
    check('keep: kept_at is left standing on the way down', /ELSE kept_at END/.test(sql), sql);
  }
  {
    const state = freshState();
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', `/radio/calls/${CALL}/keep`, { ...auth(ME), body: { keeping: false } });
    check('un-keep: kept is written false', state.participantUpdates[0]?.params[2] === false);
    check('un-keep: still 200', r.status === 200, r.status);
  }

  // ── 10. never_record has teeth ───────────────────────────────────────────
  {
    const participants = freshState().participants.map((p) =>
      (p.user_id === FRIEND ? { ...p, radio_never_record: true } : p));
    const state = freshState({ participants });
    h.setQueryHandler(handlerFor(state));

    const read = await h.request('GET', `/radio/calls/${CALL}`, auth(ME));
    check('never_record: the payload tells both clients not to record',
      read.json?.recording_allowed === false, read.json?.recording_allowed);
    check('never_record: the flag is returned per participant',
      read.json?.participants?.find((p) => p.user_id === FRIEND)?.never_record === true);

    const kept = await h.request('POST', `/radio/calls/${CALL}/keep`, { ...auth(ME), body: { keeping: true } });
    check('never_record: keeping is refused', kept.status === 409, kept.status);
    check('never_record: with a reason the app can show', kept.json?.reason === 'never_record', kept.json);
    check('never_record: and the name of who turned it off', kept.json?.blocked_by === 'Alex', kept.json);
    check('never_record: nothing was written', state.participantUpdates.length === 0);
  }

  // ── 11. The upload path a kept call takes ────────────────────────────────
  {
    const state = freshState();
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', `/radio/workspaces/${WS}/upload-url`, {
      ...auth(ME), body: { kind: 'voice_note', mime_type: 'audio/aac' },
    });
    // Without this clause the file lands under an .m4a key with an audio/mp4
    // Content-Type, and an ADTS stream served as mp4 will not play on iOS.
    check('upload: audio/aac is honoured', r.json?.mime_type === 'audio/aac', r.json?.mime_type);
    check('upload: and gets an .aac key', /\.aac$/.test(r.json?.r2_key || ''), r.json?.r2_key);
  }
  {
    const state = freshState();
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', `/radio/workspaces/${WS}/files`, {
      ...auth(ME),
      body: {
        kind: 'voice_note', r2_key: `radio/${WS}/x.aac`, size_bytes: 1024,
        mime_type: 'audio/aac', duration_ms: 840000, call_id: CALL,
        filename: 'Call with Alex',
      },
    });
    check('finalize: 201', r.status === 201, r.status);
    check('finalize: call_id is stored', state.fileInsert?.params[9] === CALL, state.fileInsert?.params[9]);
    // Provenance, not a kind: the transcription pipeline's WHERE clause is
    // `kind = 'voice_note'`, and a fourth kind would fall straight out of it.
    check('finalize: the kind is still voice_note', state.fileInsert?.params[3] === 'voice_note');
    check('finalize: the participant row points at the file',
      state.participantUpdates.some((u) => /file_id = \$3/.test(u.text)));
  }
  {
    const state = freshState({ onCall: [FRIEND] });
    h.setQueryHandler(handlerFor(state));
    const r = await h.request('POST', `/radio/workspaces/${WS}/files`, {
      ...auth(ME),
      body: { kind: 'voice_note', r2_key: `radio/${WS}/x.aac`, size_bytes: 10, call_id: CALL },
    });
    check('finalize: a non-participant cannot claim a call', r.status === 403, r.status);
    check('finalize: and nothing was inserted', state.fileInsert === undefined);
  }

  // ── 12. Flagging it for Offhand ──────────────────────────────────────────
  //
  // What this route does has not changed; what the column it writes MEANS has.
  // A kept call is now pushed to Offhand as it is recorded
  // (services/offhand_push, tested on the wire in test/offhand_push.test.js),
  // so offhand_requested_at is no longer the road a call takes to Offhand —
  // it is the road it takes when the push could not deliver it, and the push
  // is the other writer of this same column. These checks are therefore about
  // the manual ask surviving alongside that: the user can still put a message
  // in front of their assistant, they can still take it back, and neither the
  // ask nor the un-ask may disturb what the push recorded about the delivery.
  {
    const state = freshState();
    h.setQueryHandler(handlerFor(state));
    const on = await h.request('POST', `/radio/files/${FILE}/offhand`, { ...auth(ME), body: {} });
    check('offhand: a person can still ask for a message by hand', on.json?.offhand_requested_at !== null, on.json);
    check('offhand: a stamp already there — theirs, or one a failed push left — keeps its own time',
      /COALESCE\(offhand_requested_at, NOW\(\)\)/.test(state.fileUpdates[0]?.text || ''));

    const off = await h.request('POST', `/radio/files/${FILE}/offhand`, { ...auth(ME), body: { requested: false } });
    check('offhand: it can be taken back', off.json?.offhand_requested_at === null, off.json);
    // Taking the flag back is the user saying "not this one", which is allowed
    // to clear a stamp the push left. It must not also erase the record of
    // what happened to the delivery: offhand_push_status and offhand_note_id
    // are the only answer to "where did my call go", and they are not this
    // route's to touch.
    check('offhand: and neither direction touches what the push recorded',
      state.fileUpdates.every((u) => !/offhand_push_status|offhand_note_id/.test(u.text)),
      state.fileUpdates.map((u) => u.text));
  }

  // ── 13. The account setting ──────────────────────────────────────────────
  {
    const state = freshState();
    h.setQueryHandler(handlerFor(state));
    const ok = await h.request('PATCH', '/users/me', { ...auth(ME), body: { radio_never_record: true } });
    check('setting: it can be switched on alone', ok.status === 200, ok.status);
    check('setting: and is written as a boolean', state.userUpdate?.params[0] === true);
    check('setting: the response reflects it', ok.json?.radio_never_record === true, ok.json);

    // A "false" string read as true would silently switch someone's calls
    // back on, which is the one direction this must never fail in.
    const sloppy = await h.request('PATCH', '/users/me', { ...auth(ME), body: { radio_never_record: 'false' } });
    check('setting: a string is refused', sloppy.status === 400, sloppy.status);
  }

  // ── 14. The lock-screen ring (Phase 2) ──────────────────────────
  {
    check('voip: inert without an APNs key', apnsVoip.isConfigured() === false);
    const quiet = await apnsVoip.ring([ME], { type: 'radio_call_ring' });
    check('voip: ringing without a key does nothing and does not throw',
      quiet.sent === 0 && quiet.skipped === true, quiet);

    // The two halves of keeping the two token kinds apart. A PushKit token is
    // not an FCM token: sending one to FCM fails every time, and the
    // invalid-token pruning in notifications.js would then delete the very
    // token that makes a locked iPhone ring.
    //
    // Only this half is reachable from a test — the FCM lookup returns early
    // with no Firebase credentials, which is every suite in this repo — so
    // the exclusion on the other side is asserted as the statement text it
    // would send, the same way the transcription suite pins its WHERE clause.
    let voipQuery = null;
    h.setQueryHandler((text) => {
      if (/FROM device_tokens/.test(text)) {
        voipQuery = text;
        return { rows: [{ token: 'v'.repeat(64) }] };
      }
      return { rows: [] };
    });
    await apnsVoip.voipTokensFor([ME]);
    check('voip: the VoIP lookup takes only PushKit tokens',
      voipQuery !== null && /platform = 'ios_voip'/.test(voipQuery), voipQuery);

    const fcmSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'services', 'notifications.js'), 'utf8',
    );
    check('voip: and every FCM send excludes them',
      /platform <> 'ios_voip'/.test(fcmSource));
  }

  // ── 15. Registering a PushKit token ─────────────────────────
  {
    let registered = null;
    h.setQueryHandler((text, params) => {
      if (/INSERT INTO device_tokens/.test(text)) {
        registered = params;
        return { rows: [] };
      }
      return { rows: [] };
    });
    const ok = await h.request('POST', '/devices', {
      ...auth(ME),
      body: { token: 'v'.repeat(64), platform: 'ios_voip', app: 'radio' },
    });
    check('voip: a PushKit token registers', ok.status === 201, ok.status);
    check('voip: and is stored as its own platform', registered?.[2] === 'ios_voip');

    const nonsense = await h.request('POST', '/devices', {
      ...auth(ME), body: { token: 'v'.repeat(64), platform: 'carrier-pigeon' },
    });
    check('voip: an unknown platform is still refused', nonsense.status === 400, nonsense.status);
  }

  await h.close();
});
