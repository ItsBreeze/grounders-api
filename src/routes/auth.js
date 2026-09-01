const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { v4: uuid } = require('uuid');
const pool    = require('../db/pool');

const OTP_EXPIRY_MINUTES = parseInt(process.env.OTP_EXPIRY_MINUTES) || 10;
const OTP_EXPIRY_MS     = OTP_EXPIRY_MINUTES * 60 * 1000;
const ACCESS_EXPIRY     = process.env.ACCESS_TOKEN_EXPIRY  || '30d';
const REFRESH_EXPIRY_MS = parseInt(process.env.REFRESH_TOKEN_EXPIRY_DAYS || '365') * 86400 * 1000;

let twilioClient = null;
if (
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_PHONE_NUMBER &&
  process.env.DEV_MODE !== 'true'
) {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log('[auth] Twilio SMS enabled');
} else {
  console.log('[auth] DEV_MODE — OTP returned in response body');
}

// Email OTPs had no sender at all: request-otp generated and stored a code for
// an email target and then only ever called sendSms, so the address got
// nothing and the code sat in the table until it expired. Resend is already a
// dependency for moderation alerts, so it sends these too.
let resendClient = null;
try {
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL) {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
    console.log('[auth] Resend email OTP enabled');
  } else {
    console.log('[auth] No RESEND_API_KEY/RESEND_FROM_EMAIL — email OTP returned in response body');
  }
} catch (err) {
  console.warn('[auth] Resend init failed:', err.message);
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function issueAccessToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: ACCESS_EXPIRY });
}

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

async function storeRefreshToken(userId, token) {
  try {
    const hash = await bcrypt.hash(token, 10);
    const expiresAt = new Date(Date.now() + REFRESH_EXPIRY_MS);
    await pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
    await pool.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [uuid(), userId, hash, expiresAt]
    );
    return token;
  } catch(e) {
    console.warn('[auth] refresh_tokens table not ready:', e.message);
    return null;
  }
}

async function sendSms(phone, code, brand = 'Grounders') {
  if (!twilioClient) return;
  await twilioClient.messages.create({
    to: phone,
    from: process.env.TWILIO_PHONE_NUMBER,
    body: `${code} is your ${brand} code.`,
  });
}

async function sendEmail(email, code, brand = 'Grounders') {
  if (!resendClient) return;
  await resendClient.emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to: email,
    subject: `${code} is your ${brand} code`,
    text: `${code} is your ${brand} code. It expires in ${OTP_EXPIRY_MINUTES} minutes.`,
  });
}

// A pasted or autofilled code can carry spaces or a stray newline, and a client
// that sends JSON numbers sends 123456 rather than "123456". bcrypt.compare
// refuses a non-string outright and reads " 123456" as a different secret —
// both of which surface as "Incorrect code" to someone who typed the right
// digits. Keep the digits and discard everything else.
function normalizeCode(code) {
  return String(code ?? '').replace(/[^0-9]/g, '');
}

function sanitizeUser(u) {
  return {
    id: u.id,
    display_name: u.display_name,
    phone: u.phone,
    email: u.email,
    total_distance_m: u.total_distance_m,
    created_at: u.created_at,
  };
}

