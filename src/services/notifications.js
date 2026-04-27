/**
 * Push notifications via Firebase Cloud Messaging.
 *
 * Fire-and-forget. If FCM env vars are missing, calls are no-ops.
 * Invalid/expired tokens are pruned from the DB automatically.
 */

const admin = require('firebase-admin');
const pool  = require('../db/pool');

let initialized = false;

function init() {
  if (initialized) return;

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    console.warn('[notifications] Firebase env vars not set — push disabled');
    return;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey:  FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    initialized = true;
    console.log('[notifications] Firebase Admin initialized');
  } catch (err) {
    console.error('[notifications] Firebase init failed:', err.message);
  }
}

init();

function isReady() {
  return initialized;
}

async function sendToUser(userId, payload) {
  return sendToUsers([userId], payload);
}

async function sendToUsers(userIds, { title, body, data = {} }) {
  if (!initialized) return { sent: 0, failed: 0, skipped: true };
  if (!Array.isArray(userIds) || !userIds.length) return { sent: 0, failed: 0 };

  let tokens;
  try {
    const { rows } = await pool.query(
      `SELECT token FROM device_tokens WHERE user_id = ANY($1)`,
      [userIds]
    );
    tokens = rows.map(r => r.token);
  } catch (err) {
    console.error('[notifications] token lookup failed:', err.message);
    return { sent: 0, failed: 0 };
  }

  if (!tokens.length) return { sent: 0, failed: 0 };

  const stringData = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined) stringData[k] = String(v);
  }

  const CHUNK_SIZE = 500;
  const invalidTokens = [];
  let totalSent = 0;
  let totalFailed = 0;

  for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
    const chunk = tokens.slice(i, i + CHUNK_SIZE);
    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        notification: { title, body },
        data: stringData,
        apns: {
          payload: { aps: { sound: 'default', 'mutable-content': 1 } },
        },
        android: {
          priority: 'high',
          notification: { sound: 'default', channelId: 'grounders_default' },
        },
      });

      totalSent   += response.successCount;
      totalFailed += response.failureCount;

      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/invalid-argument'
          ) {
            invalidTokens.push(chunk[idx]);
          } else {
            console.warn('[notifications] send error:', code, resp.error?.message);
          }
        }
      });
    } catch (err) {
      console.error('[notifications] multicast failed:', err.message);
      totalFailed += chunk.length;
    }
  }

  if (invalidTokens.length) {
    pool.query(`DELETE FROM device_tokens WHERE token = ANY($1)`, [invalidTokens])
      .then(() => console.log(`[notifications] pruned ${invalidTokens.length} dead tokens`))
      .catch(err => console.error('[notifications] prune failed:', err.message));
  }

  return { sent: totalSent, failed: totalFailed };
}

function fireAndForget(promise) {
  Promise.resolve(promise).catch(err => {
    console.error('[notifications] fire-and-forget error:', err.message);
  });
}

module.exports = { sendToUser, sendToUsers, fireAndForget, isReady };
