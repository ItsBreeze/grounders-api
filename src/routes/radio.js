/**
 * Radio routes — workspaces, members, files (voice notes + uploaded files).
 *
 * All endpoints require auth. The first authenticated radio call flips
 * users.radio_enabled = true (fire-and-forget) so we can tell "has ever used radio."
 *
 * Storage model: every uploaded artifact is charged to its uploader
 * (radio_files.owner_id), not the workspace owner. Quotas are not enforced
 * yet (free-to-start) but radio_storage_used_bytes is maintained from day one.
 *
 * R2 keys: radio/{workspace_id}/{uuid}.{ext}
 */

const router = require('express').Router();
const { v4: uuid } = require('uuid');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const notifications = require('../services/notifications');

router.use(requireAuth);

// Mark the user as a radio user on first authenticated radio call.
// Fire-and-forget — never blocks the request.
router.use((req, _res, next) => {
  pool.query(
    `UPDATE users SET radio_enabled = true WHERE id = $1 AND radio_enabled = false`,
    [req.user.id]
  ).catch(() => {});
  next();
});

const ALLOWED_KINDS = ['voice_note', 'file'];
const VOICE_MIME = 'audio/mp4';
const VOICE_EXT = 'm4a';
const PRESIGN_TTL = 600;
const DOWNLOAD_TTL = 3600;

function r2() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function isMember(workspaceId, userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM radio_workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId]
  );
  return rows.length > 0;
}

async function isOwner(workspaceId, userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM radio_workspaces WHERE id = $1 AND owner_id = $2`,
    [workspaceId, userId]
  );
  return rows.length > 0;
}

async function areFriends(userIdA, userIdB) {
  const [a, b] = userIdA < userIdB ? [userIdA, userIdB] : [userIdB, userIdA];
  const { rows } = await pool.query(
    `SELECT 1 FROM friendships WHERE user_id_a = $1 AND user_id_b = $2`,
    [a, b]
  );
  return rows.length > 0;
}


// ─── Workspaces ─────────────────────────────────────────────────────────────

// GET /radio/workspaces — workspaces I'm a member of
router.get('/workspaces', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const { rows } = await pool.query(
      `SELECT w.id, w.name, w.owner_id, w.created_at,
              (SELECT COUNT(*)::int FROM radio_workspace_members m WHERE m.workspace_id = w.id) AS member_count,
              (SELECT MAX(created_at) FROM radio_files f WHERE f.workspace_id = w.id) AS last_activity_at
         FROM radio_workspaces w
         JOIN radio_workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = $1
        ORDER BY last_activity_at DESC NULLS LAST, w.created_at DESC`,
      [myId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /radio/workspaces { name?, member_ids?: [uuid] }
// Creator is automatically a member. Each invited member must be a friend.
router.post('/workspaces', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const myId = req.user.id;
    const name = (req.body.name || '').toString().slice(0, 100);
    const memberIds = Array.isArray(req.body.member_ids) ? req.body.member_ids : [];

    for (const mid of memberIds) {
      if (mid === myId) continue;
      if (!(await areFriends(myId, mid))) {
        return res.status(403).json({ error: `Not friends with ${mid}` });
      }
    }

    await client.query('BEGIN');
    const wsId = uuid();
    await client.query(
      `INSERT INTO radio_workspaces (id, owner_id, name) VALUES ($1, $2, $3)`,
      [wsId, myId, name]
    );

    const allMembers = Array.from(new Set([myId, ...memberIds]));
    for (const mid of allMembers) {
      await client.query(
        `INSERT INTO radio_workspace_members (workspace_id, user_id, added_by)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [wsId, mid, myId]
      );
    }
    await client.query('COMMIT');

    const invitedIds = allMembers.filter(id => id !== myId);
    if (invitedIds.length) {
      notifications.fireAndForget((async () => {
        const { rows: [creator] } = await pool.query(
          `SELECT display_name FROM users WHERE id = $1`, [myId]
        );
        const creatorName = creator?.display_name?.trim() || 'Someone';
        const wsName = name.trim() || 'a workspace';
        return notifications.sendToUsers(invitedIds, {
          title: `Added to ${wsName}`,
          body:  `${creatorName} added you to a Radio workspace`,
          data:  { type: 'radio_workspace_added', workspace_id: wsId, from_user_id: myId },
        });
      })());
    }

    res.status(201).json({ id: wsId, owner_id: myId, name, member_ids: allMembers });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// GET /radio/workspaces/:id — workspace + members
router.get('/workspaces/:id', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    if (!(await isMember(wsId, myId))) return res.status(404).json({ error: 'Workspace not found' });

    const { rows: [ws] } = await pool.query(
      `SELECT id, owner_id, name, created_at FROM radio_workspaces WHERE id = $1`,
      [wsId]
    );
    const { rows: members } = await pool.query(
      `SELECT m.user_id, m.added_by, m.joined_at, u.display_name
         FROM radio_workspace_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1
        ORDER BY m.joined_at`,
      [wsId]
    );
    res.json({ ...ws, members });
  } catch (err) { next(err); }
});

