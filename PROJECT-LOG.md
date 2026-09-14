# Project log — Google Multi-Account Connector

Why this exists in the shape it does. The reasoning behind a decision is the
part that does not survive in a diff, and it is what you need when changing that
decision later.

Chronological. Each entry is the problem, what was decided, and why the
alternative was rejected.

---

## 1 — The reason for building it at all

Claude's first-party Google connectors hold **exactly one account each**.
Linking a second replaces the first. Anyone with a personal address and a work
address therefore cannot ask a question that spans both, and the workaround —
relinking, asking, relinking back — is worse than not asking.

This server holds as many accounts as you link, and every search tool fans out
across all of them in one call and merges the results by date. That single
property is the justification for the whole thing; everything else follows from
it.

**Kept deliberately self-contained.** Four tables with no foreign keys into the
Grounders schema, its own env vars, its own route prefixes. Deleting the routes
and the migration block removes it entirely, and without its env vars its routes
answer `503` while the rest of the API runs unaffected. It shares a deployment
with the Grounders API for convenience, not by dependency.

## 2 — Security decisions made early, because they are hard to reverse

- **Tokens are AES-256-GCM encrypted at rest** under `TOKEN_ENC_KEY`. The
  database never holds a usable Google token.
- **MCP tokens are signed with a key derived from `JWT_SECRET` by HMAC, not with
  `JWT_SECRET` itself.** This is not paranoia: `middleware/auth.js` verifies
  user tokens with no audience check, so sharing the key would have made every
  connector token a valid Grounders *user* token. The suite `test:tokens` asserts
  this in both directions, and it should never be deleted.
- **The Gmail scope is `gmail.modify`, excluding `mail.google.com`.** Mail
  therefore *cannot* be permanently deleted — a structural guarantee rather than
  a promise about which tools exist.
- PKCE S256 required; authorization codes single-use and hashed; refresh tokens
  rotated on use; `redirect_uri` matched exactly against registration.

## 3 — Bugs that only production found

Worth recording because each was invisible to a passing test suite.

- **Array query parameters were comma-joined instead of repeated.** Google
  expects `metadataHeaders=From&metadataHeaders=Subject&…` and silently returns a
  message with *no headers at all* when handed `"From,To,Subject,Date"`. Every
  search result came back with empty from/to/subject/date, and the cross-account
  date sort was a no-op because every date compared equal. The same bug sat in
  `getReplyContext`, where it would have broken threading on the first reply
  sent. This is the origin of the rule below about asserting on the wire.
- Diagnosing a bad `GOOGLE_CLIENT_SECRET` meant running the whole consent
  round-trip to fail at the last step. `/gmail/check` posts a deliberately bogus
  authorization code: Google validates client credentials *before* the grant, so
  `invalid_client` and `invalid_grant` cleanly separate "your secret is wrong"
  from "both fine".
- A pasted `PUBLIC_BASE_URL=` prefix or a stray space surfaced as Google's
  `redirect_uri_mismatch`, which points at the OAuth client rather than at the
  real cause. Now validated as a bare origin at both read sites.
- `MCP_ADMIN_PASSWORD` now trims both sides before the constant-time compare.
  Copying a passphrase picks up whitespace, and the resulting "incorrect
  password" is unfixable by careful retyping.

## 4 — Extending past Gmail, and the extraction refusal

Calendar, Drive, Contacts and Tasks each have their own first-party connector
with the same one-account limit, so the argument for mail applied unchanged.

**Document text extraction uses only Node's standard library.** Office formats
are ZIP archives of XML and zlib is in `node:zlib`; PDFs are parsed from their
content streams. The alternative was a parsing dependency to vendor, audit and
keep current, for a job the standard library can do.

**The important decision here is the refusal.** Two kinds of PDF have no text to
recover: a scan, and one whose fonts are CID-keyed or subset, where the content
stream holds glyph numbers rather than characters. A union of the document's
ToUnicode tables would often fix the second case — but subset fonts reuse codes
with different meanings, so it would *sometimes* produce text that reads
correctly and says something the document does not. That is the worst available
failure, so the output is scored for readability and **refused** instead, naming
the cause. `ocr: true` routes those through Drive's own conversion.

