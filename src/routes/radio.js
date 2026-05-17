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


// ─── Dial state (per-user UI layout) ────────────────────────────────────────

// GET /radio/dial — my saved dial layout
router.get('/dial', async (req, res, next) => {
  try {
    const { rows: [u] } = await pool.query(
      `SELECT radio_dial_state AS state FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json(u?.state || { tiles: [], groups: [] });
  } catch (err) { next(err); }
});

// PUT /radio/dial { tiles: [...], groups: [...] }
router.put('/dial', async (req, res, next) => {
  try {
    const tiles = Array.isArray(req.body.tiles) ? req.body.tiles : [];
    const groups = Array.isArray(req.body.groups) ? req.body.groups : [];
    const state = { tiles, groups };
    await pool.query(
      `UPDATE users SET radio_dial_state = $1 WHERE id = $2`,
      [JSON.stringify(state), req.user.id]
    );
    res.json(state);
  } catch (err) { next(err); }
});


// ─── Search (contacts + workspaces + files) ─────────────────────────────────

// GET /radio/search?q=...&limit=10
// Returns three grouped lists, scoped to:
//   - friends (contacts): match display_name
//   - workspaces I'm a member of: match name
//   - files inside those workspaces: match filename
router.get('/search', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    if (!q) return res.json({ contacts: [], workspaces: [], files: [] });
    const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;

    const [contactsR, workspacesR, filesR] = await Promise.all([
      pool.query(
        `SELECT u.id, u.display_name
           FROM friendships f
           JOIN users u
             ON u.id = CASE WHEN f.user_id_a = $1 THEN f.user_id_b ELSE f.user_id_a END
          WHERE (f.user_id_a = $1 OR f.user_id_b = $1)
            AND u.display_name ILIKE $2 ESCAPE '\\'
          ORDER BY u.display_name
          LIMIT $3`,
        [myId, like, limit]
      ),
      pool.query(
        `SELECT w.id, w.name, w.owner_id,
                (SELECT COUNT(*)::int FROM radio_workspace_members m WHERE m.workspace_id = w.id) AS member_count
           FROM radio_workspaces w
           JOIN radio_workspace_members me ON me.workspace_id = w.id
          WHERE me.user_id = $1
            AND w.name ILIKE $2 ESCAPE '\\'
          ORDER BY w.created_at DESC
          LIMIT $3`,
        [myId, like, limit]
      ),
      pool.query(
        `SELECT f.id, f.workspace_id, f.kind, f.filename, f.mime_type, f.size_bytes,
                f.duration_ms, f.created_at, f.r2_key,
                w.name AS workspace_name
           FROM radio_files f
           JOIN radio_workspaces w ON w.id = f.workspace_id
           JOIN radio_workspace_members me ON me.workspace_id = f.workspace_id
          WHERE me.user_id = $1
            AND f.filename IS NOT NULL
            AND f.filename ILIKE $2 ESCAPE '\\'
          ORDER BY f.created_at DESC
          LIMIT $3`,
        [myId, like, limit]
      ),
    ]);

    const base = process.env.R2_PUBLIC_URL;
    res.json({
      contacts: contactsR.rows,
      workspaces: workspacesR.rows,
      files: filesR.rows.map(r => ({ ...r, url: `${base}/${r.r2_key}` })),
    });
  } catch (err) { next(err); }
});


// ─── Workspaces ─────────────────────────────────────────────────────────────

// GET /radio/workspaces — workspaces I'm a member of, with member list embedded
// so the client can collapse 1:1 workspaces into a single contact tile.
router.get('/workspaces', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const { rows } = await pool.query(
      `SELECT w.id, w.name, w.color, w.owner_id, w.created_at,
              (SELECT COUNT(*)::int FROM radio_workspace_members m WHERE m.workspace_id = w.id) AS member_count,
              (SELECT MAX(created_at) FROM radio_files f WHERE f.workspace_id = w.id) AS last_activity_at,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'user_id', mm.user_id,
                  'display_name', uu.display_name
                ) ORDER BY uu.display_name)
                FROM radio_workspace_members mm
                JOIN users uu ON uu.id = mm.user_id
                WHERE mm.workspace_id = w.id
              ), '[]'::json) AS members
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
    const rawColor = (req.body.color || '').toString().trim();
    // Accept hex like "#1E88E5" — case-insensitive, no surrounding whitespace.
    const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor.toUpperCase() : null;
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
      `INSERT INTO radio_workspaces (id, owner_id, name, color) VALUES ($1, $2, $3, $4)`,
      [wsId, myId, name, color]
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

    res.status(201).json({ id: wsId, owner_id: myId, name, color, member_ids: allMembers });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// GET /radio/workspaces/dm?user_id=X