router.post('/request-otp', async (req, res, next) => {
  try {
    const { phone, email, client } = req.body;
    if (!phone && !email) return res.status(400).json({ error: 'Provide phone or email' });
    if (phone && email) return res.status(400).json({ error: 'Provide only one of phone or email' });

    // Brand the SMS body based on which front-end requested the OTP.
    // Defaults to 'Grounders' so existing clients keep their current text.
    const brand = client === 'radio' ? 'Radio' : 'Grounders';

    // Reviewer phone — pretend success without sending SMS or storing OTP.
    if (phone && process.env.APP_REVIEW_PHONE && phone === process.env.APP_REVIEW_PHONE) {
      return res.json({ message: 'OTP sent' });
    }

    const target = (phone || email).trim();
    const type   = phone ? 'phone' : 'email';
    const code   = generateOtp();
    const hash   = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

    // This used to mark every outstanding code used before inserting the new
    // one, which meant a second request-otp — a double tap, a retry after a
    // slow response, a screen that re-rendered — silently killed the code the
    // user had already received. They then typed a code that was real, arrived
    // by SMS, and no longer verified: "Incorrect code". Outstanding codes are
    // now left to expire on their own, and verify-otp accepts any of them.
    await pool.query(
      `INSERT INTO otps (id, target, code_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [uuid(), target, hash, expiresAt]
    );

    if (type === 'phone') await sendSms(target, code, brand);
    else                  await sendEmail(target, code, brand);

    // Hand the code back only when this channel has no configured sender and
    // it could not have reached anyone. The old check keyed on Twilio alone,
    // so once SMS was configured an email sign-in got neither a message nor a
    // code in the response.
    const delivered = type === 'phone' ? !!twilioClient : !!resendClient;
    const body = { message: 'OTP sent' };
    if (!delivered) body._dev_otp = code;
    res.json(body);
  } catch (err) { next(err); }
});

router.post('/verify-otp', async (req, res, next) => {
  try {
    const { phone, email, code, display_name } = req.body;
    if (!phone && !email) return res.status(400).json({ error: 'Provide phone or email' });
    if (code === undefined || code === null || code === '') {
      return res.status(400).json({ error: 'Provide code' });
    }
    const typedCode = normalizeCode(code);
    if (!typedCode) return res.status(400).json({ error: 'Provide code' });

    // ── Reviewer backdoor ─────────────────────────────────────────────
    // App Store / Play Console reviewers can't receive SMS. When the
    // request matches the reviewer env vars, mint tokens for the
    // pre-seeded reviewer user and skip the OTP table entirely. With
    // both vars unset this branch is dead code.
    if (
      process.env.APP_REVIEW_PHONE &&
      process.env.APP_REVIEW_OTP &&
      phone === process.env.APP_REVIEW_PHONE &&
      (code === process.env.APP_REVIEW_OTP || typedCode === process.env.APP_REVIEW_OTP)
    ) {
      const { rows } = await pool.query(
        `SELECT * FROM users WHERE phone = $1`,
        [phone]
      );
      if (!rows.length) {
        return res.status(500).json({ error: 'Reviewer user missing — run the migration' });
      }
      const reviewer = rows[0];
      // Clear any pending deletion in case the reviewer previously deleted.
      if (reviewer.deletion_pending_at) {
        await pool.query(
          `UPDATE users SET deletion_pending_at = NULL WHERE id = $1`,
          [reviewer.id]
        );
      }
      const accessToken  = issueAccessToken(reviewer.id);
      const refreshToken = await storeRefreshToken(reviewer.id, generateRefreshToken());
      return res.json({
        token: accessToken,
        refresh_token: refreshToken,
        user: sanitizeUser(reviewer),
        is_new: false,
      });
    }

    const target = (phone || email).trim();
    const { rows: otpRows } = await pool.query(
      `SELECT * FROM otps WHERE target = $1 AND used = false AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 5`,
      [target]
    );
    if (!otpRows.length) return res.status(401).json({ error: 'Code expired — request a new one' });

    // Any code still outstanding for this target counts, newest first, so a
    // duplicate request-otp no longer invalidates the code already in the
    // user's hand. The limiter on /auth caps this at five requests per fifteen
    // minutes, so the guessing surface stays five six-digit codes per window.
    let matchedOtp = null;
    for (const row of otpRows) {
      if (await bcrypt.compare(typedCode, row.code_hash)) { matchedOtp = row; break; }
    }
    if (!matchedOtp) return res.status(401).json({ error: 'Incorrect code' });

    // Burn every outstanding code for this target rather than only the one
    // used, so a superseded code cannot sign anyone in afterwards.
    await pool.query(`UPDATE otps SET used = true WHERE target = $1 AND used = false`, [target]);

    const col = phone ? 'phone' : 'email';
    let { rows: userRows } = await pool.query(`SELECT * FROM users WHERE ${col} = $1`, [target]);

    let user, isNew = false;
    if (userRows.length) {
      user = userRows[0];
      // Returning user signing back in cancels a pending account deletion.
      if (user.deletion_pending_at) {
        await pool.query(
          `UPDATE users SET deletion_pending_at = NULL WHERE id = $1`,
          [user.id]
        );
        user.deletion_pending_at = null;
      }
    } else {
      isNew = true;
      const name = display_name?.trim() || '';
      ({ rows: [user] } = await pool.query(
        `INSERT INTO users (id, display_name, ${col}) VALUES ($1, $2, $3) RETURNING *`,
        [uuid(), name, target]
      ));
    }

    const accessToken  = issueAccessToken(user.id);
    const refreshToken = await storeRefreshToken(user.id, generateRefreshToken());

    res.json({ token: accessToken, refresh_token: refreshToken, user: sanitizeUser(user), is_new: isNew });
  } catch (err) { next(err); }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Provide refresh_token' });

    const { rows } = await pool.query(
      `SELECT rt.*, u.* FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.expires_at > NOW()`
    );

    let matched = null;
    for (const row of rows) {
      if (await bcrypt.compare(refresh_token, row.token_hash)) { matched = row; break; }
    }

    if (!matched) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const newAccessToken  = issueAccessToken(matched.user_id);
    const newRefreshToken = await storeRefreshToken(matched.user_id, generateRefreshToken());

    res.json({
      token: newAccessToken,
      refresh_token: newRefreshToken,
      user: sanitizeUser(matched),
    });
  } catch (err) { next(err); }
});

module.exports = router;
