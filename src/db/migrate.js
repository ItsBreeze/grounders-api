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

CREATE INDEX IF NOT EXISTS idx_posts_user     ON posts(user_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_posted   ON posts(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_latng    ON posts(lat, lng);


-- ─── Reactions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reactions (
  post_id     UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);


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
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();/**
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

CREATE INDEX IF NOT EXISTS idx_posts_user     ON posts(user_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_posted   ON posts(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_latng    ON posts(lat, lng);


-- ─── Reactions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reactions (
  post_id     UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);


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

`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running Grounders migration…');
    await client.query(SQL);
    console.log('Migration complete ✓');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
