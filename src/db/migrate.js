/**
 * Grounders — Database Migration
 *
 * Run with: node src/db/migrate.js
 *
 * Schema overview:
 *  users            — phone OR email auth, running distance aggregate
 *  otps             — short-lived codes for phone/email verification
 *  posts            — photo/video/audio with GPS + attestation
 *  reactions        — one emoji per user per post (upsertable)
 *  friendships      — canonical bidirectional rows (user_id_a < user_id_b)
 *  friend_requests  — pending inbound/outbound
 *  protected_zones  — GPS-only, no address text stored
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
  phone             TEXT        UNIQUE,                  -- E.164 e.g. +16041234567
  email             TEXT        UNIQUE,
  -- At least one of phone/email must be set (enforced via check)
  total_distance_m  FLOAT       NOT NULL DEFAULT 0,      -- running aggregate
  last_post_lat     DOUBLE PRECISION,                    -- for incremental distance calc
  last_post_lng     DOUBLE PRECISION,
  last_post_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT phone_or_email CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;


-- ─── OTPs ──────────────────────────────────────────────────────────────────
-- Stores hashed OTP codes for phone/email verification.
-- A NULL phone means it's an email OTP and vice versa.
CREATE TABLE IF NOT EXISTS otps (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  target      TEXT        NOT NULL,     -- the phone or email
  code_hash   TEXT        NOT NULL,     -- bcrypt hash of the 6-digit code
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otps_target ON otps(target);


-- ─── Posts ─────────────────────────────────────────────────────────────────
CREATE TYPE post_type AS ENUM ('photo', 'video', 'audio');
CREATE TYPE visibility AS ENUM ('friends', 'public');

CREATE TABLE IF NOT EXISTS posts (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              post_type    NOT NULL,
  media_url         TEXT         NOT NULL,      -- S3/CDN URL
  media_thumb_url   TEXT,                        -- thumbnail for photo/video
  description       TEXT,
  audio_title       TEXT,                        -- required when type = 'audio'
  lat               DOUBLE PRECISION NOT NULL,
  lng               DOUBLE PRECISION NOT NULL,
  visibility        visibility   NOT NULL DEFAULT 'friends',
  -- Hardware attestation fields
  captured_at       TIMESTAMPTZ  NOT NULL,       -- sealed at capture time in-app
  attestation_token TEXT,                        -- App Attest / Play Integrity token
  attestation_data  JSONB,                       -- full attestation payload
  posted_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT audio_requires_title CHECK (type != 'audio' OR audio_title IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_posts_user     ON posts(user_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_location ON posts USING gist (
  -- for bounding-box queries when Postgis is added; lat/lng columns for now
  point(lng, lat) point_ops
) WHERE FALSE; -- placeholder; enable after adding PostGIS
CREATE INDEX IF NOT EXISTS idx_posts_posted   ON posts(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_latng    ON posts(lat, lng);


-- ─── Reactions ─────────────────────────────────────────────────────────────
-- One reaction per user per post. Upsert to change emoji, delete to remove.
CREATE TABLE IF NOT EXISTS reactions (
  post_id     UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);


-- ─── Friendships ───────────────────────────────────────────────────────────
-- Canonical bidirectional friendship. user_id_a < user_id_b (text compare)
-- ensures exactly one row per pair regardless of who initiated.
-- Deleting this row removes the friendship in both directions atomically.
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
CREATE TYPE request_status AS ENUM ('pending', 'rejected');

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
-- Stored as coordinates only — no address text ever persisted.
CREATE TABLE IF NOT EXISTS protected_zones (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  radius_m    INTEGER     NOT NULL DEFAULT 500,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zones_user ON protected_zones(user_id);

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