Bugs found only by testing against real files: a word boundary after `T*` in the
PDF operator pattern can never match (`*` is not a word character), so every PDF
would have come back as one run-on line; content streams had to be found by
scanning *back* from the `stream` keyword, because a page dictionary nests
`/Resources` inside itself and a forward match spans objects and picks up the
wrong `/Length`.

## 5 — Shared drives, and what the default corpus hides

Drive's `files.list` defaults to `corpora=user`: My Drive plus files shared
directly with the account. Drives owned by an *organisation* are excluded, and a
request naming a file inside one returns `404 File not found` without
`supportsAllDrives` — an error that reads as a wrong id rather than as a missing
capability.

Verified against the live deployment afterwards: for the work account, **the
three most recently modified files in the entire Drive were all invisible**, and
"what did I touch most recently" returned a five-day-old answer with nothing to
indicate anything was missing.

`supportsAllDrives` is applied in one wrapper rather than at each of the eighteen
call sites, so a later endpoint cannot silently reintroduce the gap. Which
methods accept it comes from the v3 discovery document, not from memory:
`files.export`, `comments` and `replies` do **not** take it.

## 6 — Writes land on files you own

Reaching shared drives widened writes as well as reads, and a shared drive holds
colleagues' documents. The rule now:

| Situation | What happens |
|---|---|
| You own the file | The write just happens |
| You do not own it | A **private copy** is made in your My Drive and edited there |
| You want the original | `edit_original` returns a **draft** and writes nothing |
| The user approves the draft | `confirm_edit` applies it |

Three things worth keeping straight:

- **Everything in a shared drive counts as not yours**, including files you
  created there, because a shared drive is owned by the organisation. That is
  the correct reading for this purpose: those documents are colleagues' to lose.
- **The copy must name `parents: ['root']`.** `files.copy` with no parent puts
  the copy beside the source, which for a shared-drive file means the copy lands
  in that same shared drive — still not private. This is easy to get wrong and
  there is a test for it.
- **Sharing and trashing have no copy path**, only a draft. Copying a colleague's
  document and sharing *that* spreads their content further, not less.

**A shared drive you are not a member of cannot be named.** Its id is also its
root folder's id, which suggests `files.get` should name it — but reaching a file
inside a drive grants nothing on the root folder above it, so that call answers
`File not found`. This was built, deployed, and only then found not to work,
because the test stub answered where the real API refuses. It now reports
`shared_drive_member: false` instead. The lesson is narrow and worth keeping: a
stub proves the code sends what you meant, never that the service permits it.

**Revoking and restoring are never gated.** `unshare_file` and `untrash_file`
work without confirmation even on files you do not own. The asymmetry is the
point: widening access needs approval, narrowing never does, and a brake that
needs permission is not a brake.

## Principles that keep applying

1. **Every outward action needs an undo, and that is the condition for offering
   it.** `unshare_file` and `untrash_file` exist because `share_file` and
   `trash_file` do. Claude's first-party connector has neither.
2. **Refuse rather than return plausible nonsense.** Text that reads correctly
   and says the wrong thing is worse than an error.
3. **Assert on what goes over the wire, not on the return value.** The failures
   worth catching here are calls that succeed while asking the wrong question,
   and only a wire-level assertion sees those. Hence `global.fetch` stubs
   throughout the suites.
4. **Prefer a structural guarantee to a convention.** `gmail.modify` makes
   permanent deletion impossible; a rule saying "don't call the delete endpoint"
   would not.
5. **Check the API's own discovery document rather than recalling it.** It
   settled which Drive methods accept `supportsAllDrives`, and it disproved an
   assumed conflict between `corpora=allDrives` and `orderBy`.
6. **A count in a README is a test.** Tool counts and check totals are asserted
   in the suites, so documentation that drifts fails the build.

## Operational notes

- Deployed on **Railway**, which auto-deploys from `main`.
- While the Google app stays in **Testing**, refresh tokens expire after 7 days
  and accounts must be re-linked. Publishing stops that, but Gmail, Drive and
  Contacts are restricted scopes, so Google verification applies.
- Granted scopes are fixed at link time and Google will not extend them
  retroactively. Adding a product means re-visiting `/gmail/connect` per account;
  `list_accounts` reports which products each grant actually covers.
