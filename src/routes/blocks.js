/**
 * Block routes
 *
 * POST   /users/:id/block    — block a user
 * DELETE /users/:id/block    — unblock a user
 * GET    /blocks             — list users I've blocked
 *
 * Blocking a user also removes any existing friendship and pending
 * friend requests in either direction.
 */

const router = require('express').Router({ mergeParams: true });
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { canonicalPair } = require('../utils/friends');

router.use(requireAuth);

// POST /users/:id/block
router.post('/users/:id/block', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const myId = req.user.id;
    const targetId = req.params.id;
    if (targetId === myId) return res.status(400).json({ error: 'Cannot block yourself' });

    const { rows } = await client.query(`SELECT id FROM users WHERE id = $1`, [targetId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    await client.query('BEGIN');

    await client.query(
      `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [myId, targetId]
    );

    // Remove any existing friendship (canonical row).
    const [a, b] = canonicalPair(myId, targetId);
    await client.query(
      `DELETE FROM friendships WHERE user_id_a = $1 AND user_id_b = $2`,
      [a, b]
    );

    // Remove pending friend requests in either direction.
    await client.query(
      `DELETE FROM friend_requests
       WHERE (from_user_id = $1 AND to_user_id = $2)
          OR (from_user_id = $2 AND to_user_id = $1)`,
      [myId, targetId]
    );

    await client.query('COMMIT');
    res.json({ blocked: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /users/:id/block
router.delete('/users/:id/block', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [req.user.id, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not blocked' });
    res.json({ unblocked: true });
  } catch (err) {
    next(err);
  }
});

// GET /blocks
router.get('/blocks', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.blocked_id AS id, u.display_name, b.created_at
       FROM blocks b
       JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
