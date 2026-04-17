/**
 * Protected zones routes
 *
 * GET    /zones        — list my zones
 * POST   /zones        — add a zone (coordinates only, no address text)
 * DELETE /zones/:id    — remove a zone
 */

const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

const MAX_ZONES = 10;

// ── GET /zones ───────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, lat, lng, radius_m, created_at
       FROM protected_zones
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST /zones ──────────────────────────────────────────────────────────────
// The app resolves the address to coordinates client-side (Google Places).
// Only coordinates are sent here — no address text is ever stored.

router.post('/', async (req, res, next) => {
  try {
    const { lat, lng, radius_m = 500 } = req.body;
    const myId = req.user.id;

    if (lat == null || lng == null) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat and lng must be numbers' });
    }

    // Enforce zone limit
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS count FROM protected_zones WHERE user_id = $1`,
      [myId]
    );
    if (parseInt(countRows[0].count) >= MAX_ZONES) {
      return res.status(400).json({ error: `Maximum ${MAX_ZONES} zones allowed` });
    }

    const { rows: [zone] } = await pool.query(
      `INSERT INTO protected_zones (id, user_id, lat, lng, radius_m)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, lat, lng, radius_m, created_at`,
      [uuid(), myId, lat, lng, Math.min(radius_m, 1000)]
    );

    res.status(201).json(zone);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /zones/:id ────────────────────────────────────────────────────────

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM protected_zones WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Zone not found' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
