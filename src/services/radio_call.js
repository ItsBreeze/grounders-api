/**
 * Live calls on Radio — the paperwork, not the media.
 *
 * Agora carries the audio and video. This server never sees a byte of a call:
 * it mints the token that lets a phone join a channel, it rings the other
 * phone through FCM, and it records who kept what. That is the whole job, and
 * it is why calling adds no process, no websocket and no media path to
 * Railway.
 *
 * Why a token service at all. An Agora channel is open to anyone holding a
 * token for it, so the App Certificate must never ship in a client binary —
 * the phone asks for a token, this file mints it against the call row the
 * caller is actually a participant in, and it expires in an hour. A call
 * outlasting its token keeps working: the token is checked at join, not
 * continuously, and a mid-call renewal is a Phase 2 concern for calls longer
 * than an hour.
 *
 * Inert without a key. With AGORA_APP_ID or AGORA_APP_CERTIFICATE absent,
 * isConfigured() is false, POST /radio/calls answers 503 'Calling is not
 * configured', and the app falls back to the toast it showed before calling
 * existed. Same discipline as radio_transcribe: a deploy that has not been
 * given the credentials behaves exactly as the deploy before it did.
 *
 * The uid. Agora identifies a participant in a channel by a 32-bit unsigned
 * integer, and Grounders identifies a user by a uuid. The bridge is a stable
 * hash of the uuid, computed the same way on every call so a reconnecting
 * phone rejoins as itself. Collisions are possible in principle — two uuids
 * into 31 bits — and harmless in practice: a collision would have to be
 * between the two people on one call, and the token is minted per call
 * anyway. uid 0 is reserved by Agora for "assign me one", so the hash is
 * forced away from it.
 */

const crypto = require('crypto');
const pool = require('../db/pool');
const notifications = require('./notifications');
const apnsVoip = require('./apns_voip');

/** An Agora token's life. Long enough that no ordinary call renews. */
const TOKEN_TTL_SECONDS = 3600;

/**
 * How long a callee's phone is given to answer before the call is a missed
 * one. The app polls for this window and stops; the server uses the same
 * number so both ends agree on when ringing ended without exchanging it.
 */
const RING_TIMEOUT_MS = 45 * 1000;

/**
 * A call left 'active' by a client that died — force-killed mid-call, battery
 * out — is swept when anything next touches that call, and by the end route.
 * Six hours is far past any real call and far short of leaving a row that
 * says "in progress" on the screen forever.
 */
const ABANDONED_AFTER_MS = 6 * 60 * 60 * 1000;

function isConfigured() {
  return Boolean(process.env.AGORA_APP_ID && process.env.AGORA_APP_CERTIFICATE);
}

/**
 * uuid → a stable Agora uid in [1, 2^31). Not security-bearing: the token is
 * what authorises a join, and this only has to be the same number every time
 * for the same person.
 */
function uidFor(userId) {
  const digest = crypto.createHash('sha256').update(String(userId)).digest();
  // Mask to 31 bits so the value is comfortably inside Agora's uint32 and
  // never negative when it crosses a signed boundary in a client SDK.
  const n = digest.readUInt32BE(0) & 0x7fffffff;
  return n === 0 ? 1 : n;
}

/**
 * Mint an RTC token for one participant of one call.
 *
 * `agora-token` is required lazily so the module loads — and every route that
 * does not call it keeps working — on a deploy where the dependency is
 * present but the credentials are not, and so the test harness never needs
 * the package at all.
 */
function mintToken({ channel, uid }) {
  if (!isConfigured()) return null;
  // eslint-disable-next-line global-require
  const { RtcTokenBuilder, RtcRole } = require('agora-token');
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const token = RtcTokenBuilder.buildTokenWithUid(
    process.env.AGORA_APP_ID,
    process.env.AGORA_APP_CERTIFICATE,
    channel,
    uid,
    RtcRole.PUBLISHER,
    expiresAt,
    expiresAt,
  );
  return { token, uid, expires_at: new Date(expiresAt * 1000).toISOString() };
}

/**
 * The participants of a call, with the one flag both clients enforce.
 *
 * never_record is returned for everyone, not just the asker, because the rule
 * is "if ANY participant has it set, NOBODY records" — a client cannot apply
 * that without seeing the others' setting, and a client that had to ask the
 * peer for it over the media channel would be trusting the peer. This is the
 * one place the answer comes from, and both phones get the same one.
 */
async function participantsOf(callId) {
  const { rows } = await pool.query(
    `SELECT p.user_id, p.kept, p.kept_at, p.joined_at, p.left_at,
            u.display_name, u.radio_never_record
       FROM radio_call_participants p
       JOIN users u ON u.id = p.user_id
      WHERE p.call_id = $1
      ORDER BY p.joined_at NULLS LAST`,
    [callId],
  );
  return rows.map((r) => ({
    user_id: r.user_id,
    name: (r.display_name || '').trim() || 'Someone',
    never_record: r.radio_never_record === true,
    kept: r.kept === true,
    kept_at: r.kept_at,
    joined_at: r.joined_at,
    left_at: r.left_at,
  }));
}

/** True when nobody on this call may be recorded. One flag, both clients. */
function recordingAllowed(participants) {
  return !participants.some((p) => p.never_record);
}

/**
 * The shape every call route answers with, so the client has one parser.
 * `token` is minted for `forUserId` and nobody else.
 */
