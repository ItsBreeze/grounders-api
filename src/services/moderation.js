/**
 * Moderation alert dispatcher.
 *
 * Sends email alerts via Resend when reports are filed. If env vars
 * are missing, calls are no-ops and the report still lands in the DB.
 *
 * Required env vars (optional — without them, alerts are skipped):
 *   RESEND_API_KEY     — from resend.com dashboard
 *   MODERATION_EMAIL   — where to send alerts (e.g. you@grounders.app)
 */

let resendClient = null;
try {
  if (process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
    console.log('[moderation] Resend email alerts enabled');
  } else {
    console.log('[moderation] No RESEND_API_KEY — email alerts disabled');
  }
} catch (err) {
  console.warn('[moderation] Resend init failed:', err.message);
}

async function notifyModeration({
  reportId, postId, postOwnerId, reporterId, reason, details,
}) {
  if (!resendClient || !process.env.MODERATION_EMAIL) return;

  const lines = [
    `Report ID: ${reportId}`,
    `Reason: ${reason}`,
    details ? `Details: ${details}` : null,
    `Post ID: ${postId}`,
    `Post owner: ${postOwnerId}`,
    `Reporter: ${reporterId}`,
  ].filter(Boolean).join('\n');

  try {
    await resendClient.emails.send({
      from: 'Grounders Moderation <moderation@grounders.app>',
      to: process.env.MODERATION_EMAIL,
      subject: `[Grounders] New report — ${reason}`,
      text: lines,
    });
  } catch (err) {
    console.warn('[moderation] email send failed:', err.message);
  }
}

module.exports = { notifyModeration };
