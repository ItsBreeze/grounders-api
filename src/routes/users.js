const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { canonicalPair } = require('../utils/friends');

router.use(requireAuth);

router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.*,
              COUNT(DISTINCT p.id) AS post_count,
              COUNT(DISTINCT f.user_id_a::text || f.user_id_b::text) AS friend_count
       FROM users u
       LEFT JOIN posts p ON p.user_id = u.id
       LEFT JOIN friendships f ON f.user_id_a = u.id OR f.user_id_b = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(sanitizeUser(rows[0]));
  } catch (err) { next(err); }
});

router.patch('/me', async (req, res, next) => {
  try {
    const { display_name } = req.body;
    if (!display_name?.trim()) {
      return res.status(400).json({ error: 'display_name is required' });
    }
    const { rows } = await pool.query(
      `UPDATE users SET display_name = $1 WHERE id = $2 RETURNING *`,
      [display_name.trim(), req.user.id]
    );
    res.json(sanitizeUser(rows[0]));
  } catch (err) { next(err); }
});

// ── GET /users/:id/friends ───────────────────────────────────────────
// Returns the target user's friends list, with an is_mutual flag per row
// indicating whether the current viewer is also friends with that person.
// MUST be declared before the generic `/:id` route below.
router.get('/:id/friends', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const targetId = req.params.id;

    const { rows } = await pool.query(
      `SELECT
         u.id,
         u.display_name,
         u.phone,
         EXISTS (
           SELECT 1 FROM friendships f2
           WHERE (f2.user_id_a = $1 AND f2.user_id_b = u.id)
              OR (f2.user_id_b = $1 AND f2.user_id_a = u.id)
         ) AS is_mutual
       FROM friendships f
       JOIN users u
         ON u.id = CASE
                     WHEN f.user_id_a = $2 THEN f.user_id_b
                     ELSE f.user_id_a
                   END
       WHERE f.user_id_a = $2 OR f.user_id_b = $2
       ORDER BY u.display_name`,
      [myId, targetId]
    );

    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const targetId = req.params.id;
    const myId = req.user.id;
    if (targetId === myId) return res.redirect('/users/me');
    const rel = await getRelationship(myId, targetId);
    if (!rel) return res.status(403).json({ error: 'Not connected to this user' });
    const { rows } = await pool.query(
      `SELECT u.*, COUNT(DISTINCT p.id) AS post_count
       FROM users u
       LEFT JOIN posts p ON p.user_id = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [targetId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ...sanitizeUser(rows[0]), relationship: rel });
  } catch (err) { next(err); }
});

async function getRelationship(myId, otherId) {
  const [a, b] = canonicalPair(myId, otherId);
  const { rows: fr } = await pool.query(
    `SELECT 1 FROM friendships WHERE user_id_a = $1 AND user_id_b = $2`, [a, b]
  );
  if (fr.length) return 'friend';
  const { rows: fof } = await pool.query(
    `SELECT 1
     FROM friendships f1
     JOIN friendships f2
       ON (f1.user_id_a = f2.user_id_a OR f1.user_id_a = f2.user_id_b
           OR f1.user_id_b = f2.user_id_a OR f1.user_id_b = f2.user_id_b)
     WHERE (f1.user_id_a = $1 OR f1.user_id_b = $1)
       AND (f2.user_id_a = $2 OR f2.user_id_b = $2)
       AND f1.user_id_a != f1.user_id_b
       AND f2.user_id_a != f2.user_id_b
     LIMIT 1`,
    [myId, otherId]
  );
  if (fof.length) return 'friend_of_friend';
  return null;
}

function sanitizeUser(u) {
  return {
    id: u.id,
    display_name: u.display_name,
    phone: u.phone,
    total_distance_m: parseFloat(u.total_distance_m) || 0,
    post_count: parseInt(u.post_count) || 0,
    friend_count: parseInt(u.friend_count) || 0,
    created_at: u.created_at,
  };
}

module.exports = router;