// PATCH /radio/workspaces/:id { name } — owner only
router.patch('/workspaces/:id', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    if (!(await isOwner(wsId, myId))) return res.status(403).json({ error: 'Owner only' });

    const name = (req.body.name || '').toString().slice(0, 100);
    await pool.query(`UPDATE radio_workspaces SET name = $1 WHERE id = $2`, [name, wsId]);
    res.json({ id: wsId, name });
  } catch (err) { next(err); }
});

// DELETE /radio/workspaces/:id — owner only.
// Refund radio_storage_used_bytes to each file owner before cascade.
router.delete('/workspaces/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    if (!(await isOwner(wsId, myId))) return res.status(403).json({ error: 'Owner only' });

    await client.query('BEGIN');

    const { rows: files } = await client.query(
      `SELECT id, owner_id, r2_key, size_bytes FROM radio_files WHERE workspace_id = $1`,
      [wsId]
    );

    const refunds = new Map();
    for (const f of files) {
      refunds.set(f.owner_id, (refunds.get(f.owner_id) || 0) + Number(f.size_bytes));
    }
    for (const [ownerId, bytes] of refunds) {
      await client.query(
        `UPDATE users SET radio_storage_used_bytes = GREATEST(0, radio_storage_used_bytes - $1) WHERE id = $2`,
        [bytes, ownerId]
      );
    }

    await client.query(`DELETE FROM radio_workspaces WHERE id = $1`, [wsId]);
    await client.query('COMMIT');

    // Best-effort R2 deletion after DB commit.
    const s3 = r2();
    const bucket = process.env.R2_BUCKET_NAME;
    Promise.all(files.map(f =>
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: f.r2_key })).catch(() => {})
    )).catch(() => {});

    res.json({ deleted: true, file_count: files.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});


// ─── Members ────────────────────────────────────────────────────────────────

// POST /radio/workspaces/:id/members { user_id } — adder must be a member AND friend
router.post('/workspaces/:id/members', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    const newId = req.body.user_id;
    if (!newId) return res.status(400).json({ error: 'user_id required' });
    if (!(await isMember(wsId, myId))) return res.status(403).json({ error: 'Not a member' });
    if (newId !== myId && !(await areFriends(myId, newId))) {
      return res.status(403).json({ error: 'Not friends with this user' });
    }

    const { rows: inserted } = await pool.query(
      `INSERT INTO radio_workspace_members (workspace_id, user_id, added_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING user_id`,
      [wsId, newId, myId]
    );

    if (inserted.length && newId !== myId) {
      notifications.fireAndForget((async () => {
        const { rows: [adder] } = await pool.query(
          `SELECT display_name FROM users WHERE id = $1`, [myId]
        );
        const { rows: [ws] } = await pool.query(
          `SELECT name FROM radio_workspaces WHERE id = $1`, [wsId]
        );
        const adderName = adder?.display_name?.trim() || 'Someone';
        const wsName = ws?.name?.trim() || 'a workspace';
        return notifications.sendToUser(newId, {
          title: `Added to ${wsName}`,
          body:  `${adderName} added you to a Radio workspace`,
          data:  { type: 'radio_workspace_added', workspace_id: wsId, from_user_id: myId },
        });
      })());
    }

    res.status(201).json({ added: true, user_id: newId });
  } catch (err) { next(err); }
});

// DELETE /radio/workspaces/:id/members/:userId — owner can remove anyone; self can leave
router.delete('/workspaces/:id/members/:userId', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    const targetId = req.params.userId;
    const owner = await isOwner(wsId, myId);
    if (!owner && targetId !== myId) return res.status(403).json({ error: 'Owner only, or leave yourself' });
    if (owner && targetId === myId) return res.status(400).json({ error: 'Owner cannot leave; delete the workspace instead' });

    const { rows } = await pool.query(
      `DELETE FROM radio_workspace_members WHERE workspace_id = $1 AND user_id = $2 RETURNING user_id`,
      [wsId, targetId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    res.json({ removed: true });
  } catch (err) { next(err); }
});


// ─── Files (chronological feed of voice notes + files) ──────────────────────

