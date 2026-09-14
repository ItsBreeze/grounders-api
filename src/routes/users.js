const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { canonicalPair } = require('../utils/friends');

router.use(requireAuth);

// GET /users/lookup?phone=+17801234567
// Resolve a phone number to a user. Matches by digits only so "+1 780 …",
// "17801234567", etc. all map to the same row. 404 when no account exists
// (client can then offer to send an SMS invite).
router.get('/lookup', async (req, res, next) => {
  try {
    const phoneRaw = (req.query.phone || '').toString();
    const digits = phoneRaw.replace(/\D/g, '');
    if (digits.length < 10) return res.status(400).json({ error: 'Invalid phone' });
    const { rows } = await pool.query(
      `SELECT id, display_name, phone
         FROM users
        WHERE regexp_replace(phone, '\\D', '', 'g')
            = regexp_replace($1, '\\D', '', 'g')
        LIMIT 1`,
      [digits]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

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
    res.json(sanitizeSelf(rows[0]));
  } catch (err) { next(err); }
});

// PATCH /users/me — display_name, the partner-link switch, and the calling
// opt-out. Every field is optional on its own and what is absent is left as
// it was; a body with none of them is the 400 it always was.
router.patch('/me', async (req, res, next) => {
  try {
    const { display_name, partner_link_enabled, radio_never_record } = req.body || {};
    if (display_name === undefined
      && partner_link_enabled === undefined
      && radio_never_record === undefined) {
      return res.status(400).json({ error: 'display_name is required' });
    }

    const sets = [];
    const params = [];
    if (display_name !== undefined) {
      if (!display_name?.trim()) {
        return res.status(400).json({ error: 'display_name is required' });
      }
      params.push(display_name.trim());
      sets.push(`display_name = $${params.length}`);
    }
    if (partner_link_enabled !== undefined) {
      // A string "false" arriving from a sloppy client must not read as
      // true and quietly leave the switch on.
      if (typeof partner_link_enabled !== 'boolean') {
        return res.status(400).json({ error: 'partner_link_enabled must be a boolean' });
      }
      params.push(partner_link_enabled);
      sets.push(`partner_link_enabled = $${params.length}`);
    }
    if (radio_never_record !== undefined) {
      // The same strictness, for the same reason, and it matters more here:
      // a "false" string read as true would silently switch someone's calls
      // back on. Both clients enforce this flag from the token response, so
      // the value written here is the one that decides whether anybody on a
      // call records at all.
      if (typeof radio_never_record !== 'boolean') {
        return res.status(400).json({ error: 'radio_never_record must be a boolean' });
      }
      params.push(radio_never_record);
      sets.push(`radio_never_record = $${params.length}`);
    }

    params.push(req.user.id);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json(sanitizeSelf(rows[0]));
  } catch (err) { next(err); }
});

// DELETE /users/me — soft-delete with 14-day grace period.
// Required by Apple guideline 5.1.1(v). Reaper hard-deletes after 14 days.
// Signing back in clears deletion_pending_at (see auth.js).
router.delete('/me', async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE users
          SET deletion_pending_at = NOW()
        WHERE id = $1
          AND deletion_pending_at IS NULL`,
      [req.user.id]
    );
    // Wipe device tokens immediately — no more pushes.
    await pool.query(
      `DELETE FROM device_tokens WHERE user_id = $1`,
      [req.user.id]
    );
    // Wipe refresh tokens — JWT can still be used until expiry,
    // but they can't refresh it.
    await pool.query(
      `DELETE FROM refresh_tokens WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ deleted: true, hard_delete_in_days: 14 });
  } catch (err) { next(err); }
});

// GET /users/:id/friends — must come before generic /:id route.
// Returns id, display_name and is_mutual only. Phone numbers stay out: any
// user can call this for any target, and the client never reads them here.
router.get('/:id/friends', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const targetId = req.params.id;
    const { rows } = await pool.query(
      `SELECT
         u.id,
         u.display_name,
         EXISTS (
           SELECT 1 FROM friendships f2
           WHERE (f2.user_id_a = $1 AND f2.user_id_b = u.id)
              OR (f2.user_id_b = $1 AND f2.user_id_a = u.id)
         ) AS is_mutual
       FROM friendships f
       JOIN users u
         ON u.id = CASE WHEN f.user_id_a = $2 THEN f.user_id_b ELSE f.user_id_a END
       WHERE (f.user_id_a = $2 OR f.user_id_b = $2)
         AND u.deletion_pending_at IS NULL
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

// The owner's own view of their row: the public shape plus the settings only
// they may see or change. Deliberately not folded into sanitizeUser, so
// GET /users/:id does not report whether somebody else accepts partner links.
function sanitizeSelf(u) {
  return {
    ...sanitizeUser(u),
    // NOT NULL DEFAULT TRUE in the schema, so this is always a boolean from a
    // migrated database; the coercion only covers a row read by a server
    // whose migration has not run yet, where absent means "not refused".
    partner_link_enabled: u.partner_link_enabled !== false,
    // NOT NULL DEFAULT false, so the coercion only covers a row read before
    // the migration lands — where absent means "has not opted out", which is
    // the same answer the column gives.
    radio_never_record: u.radio_never_record === true,
  };
}

module.exports = router;
