/**
 * Friends routes
 *
 * GET    /friends                       — my friends list
 * GET    /friends/requests              — pending requests (inbound + outbound)
 * POST   /friends/requests              — send a friend request
 * POST   /friends/requests/:id/accept   — accept an inbound request
 * DELETE /friends/requests/:id          — decline or cancel a request
 * DELETE /friends/:userId               — unfriend (removes both directions atomically)
 *
 * Key invariant: friendships table stores exactly one canonical row per pair,
 * with user_id_a < user_id_b. Deleting that row ends the friendship for BOTH users
 * with zero extra work — there is no other row to clean up.
 */

const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { canonicalPair } = require('../utils/friends');

router.use(requireAuth);

// ── GET /friends ─────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const { rows } = await pool.query(
      `SELECT
         CASE WHEN f.user_id_a = $1 THEN f.user_id_b ELSE f.user_id_a END AS id,
         u.display_name,
         u.total_distance_m,
         f.created_at AS friends_since
       FROM friendships f
       JOIN users u
         ON u.id = CASE WHEN f.user_id_a = $1 THEN f.user_id_b ELSE f.user_id_a END
       WHERE f.user_id_a = $1 OR f.user_id_b = $1
       ORDER BY u.display_name`,
      [myId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /friends/requests ────────────────────────────────────────────────────

router.get('/requests', async (req, res, next) => {
  try {
    const myId = req.user.id;

    const { rows: inbound } = await pool.query(
      `SELECT fr.id, fr.from_user_id, fr.created_at, u.display_name
       FROM friend_requests fr
       JOIN users u ON u.id = fr.from_user_id
       WHERE fr.to_user_id = $1 AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [myId]
    );

    const { rows: outbound } = await pool.query(
      `SELECT fr.id, fr.to_user_id, fr.created_at, u.display_name
       FROM friend_requests fr
       JOIN users u ON u.id = fr.to_user_id
       WHERE fr.from_user_id = $1 AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [myId]
    );

    res.json({ inbound, outbound });
  } catch (err) {
    next(err);
  }
});

// ── POST /friends/requests ───────────────────────────────────────────────────
// Body: { to_user_id } OR { phone } OR { email }

router.post('/requests', async (req, res, next) => {
  try {
    const myId = req.user.id;
    let toUserId = req.body.to_user_id;

    // Allow lookup by phone or email
    if (!toUserId && (req.body.phone || req.body.email)) {
      const col = req.body.phone ? 'phone' : 'email';
      const val = req.body.phone || req.body.email;
      const { rows } = await pool.query(
        `SELECT id FROM users WHERE ${col} = $1`,
        [val]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      toUserId = rows[0].id;
    }

    if (!toUserId) return res.status(400).json({ error: 'Provide to_user_id, phone, or email' });
    if (toUserId === myId) return res.status(400).json({ error: 'Cannot friend yourself' });

    // Check not already friends
    const [a, b] = canonicalPair(myId, toUserId);
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM friendships WHERE user_id_a = $1 AND user_id_b = $2`,
      [a, b]
    );
    if (existing.length) return res.status(409).json({ error: 'Already friends' });

    // Check for existing pending request in either direction
    const { rows: pendingRows } = await pool.query(
      `SELECT id, from_user_id FROM friend_requests
       WHERE status = 'pending'
         AND ((from_user_id = $1 AND to_user_id = $2)
           OR (from_user_id = $2 AND to_user_id = $1))`,
      [myId, toUserId]
    );

    if (pendingRows.length) {
      const pending = pendingRows[0];
      // If the other person already sent us a request, auto-accept
      if (pending.from_user_id === toUserId) {
        return acceptRequest(pending.id, myId, res);
      }
      return res.status(409).json({ error: 'Request already sent' });
    }

    const { rows: [request] } = await pool.query(
      `INSERT INTO friend_requests (id, from_user_id, to_user_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [uuid(), myId, toUserId]
    );

    res.status(201).json({ request_id: request.id, status: 'pending' });
  } catch (err) {
    next(err);
  }
});

// ── POST /friends/requests/:id/accept ───────────────────────────────────────

router.post('/requests/:id/accept', async (req, res, next) => {
  try {
    await acceptRequest(req.params.id, req.user.id, res);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /friends/requests/:id ─────────────────────────────────────────────
// Used for both declining inbound and cancelling outbound requests

router.delete('/requests/:id', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const { rows } = await pool.query(
      `DELETE FROM friend_requests
       WHERE id = $1
         AND (from_user_id = $2 OR to_user_id = $2)
       RETURNING id`,
      [req.params.id, myId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Request not found' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /friends/:userId ──────────────────────────────────────────────────
// Atomically removes the canonical friendship row.
// Both users lose each other as a friend simultaneously — no second query needed.

router.delete('/:userId', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const otherId = req.params.userId;
    const [a, b] = canonicalPair(myId, otherId);

    const { rows } = await pool.query(
      `DELETE FROM friendships WHERE user_id_a = $1 AND user_id_b = $2 RETURNING *`,
      [a, b]
    );
    if (!rows.length) return res.status(404).json({ error: 'Friendship not found' });

    res.json({ unfriended: true });
  } catch (err) {
    next(err);
  }
});

// ── Shared accept helper ─────────────────────────────────────────────────────

async function acceptRequest(requestId, acceptingUserId, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM friend_requests
       WHERE id = $1 AND to_user_id = $2 AND status = 'pending'`,
      [requestId, acceptingUserId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found or not addressed to you' });
    }

    const req = rows[0];
    const [a, b] = canonicalPair(req.from_user_id, req.to_user_id);

    // Create canonical friendship row
    await client.query(
      `INSERT INTO friendships (user_id_a, user_id_b) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [a, b]
    );

    // Remove the request row (clean up, no longer needed)
    await client.query(`DELETE FROM friend_requests WHERE id = $1`, [requestId]);

    await client.query('COMMIT');
    res.json({ friended: true, friend_id: req.from_user_id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
