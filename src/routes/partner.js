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
 * without one refuses outright rather than accepting anything. The account
 * holder can refuse that trust for their own account: users.partner_link_enabled,
 * checked below before any token is issued.
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
    //
    // `phone` is UNIQUE on the raw text but this compares digits, so one
    // person can hold two rows: "+17805550134" and "7805550134" are
    // different strings and the same number. A bare LIMIT 1 then picks
    // whichever the planner reached first, and linking the empty twin fails
    // silently — the app connects, says "Connected as", and every read comes
    // back empty because the account it is reading has nothing in it. Take
    // the account that is actually in use, and say so when there was a
    // choice to make.
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

    // The account holder's own veto, checked here — the first thing this
    // route does once it knows whose account this is, and above every later
    // branch — so that no path from a matched account to an issued token can
    // get around it.
    //
    // WHY it exists: every other way to a connector grant costs the account
    // holder a consent page they had to look at and approve. This one costs
    // them nothing they can see. The endpoint issues the grant on Offhand's
    // word that it texted a code to this number, and there is no way from
    // here to check that word — the trust is the whole design (above), so the
    // owner of the account needs some way to say "no, not even on Offhand's
    // say-so". Until recently they had no way to say it after the fact
    // either: a grant made this way was invisible from this side (nothing in
    // Grounders or ItsRadio listed it) and unrevocable from this side (only
    // Offhand's own Disconnect, calling /partner/offhand/unlink, could take
    // it back). This switch is the answer to both, which is why it is a
    // per-account column and not a server-wide setting.
    //
    // What it deliberately does NOT do: revoke a grant that already exists.
    // A refresh token already issued keeps rotating at /oauth/token, which
    // never reads this column. Turning the switch off stops the NEXT link;
    // it does not cut a live one. To cut a live one: Disconnect in Offhand
    // (POST /partner/offhand/unlink), or delete the Grounders account, whose
    // cascade takes oauth_refresh_tokens with it. The reason is that
    // flipping a settings toggle should not silently break the assistant
    // someone is still using — a revocation should be an act, not a
    // side effect.
    //
    // Read across EVERY row that holds these digits, not only the one this
    // route is about to link. One person can hold two rows (above) and is
    // signed in to just one of them, so the refusal they recorded there has
    // to count even when the row the ordering picks is the other one.
    //
    // `=== false` rather than `!r.partner_link_enabled`: on a server whose
    // migration has not run yet the column is absent, and undefined there
    // means "nobody has refused", not "everybody has".
    if (rows.some((r) => r.partner_link_enabled === false)) {
      return res.status(403).json({ error: 'link_disabled' });
    }

    if (rows.length > 1) {
      // Worth knowing about: two rows hold one person's number in two
      // formats, so something upstream is not normalising on write.
      console.warn(
        '[partner] %d accounts share these phone digits; linked %s',
        rows.length, user.id,
      );
    }
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
