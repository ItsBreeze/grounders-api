/**
 * Report routes
 *
 * POST /posts/:id/report — file a report on a post.
 *
 * Required by App Store / Play Console for any app with user-generated
 * content. The report row lands first; the email alert is fire-and-forget.
 */

const router = require('express').Router({ mergeParams: true });
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { notifyModeration } = require('../services/moderation');

router.use(requireAuth);

router.post('/:id/report', async (req, res, next) => {
  try {
    const { reason, details } = req.body || {};
    if (typeof reason !== 'string' || reason.length === 0 || reason.length > 200) {
      return res.status(400).json({ error: 'reason is required (1–200 chars)' });
    }
    if (details !== undefined && details !== null &&
        (typeof details !== 'string' || details.length > 2000)) {
      return res.status(400).json({ error: 'details must be a string under 2000 chars' });
    }

    // Confirm the post exists. 404 silently — pretend success either
    // way so spam reporters can't probe for valid IDs.
    const post = await pool.query(
      `SELECT id, user_id FROM posts WHERE id = $1`,
      [req.params.id]
    );
    if (!post.rows.length) {
      return res.json({ reported: true });
    }

    const { rows } = await pool.query(
      `INSERT INTO reports (post_id, reporter_id, reason, details)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at`,
      [req.params.id, req.user.id, reason, details || null]
    );

    notifyModeration({
      reportId: rows[0].id,
      postId: req.params.id,
      postOwnerId: post.rows[0].user_id,
      reporterId: req.user.id,
      reason,
      details,
    }).catch(err => console.warn('[report] alert failed:', err.message));

    res.json({ reported: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
