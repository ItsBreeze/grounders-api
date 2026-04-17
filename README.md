# Grounders API

Node.js + Express + PostgreSQL backend for the Grounders app.

---

## Setup

```bash
cp .env.example .env      # fill in DATABASE_URL and JWT_SECRET
npm install
npm run migrate           # creates all tables
npm run dev               # nodemon dev server
```

---

## Auth flow

All protected endpoints require:
```
Authorization: Bearer <token>
```

### 1 — Request OTP
```
POST /auth/request-otp
{ "phone": "+16041234567" }          -- or --
{ "email": "user@example.com" }
```
Response: `{ "message": "OTP sent", "_dev_otp": "123456" }` *(dev only)*

### 2 — Verify OTP + get token
```
POST /auth/verify-otp
{ "phone": "+16041234567", "code": "123456", "display_name": "Jamie Kim" }
```
Response: `{ "token": "eyJ...", "user": {...}, "is_new": true }`

---

## Endpoints

### Users
| Method | Path | Description |
|--------|------|-------------|
| GET | `/users/me` | My profile with post_count, friend_count, total_distance_m |
| PATCH | `/users/me` | Update display_name |
| GET | `/users/:id` | Another user's profile (friends or friend-of-friend only) |

---

### Posts
| Method | Path | Description |
|--------|------|-------------|
| POST | `/posts` | Create a post |
| GET | `/posts` | Map feed (see query params below) |
| GET | `/posts/:id` | Single post + reactions |
| DELETE | `/posts/:id` | Delete own post (recalculates distance aggregate) |
| GET | `/posts/by-user/:userId` | All posts by a user |

**POST /posts body:**
```json
{
  "type": "photo",
  "media_url": "https://cdn.example.com/abc.jpg",
  "media_thumb_url": "https://cdn.example.com/abc_thumb.jpg",
  "description": "Optional caption",
  "audio_title": "Required only for audio type",
  "lat": 49.2827,
  "lng": -123.1207,
  "visibility": "friends",
  "captured_at": "2025-01-01T12:00:00Z",
  "attestation_token": "...",
  "attestation_data": {}
}
```

**GET /posts query params:**
```
bbox=49.27,-123.14,49.30,-123.10   -- map viewport bounding box
visibility=friends|public|all
limit=50
before=2025-01-01T12:00:00Z        -- cursor for pagination
```

---

### Reactions
| Method | Path | Description |
|--------|------|-------------|
| PUT | `/posts/:postId/reactions` | Set/change reaction `{ "emoji": "❤️" }` |
| DELETE | `/posts/:postId/reactions` | Remove my reaction |
| GET | `/posts/:postId/reactions` | All reactions with counts |

Allowed emojis: `👍 ❤️ 🔥 😮 😂`

---

### Friends
| Method | Path | Description |
|--------|------|-------------|
| GET | `/friends` | My friends list |
| GET | `/friends/requests` | Inbound + outbound pending requests |
| POST | `/friends/requests` | Send request (by user_id, phone, or email) |
| POST | `/friends/requests/:id/accept` | Accept inbound request |
| DELETE | `/friends/requests/:id` | Decline or cancel a request |
| DELETE | `/friends/:userId` | **Unfriend** — atomically removes both directions |

**Friendship bidirectionality:**
The `friendships` table stores a single canonical row per pair (`user_id_a < user_id_b`).
`DELETE /friends/:userId` deletes that one row. Both users instantly lose each other —
no triggers, no second query, no race condition possible.

---

### Protected Zones
| Method | Path | Description |
|--------|------|-------------|
| GET | `/zones` | My zones |
| POST | `/zones` | Add zone `{ "lat": 49.28, "lng": -123.12 }` |
| DELETE | `/zones/:id` | Remove zone |

> Addresses are resolved to coordinates client-side (Google Places). Only `lat`/`lng` is sent to and stored by the API. No address text is ever persisted.

---

## Distance tracking

`users.total_distance_m` is a running aggregate updated incrementally:

- **On post**: fetch the user's `last_post_lat/lng`, compute haversine distance to new post, add to `total_distance_m`. Update `last_post_lat/lng`.
- **On delete**: recompute from scratch by fetching all remaining posts in chronological order. (Rare operation — acceptable cost.)

---

## Schema overview

```
users               — phone OR email, total_distance_m running aggregate
otps                — hashed 6-digit codes, 10-min TTL
posts               — photo/video/audio, GPS, attestation, visibility
reactions           — PRIMARY KEY (post_id, user_id), one emoji per user per post
friendships         — canonical (user_id_a < user_id_b), bidirectional by design
friend_requests     — pending/rejected states, cleaned up on accept
protected_zones     — lat/lng only, 500m radius default
```

---

## Production checklist

- [ ] Set `DEV_MODE=false` and wire up Twilio (SMS) + SendGrid (email)
- [ ] Add PostGIS extension for efficient geospatial bounding box queries
- [ ] Implement App Attest (iOS) and Play Integrity (Android) verification in `POST /posts`
- [ ] Add media upload endpoint (pre-signed S3 URLs) — keep media out of this API
- [ ] Enable SSL on the DB connection
- [ ] Set a strong `JWT_SECRET` (32+ random chars)
- [ ] Add Redis for OTP dedup and reaction rate-limit caching
