/**
 * Live calls — REST only, in the shape of every other route in this repo.
 *
 * There is no websocket and no SSE here on purpose. Ringing is an FCM push,
 * the ringing window is a 2-second poll bounded to 45 seconds that stops the
 * moment the channel is joined, and everything in-call rides Agora's own data
 * stream between the phones. That is the one place this design pays for
 * having no realtime server, and it buys a feature that adds nothing to the
 * Railway deploy.
 *
 * Every route below establishes that the caller is a participant of the call
 * (or, for creation, a member of the workspace) before it answers. A call id
 * is a uuid and not a secret, so nothing is authorised by holding one.
 */

const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const radioCall = require('../services/radio_call');

router.use(requireAuth);

/**
 * Phase 2 rings a group. The cap is four because the participant grid is
 * designed for four and because `audioFileRecordingMixed` mixing five voices
 * into one mono track stops being a transcript and starts being a crowd.
 */
const MAX_PARTICIPANTS = 4;

async function isMember(workspaceId, userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM radio_workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  return rows.length > 0;
}

/** The call row, or null. */
async function getCall(callId) {
  const { rows } = await pool.query(`SELECT * FROM radio_calls WHERE id = $1`, [callId]);
  return rows[0] || null;
}

/**
 * Load a call the caller is actually on. Answers the same 404 for "no such
 * call" and "not your call" — a caller who is on neither should not be able
 * to tell them apart.
 */
async function callForParticipant(callId, userId) {
  const call = await getCall(callId);
  if (!call) return null;
  const { rows } = await pool.query(
    `SELECT 1 FROM radio_call_participants WHERE call_id = $1 AND user_id = $2`,
    [callId, userId],
  );
  return rows.length ? call : null;
}

async function displayName(userId) {
  const { rows } = await pool.query(`SELECT display_name FROM users WHERE id = $1`, [userId]);
  return (rows[0]?.display_name || '').trim() || 'Someone';
}

async function workspaceName(workspaceId) {
  const { rows } = await pool.query(`SELECT name FROM radio_workspaces WHERE id = $1`, [workspaceId]);
  return (rows[0]?.name || '').trim();
}

// POST /radio/calls { workspace_id, callee_id | callee_ids[], media }
// Creates the call, writes a participant row per person, rings everyone else.
router.post('/', async (req, res, next) => {
  try {
    if (!radioCall.isConfigured()) {
      return res.status(503).json({ error: 'Calling is not configured' });
    }
    const myId = req.user.id;
    const wsId = (req.body.workspace_id || '').toString();
    const media = req.body.media === 'video' ? 'video' : 'audio';

    if (!wsId) return res.status(400).json({ error: 'workspace_id required' });
    if (!(await isMember(wsId, myId))) return res.status(403).json({ error: 'Not a member' });

    // One callee or several. The array form is what a group call sends; the
    // singular is kept because it is what a 1:1 call means and what the row
    // records.
    const raw = Array.isArray(req.body.callee_ids)
      ? req.body.callee_ids
      : [req.body.callee_id].filter(Boolean);
    const asked = [...new Set(raw.map((v) => (v || '').toString()).filter(Boolean))];
    // Calling YOURSELF is allowed, and it is a real feature rather than a hole
    // left open: one account, two devices, and the phone in your pocket rings
    // the tablet on the desk. It is also the only call a person can place
    // alone, which makes it the only way to try calling without a second
    // human. It works because the Agora uid is per LEG, not per person — see
    // radio_call.uidFor — so the two devices are two participants even though
    // they are one user.
    //
    // The self-call is the whole callee list or it is not a self-call: mixing
    // yourself into a group alongside other people would mean two of your own
    // devices plus everyone else, which nothing downstream is built for.
    const isSelfCall = asked.length === 1 && asked[0] === myId;
    const callees = isSelfCall ? asked : asked.filter((v) => v !== myId);
    if (!callees.length) return res.status(400).json({ error: 'callee_id required' });
    if (callees.length + 1 > MAX_PARTICIPANTS) {
      return res.status(400).json({ error: `A call holds at most ${MAX_PARTICIPANTS} people` });
    }

    // Everyone on the call must be in the workspace it is being held in.
    // Checked per callee rather than trusted from the client's member list,
    // which is one refresh out of date the moment somebody leaves.
    const { rows: memberRows } = await pool.query(
      `SELECT user_id FROM radio_workspace_members WHERE workspace_id = $1 AND user_id = ANY($2)`,
      [wsId, callees],
    );
    if (memberRows.length !== callees.length) {
      return res.status(403).json({ error: 'Everyone on a call has to be in the conversation' });
    }

    const callId = uuid();
    const { rows: [call] } = await pool.query(
      `INSERT INTO radio_calls (id, workspace_id, started_by, callee_id, media, channel, state)
       VALUES ($1, $2, $3, $4, $5, $1::text, 'ringing')
       RETURNING *`,
      [callId, wsId, myId, callees.length === 1 ? callees[0] : null, media],
    );

    // The caller is on the call the moment it exists — they are already in
    // the channel — and the callees are guests until they answer.
    // A self-call writes ONE row, not two: the primary key is
    // (call_id, user_id) and both legs are the same user. That is the honest
    // shape — there is one person on this call, on two devices — and it keeps
    // the keep record, the allowance and the Offhand push all counting once.
    await pool.query(
      `INSERT INTO radio_call_participants (call_id, user_id, joined_at)
       SELECT $1, u, CASE WHEN u = $2 THEN NOW() ELSE NULL END
         FROM unnest($3::uuid[]) AS u
       ON CONFLICT (call_id, user_id) DO NOTHING`,
      [callId, myId, [myId, ...callees]],
    );

    const [callerName, wsName] = await Promise.all([displayName(myId), workspaceName(wsId)]);
    for (const calleeId of callees) {
      radioCall.ring({ call, callerName, workspaceName: wsName, calleeId });
    }

    // Leg 'a': this device created the call.
    res.status(201).json(await radioCall.callPayload(call, myId, 'a'));
  } catch (err) { next(err); }
});

