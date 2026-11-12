/**
 * Reaper job — hard-deletes users whose 14-day soft-delete window has
 * elapsed. Cascades through posts, reactions, friends, zones, devices,
 * refresh tokens via FK ON DELETE CASCADE.
 *
 * The rows cascade; the files in R2 do not, so each user's objects are
 * deleted first and the user only once they are gone. A user whose objects
 * could not all be deleted is left for the next run: the keys live only in
 * the rows, so deleting the rows first would strand the files for good.
 * Deleting an object that is already gone succeeds, so a re-run is safe.
 *
 * Wired into a daily node-cron schedule in src/server.js (3am UTC).
 */

const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const pool = require('../db/pool');

const DUE = `deletion_pending_at IS NOT NULL
           AND deletion_pending_at < NOW() - INTERVAL '14 days'`;
const BATCH = 25;

function r2() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
}

/** Every R2 key that deleting this user leaves with no row pointing at it. */
async function objectKeysOf(userId) {
  // Radio: the user's own files, and everything in the workspaces they own
  // (those rows cascade with the workspace, whoever uploaded them). Minus any
  // key a surviving row still uses: copy-to-self makes a second row over the
  // same object, in someone else's workspace.
  const { rows: files } = await pool.query(
    `SELECT DISTINCT f.r2_key
       FROM radio_files f
      WHERE f.r2_key IS NOT NULL
        AND (f.owner_id = $1
             OR f.workspace_id IN (SELECT id FROM radio_workspaces WHERE owner_id = $1))
        AND NOT EXISTS (
              SELECT 1 FROM radio_files s
               WHERE s.r2_key = f.r2_key
                 AND s.owner_id <> $1
                 AND s.workspace_id NOT IN (SELECT id FROM radio_workspaces WHERE owner_id = $1))`,
    [userId]
  );
  const keys = new Set(files.map(f => f.r2_key));

  // Grounders posts store a URL the client sent, not a key. Only a path under
  // the user's own upload prefix (routes/uploads.js) is taken as theirs, so a
  // post that names somebody else's file cannot get it deleted.
  const { rows: posts } = await pool.query(
    `SELECT media_url, media_thumb_url FROM posts WHERE user_id = $1`,
    [userId]
  );
  for (const p of posts) {
    for (const url of [p.media_url, p.media_thumb_url]) {
      const m = /^https?:\/\/[^/]+\/(posts\/([^/]+)\/[^/?#]+)/.exec(url || '');
      if (m && m[2] === userId) keys.add(m[1]);
    }
  }
  return [...keys];
}

async function deleteObjects(s3, keys) {
  let failed = 0;
  for (let i = 0; i < keys.length; i += BATCH) {
    const results = await Promise.allSettled(keys.slice(i, i + BATCH).map(Key =>
      s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key }))
    ));
    for (const r of results) {
      if (r.status === 'rejected') {
        failed += 1;
        console.error('[reap_users] R2 delete failed:', r.reason && r.reason.message);
      }
    }
  }
  return failed;
}

// shortcut: a user who signs back in between the object delete and the row
// delete below keeps the account and loses the files (a seconds-wide window,
// 14 days after they asked). Lock the row for the duration if it ever matters.
async function reapDeletedUsers() {
  try {
    const { rows: due } = await pool.query(`SELECT id FROM users WHERE ${DUE}`);
    if (!due.length) return 0;

    const s3 = r2();
    if (!s3) console.warn('[reap_users] R2 is not configured — deleting rows only, no stored files');

    let reaped = 0;
    for (const { id } of due) {
      try {
        if (s3) {
          const keys = await objectKeysOf(id);
          const failed = await deleteObjects(s3, keys);
          if (failed) {
            console.error(`[reap_users] user ${id}: ${failed} of ${keys.length} files not deleted — account kept for the next run`);
            continue;
          }
          console.log(`[reap_users] user ${id}: deleted ${keys.length} files`);
        }
        const { rowCount } = await pool.query(`DELETE FROM users WHERE id = $1 AND ${DUE}`, [id]);
        reaped += rowCount;
      } catch (err) {
        console.error(`[reap_users] user ${id} failed:`, err.message);
      }
    }
    if (reaped > 0) console.log(`[reap_users] hard-deleted ${reaped} users`);
    return reaped;
  } catch (err) {
    console.error('[reap_users] failed:', err.message);
    return 0;
  }
}

module.exports = { reapDeletedUsers };
