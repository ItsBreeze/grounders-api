/**
 * Friends routes
 *
 * Push notifications fired (fire-and-forget) on:
 *   - new request → recipient
 *   - accept       → original sender
 */

const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { canonicalPair } = require('../utils/friends');
const notifications = require('../services/notifications');

router.use(requireAuth);

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

router.post('/requests', async (req, res, next) => {
  try {
    const myId = req.user.id;
    let toUserId = req.body.to_user_id;

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

    const [a, b] = canonicalPair(myId, toUserId);
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM friendships WHERE user_id_a = $1 AND user_id_b = $2`,
      [a, b]
    );
    if (existing.length) return res.status(409).json({ error: 'Already friends' });

    const { rows: pendingRows } = await pool.query(
      `SELECT id, from_user_id FROM friend_requests
       WHERE status = 'pending'
         AND ((from_user_id = $1 AND to_user_id = $2)
           OR (from_user_id = $2 AND to_user_id = $1))`,
      [myId, toUserId]
    );

    if (pendingRows.length) {
      const pending = pendingRows[0];
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

    notifications.fireAndForget((async () => {
      const { rows } = await pool.query(`SELECT display_name FROM users WHERE id = $1`, [myId]);
      const senderName = rows[0]?.display_name?.trim() || 'Someone';
      return notifications.sendToUser(toUserId, {
        title: 'New friend request',
        body:  `${senderName} wants to be friends`,
        data:  {
          type: 'friend_request',
          request_id: request.id,
          from_user_id: myId,
        },
      });
    })());

    res.status(201).json({ request_id: request.id, status: 'pending' });
  } catch (err) {
    next(err);
  }
});

router.post('/requests/:id/accept', async (req, res, next) => {
  try {
    await acceptRequest(req.params.id, req.user.id, res);
  } catch (err) {
    next(err);
  }
});

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

    const fr = rows[0];
    const [a, b] = canonicalPair(fr.from_user_id, fr.to_user_id);

    await client.query(
      `INSERT INTO friendships (user_id_a, user_id_b) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [a, b]
    );
    await client.query(`DELETE FROM friend_requests WHERE id = $1`, [requestId]);

    await client.query('COMMIT');

    notifications.fireAndForget((async () => {
      const { rows } = await pool.query(`SELECT display_name FROM users WHERE id = $1`, [acceptingUserId]);
      const accepterName = rows[0]?.display_name?.trim() || 'Someone';
      return notifications.sendToUser(fr.from_user_id, {
        title: 'Friend request accepted',
        body:  `You and ${accepterName} are now friends`,
        data:  {
          type: 'friend_accepted',
          user_id: acceptingUserId,
        },
      });
    })());

    res.json({ friended: true, friend_id: fr.from_user_id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
