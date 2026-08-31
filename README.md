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

## Google multi-account MCP connector

A remote [MCP](https://modelcontextprotocol.io) server that gives Claude access to
**several Google accounts at once** — Gmail, Calendar, Drive, Contacts and Tasks.
Claude's built-in Google connectors each hold exactly one account; connecting a
second replaces the first. This holds as many as you link, and every search tool
fans out across all of them in a single call.

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
| GET | `/gmail/connect` | Link an account (repeat per account) |
| POST | `/gmail/unlink` | Unlink one, revoking the grant at Google |

### Tools (53)

Every tool takes an optional `account`. On a search, **omitting it fans the call
out across every linked account** and merges the results — the thing no
single-account connector can do. On a write it names the one account to act on,
so "create this event" is never ambiguous about whose calendar it lands in.

#### Gmail (23)

| Area | Tools | Notes |
|------|-------|-------|
| Accounts | `list_accounts` | Which accounts are linked, with token health |
| Search | `search_messages`, `search_threads` | Gmail query syntax, merged and date-sorted across accounts. `search_threads` returns one row per conversation — subject, every participant, message and unread counts, last activity — for "where does my thread with X stand" without pulling bodies |
| Read | `get_message`, `get_thread`, `get_attachment` | Bodies flattened to text and capped at 60 KB; attachment metadata included. **`get_attachment` extracts text from PDF, Word, Excel, PowerPoint and OpenDocument attachments**, so an emailed contract or invoice is readable directly; anything else comes back base64 (2 MB cap) |
| Send | `send_message`, `reply_to_message`, `forward_message` | Replies thread via `In-Reply-To`/`References`; forwards carry attachments (10 MB cap, skipped ones named) |
| Drafts | `create_draft`, `list_drafts`, `get_draft`, `update_draft`, `send_draft`, `delete_draft` | `create_draft` with `reply_to_message_id` drafts an in-thread reply for review — the safe path for AI-written mail |
| Labels | `modify_labels`, `list_labels`, `create_label`, `update_label`, `delete_label` | `modify_labels` takes `message_id` or `thread_id`; removing `INBOX` archives |
| Trash & spam | `trash_message`, `untrash_message`, `mark_spam` | All take `message_id` or `thread_id`; trash is recoverable for 30 days; `mark_spam` with `unmark: true` restores |

#### Calendar (9)

| Area | Tools | Notes |
|------|-------|-------|
| Read | `list_calendars`, `list_events`, `search_events`, `get_event` | `list_events` merges every linked calendar into one timeline, defaulting to the next 7 days; recurring series are expanded into actual occurrences, so a weekly standup appears on each day it happens |
| Write | `create_event`, `update_event`, `delete_event` | Times are ISO 8601; a bare `YYYY-MM-DD` means all-day. `update_event` patches — unmentioned fields keep their value. Attendees are **not** emailed unless `send_updates` says so |
| RSVP | `respond_to_event` | accepted / declined / tentative, as the account that was invited; notifies the organiser by default |
| Scheduling | `suggest_time` | Free slots across **every** linked calendar at once — busy anywhere means busy. Returns whole gaps rather than chopping a 3-hour opening into six half-hour slots |

#### Drive (14)

| Area | Tools | Notes |
|------|-------|-------|
| Find | `search_files`, `list_recent_files`, `get_file_metadata` | Text search over names and contents, with optional raw Drive query syntax in `filter`. Trashed files excluded unless you ask for them |
| Read | `read_file_content`, `download_file_content` | Docs, Sheets and Slides exported (Sheets as CSV); **PDF, Word, Excel, PowerPoint and OpenDocument extracted to text**; `ocr: true` routes scans and images through Google's own conversion; `include_comments` returns the comment threads. `download_file_content` takes `export_as` — turn a Doc into a PDF or docx, a Sheet into xlsx. Text caps at 60 KB, binaries at 2 MB base64 |
| Write | `create_file`, `update_file`, `copy_file` | Text via `content`, binary via `content_base64`. `convert_to` makes Drive convert the upload into an editable Doc, Sheet or Slides — or a folder. `update_file` renames, moves and describes; overwriting contents additionally needs `replace_content: true` |
| Comment | `comment_on_file` | Leave a comment on a draft, or reply to a thread — the review path that changes nothing in the document |
| Sharing | `get_file_permissions`, `share_file`, `unshare_file` | Shares with one named person at reader/commenter/writer. Domain-wide and public-link sharing are off unless `DRIVE_ALLOW_PUBLIC_SHARING=true`, and then still need `confirm_public`. **`unshare_file` withdraws access** — by person, by domain, or by removing the public link |
| Remove | `trash_file`, `untrash_file` | Trash and restore, within the 30-day window — see the scope note below |

#### Contacts (2) and Tasks (5)

| Area | Tools | Notes |
|------|-------|-------|
| Contacts | `search_contacts`, `list_contacts` | Read-only. Searches saved contacts **and** people the account has corresponded with, so "email Ann" resolves to an address instead of a guess |
| Tasks | `list_task_lists`, `list_tasks`, `create_task`, `update_task`, `delete_task` | `list_id` defaults to the account's first list. `update_task` with `completed: true` ticks a task off; `false` reopens it. Google Tasks has no trash, so `delete_task` is permanent |

### Document text extraction

`read_file_content` and `get_attachment` both return text for PDF, Word, Excel,
PowerPoint and OpenDocument files, using only Node's standard library — no
parsing dependency to vendor, audit or keep current.

| Format | How | Notes |
|--------|-----|-------|
| .docx / .odt | ZIP + XML | Paragraphs, tabs and line breaks preserved; styles and revision marks dropped |
| .xlsx / .ods | ZIP + XML | One CSV block per sheet, named from the workbook relationships. Cells are placed by column letter, so a gap stays a gap |
| .pptx / .odp | ZIP + XML | One block per slide, in presentation order |
| .pdf | Content-stream parsing | Flate, ASCII85 and ASCIIHex filter chains; literal, hex and octal strings; positioning operators become line breaks |

**Where it stops, and what happens then.** Two kinds of PDF have no text to
extract: a scan, which is a picture of a page, and one whose fonts are CID-keyed
or subset, where the bytes in the content stream are glyph numbers that need the
font's own tables to become letters. Both would decode into confident-looking
nonsense, so the result is scored for readability and **refused** rather than
returned — the refusal names the cause and points at the fix.

That fix is `ocr: true` on `read_file_content`, which copies the file as a Google
Doc (Drive runs OCR during that conversion), exports the text, and deletes the
copy in a `finally` block. It reads scans, photographs and images. Two things
worth knowing: it is the one place this server writes to Drive during a read, and
that delete is the only permanent delete in the whole server — its target is a
file created seconds earlier by that same call, never anything the user put
there. If the cleanup itself fails, the result says so and names the file.

Extraction is capped at 60 KB like every other body, with the cut flagged.

### Setup

1. **Google Cloud** — create a project; enable the **Gmail, Calendar, Drive, People
   and Tasks** APIs; configure the consent screen as **External**, and add every
   Google address you plan to link as a **test user**. Create an OAuth client of type
   **Web application** with the authorized redirect URI set to exactly
   `<PUBLIC_BASE_URL>/gmail/oauth/callback`.
2. **Env** — set `PUBLIC_BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `MCP_ADMIN_PASSWORD` and `TOKEN_ENC_KEY` (see `.env.example`), then deploy.
3. **Link accounts** — visit `<PUBLIC_BASE_URL>/gmail/connect` once per account.
4. **Add to Claude** — Settings → Connectors → Add custom connector →
   `<PUBLIC_BASE_URL>/mcp`. Claude registers itself, sends you to the consent
   screen, and you enter `MCP_ADMIN_PASSWORD` once.

> **Upgrading from a Gmail-only deployment:** the granted scopes are fixed at link
> time, so an account linked before Calendar, Drive, Contacts and Tasks existed
> holds a Gmail-only grant. Google will not extend it retroactively. Visit
> `/gmail/connect` again for each account — that adds the missing access and
> changes nothing else. Until then the new tools name the account and say to
> re-link it, rather than failing with an opaque 403.

### Security notes

- Google refresh and access tokens are AES-256-GCM encrypted at rest under
  `TOKEN_ENC_KEY`. The database never holds a usable token.
- **Mail cannot be permanently deleted.** The Gmail scope is `gmail.modify`:
  read, send, label, archive, trash. It deliberately excludes `mail.google.com`,
  so `trash_message` is recoverable for 30 days and nothing here can destroy mail.
- **Drive is different, and the difference is worth knowing.** Drive has no
  equivalent middle scope: `drive.file` only sees files this app itself created,
  which cannot answer "find my lease", so searching and editing existing files
  needs full `drive` — which *does* permit permanent deletion. There the limit is
  enforced by the tool surface instead: `trash_file` trashes, and no tool reaches
  Drive's permanent-delete endpoint. That is a weaker guarantee than Gmail's,
  because it is a matter of what is exposed rather than what is possible.
- **Every outward action has an undo, which is the condition for offering it.**
  `unshare_file` withdraws any grant `share_file` can make, and `untrash_file`
  restores what `trash_file` removed. The first-party connector has neither,
  so a permission it grants cannot be taken back through the same interface.
  This is the one place the wider surface here is also the safer one.
- **Contacts are read-only** by scope, not just by omission.
- **Drive writes are guarded where the first-party connector is simply narrower.**
  Claude's Drive connector shares with one email address and a role — it has no
  way to publish a file — and its `update_file` changes only the title and parent.
  Two guards match that default, because both failures are one-way and neither
  looks alarming in a tool result:
  - `share_file` takes a named person only. Domain-wide and public-link sharing
    need `DRIVE_ALLOW_PUBLIC_SHARING=true`, and are refused outright otherwise
    rather than quietly narrowed to something safer. Even enabled, they need
    `confirm_public: true` as a second signal, and the refusal spells out what
    the grant would actually mean before it is repeated.
  - Overwriting a file's contents needs `replace_content: true` alongside
    `content`, so a rename can never destroy a document as a side effect.
- Authorization codes are single-use and hashed; PKCE S256 is required; refresh
  tokens rotate on every use; `redirect_uri` must match the registration exactly.
- While the Google app stays in **Testing**, refresh tokens expire after 7 days
  and accounts must be re-linked. Publishing the app stops that, but Gmail, Drive
  and Contacts are all restricted scopes, so Google verification applies.

### Architecture

```
src/services/google_http.js     shared transport: URL building, bearer auth,
                                error unwrapping, bounded-concurrency mapLimit
src/services/gmail_api.js       one thin client per Google API, each returning
src/services/calendar_api.js    shaped results rather than raw payloads
src/services/drive_api.js
src/services/people_api.js
src/services/tasks_api.js
src/services/office_text.js     .docx/.xlsx/.pptx/.odt text, via a ZIP reader
src/services/pdf_text.js        PDF content-stream text, with a readability guard
src/services/text_extract.js    one entry point both Drive and Gmail read through
src/services/gmail_accounts.js  linked accounts, token refresh, scope gating
src/mcp/shared.js               resolveAccount / tokenFor / fanOut / mergeSearch
src/mcp/tools/                  one module per product, assembled by index.js
```

Rate limits are respected rather than discovered: Google meters quota per user
per second, so per-item detail fetches run five at a time, and a fetch that fails
anyway is **counted** in `unavailable_*` rather than silently dropped from the
results.

### Tests

Nine suites, all plain Node — no framework, no new dependencies. 338 checks.

```bash
# No database, no network:
npm run test:tokens     # MCP and user tokens cannot be swapped, in either direction
npm run test:query      # Google query-string construction (repeated array params)
npm run test:mime       # entity decoding, body truncation, MIME construction
npm run test:threads    # address parsing, thread summaries, cross-account fan-out
npm run test:products   # free-slot arithmetic, Drive query quoting, multipart
                        # upload framing, task dates, scope gating, tool-surface shape
npm run test:drive-safety   # the sharing and overwrite guards, both env states
npm run test:extract    # PDF and Office text extraction, against real fixtures
npm run test:drive-parity   # upload framing, conversion, export and comments, on the wire

# Needs a database:
DATABASE_URL=postgres://…  npm run test:accounts   # resolution + encryption at rest

# Needs the API running:
npm start &
TEST_BASE_URL=http://127.0.0.1:3000  npm run test:mcp   # OAuth + MCP protocol
```
