/**
 * Putting something into a Radio conversation — one place, so the apps and
 * the connector cannot drift apart.
 *
 * Every text message and every file lands in radio_files, charges its bytes
 * to whoever sent it, and pushes a notification to the other members. That
 * was written once inside routes/radio.js; now that the MCP connector can
 * send too, a second copy would mean a second set of push payloads for the
 * Radio apps to learn. So the route and the tool both call these.
 *
 * The insert and the storage counter move together in one statement rather
 * than a transaction: a CTE is atomic, and it keeps this callable from the
 * test harness, which stubs pool.query and nothing else.
 */

const { v4: uuid } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const pool = require('../db/pool');
const notifications = require('./notifications');
const radioTranscribe = require('./radio_transcribe');
const offhandPush = require('./offhand_push');

// A file sent through the connector is downloaded into memory first, so this
// is a memory cap as much as a policy one.
const SEND_FILE_CAP_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20000;
const TEXT_MAX_CHARS = 5000;

function r2() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function isMember(workspaceId, userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM radio_workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  return rows.length > 0;
}

/** The other members of a workspace — the ones a push is for. */
async function recipients(workspaceId, senderId) {
  const { rows } = await pool.query(
    `SELECT user_id FROM radio_workspace_members WHERE workspace_id = $1 AND user_id != $2`,
    [workspaceId, senderId],
  );
  return rows.map((r) => r.user_id);
}

async function names(senderId, workspaceId) {
  const [{ rows: [sender] }, { rows: [ws] }] = await Promise.all([
    pool.query(`SELECT display_name FROM users WHERE id = $1`, [senderId]),
    pool.query(`SELECT name FROM radio_workspaces WHERE id = $1`, [workspaceId]),
  ]);
  return {
    senderName: sender?.display_name?.trim() || 'Someone',
    workspaceName: ws?.name?.trim() || 'workspace',
  };
}

/**
 * A text message. Returns the radio_files row. The caller has already
 * established membership.
 */
async function sendText({ userId, workspaceId, content }) {
  const text = String(content || '').trim();
  if (!text) throw Object.assign(new Error('content required'), { status: 400 });
  if (text.length > TEXT_MAX_CHARS) {
    throw Object.assign(new Error(`content too long (max ${TEXT_MAX_CHARS} chars)`), { status: 400 });
  }

  const { rows: [row] } = await pool.query(
    `INSERT INTO radio_files (id, workspace_id, owner_id, kind, text_content, size_bytes)
     VALUES ($1, $2, $3, 'text', $4, 0)
     RETURNING *`,
    [uuid(), workspaceId, userId, text],
  );

  notifications.fireAndForget((async () => {
    const to = await recipients(workspaceId, userId);
    if (!to.length) return;
    const { senderName, workspaceName } = await names(userId, workspaceId);
    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    return notifications.sendToUsers(to, {
      title: `${senderName} (${workspaceName})`,
      body: preview,
      app: 'radio',
      data: {
        type: 'radio_text',
        workspace_id: workspaceId,
        file_id: row.id,
        from_user_id: userId,
        sender_name: senderName,
        workspace_name: workspaceName,
        is_group: to.length > 1,
        preview,
      },
    });
  })());

  return row;
}

/**
 * A file or voice note whose bytes are already in R2. Returns the row plus
 * its public URL. The caller has already established membership and that
 * r2Key belongs to this workspace.
 */