// GET /radio/calls/:id — the ringing poll, and the catch-up read a phone does
// when it comes back to the foreground. Resolves an unanswered call into a
// missed one on the way past, so no timer has to live on the server.
router.get('/:id', async (req, res, next) => {
  try {
    const call = await callForParticipant(req.params.id, req.user.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    const current = await radioCall.expireIfUnanswered(call);
    res.json(await radioCall.callPayload(current, req.user.id));
  } catch (err) { next(err); }
});

// POST /radio/calls/:id/token — a fresh token for the same channel. Used by
// the callee at answer time and by either phone if a call outlives its hour.
router.post('/:id/token', async (req, res, next) => {
  try {
    if (!radioCall.isConfigured()) {
      return res.status(503).json({ error: 'Calling is not configured' });
    }
    const call = await callForParticipant(req.params.id, req.user.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (call.state === 'ended' || call.state === 'declined' || call.state === 'missed') {
      return res.status(409).json({ error: 'That call has ended' });
    }
    // A fresh token is only ever asked for by a device that is joining or
    // rejoining as the answering side, so it gets leg 'b'.
    res.json(await radioCall.callPayload(call, req.user.id, 'b'));
  } catch (err) { next(err); }
});

// POST /radio/calls/:id/answer — the callee joined. Idempotent: answering a
// call that is already active is how a reconnect looks.
router.post('/:id/answer', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const call = await callForParticipant(req.params.id, myId);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (['ended', 'declined', 'missed'].includes(call.state)) {
      return res.status(409).json({ error: 'That call has ended' });
    }

    await pool.query(
      `UPDATE radio_call_participants SET joined_at = COALESCE(joined_at, NOW())
        WHERE call_id = $1 AND user_id = $2`,
      [call.id, myId],
    );
    const { rows } = await pool.query(
      `UPDATE radio_calls SET state = 'active', answered_at = COALESCE(answered_at, NOW())
        WHERE id = $1 AND state IN ('ringing', 'active')
        RETURNING *`,
      [call.id],
    );
    // Leg 'b': this device answered. On a self-call that is what keeps the
    // two devices apart in the channel.
    res.json(await radioCall.callPayload(rows[0] || call, myId, 'b'));
  } catch (err) { next(err); }
});

