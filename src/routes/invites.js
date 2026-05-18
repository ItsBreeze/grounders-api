/**
 * Invites — send an SMS to a phone number that doesn't yet have an account
 * so they can join either Grounders or Itsradio. Reuses the same Twilio
 * credentials as the OTP path.
 */

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const pool = require('../db/pool');

router.use(requireAuth);

let twilioClient = null;
if (
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_PHONE_NUMBER &&
  process.env.DEV_MODE !== 'true'
) {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

const RADIO_URL    = process.env.RADIO_APP_URL    || 'https://itsradio.app';
const GROUNDERS_URL = process.env.GROUNDERS_APP_URL || 'https://grounders.app';

// POST /invites/sms { phone, source: 'radio' | 'grounders' }
// `phone` may be any format — we normalise to digits and require the lead 1.
// Sends a single-message invite from the inviter to the recipient.
router.post('/sms', async (req, res, next) => {
  try {
    const phoneRaw = (req.body.phone || '').toString();
    const source = req.body.source === 'radio' ? 'radio' : 'grounders';
    const digits = phoneRaw.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    const e164 = digits.startsWith('1') || digits.length > 10 ? `+${digits}` : `+1${digits}`;

    // Sender name — used in the SMS body.
    const { rows: [u] } = await pool.query(
      `SELECT display_name FROM users WHERE id = $1`,
      [req.user.id]
    );
    const senderName = u?.display_name?.trim() || 'A friend';

    const appLabel = source === 'radio' ? 'itsradio' : 'Grounders';
    const url = source === 'radio' ? RADIO_URL : GROUNDERS_URL;
    const body = `${senderName} tagged you on ${appLabel}. Join here: ${url}`;

    if (!twilioClient) {
      // Dev mode — return the would-be message so the client can show it.
      return res.json({ sent: false, dev: true, to: e164, body });
    }
    await twilioClient.messages.create({
      to: e164,
      from: process.env.TWILIO_PHONE_NUMBER,
      body,
    });
    res.json({ sent: true, to: e164 });
  } catch (err) { next(err); }
});

module.exports = router;
