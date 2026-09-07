/**
 * Device token routes — register/unregister FCM tokens.
 *
 * POST   /devices              — register or refresh a token
 * DELETE /devices/:token       — unregister a specific token
 * DELETE /devices              — unregister ALL tokens for the current user
 */

const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

const VALID_PLATFORMS = ['ios', 'android', 'web'];
// Which client registered the token. Older builds send nothing and are
// treated as the main Grounders app.
const VALID_APPS = ['grounders', 'radio'];

router.post('/', async (req, res, next) => {
  try {
    const { token, platform } = req.body;
    const app = VALID_APPS.includes(req.body.app) ? req.body.app : 'grounders';

    if (!token || typeof token !== 'string' || token.length < 20 || token.length > 4096) {
      return res.status(400).json({ error: 'token is required (string, 20–4096 chars)' });
    }
    if (!VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: 'platform must be ios, android, or web' });
    }

    await pool.query(
      `INSERT INTO device_tokens (token, user_id, platform, app)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token)
       DO UPDATE SET user_id      = EXCLUDED.user_id,
                     platform     = EXCLUDED.platform,
                     app          = EXCLUDED.app,
                     last_seen_at = NOW()`,
      [token, req.user.id, platform, app]
    );

    res.status(201).json({ registered: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:token', async (req, res, next) => {
  try {
    await pool.query(
      `DELETE FROM device_tokens WHERE token = $1 AND user_id = $2`,
      [req.params.token, req.user.id]
    );
    res.json({ unregistered: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    await pool.query(
      `DELETE FROM device_tokens WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ unregistered: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
