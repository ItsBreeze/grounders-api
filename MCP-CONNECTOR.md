# Grounders + Radio MCP Connector

Your Grounders feed and your Radio threads, inside whatever assistant you
already use. `POST /mcp` is a Model Context Protocol server: a user adds the
URL in Claude's Settings → Connectors (or ChatGPT's, or Gemini's), signs in
once with the phone number they use in the apps, and from then on their
assistant can read their posts, friends and messages mid-conversation.

It is the same design as Offhand's connector — same protocol, same OAuth
shape, same consent flow — so a user with both adds two URLs and gets one
assistant that can answer across notes, posts and messages. Grounders and
Radio share this API and this database, so they share one connector. Offhand's
own in-app assistant reads through it too, linked by phone number rather than
a consent page — see *Offhand, built in* below.

```
Connector URL:  https://<PUBLIC_BASE_URL>/mcp
Sign in with:   the phone number you use in Grounders or Radio
Reads:          posts (with photos), friends, Radio messages and files
Never:          voice notes, phone numbers, anything written
```

---

## What the assistant can do

| Ask | Tool it reaches for |
|---|---|
| "What were my friends up to this week?" | `feed` — last 7 days, friends + you, grouped by person |
| "Show me what Sam posted in August" | `feed` with `friend: "Sam"`, `since`/`until` |
| "Who's been near Whistler lately?" | `feed` with `near: {lat, lng, radius_m}` |
| "What's in that photo?" | `fetch post:…` — returns the thumbnail as an image the model can see |
| "Which of my friends has gone quiet?" | `friends` — last post, posts in 30 days, friends since |
| "What did Dana and I decide about Friday?" | `radio_messages` with `with: "Dana"` |
| "Find the PDF Jordan shared" | `search` then `fetch message:…` |
| "How much have I posted?" | `me` |

Seven read tools, offered to every client:

| Tool | Does |
|---|---|
| `search` | Keyword search over captions, posters, friend names, Radio text and file names, workspace names. Returns `{id, title, text, url, kind}` |
| `fetch` | One item by prefixed id: `post:` (with image), `user:` (profile + recent posts + shared workspaces), `workspace:` (members + recent messages), `message:` (full text, or a file: images as image, text files inline, others as a link) |
| `feed` | Posts over a window, filtered by person, type or place; returns posts and a per-person summary |
| `friends` | Friends with activity signals, plus pending requests both ways |
| `me` | Own account summary, no contact details |
| `radio_workspaces` | Conversations you are in: members, unread, counts by kind |
| `radio_messages` | One conversation in order, text in full, files with links |

`search` and `fetch` are named and shaped to match ChatGPT's knowledge-base
connector contract, which requires exactly those two. Claude and Gemini do
not care, so matching costs nothing and buys a client.

### Sending, for a client that may

Seven more tools appear only for a grant carrying `grounders.write`, which
today is Offhand's partner link and nothing else. A grant from the consent
page — Claude, ChatGPT, Gemini — never sees them in `tools/list`, and naming
one anyway is refused before any query runs. Nobody's Radio grows a send
button because they added a connector.

