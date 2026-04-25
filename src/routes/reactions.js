/**
 * Reactions routes
 *
 * PUT    /posts/:postId/reactions  — upsert reaction (change or set emoji)
 * DELETE /posts/:postId/reactions  — remove my reaction
 * GET    /posts/:postId/reactions  — list all reactions on a post
 */
const router = require('express').Router({ mergeParams: true });
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { canonicalPair } = require('../utils/friends');

router.use(requireAuth);

// Hard cap on the stored emoji string. A single complex emoji (e.g. a
// family-of-5 ZWJ sequence with skin tones) maxes out around 35 chars;
// 64 leaves headroom without allowing abuse.
const MAX_EMOJI_LENGTH = 64;

/**
 * Validates that `s` is a non-empty string consisting entirely of
 * emoji-related Unicode codepoints, with at least one actual pictograph
 * (or a flag). Rejects plain text, whitespace, and oversized payloads.
 *
 * Allowed codepoint classes:
 *   - Extended_Pictographic  (the actual emoji glyphs)
 *   - Emoji_Component        (skin tones, hair components, keycap digits)
 *   - Regional_Indicator     (the two-letter flag building blocks)
 *   - U+200D (ZWJ)           joiner for compound emojis
 *   - U+FE0F (VS16)          emoji-presentation variation selector
 */
function isValidEmoji(s) {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > MAX_EMOJI_LENGTH) return false;

  // Must contain at least one pictograph or regional indicator —
  // otherwise a bare digit like "1" would pass via Emoji_Component.
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)) return false;

  // Every codepoint must belong to one of the emoji-related classes.
  return /^[\p{Extended_Pictographic}\p{Emoji_Component}\p{Regional_Indicator}\u200D\uFE0F]+$/u.test(s);
}

// ── PUT /posts/:postId/reactions ─────────────────────────────────────────────
router.put('/', async (req, res, next) => {
  try {
    const { emoji } = req.body;
    const myId = req.user.id;
    const postId = req.params.postId;

    if (!isValidEmoji(emoji)) {
      return res.status(400).json({ error: 'emoji must be a valid emoji character' });
    }

    // Verify post exists and user can react
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

    // Upsert — if same emoji already exists, this is effectively a no-op
    await pool.query(
      `INSERT INTO reactions (post_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (post_id, user_id)
       DO UPDATE SET emoji = EXCLUDED.emoji, created_at = NOW()`,
      [postId, myId, emoji]
    );

    const counts = await getReactionCounts(postId);
    res.json({ reacted: true, emoji, counts });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /posts/:postId/reactions ─────────────────────────────────────────
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

// ── GET /posts/:postId/reactions ─────────────────────────────────────────────
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

    // Group counts by emoji
    const counts = {};
    rows.forEach(r => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });

    // Highlight the calling user's reaction
    const mine = rows.find(r => r.user_id === req.user.id)?.emoji || null;

    res.json({ counts, mine, reactions: rows });
  } catch (err) {
    next(err);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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
