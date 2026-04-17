/**
 * Auth routes
 *
 * POST /auth/request-otp   — send a 6-digit OTP to phone or email
 * POST /auth/verify-otp    — verify OTP, create user if new, return JWT
 *
 * In DEV_MODE the OTP is returned directly in the response instead of
 * being sent via SMS/email, so you can test without a provider configured.
 */

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');

const OTP_EXPIRY_MS = (parseInt(process.env.OTP_EXPIRY_MINUTES) || 10) * 60 * 1000;

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function issueToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

/**
 * In production replace this with Twilio (SMS) / SendGrid (email).
 * Returns the code so DEV_MODE can echo it back.
 */
async function sendOtp(target, code, type) {
  if (process.env.DEV_MODE === 'true') {
    console.log(`[DEV] OTP for ${target}: ${code}`);
    return; // will be returned in response body
  }
  if (type === 'phone') {
    // await twilioClient.messages.create({ to: target, from: ..., body: `Your Grounders code: ${code}` });
  } else {
    // await sendgrid.send({ to: target, subject: 'Your Grounders code', text: `Code: ${code}` });
  }
}

// ── POST /auth/request-otp ──────────────────────────────────────────────────

router.post('/request-otp', async (req, res, next) => {
  try {
    const { phone, email } = req.body;

    if (!phone && !email) {
      return res.status(400).json({ error: 'Provide phone or email' });
    }
    if (phone && email) {
      return res.status(400).json({ error: 'Provide only one of phone or email' });
    }

    const target = phone || email;
    const type = phone ? 'phone' : 'email';
    const code = generateOtp();
    const hash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

    // Invalidate any previous unused OTPs for this target
    await pool.query(
      `UPDATE otps SET used = true WHERE target = $1 AND used = false`,
      [target]
    );

    await pool.query(
      `INSERT INTO otps (id, target, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [uuid(), target, hash, expiresAt]
    );

    await sendOtp(target, code, type);

    const body = { message: 'OTP sent' };
    if (process.env.DEV_MODE === 'true') body._dev_otp = code;

    res.json(body);
  } catch (err) {
    next(err);
  }
});

// ── POST /auth/verify-otp ───────────────────────────────────────────────────

router.post('/verify-otp', async (req, res, next) => {
  try {
    const { phone, email, code, display_name } = req.body;

    if (!phone && !email) return res.status(400).json({ error: 'Provide phone or email' });
    if (!code) return res.status(400).json({ error: 'Provide code' });

    const target = phone || email;

    // Find the most recent valid OTP
    const { rows: otpRows } = await pool.query(
      `SELECT * FROM otps
       WHERE target = $1 AND used = false AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [target]
    );

    if (!otpRows.length) {
      return res.status(401).json({ error: 'No valid OTP found — request a new one' });
    }

    const otp = otpRows[0];
    const valid = await bcrypt.compare(code, otp.code_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Incorrect code' });
    }

    // Mark OTP used
    await pool.query(`UPDATE otps SET used = true WHERE id = $1`, [otp.id]);

    // Upsert user — create on first login, return existing on subsequent
    const col = phone ? 'phone' : 'email';
    let { rows: userRows } = await pool.query(
      `SELECT * FROM users WHERE ${col} = $1`,
      [target]
    );

    let user;
    let isNew = false;

    if (userRows.length) {
      user = userRows[0];
    } else {
      isNew = true;
      const name = display_name?.trim() || '';
      ({ rows: [user] } = await pool.query(
        `INSERT INTO users (id, display_name, ${col})
         VALUES ($1, $2, $3)
         RETURNING *`,
        [uuid(), name, target]
      ));
    }

    const token = issueToken(user.id);
    res.json({ token, user: sanitizeUser(user), is_new: isNew });
  } catch (err) {
    next(err);
  }
});

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

module.exports = router;