| Tool | Does |
|---|---|
| `radio_send_message` | A text message into a conversation, addressed by `to` (a friend's name → the direct thread) or `workspace_id` |
| `radio_send_file` | Fetches an https URL — a Grounders photo, a file from another thread, a link — and sends it as a file, with an optional message alongside. 20 MB |
| `radio_start_conversation` | Opens (or finds) the direct thread with a friend, or creates a named group |
| `radio_add_member` | Adds a friend to a group you are in |
| `radio_rename_conversation` | Renames a group |
| `radio_mark_read` | Clears the unread count, as opening it would |
| `radio_delete_message` | Deletes one of your own messages — the way to take something back |

Radio only. A Grounders post needs a photo taken at a place at a time and
belongs to the camera in the user's hand, so Grounders stays read-only through
the connector however the grant is scoped.

The bounds are the app's bounds, enforced per call: you can only write into a
conversation you are a member of, only add someone you are already friends
with, and only delete a message you sent. Every message goes through
`src/services/radio_send.js`, which is also what `POST /radio/workspaces/:id/text`
and `/files` call — so a message sent by an assistant is the same row, with the
same push notification, as one sent from the app.

`radio_send_file` will only fetch public https, and resolves every redirect hop
against the private address ranges before requesting it: the URL comes from a
model, which got it from a tool result or from something a person typed, and is
not trusted to point outward.

The scope is decided from the client id in `src/services/mcp_oauth.js`, never
from anything a client asks for, and it is recomputed on every refresh — so a
link made before sending existed becomes write-capable without the user
reconnecting.

### Photos

A post's `fetch` result carries the picture itself as an MCP image content
block, so the assistant can say what is in it rather than reading a caption
that is usually empty. The 480 px thumbnail the app uploads beside every
photo (≈50 KB) is the default; `image: "full"` fetches the original, capped
at 3 MB; `image: "none"` skips it. Videos return their still. Audio posts
return their title.

### Places

Posts carry coordinates, never place names — the app stores lat/lng only.
The assistant is told to interpret them itself, and `feed`'s `near` filter
takes the coordinates it supplies for a place name. Protected zones are not
exposed.

### Voice notes

Left out on purpose. The assistant cannot listen, and a link to an audio file
would only invite it to guess at the contents. `radio_messages` omits them and
reports how many were skipped; `include_voice_notes: true` lists them as
"sent a voice note" placeholders (sender, time, duration — no audio) so a
thread still reads in sequence.

---

## What it applies

Every query mirrors the apps' own visibility rules rather than approximating
them:

- A post is readable when it is yours, a friend's, or public. `feed` defaults
  to you + friends; `include_public: true` widens it.
- Archived posts, posts by users who blocked you or whom you blocked, and
  posts by accounts pending deletion are excluded everywhere.
- A profile is readable for friends and friends-of-friends, with the same
  post visibility the app gives each.
- A workspace is readable only to its members.
- Nothing is written. Reading a thread through the connector does not mark it
  read, does not flip `radio_enabled`, and cannot post, react, message, add
  friends or delete.
- No phone numbers or emails leave the server — not the user's own, not
  anyone else's.

`test/mcp.test.js` asserts these on the SQL that goes to the pool, not on the
JSON built from it.

---

## Auth

OAuth 2.1 with Dynamic Client Registration, because Claude Desktop performs
DCR on every connect and has no fallback. Registration is therefore open, so
the security sits elsewhere:

- PKCE is mandatory and S256-only.
- Redirect URIs match exactly against registration. A prefix match is an open
  redirect.
- Authorization codes are single-use and claimed atomically.
- Refresh tokens are stored only as SHA-256 hashes and rotate on use.
- Access tokens are one-hour JWTs, **signed with a key derived from
  `JWT_SECRET` by HMAC, never `JWT_SECRET` itself**, and carry
  `aud: grounders-mcp`. `middleware/auth.js` verifies app tokens with the raw
  secret and no audience check, so a connector token signed with the raw
  secret would also be a full app session. The suite asserts both directions:
  a connector token is refused by `/users/me`, an app token is refused by
  `/mcp`.

Sign-in at the consent page is the app's own phone-code flow: same `otps`
table, same bcrypt, same Twilio sender (borrowed from `routes/auth.js`).
Connecting never creates an account — there would be nothing to read, and it
would let anyone mint accounts through OAuth. An account pending deletion is
refused at consent; signing in to the app cancels the deletion, and a
third-party assistant should not quietly do the same.

### Endpoints

| Path | Role |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 discovery |
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728: which server guards `/mcp` |
| `POST /oauth/register` | RFC 7591 dynamic client registration (rate-limited) |
| `GET /oauth/authorize` | Consent page: phone number |
| `POST /oauth/authorize/code` | Sends the code, shows the grant |
| `POST /oauth/authorize/approve` | Verifies the code, redirects with an auth code |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants |
| `POST /mcp` | Streamable HTTP JSON-RPC: `initialize`, `ping`, `tools/list`, `tools/call` |
| `GET /mcp` | 401 with a `WWW-Authenticate` challenge, for clients probing for auth |

These are mounted at the root — the `.well-known` paths cannot be nested — and
**before** `blockRoutes`, whose root-mounted `requireAuth` would otherwise
answer them with the app's own 401.

---

## Offhand, built in

Offhand's own assistant reads Grounders and Radio through this same connector
— as an MCP client of `POST /mcp`, with the same tools and the same visibility
rules — but its users never see the consent page. Offhand signs people in with
the same texted-code flow this API does, so a number Offhand has verified is
one this API can trust. Offhand's server presents a shared key and the phone,
and receives what the consent page would have issued.

| Path | Role |
|---|---|
| `POST /partner/offhand/link` | `{ phone }` → the connector's tokens for that account (client `offhand`, scope `grounders.read grounders.write`) plus the display name. 404 `no_account`, 403 `account_closing`, 400 `invalid_phone` |
| `POST /partner/offhand/unlink` | `{ refresh_token }` → 204, the grant revoked. Idempotent |

Both take `Authorization: Bearer <OFFHAND_PARTNER_KEY>`, compared in constant
time; a server with the variable unset (or shorter than 32 characters) answers
503 rather than falling open. The trust decision — "Offhand verified this
phone" — lives in `src/routes/partner.js` and nowhere else. What comes out is
an ordinary connector grant: the access token opens `/mcp` and is refused by
the app's routes, the refresh token is stored hashed and rotates at
`/oauth/token` like any other, and linking never creates an account. The
response carries the display name and nothing else about the user. Offhand
revokes the grant when the user disconnects or deletes their Offhand account.

`test/partner.test.js` asserts all of that — 25 checks, `npm run test:partner`.

---

## Configuration

Two optional variables:

```
PUBLIC_BASE_URL=https://grounders-api-production.up.railway.app
OFFHAND_PARTNER_KEY=            # 32+ chars; unset, /partner/* answers 503
```

The discovery documents advertise it verbatim. Unset, the server uses the
request's own scheme and host, which is correct on Railway (`trust proxy` is
1, so the scheme is `https`). Set it if the API is ever fronted by a domain
that differs from the host it sees.

