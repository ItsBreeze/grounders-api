    at Module.require (node:internal/modules/cjs/loader:1463:12)
    at Object.<anonymous> (/app/src/app.js:9:24)
Node.js v22.22.2
> node src/server.js
module.exports = router;const router = require('express').Router();
                              ^
SyntaxError: Identifier 'router' has already been declared
    at wrapSafe (node:internal/modules/cjs/loader:1637:18)
    at Module._compile (node:internal/modules/cjs/loader:1679:20)
    at Object..js (node:internal/modules/cjs/loader:1838:10)
    at Module.load (node:internal/modules/cjs/loader:1441:32)
    at TracingChannel.traceSync (node:diagnostics_channel:328:14)
    at wrapModuleLoad (node:internal/modules/cjs/loader:237:24)
> grounders-api@1.0.0 start
> node src/server.js
    at Object..js (node:internal/modules/cjs/loader:1838:10)
    at Module.load (node:internal/modules/cjs/loader:1441:32)
    at Function._load (node:internal/modules/cjs/loader:1263:12)
    at TracingChannel.traceSync (node:diagnostics_channel:328:14)
    at Module.require (node:internal/modules/cjs/loader:1463:12)
[auth] Twilio SMS enabled
Node.js v22.22.2
module.exports = router;const router = require('express').Router();
npm warn config production Use `--omit=dev` instead.
> grounders-api@1.0.0 start
[auth] Twilio SMS enabled
                              ^
SyntaxError: Identifier 'router' has already been declared
    at Object..js (node:internal/modules/cjs/loader:1838:10)
    at Function._load (node:internal/modules/cjs/loader:1263:12)
    at TracingChannel.traceSync (node:diagnostics_channel:328:14)
    at wrapModuleLoad (node:internal/modules/cjs/loader:237:24)
Node.js v22.22.2
> grounders-api@1.0.0 start
> node src/server.js
/app/src/routes/users.js:129
SyntaxError: Identifier 'router' has already been declared
    at Module._compile (node:internal/modules/cjs/loader:1679:20)
    at TracingChannel.traceSync (node:diagnostics_channel:328:14)
    at Object.<anonymous> (/app/src/app.js:9:24)
> node src/server.js
[auth] Twilio SMS enabled
module.exports = router;const router = require('express').Router();
    at Object..js (node:internal/modules/cjs/loader:1838:10)
    at Module.load (node:internal/modules/cjs/loader:1441:32)
    at Function._load (node:internal/modules/cjs/loader:1263:12)
> grounders-api@1.0.0 start
    at Module.require (node:internal/modules/cjs/loader:1463:12)
    at require (node:internal/modules/helpers:147:16)
    at Object.<anonymous> (/app/src/app.js:9:24)
/app/src/routes/users.js:129
    at wrapModuleLoad (node:internal/modules/cjs/loader:237:24)
    at require (node:internal/modules/helpers:147:16)
    at Object.<anonymous> (/app/src/app.js:9:24)
Node.js v22.22.2
    at Object..js (node:internal/modules/cjs/loader:1838:10)
    at Module.load (node:internal/modules/cjs/loader:1441:32)
    at Function._load (node:internal/modules/cjs/loader:1263:12)
> grounders-api@1.0.0 start
[auth] Twilio SMS enabled
/app/src/routes/users.js:129
module.exports = router;const router = require('express').Router();
    at wrapSafe (node:internal/modules/cjs/loader:1637:18)
    at Module._compile (node:internal/modules/cjs/loader:1679:20)
    at wrapModuleLoad (node:internal/modules/cjs/loader:237:24)
    at Module.require (node:internal/modules/cjs/loader:1463:12)
    at Object.<anonymous> (/app/src/app.js:9:24)
[auth] Twilio SMS enabled
/app/src/routes/users.js:129
SyntaxError: Identifier 'router' has already been declared
    at wrapSafe (node:internal/modules/cjs/loader:1637:18)
    at Module.load (node:internal/modules/cjs/loader:1441:32)
    at Function._load (node:internal/modules/cjs/loader:1263:12)
    at TracingChannel.traceSync (node:diagnostics_channel:328:14)
    at Module.require (node:internal/modules/cjs/loader:1463:12)
npm warn config production Use `--omit=dev` instead.
    at require (node:internal/modules/helpers:147:16)
Node.js v22.22.2
    at wrapSafe (node:internal/modules/cjs/loader:1637:18)const router = require('express').Router();
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

module.exports = router;const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { canonicalPair } = require('../utils/friends');

router.use(requireAuth);

router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.*,
              COUNT(DISTINCT p.id) AS post_count,
COUNT(DISTINCT f.user_id_a::text || f.user_id_b::text) AS friend_count       FROM users u
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
