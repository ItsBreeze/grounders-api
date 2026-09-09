/**
 * The Offhand partner link: Grounders + Radio built into Offhand's own
 * assistant, without a second sign-in.
 *
 * Offhand signs its users in with the same phone-code flow this API does, so
 * a person who uses both has already proven their number once. Rather than
 * send them through the OAuth consent page again inside their own app,
 * Offhand's server asks here — under a shared key — for a connector token for
 * a phone it has verified. What comes back is exactly what the consent page
 * would have issued: a refresh token for the `offhand` client, redeemable at
 * /oauth/token, whose access tokens open /mcp and nothing else. Every read
 * then goes through the same tools, with the same visibility rules, as any
 * other assistant's.
 *
 * The one trust decision — "Offhand verified this phone" — lives in this file
 * and nowhere else. The key is compared in constant time, and a server
 * without one refuses outright rather than accepting anything.
 *
 * Linking never creates an account, and an account pending deletion is
 * refused, for the same reasons the consent page has (MCP-CONNECTOR.md).
 */

const crypto = require('crypto');
const express = require('express');
const pool = require('../db/pool');
const oauth = require('../services/mcp_oauth');
const { phoneFrom } = require('../utils/phone');

const router = express.Router();

const CLIENT_ID = 'offhand';
const CLIENT_NAME = 'Offhand';

// Anything shorter than this is a placeholder, not a secret.
const MIN_KEY_LENGTH = 32;

function requirePartnerKey(req, res, next) {
  const expected = process.env.OFFHAND_PARTNER_KEY || '';
  if (expected.length < MIN_KEY_LENGTH) {
    return res.status(503).json({
      error: 'partner_unconfigured',
      error_description: 'OFFHAND_PARTNER_KEY is not set on this server',
    });
  }
  const header = req.get('Authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// POST /partner/offhand/link  { phone } -> connector tokens for that account
router.post('/partner/offhand/link', requirePartnerKey, async (req, res, next) => {
  try {
    const phone = phoneFrom(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ error: 'invalid_phone' });

    // Match the way the app does (digits only, so formatting never matters),
    // and never create an account here.
    const { rows } = await pool.query(
      `SELECT id, display_name, deletion_pending_at FROM users
        WHERE regexp_replace(phone, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g')
        LIMIT 1`,
      [phone],
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'no_account' });
    // Signing in to the app cancels a pending deletion; a link from another
    // app should not quietly do the same.
    if (user.deletion_pending_at) return res.status(403).json({ error: 'account_closing' });

    await oauth.ensureClient({ clientId: CLIENT_ID, clientName: CLIENT_NAME });
    const tokens = await oauth.issueTokens({ userId: user.id, clientId: CLIENT_ID });

    // No phone, no email, no id — the display name is all Offhand needs to
    // show "Connected as Sam".
    res.json({ ...tokens, client_id: CLIENT_ID, user: { display_name: user.display_name || '' } });
  } catch (err) { next(err); }
});

// POST /partner/offhand/unlink  { refresh_token } -> 204
// Offhand calls this when the user disconnects (or deletes their Offhand
// account), so the grant does not outlive the link.
router.post('/partner/offhand/unlink', requirePartnerKey, async (req, res, next) => {
  try {
    const token = req.body && req.body.refresh_token;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'refresh_token is required' });
    }
    await oauth.revokeRefreshToken({ refreshToken: token, clientId: CLIENT_ID });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