// GET /radio/workspaces/:id/files?limit=50&before=<ISO>
router.get('/workspaces/:id/files', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    if (!(await isMember(wsId, myId))) return res.status(404).json({ error: 'Workspace not found' });

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const before = req.query.before ? new Date(req.query.before) : null;

    const params = [wsId];
    let where = `WHERE f.workspace_id = $1`;
    if (before && !isNaN(before)) {
      params.push(before.toISOString());
      where += ` AND f.created_at < $${params.length}`;
    }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT f.id, f.kind, f.owner_id, f.r2_key, f.mime_type, f.filename,
              f.size_bytes, f.duration_ms, f.created_at,
              u.display_name AS owner_name
         FROM radio_files f
         JOIN users u ON u.id = f.owner_id
         ${where}
        ORDER BY f.created_at DESC
        LIMIT $${params.length}`,
      params
    );

    const base = process.env.R2_PUBLIC_URL;
    res.json(rows.map(r => ({ ...r, url: `${base}/${r.r2_key}` })));
  } catch (err) { next(err); }
});

// POST /radio/workspaces/:id/upload-url { kind, mime_type?, filename? }
// Returns a presigned PUT URL + the r2_key the client must echo back on finalize.
router.post('/workspaces/:id/upload-url', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    if (!(await isMember(wsId, myId))) return res.status(403).json({ error: 'Not a member' });

    const kind = req.body.kind;
    if (!ALLOWED_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be voice_note or file' });

    let mime, ext;
    if (kind === 'voice_note') {
      mime = VOICE_MIME;
      ext = VOICE_EXT;
    } else {
      mime = (req.body.mime_type || 'application/octet-stream').toString();
      const fn = (req.body.filename || '').toString();
      const dot = fn.lastIndexOf('.');
      ext = dot > -1 ? fn.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : 'bin';
      if (!ext) ext = 'bin';
    }

    const fileId = uuid();
    const key = `radio/${wsId}/${fileId}.${ext}`;

    const url = await getSignedUrl(
      r2(),
      new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key, ContentType: mime }),
      { expiresIn: PRESIGN_TTL }
    );

    res.json({ upload_url: url, r2_key: key, mime_type: mime });
  } catch (err) { next(err); }
});

// POST /radio/workspaces/:id/files
// Body: { kind, r2_key, size_bytes, mime_type?, filename?, duration_ms? }
// Called after a successful R2 PUT. Inserts the row and increments storage counter.
router.post('/workspaces/:id/files', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    if (!(await isMember(wsId, myId))) return res.status(403).json({ error: 'Not a member' });

    const { kind, r2_key, mime_type, filename, duration_ms } = req.body;
    const sizeBytes = parseInt(req.body.size_bytes);
    if (!ALLOWED_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be voice_note or file' });
    if (!r2_key || typeof r2_key !== 'string') return res.status(400).json({ error: 'r2_key required' });
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return res.status(400).json({ error: 'size_bytes must be a non-negative integer' });
    if (!r2_key.startsWith(`radio/${wsId}/`)) return res.status(400).json({ error: 'r2_key does not match workspace' });

    await client.query('BEGIN');

    const fileId = uuid();
    const { rows: [row] } = await client.query(
      `INSERT INTO radio_files
         (id, workspace_id, owner_id, kind, r2_key, mime_type, filename, size_bytes, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        fileId, wsId, myId, kind, r2_key,
        mime_type || null,
        filename || null,
        sizeBytes,
        Number.isFinite(parseInt(duration_ms)) ? parseInt(duration_ms) : null,
      ]
    );

    await client.query(
      `UPDATE users SET radio_storage_used_bytes = radio_storage_used_bytes + $1 WHERE id = $2`,
      [sizeBytes, myId]
    );

    await client.query('COMMIT');

    notifications.fireAndForget((async () => {
      const { rows: [sender] } = await pool.query(
        `SELECT display_name FROM users WHERE id = $1`, [myId]
      );
      const { rows: [ws] } = await pool.query(
        `SELECT name FROM radio_workspaces WHERE id = $1`, [wsId]
      );
      const { rows: members } = await pool.query(
        `SELECT user_id FROM radio_workspace_members WHERE workspace_id = $1 AND user_id != $2`,
        [wsId, myId]
      );
      const recipientIds = members.map(m => m.user_id);
      if (!recipientIds.length) return;

      const senderName = sender?.display_name?.trim() || 'Someone';
      const wsName = ws?.name?.trim() || 'workspace';
      const isMemo = kind === 'voice_note';
      const title = isMemo ? `${senderName} sent a voice memo` : `${senderName} shared a file`;
      const body  = isMemo ? `In ${wsName}` : `${filename || 'File'} • ${wsName}`;

      return notifications.sendToUsers(recipientIds, {
        title, body,
        data: {
          type: isMemo ? 'radio_voice_memo' : 'radio_file',
          workspace_id: wsId,
          file_id: row.id,
          from_user_id: myId,
        },
      });
    })());

    res.status(201).json({ ...row, url: `${process.env.R2_PUBLIC_URL}/${row.r2_key}` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /radio/files/:id — owner of the file only. Refunds storage + deletes from R2.
router.delete('/files/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const myId = req.user.id;

    await client.query('BEGIN');
    const { rows } = await client.query(
      `DELETE FROM radio_files WHERE id = $1 AND owner_id = $2 RETURNING r2_key, size_bytes`,
      [req.params.id, myId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'File not found or not yours' });
    }
    const f = rows[0];
    await client.query(
      `UPDATE users SET radio_storage_used_bytes = GREATEST(0, radio_storage_used_bytes - $1) WHERE id = $2`,
      [Number(f.size_bytes), myId]
    );
    await client.query('COMMIT');

    r2().send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: f.r2_key,
    })).catch(() => {});

    res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});


// ─── Storage usage ──────────────────────────────────────────────────────────

// GET /radio/storage — my current usage
router.get('/storage', async (req, res, next) => {
  try {
    const { rows: [u] } = await pool.query(
      `SELECT radio_storage_used_bytes AS used_bytes FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json({ used_bytes: Number(u?.used_bytes || 0), quota_bytes: null });
  } catch (err) { next(err); }
});

module.exports = router;