Everything else is already present: `JWT_SECRET`, `DATABASE_URL`, the Twilio
trio (without it, `DEV_MODE` shows the code on the consent page — never run
that reachable by anyone else), and `R2_PUBLIC_URL` for photo and file links.

Three tables, added by the idempotent migration: `oauth_clients`,
`oauth_codes`, `oauth_refresh_tokens`. They are distinct from the `mcp_*`
tables of the retired Gmail connector, which are left untouched.

---

## Files

| File | Holds |
|---|---|
| `src/routes/mcp.js` | The JSON-RPC transport and bearer auth |
| `src/mcp/tools.js` | Tool definitions and every query behind them |
| `src/routes/mcp_oauth.js` | Discovery, registration, consent pages, token endpoint |
| `src/services/mcp_oauth.js` | Clients, codes, tokens, the derived signing key |
| `src/routes/partner.js` | The Offhand partner link: a verified phone → connector tokens |
| `src/services/radio_send.js` | Sending on Radio — the row, the storage charge, the push — shared by the routes and the tools |
| `src/utils/phone.js` | E.164 coercion shared by the consent page and the partner link |
| `test/mcp.test.js` | 56 checks — `npm run test:mcp` |
| `test/partner.test.js` | 25 checks — `npm run test:partner` |
| `test/radio_send.test.js` | 16 checks on the write scope and its bounds — `npm run test:radio_send` |

---

## Connecting, per client

**Claude** — on the web or desktop, Settings → Connectors → Add custom
connector, paste the URL, sign in with your phone number. Once connected it
works in Claude everywhere, including mobile.

**ChatGPT** — Settings → Apps & Connectors → Advanced → Developer mode, create
a connector, paste the URL. Needs Plus, Pro, Business, Enterprise or Edu.

**Gemini** — connected apps, add a custom app, paste the URL.

Both apps carry a "Grounders + Radio" screen with the address one tap from
the clipboard and these steps: Grounders under the self-profile menu, Radio
under Settings (`lib/screens/connect_screen.dart` in each). The URL is the
whole configuration.
