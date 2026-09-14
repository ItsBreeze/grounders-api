# Radio Calls

Live voice and video calls between members of a Radio conversation, with a
recording that runs from second zero and is thrown away unless somebody asks
to keep it.

This server carries none of the **live** media. Agora carries that. What lives
here is the call's paperwork — who rang whom, who answered, and who was told
that a recording was being kept — plus the token that lets a phone join a
channel. There is no websocket, no SSE, no second process, and no change to the
Railway deploy.

A call somebody **keeps** is a different matter, and the sentence above used to
cover it and no longer does: a kept recording is uploaded to R2 and then read
back out of it by this server and pushed into the keeper's Offhand account,
where it becomes a note transcribed by AssemblyAI. So this API now holds a kept
call's bytes, in memory, twice — once on the way in and once on the way out.
Of a **discarded** call it still holds nothing, and never did.

---

## The idea, in one paragraph

Both phones start recording the moment they join the channel. Nothing leaves
either device unless somebody taps **Upload to Offhand**, at which point that
person's own recording — the whole call, from the start, not from the tap — is
uploaded as an ordinary Radio voice note. From there it goes two ways at once:
the Radio transcription pipeline picks it up with no change at all, and
`services/offhand_push` delivers it into that person's own Offhand account as a
note, where Offhand's AssemblyAI transcription does the rest ([Where a kept call
goes](#where-a-kept-call-goes)). If nobody taps, the file is deleted in the same
`finally` that tears the engine down. The retroactivity is not a ring buffer;
it is starting at zero and deleting on no-tap, which is why "nothing was kept"
is a claim about bytes that never left the phone rather than about a deletion
routine on a server.

---

## Why Agora, and not WebRTC

Neither operating system will let an app record the far end of a call from
outside an RTC pipeline.

| Route | Android | iOS |
|---|---|---|
| OS playback capture | `AudioPlaybackCapture` only reaches `USAGE_UNKNOWN` / `USAGE_GAME` / `USAGE_MEDIA` players that opt in. WebRTC plays as `USAGE_VOICE_COMMUNICATION`, and Android documents call audio as not capturable. | There is **no playback-capture API**. `AVAudioEngine` taps reach only your own engine, and WebRTC drives a raw VoiceProcessingIO AudioUnit with no node to attach to. |
| `flutter_webrtc` MediaRecorder | Attaches exactly one audio interceptor: mic **or** far end, never both. Audio-only recording logs "not implemented yet". | Requires a video track, derives the audio track from it, and is marked unavailable in the support matrix. |

So the mix has to be taken where both streams already exist — inside the RTC
SDK, which holds the decoded remote audio and never touches the prohibition.
Of the maintained Flutter RTC SDKs, only Agora exposes that, as one documented
call:

```dart
engine.startAudioRecording(AudioRecordingConfiguration(
  filePath: '…/<callId>.aac',
  fileRecordingType: AudioFileRecordingType.audioFileRecordingMixed,
  encode: true,
  sampleRate: 32000,
  quality: AudioRecordingQualityType.audioRecordingQualityMedium,
  recordingChannel: 1,
));
```

`audioFileRecordingMixed` is documented in the Flutter binding as "Record the
mixed audio of the local and all remote users."

**This one behaviour is the whole product, and it has not been run on a
device.** The API, its six fields and the enum are present in
`agora_rtc_engine` 6.6.4 and were checked against the installed package, but
nobody here has made a call with two phones and listened to the file. The
failure mode is the bad kind — one voice missing, no error. See
[What has not been verified](#what-has-not-been-verified).

ADTS `.aac` rather than `.wav` for one reason: a WAV header is finalised on
stop, so a force-kill yields an unplayable file, while a truncated ADTS stream
is still playable frame by frame. A tap is never lost to a crash.

---

## Consent

The design rests on the far end actually finding out, so it does not depend on
any single transport.

**A fixed strip**, from before the first second of audio, on every
participant's screen, not dismissible, identical on both devices:

> Both phones are recording this call. Nothing is kept unless someone taps
> Upload to Offhand.

**The button says what the tap does, before it is tapped**: *Upload to
Offhand* / *keeps this call from the start*. The sub-label is load-bearing —
the surprising part is not that a recording exists but that it reaches back,
and a person who learns that at minute ten can still act on it.

**The moment anyone taps**, the far end is told **by name**, over three paths
in order: Agora's data stream (sub-RTT, covers a screen that is on), an FCM
push from this server (covers a screen that is off), and `GET /radio/calls/:id`
on next foreground (covers the rest). In a two-party call anonymity is theatre:
there is exactly one other person and one of you did not tap.

**`users.radio_never_record`** is the per-account opt-out and it has teeth: if
**any** participant has it set, **both** clients skip recording entirely, the
button renders disabled, and the strip names who turned it off. It is enforced
from one server-supplied flag in the token response, so it is not honour-system
between peers. The settings copy says what it cannot do: *"This turns off
ItsRadio's recording for every call you're in. It can't stop someone recording
another way."*

`radio_call_participants.kept_at` is the durable record. A cancel writes
`kept = false` and **leaves `kept_at` standing** — "Alex kept this, then
stopped" is the truth, and a column that erases itself cannot tell it.

---

## Schema

| Object | Notes |
|---|---|
| `radio_calls` | The call. `callee_id` is a single person on a 1:1 call and NULL on a group call, where the participant rows are the guest list. `channel` is the call's own uuid. |
| `radio_call_participants` | Who was on it, when they joined and left, whether they kept it, when they were told, and which file their recording became. |
| `users.radio_never_record` | The opt-out, returned on every token response for every participant. |
| `radio_files.call_id` | **Provenance without a new kind.** A fourth `radio_file_kind` would fall straight out of `radio_transcribe.claim()`'s `AND kind = 'voice_note'` filter and force a decision at every kind-switched branch in the route layer. A nullable FK gives the feed its phone glyph while the row stays, to every existing code path, exactly the voice note it is. |
| `radio_files.offhand_requested_at` | Lets the MCP `radio_messages` tool surface flagged rows first. **It no longer means "the user asked".** A kept call is pushed into Offhand as a note without anybody asking, so what a stamp here marks now is the exception: the push could not deliver this recording, so surface it to the connector instead. The manual flag (`POST /radio/files/:id/offhand`) still writes the same column, because the reader wants the same thing from both — this row, first. |
| `radio_files.offhand_push_status` | `NULL` (never attempted — every row that is not a kept call, and every deploy without the partner credentials) → `'pending'` → `'pushed'` \| `'failed'` \| `'unmapped'`. `'unmapped'` is not a kind of failure: there is no Offhand account these bytes could belong to, and retrying does not change that. |
| `radio_files.offhand_push_claimed_at` | What `transcript_claimed_at` is, for the same reason: `'pending'` is written by one process and cleared by the same one, so the claim expires and the hourly sweep re-drives it. |
| `radio_files.offhand_note_id` | Offhand's id for the note this became. `TEXT`, and deliberately not a foreign key — it is another service's primary key in another database, and it exists so "where did my call go?" has an answer from this side. |

---

## Where a kept call goes

Offhand gets a kept call **pushed** to it, seconds after the recording lands.
The alternative was leaving it here with a flag on it and letting Offhand's
assistant notice it through the MCP connector — a kept call that arrives
whenever the user happens to ask a question, which is not a feature anyone can
describe. `services/offhand_push` is the push; the flag is demoted to what
happens when the push cannot be made.

**Two calls and a PUT, in that order**, against `OFFHAND_BASE_URL`, both
carrying `Authorization: Bearer $GROUNDERS_PARTNER_KEY` — the shared partner
key, which this API already holds under a second name
([Configuration](#configuration)):

| Step | What |
|---|---|
| `POST /partner/grounders/capture/upload-url` | `{phone, mime_type}` → `{uploadUrl, key, mimeType}`. **Offhand mints the key**, inside the resolved user's own `audio/<userId>/` namespace, so this side cannot name one and a stolen key cannot write elsewhere in Offhand's bucket. |
| `PUT uploadUrl` | The bytes, straight at R2, with the `Content-Type` the presign signed — anything else is a 403 from R2 that reads like a permissions problem and is not one. |
| `POST /partner/grounders/capture` | `{phone, keys:[key], duration_ms, call_id, title, attendees}` → `202 {note_id, status:'pending'}`. Small JSON naming the key, never the audio: Offhand's `express.json` caps at 2 MB and a kept call is tens of megabytes. Handing Offhand a URL to fetch instead would be SSRF with extra steps. |

**The account is matched by phone number**, because the digits the person
proved to both apps are the only identifier the two systems share — the same
basis as the existing partner link, in the other direction. It is the keeper's
own number and nobody else's: the other people on the call travel as display
names in `attendees`, which is what lets a summary say who said what, and is
not an identifier for anything. Offhand resolves it against its own
`grounders_links` (the revocable record of consent on that side), never against
its user table, and never creates an account.

**A refusal has a name, and the name decides what happens to the row.**

| Offhand answers | Row becomes | Because |
|---|---|---|
| `404 no_account`, `403 link_disabled`, `400 invalid_phone` | `unmapped` | There is nobody to deliver to. Retrying asks the same question. |
| `401 unauthorized`, `402 allowance`, `413` | `failed` | It was refused, and it will be refused again. |
| `503 partner_unconfigured`, any `5xx`, timeout, dropped socket | stays `pending` | Somebody else's outage, including an Offhand deploy that has not been given its key yet. The sweep retries hourly for a day. |

Both terminal outcomes also stamp `offhand_requested_at`, which puts the
recording in front of the user's assistant through the MCP connector. Failing
loudly into their own assistant is the fallback; failing quietly is not one.

**Why it is durable rather than fire-and-forget.** The phone deletes its local
recording the instant its R2 upload returns, so R2 holds the only copy and the
phone can never re-drive anything. A push that ended in a `console.warn` would
be a call somebody chose to keep, was told was kept, and which silently never
arrives. So every attempt claims the row, the claim expires, and the hourly
`sweepStalePushes` in `server.js` **re-runs** abandoned pushes (ten at a time,
sequentially — each holds a whole recording in memory) rather than only marking
them, which is the one place this sweep does more than the transcription one.

**It is not synchronous inside `POST /radio/workspaces/:id/files`** and must
not become so: a 500 there makes the phone retry the whole upload, and the
retry mints a fresh key, so the same audio lands as a second R2 object and a
second `radio_files` row.

---

## Routes

All behind `requireAuth`, mounted at `/radio/calls` (above `/radio`, so the
path reaches this router rather than falling through `radio.js`). Every route
establishes that the caller is a participant, and answers the **same 404** for
"no such call" and "not your call" — a call id is a uuid, not a secret.

| Method | Path | Notes |
|---|---|---|
| POST | `/radio/calls` | `{workspace_id, callee_id \| callee_ids[], media}`. Rings everyone else. 503 when Agora is not configured. |
| GET | `/radio/calls/:id` | The 2s ringing poll, and the catch-up read on foreground. Resolves an unanswered call into a missed one on the way past, so no timer lives on the server. |
| POST | `/radio/calls/:id/token` | A fresh token for the same channel. |
| POST | `/radio/calls/:id/answer` | Idempotent — a reconnect looks like answering twice. |
| POST | `/radio/calls/:id/decline` | Ends the call only while nobody else has joined, so one person saying no does not hang up on people already talking. |
| POST | `/radio/calls/:id/end` | Ends when the last participant leaves. Sweeps calls abandoned past six hours. |
| POST | `/radio/calls/:id/keep` | `{keeping}`. Writes the record, then fans the notice out. 409 with `reason: 'never_record'` when somebody has recording off. |
| POST | `/radio/files/:id/offhand` | `{requested}`. In `radio.js`, beside the other `/files/:id` routes. The manual flag; since the push landed it is no longer how a kept call normally reaches Offhand. |

There is **no route for the push**. It is a background job on the way out, not
an endpoint: `services/offhand_push`, queued by `recordFile` and re-driven by
the hourly cron.

One edit to an existing route: `POST /radio/workspaces/:id/upload-url` now
honours `audio/aac`. Without it an ADTS file lands under an `.m4a` key with an
`audio/mp4` Content-Type and will not play back on iOS.

---

## Configuration

| Env var | Effect when absent |
|---|---|
| `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE` | `POST /radio/calls` answers 503 "Calling is not configured" and the app falls back to the toast it showed before calling existed. Same inert-without-a-key discipline as `radio_transcribe`. |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID` | No VoIP push is sent. Calls still ring over FCM: answerable from the notification, with no lock-screen ring on iOS. |
| `OFFHAND_BASE_URL`, and the partner key (`GROUNDERS_PARTNER_KEY`, or `OFFHAND_PARTNER_KEY` — the same secret, see below) | No kept call is pushed to Offhand. Nothing is claimed and **no push status is written at all** — not `'failed'`, which would be a claim about work that was never attempted — so a deploy that is later given the credentials starts pushing new calls and leaves the old rows exactly as they are. The key must be at least 32 characters; anything shorter is treated as absent, because a placeholder is not a secret. |

The App Certificate is a signing key and never reaches a client: the phone
asks for a token minted against a call it is actually on, and that token
expires in an hour.

**There is one partner key, and it now opens two doors.** The same secret is
stored here as `OFFHAND_PARTNER_KEY` (the key Offhand presents at
`/partner/offhand/link`, [MCP-CONNECTOR.md](MCP-CONNECTOR.md)) and on Offhand's
server as `GROUNDERS_PARTNER_KEY` — both `.env.example` files have said so since
the link shipped. Offhand's capture routes check it under that second name,
which is why the push reads `GROUNDERS_PARTNER_KEY` first and falls back to
`OFFHAND_PARTNER_KEY`: a deploy that already has the link working has the value
under the second name, and demanding it be pasted into a third variable would
make the upgrade fail *silently* — the push is inert without a key, so the
symptom would be kept calls never arriving with nothing on the row to say why.
Setting `OFFHAND_BASE_URL` is enough.

What that key buys has changed, and it is worth saying out loud: it used to
mean "someone can read a Grounders feed as Offhand", and it now also means
"someone can write notes into Offhand accounts, put audio in their storage and
spend their allowance". Offhand refuses with `503 partner_unconfigured` rather
than falling open when its own copy is missing or short, and compares it in
constant time. Rotating it is a two-repository operation.

**Setting Agora up**: console.agora.io → create a project → copy the App ID →
enable the App Certificate and copy it. The free tier is 10,000 minutes per
month, ongoing rather than a trial.

**Setting APNs VoIP up**: developer.apple.com → Certificates, Identifiers &
Profiles → Keys → new key with "Apple Push Notifications service (APNs)"
enabled. Download the `.p8` **once** — Apple will not show it again. The VoIP
topic is the bundle id with `.voip` appended. Firebase cannot send VoIP
pushes, which is why this goes to Apple directly.

---

## Cost

Verified against Agora's pricing page and billing reference (checked 13 Sep
2026), because the first draft of this table got the video ratio wrong by 4x.

**Everything is measured in Standard minutes, per user, per wall-clock
minute**, and audio and video are not close to each other:

| Subscription | Conversion | List price / 1,000 standard min |
|---|---|---|
| Audio | **1 : 1** | $0.99 |
| Video HD (aggregate resolution ≤ 1280x720) | **1 : 4** | $3.99 |
| Video Full HD | 1 : 9 | $8.99 |

Two things that catch people out. Usage is counted **per participant**, so a
two-person call burns two users' worth of minutes per wall-clock minute. And a
user subscribed to audio *and* video at the same time is billed as **video
only** — there is no separate audio line for them. HD is the floor tier for
any video at all, so lowering the resolution below 720p saves nothing.

**The Free package is 10,000 Standard minutes a month**, ongoing rather than a
trial, and new projects are auto-subscribed to it. What that actually buys:

| | Free wall-clock time per month |
|---|---|
| Two people, audio | **~83 hours** |
| Two people, HD video | **~21 hours** |
| Three people, HD video | **~14 hours** |
| Four people, HD video | **~10 hours** |

| Line | Rate | At ~40 participant-hours/month |
|---|---|---|
| Agora RTC, all audio | 10,000 standard min free | 2,400 standard min — **$0**, with real headroom |
| Agora RTC, all HD video | same | 9,600 standard min — **$0**, with almost none |
| On-device call recording | Not a billed Agora service. Cloud Recording is; this is not it — the mix is written by the client SDK on the phone | **$0** |
| TURN / relay | Included in Agora | **$0**, and nothing to operate |
| R2 storage | $0.015/GB-month, no egress; a kept call is ~12 MB/hour | 100 kept hours ≈ **$0.02/month** |
| R2 reads for the push | Class B operations, and **the audio now leaves R2 on every kept call** — once out to this server, once back up into Offhand's bucket. No egress fee either way (both hops are inside Cloudflare), so this is operations, not bandwidth | ~2 requests per kept call — **$0** at any volume this sees |
| Deepgram Nova-3 (Radio's own transcript) | $0.0043/min | 20 kept hours ≈ **$5/month** |
| AssemblyAI (Offhand's transcript of the pushed note) | $0.23/hour — Universal-3.5 Pro with diarization, the figure Offhand's own README states — billed to **Offhand**, not to this API | 20 kept hours ≈ **$4.60/month** on Offhand's bill |
| Railway, FCM, APNs | No new process, and no *live* media through the server | **$0** |

A kept call is therefore transcribed twice, by two providers, on two bills: the
Radio pipeline makes the transcript the feed and the MCP connector read, and
AssemblyAI makes the one inside the Offhand note. That is redundant and it is
deliberate for now — collapsing them means one of the two apps reading the
other's transcript over the wire, which is a dependency neither side has today.
If the bill ever matters, the cheaper half to drop is Radio's: set
`TRANSCRIBE_PROVIDER=none` and a kept call still reaches Offhand with words.

Discarded recordings still cost exactly nothing, which is the point of doing
the mix on-device: **for a call nobody keeps**, the bytes never leave the
phone. For a call somebody keeps, they now leave it twice over — to R2, and
from there into Offhand.

### The Free package suspends, it does not bill

This is the part worth knowing before anyone leans on video. The Free
package's overuse policy is **service suspension** — not an overage charge.
Run past 10,000 standard minutes and calls stop working until a top-up or a
paid package is bought. Every paid tier has overage protection instead; Free
does not.

So the honest summary is: **audio calling is comfortably free at this scale,
and video calling is free up to about twenty hours a month of two-party
calls** — after which the failure mode is calls failing, not a surprise
invoice. If video use grows, the cheapest fix is the Starter package ($45.99
for 50,000 standard minutes), which also switches the overuse behaviour from
suspension to overage.

One lever exists in the app already: camera-off during a video call stops
publishing that stream, and a participant who is subscribed to audio alone
drops back to the audio rate.

---

## What has not been verified

Nothing here has run on a phone. The JavaScript is tested (87 checks in
`test/radio_call.test.js`), the Dart analyzes clean and is tested (21 checks in
the app's `test/call_test.dart`), and the Swift and Kotlin **have never been
compiled** — there was no macOS or Android toolchain available. Treat the
first build as a debugging session, not a formality.

In particular, before building any more on top of this:

1. **iOS mixed recording.** Two real phones, a release or TestFlight build, an
   actual conversation, then pull both files and confirm **both voices are in
   both**. If iOS records only the microphone, the design has to change, and
   it is far cheaper to learn that now than after the UI is built on it.

   **Do not test this on the iOS Simulator.** The Simulator writes the file at
   the path you gave it and leaves it **zero bytes**, with no error — which
   looks exactly like the failure you are testing for. This is reported and
   resolved as user error in Agora-Flutter-SDK issue #292, where the same code
   worked immediately on a real device. A zero-byte file on the Simulator is
   not evidence of anything.

   Two smaller things confirmed while checking that: `filePath` must be
   **absolute** (ours is, from `getApplicationSupportDirectory()`), and
   recording only works **after** the channel is joined (ours starts in
   `onJoinChannelSuccess`).
2. **The PushKit path.** A VoIP push must report to CallKit in the same run
   loop or iOS throttles and then revokes VoIP delivery *for that build*. Test
   it on an identifier you can afford to burn.
3. **Android 14 foreground service.** An untyped microphone foreground service
   is rejected at runtime. The type is declared in
   `packages/call_service`, and Play needs the foreground-service declaration
   form plus a demo video.
4. **App size.** `agora_rtc_engine` is large. Measure before and after, and use
   the Lite SDK / extension exclusion / ABI splits if it matters.

---

## Tests

`npm run test:radio_call` — 88 checks. The ones worth not deleting: the feature
is inert without credentials; a call id is not a key; everyone on a call is
checked against the database rather than trusted from the client's member list;
the App Certificate never appears in a response; `never_record` refuses with a
reason and a name; `kept_at` survives a cancel (asserted as SQL text, because
the harness stubs `pool.query` and a stub cannot notice a `CASE` clause being
deleted); a ringing call resolves itself into a missed one by being read; and a
kept call uploads as an ordinary voice note the transcription pipeline matches
unchanged.

`npm run test:offhand_push` — 74 checks, over the push into Offhand. It stubs
`global.fetch` and `S3Client.prototype.send` and asserts on the wire, because
the failure worth catching on this path is a request that succeeds while saying
the wrong thing. The ones worth not deleting: the push is inert without
`OFFHAND_BASE_URL` and a 32-character key, and writes no status at all in that
state; the partner key this API already holds is enough on its own, so the
upgrade cannot fail silently on a renamed variable; both partner calls carry
the bearer key; the key is Offhand's to mint
and this side never names one; the PUT carries the content type the presign
signed and the exact bytes; the capture body names that key and carries no
audio; only the keeper's own phone number leaves, never the other
participants'; a voice memo pushes nothing; each terminal refusal lands on the
status its name implies **and** stamps the connector flag; a retryable failure
stays `'pending'` and is re-run by the sweep rather than merely marked; and one
recording is delivered exactly once — a pushed row and a live claim are both
unclaimable, an expired claim is not.

Every other suite is inert on this path: the harness empties
`OFFHAND_BASE_URL` and `GROUNDERS_PARTNER_KEY`, so a developer's own `.env`
cannot make a harness recording arrive in a real Offhand account.
