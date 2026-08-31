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

---

## Gmail multi-account MCP connector

A remote [MCP](https://modelcontextprotocol.io) server that gives Claude access to
**several Gmail accounts at once**. Claude's built-in Gmail connector holds exactly
one Google account — connecting a second replaces the first. This holds as many as
you link, and `search_messages` fans out across all of them in a single call.

Self-contained: four tables, no foreign keys into the Grounders schema, its own env
vars. Delete the routes and the migration block to remove it entirely.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mcp` | MCP Streamable HTTP endpoint (Bearer auth) |
| GET | `/mcp/oauth/authorize` | Consent screen — operator password |
| POST | `/mcp/oauth/token` | Token + refresh grants |
| POST | `/mcp/oauth/register` | RFC 7591 dynamic client registration |
| GET | `/.well-known/oauth-protected-resource` | RFC 9728 discovery |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 discovery |
| GET | `/gmail/connect` | Link a mailbox (repeat per account) |
| POST | `/gmail/unlink` | Unlink one, revoking the grant at Google |

### Tools (22)

| Area | Tools | Notes |
|------|-------|-------|
| Accounts | `list_accounts` | Which mailboxes are linked, with token health |
| Search | `search_messages` | Gmail query syntax. **Omit `account` to search every mailbox**, merged and date-sorted. Per-mailbox `page_token` pagination |
| Read | `get_message`, `get_thread`, `get_attachment` | Bodies flattened to text and capped at 60 KB; attachment metadata included; `get_attachment` returns text files as text, binaries as base64 (2 MB cap) |
| Send | `send_message`, `reply_to_message`, `forward_message` | Replies thread via `In-Reply-To`/`References`; forwards carry attachments (10 MB cap, skipped ones named) |
| Drafts | `create_draft`, `list_drafts`, `get_draft`, `update_draft`, `send_draft`, `delete_draft` | `create_draft` with `reply_to_message_id` drafts an in-thread reply for review — the safe path for AI-written mail |
| Labels | `modify_labels`, `list_labels`, `create_label`, `update_label`, `delete_label` | `modify_labels` takes `message_id` or `thread_id`; removing `INBOX` archives |
| Trash & spam | `trash_message`, `untrash_message`, `mark_spam` | All take `message_id` or `thread_id`; trash is recoverable for 30 days; `mark_spam` with `unmark: true` restores |

### Setup

1. **Google Cloud** — create a project, enable the Gmail API, configure the consent
   screen as **External**, and add every Gmail address you plan to link as a
   **test user**. Create an OAuth client of type **Web application** with the
   authorized redirect URI set to exactly `<PUBLIC_BASE_URL>/gmail/oauth/callback`.
2. **Env** — set `PUBLIC_BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `MCP_ADMIN_PASSWORD` and `TOKEN_ENC_KEY` (see `.env.example`), then deploy.
3. **Link mailboxes** — visit `<PUBLIC_BASE_URL>/gmail/connect` once per account.
4. **Add to Claude** — Settings → Connectors → Add custom connector →
   `<PUBLIC_BASE_URL>/mcp`. Claude registers itself, sends you to the consent
   screen, and you enter `MCP_ADMIN_PASSWORD` once.

### Security notes

- Gmail refresh and access tokens are AES-256-GCM encrypted at rest under
  `TOKEN_ENC_KEY`. The database never holds a usable token.
- Scope is `gmail.modify`: read, send, label, archive, trash. It deliberately
  excludes the `mail.google.com` scope, so **nothing here can permanently delete
  mail** — `trash_message` is recoverable for 30 days.
- Authorization codes are single-use and hashed; PKCE S256 is required; refresh
  tokens rotate on every use; `redirect_uri` must match the registration exactly.
- While the Google app stays in **Testing**, refresh tokens expire after 7 days
  and mailboxes must be re-linked. Publishing the app stops that, but Gmail's
  restricted scopes then require Google verification.

### Tests

Both suites are plain Node — no framework, no new dependencies.

```bash
DATABASE_URL=postgres://…  npm run test:accounts   # resolution + encryption at rest
npm start &                                        # then, against the running API:
TEST_BASE_URL=http://127.0.0.1:3000  npm run test:mcp   # OAuth + MCP protocol
```