- `npm run smoke` is a read-only live check against the deployment, allow-listed
  by construction, reporting counts rather than contents.

---

# Project log — Grounders + Radio MCP Connector

## 1 — One connector for two apps, shaped like Offhand's

Grounders and Radio share this API, this database and this `users` table, so
one MCP server covers both; a second URL would be a second consent screen for
the same account. It is built to the same shape as Offhand's connector —
OAuth 2.1 with dynamic registration, phone-code consent, `search`/`fetch`
named for ChatGPT's contract — so a person with both adds two URLs and gets an
assistant that answers across notes, posts and messages without learning two
systems. A literal single URL spanning Offhand's separate database was
considered and rejected: it would need a gateway that mints tokens valid on
two services with two user tables, for no gain the assistant can see.

## 2 — The signing key, again

The retired Gmail connector's log recorded why MCP tokens must never be signed
with `JWT_SECRET` itself: `middleware/auth.js` checks no audience, so a
connector token signed with the raw secret is a full app session. That rule
was kept verbatim (HMAC-derived key, plus an `aud` claim for good measure),
and `test:mcp` asserts both directions. Offhand relies on the audience claim
alone because its app middleware checks audiences; this one does not, so the
derived key is the guarantee and the claim is defence in depth.

## 3 — Reads mirror the apps' rules; nothing is written

Every post query carries the same four exclusions the map feed applies —
archived, blocked either way, deletion pending, and the friend scope — and the
suite reads them off the SQL sent to the pool rather than trusting the JSON.
The connector writes nothing at all: reading a thread does not mark it read
and does not set `radio_enabled`, because an assistant skimming a
conversation on the user's behalf is not the user opening it, and the dial's
red flash exists for the user.

Phone numbers and emails never leave the server, including the user's own.
The consent page says so, in the grant text, before the code is entered.

## 4 — Photos as images, places as coordinates, voice left out

A caption is usually empty, so a post's `fetch` returns the picture itself as
an image content block — the 480 px thumbnail the app already uploads for
pins, ≈50 KB, is enough to say what is in a photo. The full original is a
parameter, capped at 3 MB, because tool results ride inside the model's
context.