async function callPayload(call, forUserId) {
  const participants = await participantsOf(call.id);
  const minted = mintToken({ channel: call.channel, uid: uidFor(forUserId) }) || {};
  return {
    call_id: call.id,
    workspace_id: call.workspace_id,
    started_by: call.started_by,
    callee_id: call.callee_id,
    media: call.media,
    state: call.state,
    channel: call.channel,
    app_id: process.env.AGORA_APP_ID || null,
    token: minted.token || null,
    uid: minted.uid || uidFor(forUserId),
    expires_at: minted.expires_at || null,
    started_at: call.started_at,
    answered_at: call.answered_at,
    ended_at: call.ended_at,
    recording_allowed: recordingAllowed(participants),
    participants,
  };
}

/**
 * Ring the callee's phone, by both roads at once.
 *
 * The FCM alert is the one that always works: it reaches Android, it reaches
 * a foregrounded iPhone, and it degrades to a missed-call notification rather
 * than to nothing. It is answer-from-notification, not a ringing lock screen.
 *
 * The VoIP push is the one that makes a locked iPhone actually ring, and it
 * is the only message iOS will wake a terminated app for. It is sent only to
 * PushKit tokens, only when APNs is configured, and it never replaces the
 * alert: a phone with both gets the CallKit screen and the notification is
 * redundant, while a phone with neither VoIP token nor CallKit still gets a
 * notification it can tap. Belt and braces, because a call that does not
 * arrive is the whole feature failing.
 */
function ring({ call, callerName, workspaceName, calleeId }) {
  apnsVoip.ring([calleeId], {
    type: 'radio_call_ring',
    call_id: call.id,
    workspace_id: call.workspace_id,
    channel: call.channel,
    media: call.media,
    from_user_id: call.started_by,
    sender_name: callerName,
    workspace_name: workspaceName || '',
  }).catch((err) => console.error('[radio_call] voip ring failed:', err.message));

  notifications.fireAndForget(notifications.sendToUsers([calleeId], {
    title: `${callerName} is calling`,
    body: workspaceName ? `On ${workspaceName}` : 'Tap to answer',
    app: 'radio',
    data: {
      type: 'radio_call_ring',
      call_id: call.id,
      workspace_id: call.workspace_id,
      channel: call.channel,
      media: call.media,
      from_user_id: call.started_by,
      sender_name: callerName,
      workspace_name: workspaceName || '',
      ring_timeout_ms: RING_TIMEOUT_MS,
    },
  }));
}

/**
 * Tell the far end that someone is keeping the call — the server's own copy
 * of a notice the client has already sent over Agora's data stream.
 *
 * Three paths carry this, and this is the second: the data stream covers a
 * peer with the screen on, this covers one whose screen is off or who is
 * briefly disconnected, and GET /radio/calls/:id on next foreground covers
 * the rest. Belt and braces on purpose — the whole consent design rests on
 * the far end actually finding out, so it must not depend on one transport.
 */
function announceKeep({ call, keeperName, keeping, to }) {
  if (!to.length) return;
  notifications.fireAndForget(notifications.sendToUsers(to, {
    title: keeping
      ? `${keeperName} is keeping this call`
      : `${keeperName} is no longer keeping this call`,
    body: keeping ? 'From the start.' : 'Nothing will be uploaded.',
    app: 'radio',
    data: {
      type: 'radio_call_keep',
      call_id: call.id,
      workspace_id: call.workspace_id,
      keeping: keeping ? 'true' : 'false',
      keeper_name: keeperName,
    },
  }));
}

/** Whoever else is on the call — the audience for a keep notice. */
async function othersOn(callId, userId) {
  const { rows } = await pool.query(
    `SELECT user_id FROM radio_call_participants WHERE call_id = $1 AND user_id != $2`,
    [callId, userId],
  );
  return rows.map((r) => r.user_id);
}

/**
 * Close calls nothing is going to close on its own.
 *
 * Runs from the end route rather than on a cron, because the only rows this
 * can affect are ones whose participants have all gone away, and the next
 * call is when anybody notices. One statement, bounded by the partial index
 * on open calls.
 */
async function sweepAbandoned() {
  const { rowCount } = await pool.query(
    `UPDATE radio_calls
        SET state = 'ended', ended_at = NOW()
      WHERE state IN ('ringing', 'active')
        AND started_at < NOW() - ($1::double precision * INTERVAL '1 millisecond')`,
    [ABANDONED_AFTER_MS],
  );
  return rowCount || 0;
}

/**
 * A ringing call nobody answered inside the window is a missed call, not a
 * ringing one. Checked whenever a call is read, so the poll itself resolves
 * it and no timer has to exist on the server.
 */
async function expireIfUnanswered(call) {
  if (call.state !== 'ringing') return call;
  const age = Date.now() - new Date(call.started_at).getTime();
  if (age < RING_TIMEOUT_MS) return call;
  const { rows } = await pool.query(
    `UPDATE radio_calls SET state = 'missed', ended_at = NOW()
      WHERE id = $1 AND state = 'ringing'
      RETURNING *`,
    [call.id],
  );
  return rows[0] || call;
}

module.exports = {
  isConfigured,
  uidFor,
  mintToken,
  participantsOf,
  recordingAllowed,
  callPayload,
  ring,
  announceKeep,
  othersOn,
  sweepAbandoned,
  expireIfUnanswered,
  TOKEN_TTL_SECONDS,
  RING_TIMEOUT_MS,
  ABANDONED_AFTER_MS,
};
