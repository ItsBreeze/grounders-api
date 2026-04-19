/**
 * Auth routes
 *
 * POST /auth/request-otp   — send a 6-digit OTP via SMS (Twilio) or log in DEV_MODE
 * POST /auth/verify-otp    — verify OTP, create user if new, return JWT
 */

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');

const OTP_EXPIRY_MS = (parseInt(process.env.OTP_EXPIRY_MINUTES) || 10) * 60 * 1000;

// ── Twilio client (only initialised when credentials present) ─────────────────
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
  console.log('[auth] DEV_MODE — OTP returned in response, no SMS sent');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function issueToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

async function sendSms(phone, code) {
  if (!twilioClient) return; // DEV_MODE — skip
  await twilioClient.messages.create({
    to: phone,
    from: process.env.TWILIO_PHONE_NUMBER,
    body: `Your Grounders code: ${code}. Valid for 10 minutes.`,
  });
}

// ── POST /auth/request-otp ────────────────────────────────────────────────────

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
      `INSERT INTO otps (id, target, code_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [uuid(), target, hash, expiresAt]
    );

    if (type === 'phone') {
      await sendSms(target, code);
    }

    const body = { message: 'OTP sent' };
    if (!twilioClient) body._dev_otp = code; // only expose in DEV_MODE

    res.json(body);
  } catch (err) {
    next(err);
  }
});

// ── POST /auth/verify-otp ─────────────────────────────────────────────────────

router.post('/verify-otp', async (req, res, next) => {
  try {
    const { phone, email, code, display_name } = req.body;

    if (!phone && !email) return res.status(400).json({ error: 'Provide phone or email' });
    if (!code) return res.status(400).json({ error: 'Provide code' });

    const target = phone || email;

    const { rows: otpRows } = await pool.query(
      `SELECT * FROM otps
       WHERE target = $1 AND used = false AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [target]
    );

    if (!otpRows.length) {
      return res.status(401).json({ error: 'Code expired — request a new one' });
    }

    const valid = await bcrypt.compare(code, otpRows[0].code_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect code' });

    await pool.query(`UPDATE otps SET used = true WHERE id = $1`, [otpRows[0].id]);

    const col = phone ? 'phone' : 'email';
    let { rows: userRows } = await pool.query(
      `SELECT * FROM users WHERE ${col} = $1`, [target]
    );

    let user, isNew = false;

    if (userRows.length) {
      user = userRows[0];
    } else {
      isNew = true;
      const name = display_name?.trim() || '';
      ({ rows: [user] } = await pool.query(
        `INSERT INTO users (id, display_name, ${col}) VALUES ($1, $2, $3) RETURNING *`,
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