Posts carry lat/lng and nothing else about place; the app stores no address
text by design. Rather than add a geocoder (and a dependency, and a leak of
every post's location to a third party), the assistant is told to interpret
coordinates itself and to supply coordinates for a place name in `feed.near`.
Assistants are good at this and the user's data stays here.

Voice notes are omitted, not linked. The assistant cannot listen, and a URL
to an audio file is an invitation to guess at what was said. The count
omitted is reported so a gap in a thread is visible, and a flag lists them as
placeholders so a conversation still reads in order.

## 5 — Accounts pending deletion

Signing in to the app cancels a pending deletion. The connector refuses such
an account at consent and answers 403 with an explanation after connecting,
rather than cancelling the deletion the way an app sign-in would: a person who
asked for their account to be removed should not have that reversed by asking
Claude a question.

## 6 — Offhand links by phone, not by consent page

Offhand's in-app assistant wanted Grounders and Radio the way Claude already
has them. The cheap version — Offhand calling Grounders' app routes with an
app token — was rejected: it would need a full app session for a read-only
job, and every visibility rule the connector encodes would have to be
re-encoded on the other side. So Offhand is an MCP client of `/mcp` like any
other, and the only new thing is how it gets a token.

A user with both apps has already proven their phone number to Offhand, by
the same texted-code flow this API uses. Making them prove it again on a
consent page, inside their own app, buys nothing. `POST /partner/offhand/link`
takes a shared key and a phone and hands back what the consent page would
have issued: a refresh token for a fixed `offhand` client, hashed and
rotating like every other, whose access tokens carry the connector audience
and are signed with the derived key. Nothing about the grant is more
privileged than one a consent page produced; the difference is confined to
who vouched for the phone, and that is one file.

The key is compared in constant time, must be at least 32 characters, and an
unset key means 503 — a partner endpoint that fell open on a missing variable
would be an unauthenticated "give me a token for this phone". When the numbers
differ, Offhand texts the second number a code of its own before asking; from
here that is the same assertion. Linking never creates an account and refuses
an account pending deletion, as the consent page does and for the same
reasons.

## 7 — The account holder's veto on the partner link

Every other route to a connector grant puts a consent page in front of the
account holder. The partner link does not, by design: it issues the grant on
Offhand's word that it verified the phone, and nothing here can check that
word. That trust was also, until now, invisible and unrevocable from this
side — neither app listed the grant, and only Offhand's own Disconnect could
take it back. Someone who wants no partner link at all had nothing to say so
with.

`users.partner_link_enabled`, NOT NULL DEFAULT TRUE, is that sentence.
`POST /partner/offhand/link` refuses with 403 `link_disabled` when it is
false, checked in the one file that makes the trust decision, immediately
after the account is matched and above every branch that could reach a token.
A per-account column rather than a server setting: the decision belongs to
the person whose posts and messages the grant would read.

**It stops new links; it does not revoke live ones.** A refresh token already
issued keeps rotating at `/oauth/token`, which never reads the column.
Checking it there was considered and rejected: flipping a settings toggle
would then silently break an assistant someone is still using, mid-sentence,
with the failure surfacing as an OAuth error in another company's app.
Revocation should be an act — `POST /partner/offhand/unlink` (Offhand's
Disconnect), or deleting the Grounders account, whose cascade takes
`oauth_refresh_tokens` with it. If a grant should ever die the moment the
switch flips, the honest way is a revoke-on-PATCH in `PATCH /users/me`, not a
check in the refresh path.

The column is read with `=== false`, not truthiness: on a server whose
migration has not run yet the column is absent, and absent means "nobody has
refused", not "everybody has". It is also read across every row that holds
the number rather than only the row about to be linked — one person can hold
two rows when their number was written two ways (§6), they are signed in to
one of them, and the refusal recorded there has to count whichever row the
match picks.

## 8 — Voice notes become words (reverses §4)

§4 above records the opposite decision and is kept as written: voice notes
were omitted because the assistant cannot listen and a link to audio is an
invitation to guess. What changed is not that judgement but the input. A
voice note now arrives with a transcript, so there is text to read, and the
reasoning in §4 never applied to text.

**The transcript is a new column, not `text_content`.** Both the route layer
and the connector read a non-null `text_content` as "this row is a typed
message". A transcript parked there would surface, everywhere, as something
the user sat down and wrote. `radio_files.transcript` /
`transcript_status` / `transcribed_at` instead, with status NULL meaning
nobody has asked — which is also the state of every row that predates this
and of every deploy with no provider key.

**Bytes come from R2 through the S3 client, not the public URL.** This job is
the first thing on the server that needs the audio itself. Asking R2 with
`GetObjectCommand` keeps the bytes on a credentialed path, and survives the
bucket being made private — the only direction that setting ever moves —
where an HTTP fetch of `R2_PUBLIC_URL` would begin 403ing.

**25 MB, checked against R2's `ContentLength` before the body is read.** An
oversized object then costs one request and no memory. It is deliberately the
same order as radio_send's 20 MB cap: both are "one object, in memory, once".
Deepgram bills by the audio minute, so the cap is a spending limit as much as
a memory one.

**Reuse is keyed on `r2_key`, not on membership.** `copy-to-self` puts a
second row over one recording; paying twice would also let the two rows drift
apart and show different words. The lookup is safe precisely because sharing
an `r2_key` means sharing the bytes, and the transcript is only ever a
rendering of bytes the caller can already play. If the bucket is ever made
private with per-row authorization, that reasoning stops holding and the
lookup needs a workspace scope.

**A claim expires, because a process does not always come back.**
`transcript_status = 'pending'` is written by one process and cleared by the
same one. A deploy, a crash or a Railway restart in between used to leave the
row pending with nothing recording *when* — `transcribed_at` is written only on
success and the table has no `updated_at` — so the endpoint answered
`started:false` / `reason:'already'` forever, the app spun a spinner with no
exit, and no reaper could be written later without a second migration. So
`transcript_claimed_at` ships with the feature rather than after the first
wedged row. Its own column, not a reuse of `transcribed_at`: that one means
"these are the words and this is when they were made", the reuse lookup orders
by it and the app and the connector read it back, so stamping a merely-claimed
row there would make a pending row read as transcribed everywhere.

**Ten minutes, and why not less.** The claim expires after `STALE_AFTER_MS` =
10 min, and `claim()` will take over one older than that. Too short and it
steals a job that is still running, which is paying Deepgram twice for one
recording. Too long and someone stares at a spinner all afternoon. A pending
row with no stamp at all predates the column, so it is stale by definition.

**The window is only a proof if every step of a running job is bounded, so the
download got a bound.** The provider POST always had one (`TRANSCRIBE_TIMEOUT_MS`
= 120s); the R2 `GetObject` had none. The AWS SDK ships `requestTimeout = 0` —
@smithy/node-http-handler only arms a timer when one is configured — so a
stalled socket had no ceiling at all and never triggered a retry to replace it.
A download that hung past ten minutes would have had its row swept to 'failed'
and re-claimed underneath it: two workers on one row, two Deepgram charges,
which is the exact thing the window exists to prevent. `fetchAudio` now passes
`AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)` (2 min) to `send()` — a signal
rather than a client `requestTimeout` because it bounds the *total*: once it
fires, every remaining retry attempt fails fast on the already-aborted signal
instead of starting a fresh clock. Worst legal case is therefore 2 min + 2 min
+ the writes against a ten-minute window, which is arithmetic rather than a
hope about network weather.

**And a sweeper as well as the expiring claim, because they fix different
halves.** The claim makes a wedged row *recoverable* — but only by someone
pressing the button, and until they do the row still says 'pending' and the
feed still draws a spinner. `sweepStaleClaims` (hourly cron in `server.js`, the
same shape as `reapDeletedUsers`) turns an abandoned claim into 'failed', which
is the state the app renders as "couldn't transcribe — tap to retry" and which
`claim()` has always treated as claimable. Hourly rather than reap_users' daily
3am: that job's window is fourteen days, this one's is ten minutes.

**A ceiling on what one account can spend, in the unit the provider bills.**
The per-file guards were real but orthogonal: 25 MB stops one file being
enormous, and the conditional UPDATE stops one row being paid for twice.
Neither stops an account recording a thousand short memos.
`TRANSCRIBE_DAILY_SECONDS_PER_USER` (default 7200 — two hours of audio per
rolling 24 hours) is summed off `transcript_claimed_at`, counting 'pending'
alongside 'ready' so a burst of simultaneous asks cannot all read a cold total.
Seconds, not files, because a hundred five-second memos and one hour-long
recording are not the same money. Two hours specifically because it is twice
the longest recording the 25 MB cap admits — a ceiling that can refuse a legal
file is a ceiling that generates bug reports — and because it bounds a runaway
at roughly half a dollar per account per day instead of at nothing.

**A duration is a positive number of milliseconds or it is not a duration.**
`duration_ms` comes off the client and `POST /radio/workspaces/:id/files` never
range-checks it, so the client controls the number the ceiling charges by
completely: it can omit it, send `0`, or send a negative. All three are charged
`ASSUMED_DURATION_MS` (60s). NULL was the obvious one; `0` is the one that is
easy to miss, because NULL at least looks like missing data while `0` looks
like a measurement — and either counting as free is the entire way around the
ceiling for the cost of one field in a JSON body. A negative is worse than
free: summed as declared it is a *credit*, so one note claiming minus an hour
would pay for the next hour of real ones. The rule is applied in both places
the money is counted — `CASE WHEN duration_ms IS NULL OR duration_ms <= 0` in
the SUM, and the same test on the claimed row's own length — and `recordFile`
now stores a non-positive declared duration as NULL so the number never reaches
the column at all. The guess is short-lived either way: `markReady` backfills
the column from what the provider measured.

**Hitting the ceiling is an answer, not an error.** `reason:'daily_limit'`
alongside 'not_configured' and 'already', all of them 200s, because the app
needs a sentence to put under the tile and a 500 there reads as "the app is
broken". The claim is handed straight back — status and stamp both NULL — so
nothing is spent, nothing is left pending, and the ask simply works again once
the window moves. It is charged to the row's owner rather than to whoever
pressed the button: recording is the unbounded axis and is always charged to
the recorder, while the manual endpoint can only ever buy a given row one
transcript, since a 'ready' row is not claimable.

**The consent page and §4's promise had to be rewritten with it.** The grant
text in `mcp_oauth.js` said "Voice notes stay out entirely" — the sentence a
person reads before approving the connector. A privacy promise that the code
has stopped keeping is worse than one that was never made, so it now says
what is true: the connector reads a transcript where one exists and never the
audio.

---

## 9 — Calls, and a recording that reaches backwards

The ask was live voice and video where **each device records both sides of the
call locally and keeps it only on demand**, with what is kept landing in
Offhand as a transcript. The alternative — each person records only their own
microphone and the server stitches the two — was offered and explicitly
overruled, so it is recorded here rather than re-litigated.

**Neither operating system will allow it from outside an RTC pipeline.**
Android's `AudioPlaybackCapture` reaches only `USAGE_UNKNOWN`/`GAME`/`MEDIA`
players and WebRTC plays as `USAGE_VOICE_COMMUNICATION`, which Android
documents as not capturable; iOS has no playback-capture API at all and WebRTC
owns the voice-processing audio unit. `flutter_webrtc`'s own recorder attaches
exactly one audio interceptor — mic **or** far end, never both. So the mix has
to be taken inside an SDK that already holds the decoded remote audio, and of
the maintained Flutter RTC SDKs only Agora exposes that, as a single documented
call. **That one API is the reason for the vendor choice**, which is why the
whole RTC surface is behind `RadioCall` in the app: the blast radius of
changing vendor is one file.

**The recording format is ADTS `.aac` because of crashes, not compression.** A
WAV header is finalised on stop, so a force-kill yields an unplayable file —
which would break the single guarantee the keep marker exists to provide. A
truncated ADTS stream is playable frame by frame, so a tap is never lost.

**The rename is the consent marker.** Tapping Upload renames the buffer file
synchronously, before any network call; Agora keeps writing to the same inode
under the new name. There is therefore no window in which somebody has tapped
and the bytes are not marked, and no separate flag to fall out of sync with
the file. Everything after the rename — telling this server, telling the far
end — can fail without losing a recording somebody chose to keep.

**Provenance is a column, not a kind.** A fourth value in `radio_file_kind`
would have fallen straight out of `radio_transcribe.claim()`'s
`AND kind = 'voice_note'` filter and forced a decision at every kind-switched
branch in the route layer. `radio_files.call_id` gives the feed its phone glyph
while the row stays, to every existing code path — including the transcription
pipeline landing in §8 — exactly the voice note it is. The only change on that
whole path is one clause accepting `audio/aac` in `upload-url`; without it an
ADTS file lands under an `.m4a` key with an `audio/mp4` Content-Type and will
not play back on iOS.

**Consent is a product behaviour, not a dialog.** A fixed, non-dismissible
strip states the model before the first second of audio, identically on every
participant's screen, so neither party is in a different informational
position. The button's sub-label says the tap reaches backwards *before* it is
tapped, because the surprising part is not that a recording exists but that it
reaches back — somebody who learns that at minute ten can still act on it, and
somebody who learns it afterwards cannot. The notice names the person, because
in a two-party call anonymity fools nobody: there is exactly one other person
and one of you did not tap. It goes out over three paths (the peer data
stream, an FCM push from here, and the next read of the call) because a design
resting on the far end finding out must not rest on one transport.

**`kept_at` is never cleared.** An un-keep writes `kept = false` and leaves the
stamp standing: "Alex kept this, then stopped" is what happened, and a column
that erases itself cannot say it. That is the row to show the day somebody
disputes it, and the test asserts the `CASE` clause as SQL text as well as
behaviour — the harness stubs `pool.query`, so a stub, not Postgres, decides
what a `WHERE` matches, and deleting the clause would otherwise leave every
behavioural check green.

**`radio_never_record` is enforced from the server, on both clients.** If any
participant has it set, neither phone records. A device-local setting would
have been a switch that only stops your own phone, which is not what the words
promise. The settings copy states the limit plainly rather than implying more:
it cannot stop somebody recording another way.

**A video call records audio only, deliberately.** No client SDK muxes local
camera, remote video and mixed audio into one local file. Getting the picture
would mean server-side composited recording, which moves both participants'
video to a vendor on *every* call in case somebody later taps — a large cost
and a real consent regression, bought for something Offhand cannot use, since
a transcript of a video call is identical to a transcript of a voice call. The
button says "Audio only" so nobody believes they captured the whiteboard.

**The ring is two roads, not one.** An FCM alert always works and degrades to
a missed-call notification. A PushKit push is the only message iOS will wake a
terminated app for, and it is what makes a locked iPhone ring — Firebase
cannot send one, so `services/apns_voip.js` posts to Apple directly. PushKit
tokens live in `device_tokens` as their own platform and every FCM send
excludes them by that platform: sending one to FCM would fail every time, and
the invalid-token pruning would then delete the very token that makes the
phone ring.

**Nothing here has run on a phone.** The JavaScript is tested and the Dart
analyzes clean, and the Swift and Kotlin have never been compiled. The risk is
concentrated in one unverified behaviour — Agora's mixed recording on iOS —
whose failure mode is one voice silently missing. `CALLING.md` says so in its
own section rather than burying it, and the first thing to do is two real
phones and a release build.

---

## 10 — A kept call is pushed into Offhand, and the trust runs the other way

§9 built the recording and stopped at the edge of this server: a kept call
became an ordinary Radio voice note with a `call_id` on it, and how it reached
Offhand was left as "Offhand's assistant will find it through the connector".
That was the wrong ending. A recording somebody chose to keep would have
arrived in Offhand whenever they next happened to ask their assistant a
question about it — which is not a feature anybody can describe, and is
indistinguishable, for days at a time, from the recording being lost.

**So this API pushes, and Offhand transcribes.** As soon as the kept call's row
is inserted, `services/offhand_push` sends the audio into the keeper's own
Offhand account, where it lands as a note and AssemblyAI makes the transcript.
Pull was considered and rejected for the reason above. Giving this server its
own AssemblyAI provider was rejected too: Offhand already has one, with
diarization, and a second copy here would be a second bill, a second prompt to
keep in step, and two transcripts of one recording that can disagree. The
transcript that matters is the one in the note.

**The direction of trust reverses, and it does so on the same key.** Everything
in §6 and §7 runs inbound: Offhand vouches for a phone, this server believes it
under `OFFHAND_PARTNER_KEY`, and the account holder can refuse with
`partner_link_enabled`. This server was a reader that never reached out. Now it
is a client of Offhand's — and the credential it presents is not a new one. It
is the same shared secret, stored here as `OFFHAND_PARTNER_KEY` and on Offhand
as `GROUNDERS_PARTNER_KEY`, which is the name its capture routes check. `§6`
said the one trust decision "lives in this file and nowhere else", meaning
`routes/partner.js`. That stopped being true the day this shipped, in both
repositories at once.

A second key was the obvious alternative and was not taken, because the value
is already shared by construction — the two servers have always had to hold the
identical string — and a second secret would mean a second rotation, a second
way to be half-configured, and a silent failure mode on every deploy that set
one and not the other. What it costs instead is that **the same lock now opens
a second door**: a leak used to mean "someone can read a Grounders feed as
Offhand" and now also means "someone can write notes into Offhand accounts,
put audio in their storage, and spend their allowance". That is written down
here, in Offhand's `routes/partner.js`, and in both `.env.example` files,
because a change in what a key is worth is exactly the thing nobody remembers
having made. Rotating it is now a two-repository operation.

For the same reason the push reads `GROUNDERS_PARTNER_KEY` and falls back to
`OFFHAND_PARTNER_KEY` rather than demanding a new variable: a deploy that
already has the link working holds the value under the second name, and this
job is inert without a key — so requiring a rename would have made the common
upgrade fail by doing nothing at all, with no status on any row to explain it.

The blast radius of that key being stolen is bounded on the other side rather
than promised on this one, which is the only kind of bound worth having.
**Offhand mints the object key**, from the user it resolves the phone to, in
that user's own `audio/<userId>/` prefix; this side never names a key, so the
key cannot be used to write anywhere else in Offhand's bucket. **Offhand
resolves the account against `grounders_links`**, the row that records that
this person connected the two apps and which they can break from Settings —
not against its user table, and never by creating an account. And the capture
is idempotent on `radio-call:<call_id>`, so a replayed request is the same
note.

**The audio moves by presigned PUT, then a small JSON call.** Posting the bytes
to Offhand as a request body dies on its own `express.json` 2 MB limit against
a recording that is tens of megabytes, and would hold one call in two
processes' memory at once. Handing Offhand a URL to fetch would be server-side
request forgery with extra steps — `services/article.js` exists because this
codebase learned that once — and would make the partner key a way to point
Offhand's server at anything. So: Offhand presigns into its own namespace, this
side PUTs the bytes straight at R2, and one JSON call says "that key is a note
now". The `Content-Type` on the PUT has to be exactly what the presign signed,
or R2 answers 403 in a way that reads like a permissions problem and is not.

**The push is durable because nothing else can retry it.** The phone deletes
its local recording the instant its own R2 upload returns, so from then on R2
holds the only copy and the phone is out of the story. A background call that
logged a warning on failure would therefore be a call somebody was *told* was
kept, and which silently never arrived anywhere. `offhand_push_status` and
`offhand_push_claimed_at` are the same devices §8 introduced for transcripts,
for the same reason — `'pending'` is written by one process and cleared by the
same one, and a deploy or a crash in between leaves a row nothing will clear —
but the sweeper does more here than there. Transcription's turns an abandoned
claim into `'failed'` and waits for somebody to press a retry button; there is
no button here, so `sweepStalePushes` **re-runs** the push, ten at a time and
sequentially, because each one holds a whole recording in memory and a sweep
that started two hundred at once would kill the process that was rescuing them.

**A refusal is classified by name, not by number, and the retries end.** The
shared error vocabulary is the contract: `no_account`, `link_disabled` and
`invalid_phone` mean there is nobody to deliver to (`'unmapped'` — its own
terminal state, and not a kind of failure, because a row that says `'failed'`
invites somebody to build a retry for something retrying cannot fix);
`unauthorized`, `allowance` and a 413 mean it was refused and will be refused
again (`'failed'`); a 5xx, a timeout or a dropped socket leaves the row
`'pending'` for the sweep. `503 partner_unconfigured` is deliberately in the
last group even though it is a flat refusal: it means the other end has not
been given its key yet, which is one deploy from being fixed, and giving up on
it would lose every call kept during a window somebody was already closing.
The retrying stops after a day — bounded by wall clock off `created_at`, which
is the first attempt to within a second because `recordFile` queues the push at
insert. That is a deliberate substitute for an attempts column: with an hourly
sweep it is about two dozen tries, and it costs no fourth column. If a push is
ever queued from anywhere but the insert, that reasoning stops holding.

**`offhand_requested_at` changed meaning, which is why two files had to be
rewritten rather than just extended.** It used to mean "the user asked for this
one", and it was how a kept call reached Offhand at all. Now the ordinary path
needs no flag, and what a stamp marks is the exception: every terminal outcome
above sets it, so a recording the push could not deliver is put in front of the
user's own assistant through the MCP connector instead. Failing loudly into
their assistant is the fallback; failing quietly is not one. The manual flag
still writes the same column — two columns both meaning "put this first" would
have to be ORed by every reader forever — so the sentence the connector says
about flagged rows (`FLAGGED_NOTE` in `src/mcp/tools.js`) can no longer claim
the user asked for them. Telling an assistant somebody asked, when nobody did,
invites it to answer a question that was never put.

**The push is not synchronous inside `POST /radio/workspaces/:id/files`, and
must not become so.** A 500 there makes the phone retry the whole upload, and
the retry mints a *fresh* key — so the same audio would land as a second R2
object and a second `radio_files` row, with the first orphaned. The finalize
call answers 201 as soon as the row exists; the delivery is the row's problem
from then on, which is exactly what the claim and the sweep are for.

**A phone number now goes outbound, and the README had to say so.** The digits
are the only identifier the two systems share — it is the whole basis of the
link in §6, in the other direction — so the keeper's own number is what
resolves the Offhand account. It is theirs, it goes to one configured host
under a shared key, and it never touches the connector: the other people on the
call travel as display names in `attendees`, which is what a summary needs to
say who said what and is not an identifier for anything. The connector's "no
phone numbers" promise was about what an assistant can read and is still true;
leaving it standing unqualified next to a server that now sends one would have
been true by wording and false by impression.
