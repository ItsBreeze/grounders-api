# Edict link

Edict is the owner's Android voice launcher. It reads and sends Radio itself,
with the calls ItsRadio makes, so it needs an ordinary app access token. It
cannot sign in a second time to get one: this API keeps **one refresh token
per account** and replaces it on every sign-in (`routes/auth.js`
`storeRefreshToken`), so a second sign-in from Edict would sign the ItsRadio
app out the next time it renews.

The Edict link gives Edict's PC that token instead. The PC already holds the
phone's trust (its pairing code and pinned keys), asks here under its own key,
and hands the token to the paired phone over that link.

## The route

| Method | Path | Auth | Body → answer |
|---|---|---|---|
| POST | `/partner/edict/link` | `Authorization: Bearer <EDICT_PARTNER_KEY>` | `{ phone }` → `{ token, expires_at, user: { id, display_name } }` |

`token` is what `/auth/verify-otp` returns as `token`: a JWT signed with
`JWT_SECRET`, `sub` = the account, plus `client: "edict"`, valid **30 days**.
It opens the app's own routes (`/radio`, `/friends`, `/invites`, `/users/me`)
and not `/mcp`. There is no refresh token: the PC renews by calling the link
again (daily). Nothing is written — no `refresh_tokens` row is read, made or
deleted — so the ItsRadio app stays signed in.

Refusals: 401 `unauthorized` (no or wrong key), 503 `partner_unconfigured`
(either variable unset, or the key under 32 characters — never open),
400 `invalid_phone`, 403 `phone_not_allowed` (not the pinned number; checked
before any account is looked up), 404 `no_account` (linking never creates
one), 403 `link_disabled`, 403 `account_closing`.

## Trust

Offhand's link (`routes/partner.js`) trusts that Offhand texted the number a
code. Here nobody did: the trust is "the key holder is the owner". That only
reaches the owner's own account, so the number is pinned on the server as well
as sent by the PC. A leaked key opens one account — the owner's — not every
account that has not opted out.

The account holder's veto is the switch Offhand's link already honours,
`users.partner_link_enabled` ("Let Offhand link" in the app's settings), false
on any row holding the number. Turning it off stops the next link; a token
already handed out runs to its expiry (at most 30 days) — it is a stateless
JWT, so the only immediate cut is rotating `JWT_SECRET`, which signs everyone
out.

## Configuration

| Variable | |
|---|---|
| `EDICT_PARTNER_KEY` | 32+ random characters; the same value is sealed in the Edict PC runner's DPAPI store. Its own key, not Offhand's. |
| `EDICT_LINK_PHONE` | The owner's number, any formatting; compared by digits. |

With either unset the route answers 503 and nothing else changes.

## Push

Edict registers its own FCM token with the linked token, as the apps do:
`POST /devices { token, platform: "android", app: "edict" }`, and
`DELETE /devices/:token` when it signs out. The Android app
`xyz.brisebois.voicelauncher` is in the same Firebase project as the others,
so the server's existing credentials deliver to it.

Edict tokens ride along on Radio sends (`app: 'radio'`) and on the both-apps
ones (`app: null`), for these `data.type`s only (`EDICT_TYPES` in
`services/notifications.js`):

| type | ids in `data` |
|---|---|
| `radio_text`, `radio_voice_memo`, `radio_file` | `file_id`, `workspace_id`, `from_user_id`, `sender_name` |
| `friend_request` | `request_id`, `from_user_id` |
| `radio_call_ring` | `call_id`, `workspace_id`, `from_user_id`, `sender_name` |

Always data-only and high priority, with `title` and `body` inside `data`:
Edict fetches and draws its own notification, under its own name, so a
`notification` block would double it. What the Grounders and ItsRadio tokens
receive is unchanged. No migration: `device_tokens.app` is free text.

## Tests

`npm run test:edict_link` — 25 checks: the key and the fence, the veto and the
closing account, that linking writes nothing and never names `refresh_tokens`,
the token's claims and 30-day life, and that it opens `/radio` but not `/mcp`.

`npm run test:edict_push` — 52 checks: each event reaches an Edict token once,
data-only, with its id and no "Radio" in its words; the other apps' messages
are byte-for-byte what they were without Edict; other events never reach it;
registering and unregistering with the linked token.
