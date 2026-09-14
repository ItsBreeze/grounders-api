/**
 * VoIP pushes, straight to Apple.
 *
 * WHY THIS EXISTS AT ALL. A locked iPhone cannot be made to ring by anything
 * in services/notifications.js. Firebase does not send VoIP pushes — there is
 * no FCM API for them — and an ordinary data push reaches APNs at priority 5,
 * is budgeted and throttled by iOS for a backgrounded app, and is not
 * delivered at all to a terminated one. A PushKit push is the only message
 * iOS will wake a killed app for, and it is what turns "a call you can answer
 * if you happen to be in the app" into a phone that rings.
 *
 * THE OBLIGATION THAT COMES WITH IT. Since iOS 13, an app that receives a
 * VoIP push MUST report an incoming call to CallKit in the same run loop, or
 * iOS throttles delivery and eventually stops delivering VoIP pushes to that
 * build entirely. The client side of that promise is in the app's AppDelegate
 * and lib/services/call_ring.dart; this file is only the sender, but the
 * obligation is why a VoIP push is never used for anything except a ring.
 *
 * WHY HAND-ROLLED. The send is one HTTP/2 POST with a JWT. Node has http2 in
 * core and jsonwebtoken is already a dependency, so a provider library would
 * add a dependency to save about forty lines and would hide the one thing
 * worth seeing here, which is the exact request Apple is being sent.
 *
 * INERT WITHOUT A KEY. With no APNS_* configuration, isConfigured() is false
 * and ring() does nothing at all: calls still ring through FCM exactly as
 * they did before this file existed, which is Phase 1's behaviour. Nothing
 * fails, nothing throws, and no route changes shape.
 */

const http2 = require('http2');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

/**
 * Apple caps a provider token's life at one hour and refuses one older than
 * that; it also rate-limits minting to once every 20 minutes per key. Fifty
 * minutes sits inside both.
 */
const TOKEN_TTL_MS = 50 * 60 * 1000;

const HOST_PROD = 'https://api.push.apple.com';
const HOST_SANDBOX = 'https://api.sandbox.push.apple.com';

const SEND_TIMEOUT_MS = 8000;

let cachedToken = null;
let cachedAt = 0;

function isConfigured() {
  return Boolean(
    process.env.APNS_KEY_ID
    && process.env.APNS_TEAM_ID
    && process.env.APNS_PRIVATE_KEY
    && process.env.APNS_BUNDLE_ID,
  );
}

function host() {
  // The VoIP topic differs between environments only by which APNs host the
  // token is presented to; a development build's token is invalid at the
  // production host and vice versa, and the error for that ("BadDeviceToken")
  // looks exactly like a stale token.
  return process.env.APNS_SANDBOX === 'true' ? HOST_SANDBOX : HOST_PROD;
}

/** The provider JWT, minted at most every 50 minutes. */
function providerToken() {
  if (cachedToken && Date.now() - cachedAt < TOKEN_TTL_MS) return cachedToken;
  const key = process.env.APNS_PRIVATE_KEY.replace(/\\n/g, '\n');
  cachedToken = jwt.sign({}, key, {
    algorithm: 'ES256',
    issuer: process.env.APNS_TEAM_ID,
    header: { alg: 'ES256', kid: process.env.APNS_KEY_ID },
    expiresIn: '50m',
  });
  cachedAt = Date.now();
  return cachedToken;
}

/** This user's PushKit tokens. Never mixed with the FCM ones. */
async function voipTokensFor(userIds) {
  if (!Array.isArray(userIds) || !userIds.length) return [];
  const { rows } = await pool.query(
    `SELECT token FROM device_tokens
      WHERE user_id = ANY($1) AND platform = 'ios_voip'`,
    [userIds],
  );
  return rows.map((r) => r.token);
}

/** One POST. Resolves with the status and Apple's reason, never rejects. */
function post(deviceToken, payload) {
  return new Promise((resolve) => {
    let client;
    try {
      client = http2.connect(host());
    } catch (err) {
      return resolve({ status: 0, reason: err.message });
    }
    const timer = setTimeout(() => {
      try { client.destroy(); } catch (_) { /* already gone */ }
      resolve({ status: 0, reason: 'timeout' });
    }, SEND_TIMEOUT_MS);

    const finish = (result) => {
      clearTimeout(timer);
      try { client.close(); } catch (_) { /* already closed */ }
      resolve(result);
    };

    client.on('error', (err) => finish({ status: 0, reason: err.message }));

    const body = Buffer.from(JSON.stringify(payload));
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken()}`,
      // The VoIP topic is the bundle id with .voip appended, and the push
      // type must say voip or Apple refuses it outright on iOS 13+.
      'apns-topic': `${process.env.APNS_BUNDLE_ID}.voip`,
      'apns-push-type': 'voip',
      'apns-priority': '10',
      // A ring is worthless once the caller has given up, so tell Apple not
      // to keep trying past the ringing window.
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 45),
      'content-type': 'application/json',
      'content-length': body.length,
    });

    let status = 0;
    let data = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('error', (err) => finish({ status: 0, reason: err.message }));
    req.on('end', () => {
      let reason = null;
      try { reason = data ? JSON.parse(data).reason : null; } catch (_) { reason = data || null; }
      finish({ status, reason });
    });
    req.end(body);
  });
}

/**
 * Ring every PushKit device these users have.
 *
 * Fire-and-forget in the strong sense: it is not awaited by the route, it
 * cannot reject, and a dead APNs leaves the call exactly as it would have
 * been — ringing over FCM, answerable from the notification.
 */
async function ring(userIds, data) {
  if (!isConfigured()) return { sent: 0, skipped: true };
  let tokens;
  try {
    tokens = await voipTokensFor(userIds);
  } catch (err) {
    console.error('[apns_voip] token lookup failed:', err.message);
    return { sent: 0 };
  }
  if (!tokens.length) return { sent: 0 };

  const payload = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined) payload[k] = String(v);
  }

  const dead = [];
  let sent = 0;
  for (const token of tokens) {
    const { status, reason } = await post(token, payload);
    if (status === 200) {
      sent += 1;
    } else {
      console.warn(`[apns_voip] ${status} ${reason || ''}`.trim());
      // The two reasons that mean this token will never work again. Anything
      // else — a timeout, a 503, a throttle — is transient and must not
      // delete a token that would ring tomorrow.
      if (reason === 'BadDeviceToken' || reason === 'Unregistered') dead.push(token);
    }
  }

  if (dead.length) {
    pool.query(`DELETE FROM device_tokens WHERE token = ANY($1)`, [dead])
      .then(() => console.log(`[apns_voip] pruned ${dead.length} dead VoIP tokens`))
      .catch((err) => console.error('[apns_voip] prune failed:', err.message));
  }
  return { sent, failed: tokens.length - sent };
}

module.exports = { isConfigured, ring, voipTokensFor, TOKEN_TTL_MS };
