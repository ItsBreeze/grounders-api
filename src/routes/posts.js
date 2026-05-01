const router = require('express').Router({ mergeParams: true });
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { haversineMetres } = require('../utils/geo');
const { canonicalPair } = require('../utils/friends');
const notifications = require('../services/notifications');

router.use(requireAuth);

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      type, media_url, media_thumb_url, description, audio_title,
      lat, lng, visibility = 'friends', captured_at,
      attestation_token, attestation_data,
    } = req.body;

    if (!['photo', 'video', 'audio'].includes(type))
      return res.status(400).json({ error: 'type must be photo, video, or audio' });
    if (!media_url) return res.status(400).json({ error: 'media_url is required' });
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng are required' });
    if (!captured_at) return res.status(400).json({ error: 'captured_at is required' });
    if (type === 'audio' && !audio_title?.trim())
      return res.status(400).json({ error: 'audio_title is required for audio posts' });
    if (!['friends', 'public'].includes(visibility))
      return res.status(400).json({ error: 'visibility must be friends or public' });

    const userId = req.user.id;
    await client.query('BEGIN');

    const postId = uuid();
    const { rows: [post] } = await client.query(
      `INSERT INTO posts
         (id, user_id, type, media_url, media_thumb_url, description,
          audio_title, lat, lng, visibility, captured_at, attestation_token, attestation_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [postId, userId, type, media_url, media_thumb_url || null,
       description || null, audio_title?.trim() || null,
       parseFloat(lat), parseFloat(lng), visibility, new Date(captured_at),
       attestation_token || null, attestation_data ? JSON.stringify(attestation_data) : null]
    );

    const { rows: [user] } = await client.query(
      `SELECT display_name, last_post_lat, last_post_lng, total_distance_m FROM users WHERE id = $1`,
      [userId]
    );

    let addedDistance = 0;
    if (user.last_post_lat != null && user.last_post_lng != null) {
      addedDistance = haversineMetres(
        user.last_post_lat, user.last_post_lng, parseFloat(lat), parseFloat(lng)
      );
    }

    await client.query(
      `UPDATE users SET total_distance_m = total_distance_m + $1,
       last_post_lat = $2, last_post_lng = $3, last_post_at = NOW() WHERE id = $4`,
      [addedDistance, parseFloat(lat), parseFloat(lng), userId]
    );

    await client.query('COMMIT');

    notifications.fireAndForget((async () => {
      const { rows: friendRows } = await pool.query(
        `SELECT CASE WHEN user_id_a = $1 THEN user_id_b ELSE user_id_a END AS friend_id
         FROM friendships WHERE user_id_a = $1 OR user_id_b = $1`,
        [userId]
      );
      if (!friendRows.length) return;
      const friendIds = friendRows.map(r => r.friend_id);
      const posterName = user.display_name?.trim() || 'A friend';
      const bodyByType = {
        photo: 'just shared a photo',
        video: 'just shared a video',
        audio: 'just shared audio',
      };
      return notifications.sendToUsers(friendIds, {
        title: 'New post',
        body:  `${posterName} ${bodyByType[type]}`,
        data:  {
          type: 'new_post',
          post_id: postId,
          from_user_id: userId,
          post_type: type,
        },
      });
    })());

    res.status(201).json(formatPost(post));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.get('/', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before ? new Date(req.query.before) : new Date();
    const visFilter = req.query.visibility || 'all';

    let latMin, lngMin, latMax, lngMax;
    if (req.query.bbox) {
      [latMin, lngMin, latMax, lngMax] = req.query.bbox.split(',').map(parseFloat);
    }

    const { rows: friendRows } = await pool.query(
      `SELECT CASE WHEN user_id_a = $1 THEN user_id_b ELSE user_id_a END AS friend_id
       FROM friendships WHERE user_id_a = $1 OR user_id_b = $1`, [myId]
    );
    const visibleUserIds = [myId, ...friendRows.map(r => r.friend_id)];

    const conditions = [
      `p.posted_at < $1`,
      `(p.user_id = ANY($2) OR p.visibility = 'public')`,
      `p.archived_at IS NULL`,
      // Hide posts by users who blocked me OR who I've blocked.
      `NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE (b.blocker_id = $3 AND b.blocked_id = p.user_id)
           OR (b.blocked_id = $3 AND b.blocker_id = p.user_id)
      )`,
      // Hide posts by users pending deletion.
      `NOT EXISTS (
        SELECT 1 FROM users u WHERE u.id = p.user_id AND u.deletion_pending_at IS NOT NULL
      )`,
    ];
    const params = [before, visibleUserIds, myId];
    let pIdx = 4;

    if (latMin != null) {
      conditions.push(`p.lat BETWEEN $${pIdx} AND $${pIdx + 1}`);
      conditions.push(`p.lng BETWEEN $${pIdx + 2} AND $${pIdx + 3}`);
      params.push(latMin, latMax, lngMin, lngMax);
      pIdx += 4;
    }

    if (visFilter === 'friends') conditions.push(`p.visibility = 'friends'`);
    else if (visFilter === 'public') conditions.push(`p.visibility = 'public'`);

    const sql = `
      SELECT p.*, u.display_name, COUNT(r.user_id) AS reaction_count
      FROM posts p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN reactions r ON r.post_id = p.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY p.id, u.display_name
      ORDER BY p.posted_at DESC
      LIMIT $${pIdx}
    `;
    params.push(limit);

    const { rows } = await pool.query(sql, params);
    res.json(rows.map(formatPost));
  } catch (err) {
    next(err);
  }
});

router.get('/by-user/:userId', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const targetId = req.params.userId;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before ? new Date(req.query.before) : new Date();

    // Block check.
    const { rows: blockRows } = await pool.query(
      `SELECT 1 FROM blocks
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)`,
      [myId, targetId]
    );
    if (blockRows.length) return res.status(404).json({ error: 'User not found' });

    // Pending-deletion check.
    const { rows: delRows } = await pool.query(
      `SELECT 1 FROM users WHERE id = $1 AND deletion_pending_at IS NOT NULL`,
      [targetId]
    );
    if (delRows.length) return res.status(404).json({ error: 'User not found' });

    const friend = targetId === myId || await areFriends(myId, targetId);
    const visCondition = friend ? `p.visibility IN ('friends','public')` : `p.visibility = 'public'`;

    const { rows } = await pool.query(
      `SELECT p.*, u.display_name, COUNT(r.user_id) AS reaction_count
       FROM posts p JOIN users u ON u.id = p.user_id
       LEFT JOIN reactions r ON r.post_id = p.id
       WHERE p.user_id = $1 AND ${visCondition}
         AND p.posted_at < $2 AND p.archived_at IS NULL
       GROUP BY p.id, u.display_name
       ORDER BY p.posted_at DESC LIMIT $3`,
      [targetId, before, limit]
    );

    res.json(rows.map(formatPost));
  } catch (err) {
    next(err);
  }
});

// ─── Archive ─────────────────────────────────────────────────────────
// Per-user soft-delete bin. Routes must be registered BEFORE `/:id` so
// the literal `/archived` path doesn't get captured by the UUID slot.

router.get('/archived', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, u.display_name, COUNT(r.user_id) AS reaction_count
       FROM posts p JOIN users u ON u.id = p.user_id
       LEFT JOIN reactions r ON r.post_id = p.id
       WHERE p.user_id = $1 AND p.archived_at IS NOT NULL
       GROUP BY p.id, u.display_name
       ORDER BY p.archived_at DESC`,
      [req.user.id]
    );
    res.json(rows.map(formatPost));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/archive', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE posts SET archived_at = NOW()
       WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Post not found or not yours' });
    res.json({ archived: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/unarchive', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE posts SET archived_at = NULL
       WHERE id = $1 AND user_id = $2 AND archived_at IS NOT NULL`,
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Post not found or not archived' });
    res.json({ unarchived: true });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const { rows } = await pool.query(
      `SELECT p.*, u.display_name, COUNT(r.user_id) AS reaction_count
       FROM posts p JOIN users u ON u.id = p.user_id
       LEFT JOIN reactions r ON r.post_id = p.id
       WHERE p.id = $1 GROUP BY p.id, u.display_name`,
      [req.params.id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Post not found' });
    const post = rows[0];

    // Block check.
    const { rows: blockRows } = await pool.query(
      `SELECT 1 FROM blocks
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)`,
      [myId, post.user_id]
    );
    if (blockRows.length) return res.status(404).json({ error: 'Post not found' });

    const canView = post.user_id === myId
      || post.visibility === 'public'
      || await areFriends(myId, post.user_id);

    if (!canView) return res.status(403).json({ error: 'Not authorised' });

    const { rows: rxRows } = await pool.query(
      `SELECT r.emoji, r.user_id, u.display_name FROM reactions r
       JOIN users u ON u.id = r.user_id WHERE r.post_id = $1`, [post.id]
    );

    res.json({ ...formatPost(post), reactions: rxRows });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const myId = req.user.id;
    const { rows } = await client.query(
      `SELECT * FROM posts WHERE id = $1 AND user_id = $2`, [req.params.id, myId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Post not found or not yours' });

    await client.query('BEGIN');
    await client.query(`DELETE FROM posts WHERE id = $1`, [req.params.id]);

    const { rows: remaining } = await client.query(
      `SELECT lat, lng, posted_at FROM posts WHERE user_id = $1 ORDER BY posted_at ASC`, [myId]
    );

    let totalDist = 0;
    for (let i = 1; i < remaining.length; i++) {
      totalDist += haversineMetres(
        remaining[i-1].lat, remaining[i-1].lng, remaining[i].lat, remaining[i].lng
      );
    }

    const last = remaining[remaining.length - 1];
    await client.query(
      `UPDATE users SET total_distance_m=$1, last_post_lat=$2, last_post_lng=$3, last_post_at=$4 WHERE id=$5`,
      [totalDist, last?.lat ?? null, last?.lng ?? null, last?.posted_at ?? null, myId]
    );

    await client.query('COMMIT');
    res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

async function areFriends(idA, idB) {
  const [a, b] = canonicalPair(idA, idB);
  const { rows } = await pool.query(
    `SELECT 1 FROM friendships WHERE user_id_a = $1 AND user_id_b = $2`, [a, b]
  );
  return rows.length > 0;
}

function formatPost(p) {
  return {
    id: p.id,
    user_id: p.user_id,
    display_name: p.display_name,
    type: p.type,
    media_url: p.media_url,
    media_thumb_url: p.media_thumb_url,
    description: p.description,
    audio_title: p.audio_title,
    lat: parseFloat(p.lat),
    lng: parseFloat(p.lng),
    visibility: p.visibility,
    captured_at: p.captured_at,
    posted_at: p.posted_at,
    reaction_count: parseInt(p.reaction_count) || 0,
  };
}

module.exports = router;
