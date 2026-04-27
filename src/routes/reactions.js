/**
 * Reactions routes
 *
 * Push notification fired (fire-and-forget) when a user reacts to someone
 * else's post. Self-reactions and PUTs that don't change the emoji are silent.
 */

const router = require('express').Router({ mergeParams: true });
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { canonicalPair } = require('../utils/friends');
const notifications = require('../services/notifications');

router.use(requireAuth);

const MAX_EMOJI_LENGTH = 64;

function isValidEmoji(s) {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > MAX_EMOJI_LENGTH) return false;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)) return false;
  return /^[\p{Extended_Pictographic}\p{Emoji_Component}\p{Regional_Indicator}\u200D\uFE0F]+$/u.test(s);
}

router.put('/', async (req, res, next) => {
  try {
    const { emoji } = req.body;
    const myId = req.user.id;
    const postId = req.params.postId;

    if (!isValidEmoji(emoji)) {
      return res.status(400).json({ error: 'emoji must be a valid emoji character' });
    }

    const { rows: postRows } = await pool.query(
      `SELECT user_id, visibility, posted_at FROM posts WHERE id = $1`,
      [postId]
    );
    if (!postRows.length) return res.status(404).json({ error: 'Post not found' });

    const post = postRows[0];
    const canReact = post.user_id === myId
      || post.visibility === 'public'
      || await areFriends(myId, post.user_id);

    if (!canReact) return res.status(403).json({ error: 'Cannot react to this post' });

    const { rows: priorRows } = await pool.query(
      `SELECT emoji FROM reactions WHERE post_id = $1 AND user_id = $2`,
      [postId, myId]
    );
    const priorEmoji = priorRows[0]?.emoji || null;

    await pool.query(
      `INSERT INTO reactions (post_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (post_id, user_id)
       DO UPDATE SET emoji = EXCLUDED.emoji, created_at = NOW()`,
      [postId, myId, emoji]
    );

    if (post.user_id !== myId && priorEmoji !== emoji) {
      notifications.fireAndForget((async () => {
        const { rows } = await pool.query(`SELECT display_name FROM users WHERE id = $1`, [myId]);
        const reactorName = rows[0]?.display_name?.trim() || 'Someone';
        return notifications.sendToUser(post.user_id, {
          title: 'New reaction',
          body:  `${reactorName} reacted ${emoji} to your post`,
          data:  {
            type: 'reaction',
            post_id: postId,
            from_user_id: myId,
            emoji,
          },
        });
      })());
    }

    const counts = await getReactionCounts(postId);
    res.json({ reacted: true, emoji, counts });
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    await pool.query(
      `DELETE FROM reactions WHERE post_id = $1 AND user_id = $2`,
      [req.params.postId, req.user.id]
    );
    const counts = await getReactionCounts(req.params.postId);
    res.json({ removed: true, counts });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.emoji, r.user_id, r.created_at, u.display_name
       FROM reactions r
       JOIN users u ON u.id = r.user_id
       WHERE r.post_id = $1
       ORDER BY r.created_at DESC`,
      [req.params.postId]
    );

    const counts = {};
    rows.forEach(r => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
    const mine = rows.find(r => r.user_id === req.user.id)?.emoji || null;

    res.json({ counts, mine, reactions: rows });
  } catch (err) {
    next(err);
  }
});

async function areFriends(idA, idB) {
  const [a, b] = canonicalPair(idA, idB);
  const { rows } = await pool.query(
    `SELECT 1 FROM friendships WHERE user_id_a = $1 AND user_id_b = $2`,
    [a, b]
  );
  return rows.length > 0;
}

async function getReactionCounts(postId) {
  const { rows } = await pool.query(
    `SELECT emoji, COUNT(*) AS count
     FROM reactions WHERE post_id = $1
     GROUP BY emoji`,
    [postId]
  );
  const counts = {};
  rows.forEach(r => { counts[r.emoji] = parseInt(r.count); });
  return counts;
}

module.exports = router;
