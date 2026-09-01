/**
 * Grounders — Database Migration
 *
 * Run with: node src/db/migrate.js
 *
 * Idempotent — safe to re-run. CREATE TYPE statements are wrapped in DO blocks
 * so subsequent runs don't error on existing types.
 */

require('dotenv').config();
const pool = require('./pool');

const SQL = `

-- ─── Extensions ────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ─── Users ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  display_name      TEXT        NOT NULL DEFAULT '',
  phone             TEXT        UNIQUE,
  email             TEXT        UNIQUE,
  total_distance_m  FLOAT       NOT NULL DEFAULT 0,
  last_post_lat     DOUBLE PRECISION,
  last_post_lng     DOUBLE PRECISION,
  last_post_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT phone_or_email CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;

-- Soft-delete flag for the 14-day account deletion grace period.
-- NULL = active. Non-null = soft-deleted at that timestamp;
-- the daily reaper hard-deletes after NOW() - INTERVAL '14 days'.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_pending_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_deletion_pending
  ON users (deletion_pending_at)
  WHERE deletion_pending_at IS NOT NULL;


-- ─── OTPs ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otps (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  target      TEXT        NOT NULL,
  code_hash   TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otps_target ON otps(target);


-- ─── Refresh tokens ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);


-- ─── Posts ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE post_type AS ENUM ('photo', 'video', 'audio');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE visibility AS ENUM ('friends', 'public');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS posts (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              post_type    NOT NULL,
  media_url         TEXT         NOT NULL,
  media_thumb_url   TEXT,
  description       TEXT,
  audio_title       TEXT,
  lat               DOUBLE PRECISION NOT NULL,
  lng               DOUBLE PRECISION NOT NULL,
  visibility        visibility   NOT NULL DEFAULT 'friends',
  captured_at       TIMESTAMPTZ  NOT NULL,
  attestation_token TEXT,
  attestation_data  JSONB,
  posted_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT audio_requires_title CHECK (type != 'audio' OR audio_title IS NOT NULL)
);

-- Soft-delete column for the per-user Archive — feed/profile queries
-- exclude rows where this is non-null; the archive endpoint surfaces
-- only those rows back to the owner.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Denormalized counter maintained by reactions triggers below. Keeps
-- the per-pin payload free of a LEFT JOIN + GROUP BY that the map
-- viewport fetch hits on every camera-idle.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS reaction_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_posts_user     ON posts(user_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_posted   ON posts(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_latng    ON posts(lat, lng);
CREATE INDEX IF NOT EXISTS idx_posts_archived ON posts(user_id, archived_at) WHERE archived_at IS NOT NULL;


-- ─── Reactions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reactions (
  post_id     UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);

-- Keep posts.reaction_count in sync. Emoji-change UPDATEs are
-- intentionally ignored — only genuine new reactions and removals
-- shift the count.
CREATE OR REPLACE FUNCTION posts_reaction_count_sync() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE posts SET reaction_count = reaction_count + 1 WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE posts SET reaction_count = GREATEST(reaction_count - 1, 0) WHERE id = OLD.post_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reactions_count_trg ON reactions;
CREATE TRIGGER reactions_count_trg
  AFTER INSERT OR DELETE ON reactions
  FOR EACH ROW EXECUTE FUNCTION posts_reaction_count_sync();

-- One-shot backfill for existing rows; no-op once the trigger has
-- been the only writer (the WHERE guards against repeated drift on
-- every migration run).
UPDATE posts p
SET reaction_count = sub.cnt
FROM (
  SELECT post_id, COUNT(*)::int AS cnt FROM reactions GROUP BY post_id
) sub
WHERE p.id = sub.post_id AND p.reaction_count <> sub.cnt;


-- ─── Friendships ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friendships (
  user_id_a   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id_b   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id_a, user_id_b),
  CONSTRAINT canonical_order CHECK (user_id_a < user_id_b),
  CONSTRAINT no_self_friend  CHECK (user_id_a != user_id_b)
);

CREATE INDEX IF NOT EXISTS idx_friendships_a ON friendships(user_id_a);
CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_id_b);


-- ─── Friend Requests ───────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE request_status AS ENUM ('pending', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS friend_requests (
  id           UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_user_id UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       request_status NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT no_self_request    CHECK (from_user_id != to_user_id),
  CONSTRAINT unique_pending     UNIQUE (from_user_id, to_user_id)
);

CREATE INDEX IF NOT EXISTS idx_requests_to   ON friend_requests(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_from ON friend_requests(from_user_id, status);


-- ─── Protected Zones ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS protected_zones (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  radius_m    INTEGER     NOT NULL DEFAULT 500,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zones_user ON protected_zones(user_id);


-- ─── Device tokens (FCM) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_tokens (
  token         TEXT        PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      TEXT        NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);


-- ─── Reports ───────────────────────────────────────────────────────────────
-- User-submitted reports on posts. Required by Apple/Google for any app
-- with user-generated content. Status is text (not enum) so new states
-- can be added without a migration.
CREATE TABLE IF NOT EXISTS reports (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id      UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  reporter_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT        NOT NULL,
  details      TEXT,
  status       TEXT        NOT NULL DEFAULT 'open',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at);


-- ─── Blocks ────────────────────────────────────────────────────────────────
-- One row per (blocker, blocked) pair. Posts and presence of blocked users
-- are filtered out for the blocker. Symmetric blocking (the blocker is
-- also hidden FROM the blocked user) is handled in the route layer.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT no_self_block CHECK (blocker_id != blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);


-- ─── Radio: per-user flags & storage usage ─────────────────────────────────
-- radio_enabled flips true the first time a user signs in via grounders.radio.app.
-- radio_storage_used_bytes is a running aggregate maintained by upload/delete
-- routes; billing enforcement is deferred (free tier for now).
ALTER TABLE users ADD COLUMN IF NOT EXISTS radio_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS radio_storage_used_bytes BIGINT NOT NULL DEFAULT 0;
-- Per-user Radio dial layout (UI state).
-- Shape: { tiles: [{ id, type: 'contact'|'workspace', ref_id, group_id?: string }], groups: [{ id, name, x?, y? }] }
-- Schema is intentionally loose so the client can evolve layout without a migration.
ALTER TABLE users ADD COLUMN IF NOT EXISTS radio_dial_state JSONB NOT NULL DEFAULT '{"tiles":[],"groups":[]}'::jsonb;


-- ─── Radio: workspaces ─────────────────────────────────────────────────────
-- A workspace is a group chronological feed of voice notes + files.
-- The creator owns it and pays for the storage of files they upload.
-- Storage is always charged to the uploader, not the workspace owner.
CREATE TABLE IF NOT EXISTS radio_workspaces (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_radio_workspaces_owner ON radio_workspaces(owner_id);

-- Optional hex color (e.g. "#1E88E5") for group workspaces. Surface in the
-- dial so users can visually distinguish their groups.
ALTER TABLE radio_workspaces ADD COLUMN IF NOT EXISTS color TEXT;


-- ─── Radio: workspace members ──────────────────────────────────────────────
-- The owner is also a member (inserted on workspace create). Members must
-- be friends of the user who added them — enforced in the route layer.
CREATE TABLE IF NOT EXISTS radio_workspace_members (
  workspace_id  UUID        NOT NULL REFERENCES radio_workspaces(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_radio_members_user ON radio_workspace_members(user_id);


-- ─── Radio: files (voice notes + uploaded files) ───────────────────────────
-- One row per uploaded artifact in a workspace. r2_key is the Cloudflare R2
-- object key; size_bytes is captured at upload time and used to maintain
-- users.radio_storage_used_bytes on insert/delete.
DO $$ BEGIN
  CREATE TYPE radio_file_kind AS ENUM ('voice_note', 'file');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Allow 'text' as a third kind so the chronological feed can carry typed
-- messages alongside voice notes and files. Older deployments need the
-- value added to the existing enum; new deployments bake it in below.
ALTER TYPE radio_file_kind ADD VALUE IF NOT EXISTS 'text';

CREATE TABLE IF NOT EXISTS radio_files (
  id            UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id  UUID            NOT NULL REFERENCES radio_workspaces(id) ON DELETE CASCADE,
  owner_id      UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          radio_file_kind NOT NULL,
  r2_key        TEXT            NOT NULL,
  mime_type     TEXT,
  filename      TEXT,
  size_bytes    BIGINT          NOT NULL,
  duration_ms   INTEGER,
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Text messages reuse this table but don't have an R2 object — relax the
-- NOT NULL constraints and add a text column. Route layer enforces the
-- "text rows have text_content; voice/file rows have r2_key" invariant.
ALTER TABLE radio_files ALTER COLUMN r2_key      DROP NOT NULL;
ALTER TABLE radio_files ALTER COLUMN size_bytes  DROP NOT NULL;
ALTER TABLE radio_files ADD COLUMN IF NOT EXISTS text_content TEXT;

-- Per-item manual ordering. When set, the client renders the item at this
-- position instead of its chronological place. Time-pill turns red on the
-- frontend whenever the displayed position diverges from created_at order.
ALTER TABLE radio_files ADD COLUMN IF NOT EXISTS manual_order DOUBLE PRECISION;

-- Optional grouping inside a workspace. Mirrors the dial-screen group model:
-- nestable via parent_id, draggable as a unit via manual_order.
CREATE TABLE IF NOT EXISTS radio_message_groups (
  id            UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id  UUID            NOT NULL REFERENCES radio_workspaces(id) ON DELETE CASCADE,
  parent_id     UUID            REFERENCES radio_message_groups(id) ON DELETE CASCADE,
  name          TEXT            NOT NULL DEFAULT '',
  color         TEXT,
  manual_order  DOUBLE PRECISION,
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_radio_msg_groups_ws ON radio_message_groups(workspace_id);
CREATE INDEX IF NOT EXISTS idx_radio_msg_groups_parent ON radio_message_groups(parent_id);

-- Each file/message can belong to one group. Deleting a group sets this null
-- (ungroups its members) rather than deleting the file — the route layer
-- handles "delete group + files" explicitly when requested.
ALTER TABLE radio_files ADD COLUMN IF NOT EXISTS group_id UUID
  REFERENCES radio_message_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_radio_files_workspace ON radio_files(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radio_files_owner     ON radio_files(owner_id);
CREATE INDEX IF NOT EXISTS idx_radio_files_group     ON radio_files(group_id);


-- ─── App Review backdoor user ──────────────────────────────────────────────
-- Pre-seeded user for App Store / Play Console reviewers. The
-- /auth/verify-otp shortcut uses APP_REVIEW_PHONE / APP_REVIEW_OTP env
-- vars to authenticate this user without sending a real SMS.
INSERT INTO users (phone, display_name)
VALUES ('+17777777777', 'App Reviewer')
ON CONFLICT (phone) DO NOTHING;

`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running Grounders migration…');
    await client.query(SQL);
    console.log('Migration complete ✓');
  } finally {
    client.release();
  }
}

// CLI mode: `node src/db/migrate.js` — close the pool when done.
// Library mode (require'd by server.js): leave the pool open so the
// app keeps using it after schema is up-to-date.
if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch(err => {
      console.error('Migration failed:', err.message);
      pool.end();
      process.exit(1);
    });
}

module.exports = { migrate };