// POST /radio/calls/:id/decline — the callee said no. In a group call one
// person declining leaves the call standing for everyone else.
router.post('/:id/decline', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const call = await callForParticipant(req.params.id, myId);
    if (!call) return res.status(404).json({ error: 'Call not found' });

    await pool.query(
      `UPDATE radio_call_participants SET left_at = NOW() WHERE call_id = $1 AND user_id = $2`,
      [call.id, myId],
    );
    // Only a declining callee ends the call outright, and only while nobody
    // else has answered — otherwise the people already talking would be hung
    // up on by someone who never joined. The caller's own participant row has
    // joined_at set from creation, so it is excluded by name rather than by
    // timestamp.
    const { rows } = await pool.query(
      `UPDATE radio_calls c SET state = 'declined', ended_at = NOW()
        WHERE c.id = $1 AND c.state = 'ringing'
          AND NOT EXISTS (
            SELECT 1 FROM radio_call_participants p
             WHERE p.call_id = c.id
               AND p.user_id != c.started_by
               AND p.joined_at IS NOT NULL
          )
        RETURNING *`,
      [call.id],
    );
    res.json(await radioCall.callPayload(rows[0] || call, myId));
  } catch (err) { next(err); }
});

// POST /radio/calls/:id/end — hang up. Idempotent, and sweeps calls some
// other client abandoned while it is here.
router.post('/:id/end', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const call = await callForParticipant(req.params.id, myId);
    if (!call) return res.status(404).json({ error: 'Call not found' });

    await pool.query(
      `UPDATE radio_call_participants SET left_at = COALESCE(left_at, NOW())
        WHERE call_id = $1 AND user_id = $2`,
      [call.id, myId],
    );
    // In a group, the call ends when the last person leaves; in a 1:1 the
    // second clause is the first one.
    const { rows } = await pool.query(
      `UPDATE radio_calls c SET state = 'ended', ended_at = NOW()
        WHERE c.id = $1 AND c.state IN ('ringing', 'active')
          AND NOT EXISTS (
            SELECT 1 FROM radio_call_participants p
             WHERE p.call_id = c.id AND p.joined_at IS NOT NULL AND p.left_at IS NULL
          )
        RETURNING *`,
      [call.id],
    );
    radioCall.sweepAbandoned().catch(() => {});
    res.json(await radioCall.callPayload(rows[0] || (await getCall(call.id)) || call, myId));
  } catch (err) { next(err); }
});

// POST /radio/calls/:id/keep { keeping } — the durable consent record, and
// the server's own copy of the notice the client has already broadcast.
//
// The client renames its buffer file BEFORE calling this, so a failure here
// never loses a recording someone chose to keep. What this adds is the part
// a phone cannot be trusted with: the record of who was told, and a delivery
// path that works when the peer's screen is off.
router.post('/:id/keep', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const call = await callForParticipant(req.params.id, myId);
    if (!call) return res.status(404).json({ error: 'Call not found' });

    const keeping = req.body.keeping !== false;
    const participants = await radioCall.participantsOf(call.id);
    if (keeping && !radioCall.recordingAllowed(participants)) {
      const off = participants.find((p) => p.never_record);
      return res.status(409).json({
        error: 'Recording is off for this call',
        reason: 'never_record',
        blocked_by: off ? off.name : null,
      });
    }

    // kept_at is stamped on the way up and left standing on the way down: a
    // cancel is "they kept it, then stopped", and a column that erases itself
    // cannot say that.
    await pool.query(
      `UPDATE radio_call_participants
          SET kept = $3, kept_at = CASE WHEN $3 THEN NOW() ELSE kept_at END
        WHERE call_id = $1 AND user_id = $2`,
      [call.id, myId, keeping],
    );

    const [keeperName, others] = await Promise.all([
      displayName(myId),
      radioCall.othersOn(call.id, myId),
    ]);
    radioCall.announceKeep({ call, keeperName, keeping, to: others });

    res.json(await radioCall.callPayload(call, myId));
  } catch (err) { next(err); }
});

module.exports = router;
