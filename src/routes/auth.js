const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { v4: uuid } = require('uuid');
const pool    = require('../db/pool');

const OTP_EXPIRY_MS     = (parseInt(process.env.OTP_EXPIRY_MINUTES) || 10) * 60 * 1000;
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

    const target = phone || email;
    const type   = phone ? 'phone' : 'email';
    const code   = generateOtp();
    const hash   = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

    await pool.query(`UPDATE otps SET used = true WHERE target = $1 AND used = false`, [target]);
    await pool.query(
      `INSERT INTO otps (id, target, code_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [uuid(), target, hash, expiresAt]
    );

    if (type === 'phone') await sendSms(target, code, brand);

    const body = { message: 'OTP sent' };
    if (!twilioClient) body._dev_otp = code;
    res.json(body);
  } catch (err) { next(err); }
});

router.post('/verify-otp', async (req, res, next) => {
  try {
    const { phone, email, code, display_name } = req.body;
    if (!phone && !email) return res.status(400).json({ error: 'Provide phone or email' });
    if (!code) return res.status(400).json({ error: 'Provide code' });

    // ── Reviewer backdoor ─────────────────────────────────────────────
    // App Store / Play Console reviewers can't receive SMS. When the
    // request matches the reviewer env vars, mint tokens for the
    // pre-seeded reviewer user and skip the OTP table entirely. With
    // both vars unset this branch is dead code.
    if (
      process.env.APP_REVIEW_PHONE &&
      process.env.APP_REVIEW_OTP &&
      phone === process.env.APP_REVIEW_PHONE &&
      code === process.env.APP_REVIEW_OTP
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

    const target = phone || email;
    const { rows: otpRows } = await pool.query(
      `SELECT * FROM otps WHERE target = $1 AND used = false AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [target]
    );
    if (!otpRows.length) return res.status(401).json({ error: 'Code expired — request a new one' });

    const valid = await bcrypt.compare(code, otpRows[0].code_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect code' });

    await pool.query(`UPDATE otps SET used = true WHERE id = $1`, [otpRows[0].id]);

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