async function recordFile({ userId, workspaceId, kind, r2Key, mimeType, filename, sizeBytes, durationMs, callId }) {
  const size = Number.isFinite(sizeBytes) ? Math.round(sizeBytes) : 0;
  // A duration is a positive number of milliseconds or it is not a duration.
  // This number is client-supplied and the route does not range-check it, and
  // downstream it is money: services/radio_transcribe charges the day's
  // ceiling by declared length and charges an unknown length an assumed
  // minute. That only holds if a declared 0 — or a negative, which would be a
  // credit against the account's other notes — lands in "unknown" rather than
  // in "free". NULL is "unknown".
  const rounded = Number.isFinite(durationMs) ? Math.round(durationMs) : null;
  const duration = rounded !== null && rounded > 0 ? rounded : null;
  // call_id is provenance, not a kind: a kept call is an ordinary voice note
  // to every code path that touches it — including the transcription
  // pipeline below — and the column only tells the feed to draw a phone
  // glyph instead of a microphone. The route has already established that
  // this user was on that call.
  const { rows: [row] } = await pool.query(
    `WITH ins AS (
       INSERT INTO radio_files
         (id, workspace_id, owner_id, kind, r2_key, mime_type, filename, size_bytes, duration_ms, call_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *
     ), bump AS (
       UPDATE users SET radio_storage_used_bytes = radio_storage_used_bytes + $8 WHERE id = $3
     )
     SELECT * FROM ins`,
    [
      uuid(), workspaceId, userId, kind, r2Key,
      mimeType || null, filename || null, size, duration, callId || null,
    ],
  );

  // A voice note transcribes itself. Fire-and-forget in the strong sense: it
  // is not awaited, it cannot reject, and a provider that is down or absent
  // leaves this send exactly as it would have been. With no provider key
  // configured it does nothing at all and transcript_status stays NULL.
  if (kind === 'voice_note' && row?.id) radioTranscribe.queue(row.id);

  // A kept call goes to Offhand, where it becomes a note. Call-only by
  // construction rather than by a flag: `callId` is set by exactly one caller,
  // POST /radio/workspaces/:id/files with a call the uploader was verified to
  // be on, so a voice memo and a connector upload cannot reach this line at
  // all — which is the guarantee that matters, because this is the one path
  // that sends somebody's audio to another service.
  //
  // Queued, never awaited, and deliberately not done inside the route. A push
  // that failed synchronously would 500 the finalize call, the phone would
  // retry the whole upload, and the retry mints a FRESH r2_key — so the same
  // recording would land as a second R2 object and a second radio_files row,
  // with the first one orphaned. Dropping the promise is safe here in a way it
  // usually is not: the row carries the claim, so a process that dies mid-push
  // leaves something the hourly sweep finds and finishes.
  if (callId && row?.id) offhandPush.queue(row.id);

  notifications.fireAndForget((async () => {
    const to = await recipients(workspaceId, userId);
    if (!to.length) return;
    const { senderName, workspaceName } = await names(userId, workspaceId);
    const isMemo = kind === 'voice_note';
    return notifications.sendToUsers(to, {
      title: isMemo ? `${senderName} sent a voice memo` : `${senderName} shared a file`,
      body: isMemo ? `In ${workspaceName}` : `${filename || 'File'} • ${workspaceName}`,
      app: 'radio',
      data: {
        type: isMemo ? 'radio_voice_memo' : 'radio_file',
        workspace_id: workspaceId,
        file_id: row.id,
        from_user_id: userId,
        sender_name: senderName,
        workspace_name: workspaceName,
        is_group: to.length > 1,
        filename: isMemo ? '' : (filename || ''),
      },
    });
  })());

  return { ...row, url: row.r2_key ? `${process.env.R2_PUBLIC_URL}/${row.r2_key}` : null };
}

const EXT_FOR = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/heic': 'heic', 'application/pdf': 'pdf', 'text/plain': 'txt',
  'text/csv': 'csv', 'text/markdown': 'md', 'application/json': 'json',
  'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
};

function extensionFor(filename, mimeType) {
  const name = String(filename || '').split('?')[0];
  const dot = name.lastIndexOf('.');
  const fromName = dot > 0 ? name.slice(dot + 1) : '';
  if (/^[A-Za-z0-9]{1,8}$/.test(fromName)) return fromName.toLowerCase();
  return EXT_FOR[String(mimeType || '').toLowerCase()] || 'bin';
}

/**
 * Bytes → R2 → a message in the conversation. This is the connector's path:
 * it holds a buffer, not a presigned upload the phone performed.
 */
async function uploadAndSend({ userId, workspaceId, buffer, filename, mimeType }) {
  if (!buffer || !buffer.length) throw Object.assign(new Error('the file was empty'), { status: 400 });
  if (buffer.length > SEND_FILE_CAP_BYTES) {
    throw Object.assign(
      new Error(`that file is ${buffer.length} bytes; the limit for sending is ${SEND_FILE_CAP_BYTES}`),
      { status: 413 },
    );
  }
  const key = `radio/${workspaceId}/${uuid()}.${extensionFor(filename, mimeType)}`;
  await r2().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream',
  }));
  return recordFile({
    userId, workspaceId, kind: 'file', r2Key: key,
    mimeType: mimeType || 'application/octet-stream',
    filename: filename || key.split('/').pop(),
    sizeBytes: buffer.length,
  });
}

/** Best effort: the row is already gone, and a stranded object is not worth
 * failing a delete over. */
function deleteObject(key) {
  if (!key) return;
  r2().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  })).catch(() => {});
}

module.exports = {
  isMember, sendText, recordFile, uploadAndSend, extensionFor, deleteObject,
  SEND_FILE_CAP_BYTES, DOWNLOAD_TIMEOUT_MS, TEXT_MAX_CHARS,
};
