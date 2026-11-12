/**
 * The Edict link: Radio inside Edict, the owner's Android voice launcher,
 * without a second sign-in on the phone.
 *
 * Signing in to Radio a second time from Edict would sign the ItsRadio app
 * out: this API keeps one refresh token per account (routes/auth.js
 * storeRefreshToken) and replaces it on every sign-in. So Edict's PC, which
 * already holds the phone's trust, asks here under its own key for an app
 * access token for the owner's number and hands it to the phone. What comes
 * back is what /auth/verify-otp's `token` is — a JWT the app's own routes
 * accept (/radio, /friends, /invites, /users/me) — with a 30-day life and no
 * refresh token. Edict renews it by calling this again; nothing here reads or
 * writes refresh_tokens, or writes anything at all.
 *
 * Unlike Offhand's link (routes/partner.js), nobody texted a code to this
 * number first: the trust is "the key holder is the owner". That trust only
 * reaches the owner's own account, so the number is pinned on the server too
 * (EDICT_LINK_PHONE). A leaked key opens that one account, never anyone
 * else's. The account holder's veto is the same switch Offhand's link honours
 * (users.partner_link_enabled), read across every row holding the number.
 *
 * Linking never creates an account, and an account pending deletion is
 * refused. See EDICT-LINK.md.
 */

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { phoneFrom } = require('../utils/phone');

const router = express.Router();

const CLIENT = 'edict';
const TOKEN_DAYS = 30;
// Anything shorter than this is a placeholder, not a secret.
const MIN_KEY_LENGTH = 32;

const digits = (p) => String(p || '').replace(/\D/g, '');

function requireEdictKey(req, res, next) {
  const expected = process.env.EDICT_PARTNER_KEY || '';
  const pinned = phoneFrom(process.env.EDICT_LINK_PHONE);
  if (expected.length < MIN_KEY_LENGTH || !pinned) {
    return res.status(503).json({
      error: 'partner_unconfigured',
      error_description: 'EDICT_PARTNER_KEY and EDICT_LINK_PHONE must both be set on this server',
    });
  }
  const header = req.get('Authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.edictPhone = pinned;
  next();
}

// POST /partner/edict/link  { phone } -> { token, expires_at, user: { id, display_name } }
router.post('/partner/edict/link', requireEdictKey, async (req, res, next) => {
  try {
    const phone = phoneFrom(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ error: 'invalid_phone' });
    if (digits(phone) !== digits(req.edictPhone)) return res.status(403).json({ error: 'phone_not_allowed' });

    // Digits only, and the account in use first: one number can sit in two
    // rows in two formats (routes/partner.js says why).
    const { rows } = await pool.query(
      `SELECT u.id, u.display_name, u.deletion_pending_at, u.partner_link_enabled
         FROM users u
        WHERE regexp_replace(u.phone, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g')
        ORDER BY u.last_post_at DESC NULLS LAST,
                 u.total_distance_m DESC,
                 u.created_at ASC`,
      [phone],
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'no_account' });
    // `=== false`: a row from before the column existed has not refused.
    if (rows.some((r) => r.partner_link_enabled === false)) return res.status(403).json({ error: 'link_disabled' });
    if (user.deletion_pending_at) return res.status(403).json({ error: 'account_closing' });

    const token = jwt.sign({ sub: user.id, client: CLIENT }, process.env.JWT_SECRET, { expiresIn: `${TOKEN_DAYS}d` });
    const { exp } = jwt.decode(token);
    res.json({
      token,
      expires_at: new Date(exp * 1000).toISOString(),
      user: { id: user.id, display_name: user.display_name || '' },
    });
  } catch (err) { next(err); }
});

module.exports = router;