// Returns the existing 1:1 workspace I share with X (exactly two members, both of us), or 404.
// Caller can fall back to POST /radio/workspaces to create one.
router.get('/workspaces/dm', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const otherId = req.query.user_id;
    if (!otherId) return res.status(400).json({ error: 'user_id required' });
    if (otherId === myId) return res.status(400).json({ error: 'Cannot DM yourself' });

    const { rows } = await pool.query(
      `SELECT w.id, w.name, w.color, w.owner_id, w.created_at
         FROM radio_workspaces w
         JOIN radio_workspace_members ma ON ma.workspace_id = w.id AND ma.user_id = $1
         JOIN radio_workspace_members mb ON mb.workspace_id = w.id AND mb.user_id = $2
        WHERE (SELECT COUNT(*) FROM radio_workspace_members m WHERE m.workspace_id = w.id) = 2
        ORDER BY w.created_at DESC
        LIMIT 1`,
      [myId, otherId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No DM workspace found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /radio/workspaces/:id — workspace + members
router.get('/workspaces/:id', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    if (!(await isMember(wsId, myId))) return res.status(404).json({ error: 'Workspace not found' });

    const { rows: [ws] } = await pool.query(
      `SELECT id, owner_id, name, color, created_at FROM radio_workspaces WHERE id = $1`,
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

// PATCH /radio/workspaces/:id { name?, color? } — owner only
router.patch('/workspaces/:id', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    if (!(await isOwner(wsId, myId))) return res.status(403).json({ error: 'Owner only' });

    const updates = [];
    const params = [];
    if ('name' in req.body) {
      params.push((req.body.name || '').toString().slice(0, 100));
      updates.push(`name = $${params.length}`);
    }
    if ('color' in req.body) {
      const raw = (req.body.color || '').toString().trim();
      const color = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : null;
      params.push(color);
      updates.push(`color = $${params.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(wsId);
    await pool.query(
      `UPDATE radio_workspaces SET ${updates.join(', ')} WHERE id = $${params.length}`,
      params
    );
    const { rows: [row] } = await pool.query(
      `SELECT id, name, color FROM radio_workspaces WHERE id = $1`,
      [wsId]
    );
    res.json(row);
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
              f.size_bytes, f.duration_ms, f.text_content, f.manual_order,
              f.group_id, f.created_at,
              u.display_name AS owner_name
         FROM radio_files f
         JOIN users u ON u.id = f.owner_id
         ${where}
        ORDER BY f.created_at DESC
        LIMIT $${params.length}`,
      params
    );

    const base = process.env.R2_PUBLIC_URL;
    res.json(rows.map(r => ({
      ...r,
      url: r.r2_key ? `${base}/${r.r2_key}` : null,
    })));
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
      // Honor client-passed mime so web (audio/webm Opus) and mobile
      // (audio/mp4 AAC) recordings each land in R2 with the right
      // Content-Type — otherwise playback breaks in the browser.
      const clientMime = (req.body.mime_type || '').toString();
      if (clientMime === 'audio/webm') { mime = 'audio/webm'; ext = 'webm'; }
      else if (clientMime === 'audio/ogg') { mime = 'audio/ogg'; ext = 'ogg'; }
      else if (clientMime === 'audio/wav') { mime = 'audio/wav'; ext = 'wav'; }
      else { mime = VOICE_MIME; ext = VOICE_EXT; }
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

// POST /radio/workspaces/:id/text { content }
// Posts a text message into the workspace feed. Sized 0 (no R2 object).
router.post('/workspaces/:id/text', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    if (!(await isMember(wsId, myId))) return res.status(403).json({ error: 'Not a member' });

    const content = (req.body.content || '').toString().trim();
    if (!content) return res.status(400).json({ error: 'content required' });
    if (content.length > 5000) return res.status(400).json({ error: 'content too long (max 5000 chars)' });

    const fileId = uuid();
    const { rows: [row] } = await pool.query(
      `INSERT INTO radio_files
         (id, workspace_id, owner_id, kind, text_content, size_bytes)
       VALUES ($1, $2, $3, 'text', $4, 0)
       RETURNING *`,
      [fileId, wsId, myId, content]
    );

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
      const preview = content.length > 80 ? `${content.slice(0, 80)}…` : content;
      return notifications.sendToUsers(recipientIds, {
        title: `${senderName} (${wsName})`,
        body:  preview,
        data:  {
          type: 'radio_text',
          workspace_id: wsId,
          file_id: row.id,
          from_user_id: myId,
        },
      });
    })());

    res.status(201).json(row);
  } catch (err) { next(err); }
});

// PATCH /radio/files/:id { manual_order?, group_id? } — any workspace member.
// `manual_order` is a DOUBLE: items render sorted DESC by COALESCE(manual_order,
// created_at_epoch_ms). `group_id` is a uuid (or null to ungroup). Pass either
// field; missing fields are left untouched.
router.patch('/files/:id', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const fileId = req.params.id;

    const { rows: [f] } = await pool.query(
      `SELECT workspace_id FROM radio_files WHERE id = $1`,
      [fileId]
    );
    if (!f) return res.status(404).json({ error: 'File not found' });
    if (!(await isMember(f.workspace_id, myId))) {
      return res.status(403).json({ error: 'Not a member' });
    }

    const sets = [];
    const params = [];
    if ('manual_order' in req.body) {
      const raw = req.body.manual_order;
      const v = raw === null ? null : Number(raw);
      if (v !== null && !Number.isFinite(v)) {
        return res.status(400).json({ error: 'manual_order must be a number or null' });
      }
      params.push(v);
      sets.push(`manual_order = $${params.length}`);
    }
    if ('group_id' in req.body) {
      const v = req.body.group_id;
      if (v !== null) {
        const { rows: [g] } = await pool.query(
          `SELECT workspace_id FROM radio_message_groups WHERE id = $1`,
          [v]
        );
        if (!g || g.workspace_id !== f.workspace_id) {
          return res.status(400).json({ error: 'group_id must belong to this workspace' });
        }
      }
      params.push(v);
      sets.push(`group_id = $${params.length}`);
    }
    if (!sets.length) {
      return res.status(400).json({ error: 'manual_order or group_id required' });
    }

    params.push(fileId);
    await pool.query(
      `UPDATE radio_files SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );
    res.json({ id: fileId });
  } catch (err) { next(err); }
});

// ─── Radio: message groups ─────────────────────────────────────────────────

// GET /radio/workspaces/:id/message_groups — list groups in this workspace.
router.get('/workspaces/:id/message_groups', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    if (!(await isMember(wsId, myId))) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    const { rows } = await pool.query(
      `SELECT id, parent_id, name, color, manual_order, created_at
         FROM radio_message_groups
        WHERE workspace_id = $1
        ORDER BY created_at ASC`,
      [wsId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /radio/workspaces/:id/message_groups { name, color?, parent_id? }
router.post('/workspaces/:id/message_groups', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const wsId = req.params.id;
    if (!(await isMember(wsId, myId))) {
      return res.status(403).json({ error: 'Not a member' });
    }
    const name = (req.body.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'name required' });

    const rawColor = (req.body.color || '').toString().trim();
    const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor.toUpperCase() : null;
    const parentId = req.body.parent_id || null;
    if (parentId) {
      const { rows: [p] } = await pool.query(
        `SELECT workspace_id FROM radio_message_groups WHERE id = $1`,
        [parentId]
      );
      if (!p || p.workspace_id !== wsId) {
        return res.status(400).json({ error: 'parent_id must belong to this workspace' });
      }
    }
    const { rows: [g] } = await pool.query(
      `INSERT INTO radio_message_groups (workspace_id, parent_id, name, color)
       VALUES ($1, $2, $3, $4)
       RETURNING id, parent_id, name, color, manual_order, created_at`,
      [wsId, parentId, name, color]
    );
    res.status(201).json(g);
  } catch (err) { next(err); }
});

// PATCH /radio/message_groups/:id { name?, color?, parent_id?, manual_order? }
router.patch('/message_groups/:id', async (req, res, next) => {
  try {
    const myId = req.user.id;
    const gid = req.params.id;
    const { rows: [g] } = await pool.query(
      `SELECT workspace_id FROM radio_message_groups WHERE id = $1`,
      [gid]
    );
    if (!g) return res.status(404).json({ error: 'Group not found' });
    if (!(await isMember(g.workspace_id, myId))) {
      return res.status(403).json({ error: 'Not a member' });
    }
    const sets = [], params = [];
    if ('name' in req.body) {
      const v = (req.body.name || '').toString().trim();
      if (!v) return res.status(400).json({ error: 'name cannot be empty' });
      params.push(v); sets.push(`name = $${params.length}`);
    }
    if ('color' in req.body) {
      const raw = (req.body.color || '').toString().trim();
      const v = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : null;
      params.push(v); sets.push(`color = $${params.length}`);
    }
    if ('parent_id' in req.body) {
      const v = req.body.parent_id || null;
      if (v !== null) {
        if (v === gid) return res.status(400).json({ error: 'parent_id cannot be self' });
        const { rows: [p] } = await pool.query(
          `SELECT workspace_id FROM radio_message_groups WHERE id = $1`,
          [v]
        );
        if (!p || p.workspace_id !== g.workspace_id) {
          return res.status(400).json({ error: 'parent_id must belong to this workspace' });
        }
        // Reject cycles: walk parent chain from candidate and bail if we hit gid.
        let cur = v;
        for (let i = 0; i < 32 && cur; i++) {
          const { rows: [row] } = await pool.query(
            `SELECT parent_id FROM radio_message_groups WHERE id = $1`,
            [cur]
          );
          if (!row) break;
          if (row.parent_id === gid) {
            return res.status(400).json({ error: 'cycle: cannot nest under own descendant' });
          }
          cur = row.parent_id;
        }
      }
      params.push(v); sets.push(`parent_id = $${params.length}`);
    }
    if ('manual_order' in req.body) {
      const raw = req.body.manual_order;
      const v = raw === null ? null : Number(raw);
      if (v !== null && !Number.isFinite(v)) {
        return res.status(400).json({ error: 'manual_order must be a number or null' });
      }
      params.push(v); sets.push(`manual_order = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
    params.push(gid);
    await pool.query(
      `UPDATE radio_message_groups SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );
    res.json({ id: gid });
  } catch (err) { next(err); }
});

// DELETE /radio/message_groups/:id?cascade=true — `cascade=true` also deletes
// the files inside (and refunds storage). Default ungroups files and removes
// the group only.
router.delete('/message_groups/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const myId = req.user.id;
    const gid = req.params.id;
    const cascade = req.query.cascade === 'true';

    const { rows: [g] } = await client.query(
      `SELECT workspace_id FROM radio_message_groups WHERE id = $1`,
      [gid]
    );
    if (!g) return res.status(404).json({ error: 'Group not found' });
    if (!(await isMember(g.workspace_id, myId))) {
      return res.status(403).json({ error: 'Not a member' });
    }

    await client.query('BEGIN');
    let deletedKeys = [];
    if (cascade) {
      // Collect descendant group ids first.
      const groupIds = new Set([gid]);
      let frontier = [gid];
      for (let depth = 0; depth < 32 && frontier.length; depth++) {
        const { rows } = await client.query(
          `SELECT id FROM radio_message_groups WHERE parent_id = ANY($1::uuid[])`,
          [frontier]
        );
        frontier = rows.map(r => r.id).filter(id => !groupIds.has(id));
        frontier.forEach(id => groupIds.add(id));
      }
      const allIds = Array.from(groupIds);
      // Delete files in those groups, refunding storage to each owner.
      const { rows: files } = await client.query(
        `DELETE FROM radio_files
          WHERE group_id = ANY($1::uuid[])
          RETURNING owner_id, r2_key, size_bytes`,
        [allIds]
      );
      for (const f of files) {
        if (f.r2_key) deletedKeys.push(f.r2_key);
        if (Number(f.size_bytes || 0) > 0) {
          await client.query(
            `UPDATE users SET radio_storage_used_bytes = GREATEST(0, radio_storage_used_bytes - $1) WHERE id = $2`,
            [Number(f.size_bytes), f.owner_id]
          );
        }
      }
    }
    await client.query(`DELETE FROM radio_message_groups WHERE id = $1`, [gid]);
    await client.query('COMMIT');

    for (const key of deletedKeys) {
      r2().send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
      })).catch(() => {});
    }
    res.json({ deleted: true });
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
      [Number(f.size_bytes || 0), myId]
    );
    await client.query('COMMIT');

    if (f.r2_key) {
      r2().send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: f.r2_key,
      })).catch(() => {});
    }

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
