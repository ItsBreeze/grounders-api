/**
 * Handing a kept call to Offhand.
 *
 * A call somebody chose to keep is uploaded by the phone as an ordinary Radio
 * voice note (services/radio_send.recordFile) and, from that moment, this job
 * carries it the rest of the way: the audio goes into the keeper's own Offhand
 * account and comes back as a note, transcribed there by AssemblyAI. That is
 * the whole point of the feature — the words of the call in the place the
 * person keeps the rest of their thinking — and everything below exists to
 * make it arrive exactly once, or to say out loud that it did not.
 *
 * Push, not pull. The alternative was leaving the recording here with a flag
 * on it and letting Offhand's assistant notice it through the MCP connector
 * next time somebody asked. That is a kept call that arrives when the user
 * happens to ask a question, which is not a feature you can describe to
 * anyone. So this server does the delivering, and the flag
 * (radio_files.offhand_requested_at) is demoted to what happens when the
 * delivery cannot be made.
 *
 * Why the bytes go by presigned PUT and a JSON call, in that order. Three
 * routes were possible and two are wrong here. Posting the audio as a request
 * body to Offhand dies on its own express.json limit (2 MB against calls that
 * are tens of megabytes), and would hold a whole recording in two processes'
 * memory at once. Handing Offhand a URL and letting it fetch the audio is
 * server-side request forgery with extra steps — this codebase already learned
 * that lesson once, which is why services/article.js exists — and it would
 * mean Offhand fetching whatever any caller with the partner key named. So:
 * Offhand mints a presigned PUT into ITS OWN R2 namespace for the resolved
 * user (audio/<userId>/…), this job PUTs the bytes straight at R2, and then
 * one small JSON call says "that key is a note now". The partner cannot name
 * a key, cannot write outside that user's prefix, and no audio passes through
 * either express app.
 *
 * Inert without configuration. With OFFHAND_BASE_URL unset, or a partner key
 * shorter than a real secret, isConfigured() is false and this job claims
 * nothing, writes no status, and throws nothing: offhand_push_status stays
 * NULL and a kept call behaves exactly as it did before this file existed.
 * The same discipline services/radio_call and services/transcribe both state
 * in those words, and it is what makes a deploy that has not been given the
 * credentials a safe deploy rather than a broken one.
 *
 * Durable, and this is the part that is not optional. The phone deletes its
 * local recording the instant the R2 upload returns, so from then on R2 holds
 * the only copy and the phone can never re-drive anything. A push that failed
 * with a console.warn would be a call somebody chose to keep, was told was
 * kept, and which silently never arrives anywhere. So every attempt claims the
 * row, the claim expires the way transcription's does, an hourly sweep
 * re-drives what a dead process abandoned, and an attempt that cannot succeed
 * ends in a status somebody can read — plus a stamp on offhand_requested_at,
 * which puts the recording in front of Offhand through the connector instead.
 * Failing loudly into the user's own assistant is the fallback; failing
 * quietly is not one.
 *
 * A phone number leaves this server. Offhand identifies the account by the
 * same digits the person proved to both apps, because that is the only
 * identifier the two systems share — it is the whole basis of the existing
 * partner link (routes/partner.js, in the other direction). It is the
 * keeper's own number, sent to one configured host under a shared key, and
 * never anybody else's: the other people on the call reach Offhand as display
 * names in `attendees`, which is what a summary needs to say who spoke and is
 * not an identifier for anything.
 */

const { S3Client, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const pool = require('../db/pool');
const { phoneFrom } = require('../utils/phone');

/**
 * Anything shorter than this is a placeholder, not a secret — the same
 * sentence and the same number routes/partner.js applies to the key coming
 * the other way. Stated as a configuration condition rather than checked at
 * the call: a deploy holding `changeme` should be inert, not sending it.
 */
const MIN_KEY_LENGTH = 32;

/**
 * How long a claim is believed before the sweep may take it over.
 *
 * As with transcription, this number is only honest if every step a running
 * push can take is itself bounded, and they all are: the R2 download by
 * DOWNLOAD_TIMEOUT_MS, the PUT by UPLOAD_TIMEOUT_MS, and each of the two JSON
 * calls by PARTNER_TIMEOUT_MS. Worst legal case is 2 + 2 + 0.5 + 0.5 minutes
 * plus the writes — about five — against a fifteen-minute window. The cost of
 * getting this wrong in the short direction is two processes uploading one
 * recording, which Offhand's idempotency key would collapse into one note
 * anyway, but which would spend the bandwidth twice and race two writes onto
 * one row for no reason.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * When the sweep stops trying.
 *
 * A retryable failure — a 5xx, a dropped socket, an Offhand deploy in
 * progress — leaves the row 'pending' and the hourly sweep picks it up again.
 * That has to end somewhere, or one unreachable host means a row retried
 * forever and a recording that is neither delivered nor admitted to.
 *
 * The bound is wall-clock rather than a counter column, which is the one place
 * this file departs from the obvious design, so: the push is queued by
 * recordFile the moment the row is inserted, which makes radio_files.created_at
 * the time of the first attempt to within a second. An hourly sweep against a
 * 24-hour window is therefore at most about twenty-four attempts, which is the
 * bounded attempt count, and it costs no fourth column on a table this size.
 * If a push is ever queued from somewhere other than the insert, this stops
 * being true and it needs its own counter.
 *
 * A day and not an hour because the failure this is forgiving is somebody
 * else's outage, and a day of hourly retries is a generous, harmless thing to
 * offer a partner service. Past it the row is marked 'failed' and flagged for
 * the connector, which is a worse road to Offhand but a real one.
 */
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How many abandoned pushes one sweep will re-drive.
 *
 * Each one holds a whole recording in memory while it uploads, so a sweep that
 * found two hundred stale rows and started them all would be an out-of-memory
 * kill on a Railway container — and the rows it was trying to rescue would be
 * abandoned by the very process that was rescuing them. They run one after
 * another, ten at a time, and the sweep runs again in an hour.
 */
const SWEEP_BATCH = 10;

/**
 * The wall-clock ceilings. The download is the same two minutes transcription
 * allows for the same object from the same bucket; the upload gets the same,
 * because it is the same bytes going the other way over a link this server
 * does not control. The JSON calls are small and get thirty seconds — long
 * enough for a cold Offhand container, short enough that two of them cannot
 * eat the claim window.
 *
 * All three are AbortSignal.timeout, not client-level settings: the AWS SDK
 * ships requestTimeout = 0 (see @smithy/node-http-handler, which only arms a
 * timer when one is configured), and a signal bounds the TOTAL — once it fires
 * every remaining retry attempt fails fast on the already-aborted signal
 * rather than starting its own fresh clock.
 */
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const PARTNER_TIMEOUT_MS = 30 * 1000;

/**
 * The object ceiling, checked against R2's ContentLength before a byte is
 * read. 25 MB is about an hour of the AAC the calling path records, and it is
 * deliberately the same number services/transcribe.js refuses at: both are
 * "one object, in memory, once". It is restated here rather than imported
 * because this path must not depend on the transcription provider module —
 * the two ceilings answer to different bills (Deepgram's minute against
 * Offhand's upload limit) and the day they differ, this is the one that
 * follows Offhand.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Read at call time, not at load. A server given its credentials by a deploy
 * that restarts the process would not care, but the suites flip these between
 * phases to check that an unconfigured deploy attempts nothing, and a constant
 * frozen at require() would make that untestable in the one direction it
 * matters.
 */
function baseUrl() {
  return String(process.env.OFFHAND_BASE_URL || '').trim().replace(/\/+$/, '');
}

/**
 * The shared partner key, under either of the two names it goes by.
 *
 * There is ONE secret. This repo has always stored it as OFFHAND_PARTNER_KEY —
 * the key Offhand presents at /partner/offhand/link — and Offhand stores the
 * same string as GROUNDERS_PARTNER_KEY, which is also the name its capture
 * routes check it under. Both .env.example files have said so since the link
 * shipped: "the same value as GROUNDERS_PARTNER_KEY on the Offhand server".
 *
 * So the wire contract's name is read first, and the name this repo already
 * holds the identical secret under is the fallback. That is not tidiness: a
 * deploy that already has the link working has the value in
 * OFFHAND_PARTNER_KEY, and demanding it be pasted into a second variable would
 * make the common upgrade fail SILENTLY — this job is inert without a key, so
 * the symptom would be kept calls quietly never arriving, with no status on
 * any row to explain it. Setting OFFHAND_BASE_URL is enough.
 *
 * The consequence is worth stating plainly, because it is new: that key used
 * to buy a read-only connector grant in this direction. Offhand's capture
 * routes now accept the same secret inbound, where it creates a note on an
 * account, writes audio into that account's storage and spends its allowance.
 * One lock, two doors. Rotating it is now a two-repo operation.
 */
function partnerKey() {
  return String(process.env.GROUNDERS_PARTNER_KEY || process.env.OFFHAND_PARTNER_KEY || '');
}

/** True when this deploy has both halves of the link and may attempt a push. */
function isConfigured() {
  return Boolean(baseUrl()) && partnerKey().length >= MIN_KEY_LENGTH;
}

function r2() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Take the row for pushing, atomically. Returns the row if this call is the
 * one that claimed it, null if it was not eligible.
 *
 * The eligible set is narrower than transcription's on purpose. There, a
 * 'failed' row is claimable again because the endpoint is a retry button
 * somebody can press. Here there is no button: a terminal status has already
 * been written AND surfaced to the connector, so re-claiming it would mean an
 * hourly job re-running a push that has been refused, against an allowance
 * that will refuse it again. 'pushed' is never claimable either — that row has
 * a note id on it, and a second delivery would rest entirely on Offhand's
 * idempotency key to undo.
 *
 * So: never attempted, or a 'pending' claim past its window. The second arm is
 * the whole of the durability guarantee — see STALE_AFTER_MS — and it is what
 * lets the sweep hand an abandoned row to a living process. A 'pending' row
 * with no stamp at all predates the column and is treated as expired; it
 * cannot be anything else.
 *
 * `call_id IS NOT NULL` is belt and braces beside the caller's own check: the
 * push is for kept calls, and a voice memo that reached this by accident would
 * be somebody's private note leaving for another service.
 */
async function claim(fileId) {
  const { rows: [row] } = await pool.query(
    `UPDATE radio_files
        SET offhand_push_status = 'pending',
            offhand_push_claimed_at = NOW()
      WHERE id = $1
        AND call_id IS NOT NULL
        AND r2_key IS NOT NULL
        AND (offhand_push_status IS NULL
             OR (offhand_push_status = 'pending'
                 AND (offhand_push_claimed_at IS NULL
                      OR offhand_push_claimed_at < NOW() - ($2::double precision * INTERVAL '1 millisecond'))))
      RETURNING id, owner_id, workspace_id, call_id, r2_key, mime_type, filename, duration_ms, created_at`,
    [fileId, STALE_AFTER_MS],
  );
  return row || null;
}

/**
 * Delivered. The note id is Offhand's, kept so that "where did my call go?"
 * has an answer from this side without asking the other one.
 *
 * offhand_requested_at is deliberately left exactly as it is: if the user
 * flagged this row themselves, that ask is theirs and a successful push is not
 * a reason to erase it.
 */
async function markPushed(fileId, noteId) {
  await pool.query(
    `UPDATE radio_files
        SET offhand_push_status = 'pushed',
            offhand_note_id = $2
      WHERE id = $1`,
    [fileId, noteId ? String(noteId) : null],
  );
}

/**
 * A terminal outcome, and the flag that gives the recording its second road.
 *
 * Both terminal marks write the same two things, because the second one is the
 * point: a recording this job could not deliver is stamped for the MCP
 * connector, so the next time the user's assistant reads the conversation the
 * call comes back at the top of it rather than sitting in a feed nobody
 * scrolls. COALESCE so a stamp the user set themselves keeps its own time —
 * "they asked for this at 09:04" is a fact worth more than "the push gave up
 * at 09:06".
 */
async function markTerminal(fileId, status) {
  await pool.query(
    `UPDATE radio_files
        SET offhand_push_status = $2,
            offhand_requested_at = COALESCE(offhand_requested_at, NOW())
      WHERE id = $1`,
    [fileId, status],
  );
}

/** Offhand refused the recording, or the retries ran out. */
async function markFailed(fileId) {
  await markTerminal(fileId, 'failed');
}

/**
 * There is no Offhand account these bytes could belong to: the keeper's
 * account here has no phone number (users.phone is nullable — the constraint
 * is phone_or_email — so an email-only account is a legal account and simply
 * cannot be matched), or Offhand has no live link for those digits, or the
 * link is broken and waiting to be reconnected.
 *
 * Its own status rather than 'failed' because nothing about retrying it
 * changes the answer, and because a row that says 'failed' invites somebody to
 * build a retry for it later.
 */
async function markUnmapped(fileId) {
  await markTerminal(fileId, 'unmapped');
}

/**
 * The number Offhand will resolve the account by. NULL for an email-only
 * account, which is a legal account here and an unmappable one there.
 */
async function phoneOf(userId) {
  const { rows: [row] } = await pool.query(
    `SELECT phone FROM users WHERE id = $1`,
    [userId],
  );
  const raw = row && row.phone ? String(row.phone).trim() : '';
  if (!raw) return null;
  // Through the SAME helper the link door uses. utils/phone.js says in its own
  // header that it is "shared by the connector's consent page and the Offhand
  // partner link, so one person's number resolves the same way whichever door
  // they come in by" — and this is a new door. users.phone is stored verbatim
  // from whatever was typed at sign-up (routes/auth.js) and never coerced, so
  // without this a person who linked as '780-555-0134' and signed up as
  // '+1 (780) 555-0134' is two different people to the lookup on the far side,
  // and every call they keep dies as a terminal 'no_account' they are never
  // told about.
  return phoneFrom(raw) || raw;
}

/**
 * Who was on the call, by display name.
 *
 * Names and nothing else. Offhand's notes carry `attendees` already — it is
 * what lets a summary say who said what — and a mixed recording of a call does
 * not label its speakers, so these names are the only chance the transcript
 * has of being read correctly. What they are NOT is identifiers: no user ids,
 * no phone numbers, nothing that would let the far side join these people to
 * anything. One person's number leaves this server, their own, and that is
 * already the smallest thing that can work.
 */
async function attendeesOf(callId) {
  const { rows } = await pool.query(
    `SELECT u.display_name
       FROM radio_call_participants p
       JOIN users u ON u.id = p.user_id
      WHERE p.call_id = $1
      ORDER BY p.joined_at NULLS LAST`,
    [callId],
  );
  return rows
    .map((r) => (r.display_name || '').trim())
    .filter(Boolean);
}

/**
 * What the note is called. The app names a kept call when it uploads it
 * ("Call with Alex"), and that is the sentence the person who kept it already
 * saw, so it wins. Falling back to the attendees rather than to "Radio call"
 * because a note list full of identical titles is a note list nobody reads.
 */
function titleFor(row, attendees) {
  const given = (row.filename || '').trim();
  if (given) return given;
  const others = attendees.filter(Boolean);
  if (others.length) return `Call with ${others.join(', ')}`;
  return 'Radio call';
}

/**
 * The object's size, without its bytes. Split out of fetchAudio so the ceiling
 * can be enforced before Offhand is asked for anywhere to put it.
 *
 * A HeadObject that fails is not treated as an answer: null means "could not
 * tell", and the caller carries on to fetchAudio, which asks the same question
 * again on the response head and refuses there. Better to attempt a push than
 * to abandon a recording because a metadata call blipped.
 */
async function sizeOf(r2Key) {
  try {
    const head = await r2().send(new HeadObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: r2Key,
    }), { abortSignal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    const n = Number(head.ContentLength);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    return null;
  }
}

/** The object's bytes, refused before they are read if the object is too big. */
async function fetchAudio(r2Key) {
  // The signal bounds the request AND the reading of its body: the SDK's node
  // handler wires it to req.destroy(), so a stream that stops arriving half
  // way through fails rather than hanging until the claim expires underneath
  // it. Without it this step has no wall-clock ceiling at all.
  const obj = await r2().send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: r2Key,
  }), { abortSignal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });

  // R2 states the size in the response head, so an object that would blow the
  // cap costs one request and no memory rather than being streamed in and then
  // thrown away. 413 is terminal: the object will not get smaller.
  const declared = Number(obj.ContentLength);
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
    throw Object.assign(
      new Error(`object is ${declared} bytes; the push limit is ${MAX_AUDIO_BYTES}`),
      { status: 413, storage: true },
    );
  }

  const bytes = await obj.Body.transformToByteArray();
  return {
    buffer: Buffer.from(bytes),
    mimeType: (obj.ContentType || '').split(';')[0] || null,
  };
}

/**
 * One JSON call to Offhand's partner surface, with the shared key.
 *
 * A non-2xx is thrown with the status AND the error name from the body
 * attached, because those names are the contract: `no_account` and
 * `link_disabled` and `allowance` mean different things to the row, and a
 * push that could only see "403" would have to guess at which. A body that is
 * not JSON at all (a proxy's HTML error page, most likely) leaves `partner`
 * undefined and the status decides, which is the right answer for exactly
 * that case.
 */
async function partnerPost(path, body) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${partnerKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PARTNER_TIMEOUT_MS),
  });

  let json = null;
  try { json = await res.json(); } catch (_) { /* not JSON; the status stands alone */ }

  if (!res.ok) {
    const name = json && typeof json.error === 'string' ? json.error : '';
    throw Object.assign(
      new Error(`Offhand answered ${res.status}${name ? ` ${name}` : ''} for ${path}`),
      { status: res.status, partner: name || undefined, allowance: json && json.allowance },
    );
  }
  return json || {};
}

/**
 * The bytes, straight at R2, on the URL Offhand signed.
 *
 * The Content-Type matters and is not cosmetic: Offhand signs the presigned
 * PUT with a ContentType, which puts content-type in the signature's signed
 * headers, so sending anything else is a 403 from R2 that reads like a
 * permissions problem and is not one. Send back exactly what the presign
 * answered with.
 */
async function putAudio(uploadUrl, buffer, contentType) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: buffer,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Tagged as storage, because the status ladder below reads a bare 403/404
    // as the PARTNER's vocabulary for link_disabled/no_account. R2 answers 403
    // for SignatureDoesNotMatch, an expired URL or clock skew, and 404 for a
    // missing bucket — none of which say anything about the user's Offhand
    // account, and all of which would otherwise mark the row terminally
    // 'unmapped' and send whoever reads that status to the phone-linking code
    // instead of to the clock.
    throw Object.assign(
      new Error(`the presigned upload answered ${res.status}`),
      { status: res.status, storage: true },
    );
  }
}

/**
 * The job itself, for a row this process has already claimed. Throws on
 * failure with a status attached; `push` is what classifies that and writes
 * the outcome.
 *
 * The order is download, presign, PUT, capture. Downloading first costs one
 * R2 GET on a push that turns out to be unmappable, which is nothing (R2
 * charges no egress, and the request is inside Cloudflare's network); doing it
 * the other way round would mint a key inside somebody's Offhand namespace
 * before knowing whether there are bytes to put in it.
 *
 * One cost of retrying is stated here rather than hidden: an attempt that dies
 * between the PUT and the capture has already put an object in Offhand's
 * bucket, and the retry presigns a fresh key and puts it there again. The note
 * does not double — Offhand keys it on 'radio-call:<call_id>' — but the first
 * object is left unreferenced on their side. That is the right trade at this
 * size (a few megabytes, rarely, against a kept call not arriving at all), and
 * the alternative — reusing a key across attempts — would mean this side
 * storing a minted key on the row and handing it back, which is exactly the
 * "the partner names the key" shape the design refuses.
 */
async function run(row) {
  const phone = await phoneOf(row.owner_id);
  if (!phone) {
    // Terminal, and not really an error: an account can legally be email-only
    // (users.phone is nullable, the constraint is phone_or_email), and there is
    // nothing to tell Offhand about a person it cannot name.
    throw Object.assign(
      new Error('the account that kept this call has no phone number to match in Offhand'),
      { status: 404, partner: 'no_account' },
    );
  }

  // Ask BEFORE fetching the bytes. This call is where Offhand refuses an
  // unlinked phone, a broken link or an account over its allowance, and each
  // of those costs one small request here instead of a 25 MB download from R2
  // that is then thrown away. It matters because an allowance refusal is
  // retried rather than abandoned (see outcomeFor): a free account that
  // subscribes tomorrow should get its call, and paying for the download on
  // every one of those attempts would be the sweep billing itself.
  //
  // The type comes from the row rather than from the object, because it is
  // signed INTO the URL and the PUT must send exactly it. The client declares
  // audio/aac when it finalizes, which is what Agora writes.
  const declaredType = row.mime_type || 'audio/aac';

  // Size before anything else. HeadObject is one cheap request, and asking it
  // here keeps two properties that would otherwise trade against each other:
  // an oversize call never mints a key in Offhand for bytes that are never
  // going to arrive, AND a refusal from Offhand never costs a 25 MB download.
  // 413 is terminal either way — the object will not get smaller.
  const declaredSize = await sizeOf(row.r2_key);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_AUDIO_BYTES) {
    throw Object.assign(
      new Error(`object is ${declaredSize} bytes; the push limit is ${MAX_AUDIO_BYTES}`),
      { status: 413, storage: true },
    );
  }

  // The key is minted by Offhand, for the Offhand user those digits resolve
  // to, inside that user's own audio/<userId>/ prefix. This side never names
  // a key, which is what keeps a stolen partner key from being a write
  // anywhere in Offhand's bucket.
  const presigned = await partnerPost('/partner/grounders/capture/upload-url', {
    phone,
    mime_type: declaredType,
  });
  if (!presigned.uploadUrl || !presigned.key) {
    throw new Error('Offhand did not return an upload URL and key');
  }

  const { buffer } = await fetchAudio(row.r2_key);
  await putAudio(presigned.uploadUrl, buffer, presigned.mimeType || declaredType);

  const attendees = await attendeesOf(row.call_id);
  const captured = await partnerPost('/partner/grounders/capture', {
    phone,
    // An array of one. Phase 2 is one note per call from several keepers'
    // recordings, and the shape is here from the start so that turning it on
    // is not a wire change on both sides at once.
    keys: [presigned.key],
    duration_ms: Number.isFinite(Number(row.duration_ms)) ? Number(row.duration_ms) : null,
    // What makes a second delivery of this call harmless: Offhand keys the
    // note on 'radio-call:<call_id>'. Two people keeping one call are two
    // Offhand accounts and therefore two notes, which is the right answer —
    // each of them kept it, and each of them gets it.
    call_id: row.call_id,
    title: titleFor(row, attendees),
    attendees,
  });

  await markPushed(row.id, captured.note_id);
  return { noteId: captured.note_id || null, displayName: captured.display_name || null };
}

/**
 * What a failure means for the row: 'retry' leaves it 'pending' for the sweep,
 * 'failed' and 'unmapped' are terminal and stamp the connector flag.
 *
 * The partner error NAME decides wherever there is one, because that is the
 * shared vocabulary and the status alone is ambiguous — a 403 is a broken link
 * (fixable by the user, in Offhand's own Settings) and a 400 could be a phone
 * this server cannot represent or a body Phase 2 will make legal. Status is
 * the fallback for everything that arrives without a name: a socket that
 * dropped, a timeout, a proxy's HTML, an Offhand deploy mid-restart.
 *
 * 503 partner_unconfigured is deliberately RETRYABLE even though it is a
 * refusal: it means the other end has not been given its key yet, which is a
 * deploy away from being fixed, and giving up on it would mean every call kept
 * during that window is lost to a config gap somebody was already fixing.
 */
function outcomeFor(err) {
  switch (err && err.partner) {
    case 'no_account':
    case 'link_disabled':
    case 'invalid_phone':
      return 'unmapped';
    case 'unauthorized':
      return 'failed';
    case 'partner_unconfigured':
      return 'retry';
    default: break;
  }

  // The allowance refusal is deliberately NOT in that switch. Offhand answers
  // 402 with `usage.checkAllowance`'s own reason as the error name — a word
  // from its billing vocabulary, which will grow plans this repo has never
  // heard of — so matching on names there would be pinning this file to
  // another service's pricing. The status is the part of that answer which is
  // contractual, and the status is enough: 402 is terminal whatever the plan
  // was called, and the allowance object travels back on the error for a log
  // to be specific about.
  const status = Number(err && err.status);
  // Origin first. A status only carries the partner's meaning when it came
  // from the partner; the same number off a storage call means something
  // entirely different, and 413 is the one storage refusal that genuinely will
  // not change on a retry (fetchAudio raises it deliberately, above its own
  // ceiling, before reading a body).
  if (err && err.storage) return status === 413 ? 'failed' : 'retry';
  // 402 is NOT terminal. Offhand's free tier compares a MONOTONIC lifetime
  // total against its cap, so a refusal today is a refusal forever unless
  // something changes on that account — and something routinely does: the
  // person subscribes, or their limit is raised. Abandoning the push on the
  // first 402 would mean a call they chose to keep is lost for good because
  // of a billing state that was temporary. It retries on the sweep's own
  // clock, cheaply now that the refusal happens before the download, and
  // GIVE_UP_AFTER_MS still bounds it — at which point offhand_requested_at is
  // stamped and the recording reaches Offhand through the connector instead.
  if (status === 402) return 'retry';
  if (status === 401 || status === 413) return 'failed';
  if (status === 404 || status === 403) return 'unmapped';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  // A 4xx with no name we know: the other end called this request wrong, and
  // sending it again unchanged would only produce the same answer.
  if (status >= 400) return 'failed';
  // No status at all — a dropped socket, a DNS failure, an abort. The network,
  // not the request.
  return 'retry';
}

/**
 * Push one file, awaiting only the claim. Resolves an outcome and never
 * rejects: `{ pushed }` on success, `{ pushed: false, reason }` otherwise,
 * where reason is 'not_configured' (nothing was written at all), 'already' (a
 * live claim, or a row already delivered or already given up on), or one of
 * 'failed' / 'unmapped' / 'retry'.
 *
 * The analogue of radio_transcribe.request, and the thing both the send path
 * and the sweep go through, so there is one place that decides what a failure
 * does to a row. Callers on a request path must not await it; see `queue`.
 */
async function push(fileId) {
  if (!isConfigured()) return { pushed: false, reason: 'not_configured' };

  const row = await claim(fileId);
  if (!row) return { pushed: false, reason: 'already' };

  try {
    const { noteId } = await run(row);
    return { pushed: true, noteId };
  } catch (err) {
    const outcome = outcomeFor(err);
    try {
      if (outcome === 'unmapped') await markUnmapped(row.id);
      else if (outcome === 'failed') await markFailed(row.id);
      // 'retry' writes nothing: the row stays 'pending' with this attempt's
      // claim stamp on it, which is exactly what the sweep looks for once the
      // window passes.
    } catch (e) {
      console.error('[offhand_push] could not record the outcome for', fileId, '—', e.message);
    }
    console.error(
      '[offhand_push] call recording', fileId, outcome === 'retry' ? 'will be retried:' : `${outcome}:`,
      err.message,
    );
    return { pushed: false, reason: outcome };
  }
}

/**
 * Fire-and-forget, for the send path. Never blocks the upload that created the
 * row, never rejects, never fails the message it belongs to — the same
 * contract radio_send documents for radioTranscribe.queue.
 *
 * "Fire-and-forget" is about this request, not about the work: what makes it
 * safe to drop the promise here is that the row carries the claim, so a
 * process that dies mid-push leaves something the sweep can find. That is the
 * difference between this and a background call that logs on failure.
 */
function queue(fileId) {
  push(fileId).catch((err) => {
    console.error('[offhand_push] could not queue call recording', fileId, '—', err.message);
  });
}

/**
 * Re-drive pushes a dead process abandoned, and give up on the ones that have
 * had their day. Wired to the hourly cron in src/server.js beside
 * sweepStaleClaims: one bounded batch, its own try/catch, a count logged only
 * when there is something to say, and it never throws at the scheduler.
 *
 * This sweep does more than transcription's, which only turns an abandoned
 * claim into 'failed' and waits for somebody to press a button. There is no
 * button here and no second copy of the audio anywhere, so an abandoned push
 * that is merely marked would be a kept call that never arrives. This one
 * actually runs them, one at a time (see SWEEP_BATCH), and only gives up when
 * the row has been trying for GIVE_UP_AFTER_MS — at which point the row is
 * marked and flagged for the connector, which is the fallback road.
 *
 * Inert without configuration, like everything else here: a deploy with no
 * OFFHAND_BASE_URL does not sweep rows into 'failed' that it never tried.
 */
async function sweepStalePushes() {
  if (!isConfigured()) return 0;
  try {
    // Give up first, and only on rows that are not in somebody's live claim —
    // a push that has been retried for a day and is running right now should
    // be allowed to finish, and markPushed would overwrite this anyway.
    const { rows: given } = await pool.query(
      `UPDATE radio_files
          SET offhand_push_status = 'failed',
              offhand_requested_at = COALESCE(offhand_requested_at, NOW())
        WHERE offhand_push_status = 'pending'
          AND created_at < NOW() - ($1::double precision * INTERVAL '1 millisecond')
          AND (offhand_push_claimed_at IS NULL
               OR offhand_push_claimed_at < NOW() - ($2::double precision * INTERVAL '1 millisecond'))
        RETURNING id`,
      [GIVE_UP_AFTER_MS, STALE_AFTER_MS],
    );

    // Two arms, and the second one is the important one.
    //
    // 'pending' is written by claim(), which runs inside the fire-and-forget
    // promise recordFile starts AFTER the radio_files row has already
    // committed. A Railway deploy in that window — this process installs no
    // SIGTERM handler — or a pool blip that makes the claim throw leaves a
    // kept call with offhand_push_status NULL. The phone deleted its only copy
    // the moment the upload returned, so if the sweep cannot see a NULL row,
    // that recording is gone and nothing on either side knows.
    //
    // The same arm makes the feature retroactive: every call kept while this
    // deploy had no OFFHAND_BASE_URL is sitting at NULL too, and is picked up
    // the first time the sweep runs configured. Both are gated on call_id and
    // r2_key so an ordinary voice memo is never swept — the push is call-only
    // by construction everywhere else and must stay so here.
    const { rows: stale } = await pool.query(
      `SELECT id
         FROM radio_files
        WHERE (
                offhand_push_status = 'pending'
                AND (offhand_push_claimed_at IS NULL
                     OR offhand_push_claimed_at < NOW() - ($1::double precision * INTERVAL '1 millisecond'))
              )
           OR (
                offhand_push_status IS NULL
                AND call_id IS NOT NULL
                AND r2_key IS NOT NULL
                AND created_at < NOW() - ($1::double precision * INTERVAL '1 millisecond')
              )
        ORDER BY created_at ASC
        LIMIT $2`,
      [STALE_AFTER_MS, SWEEP_BATCH],
    );

    // Sequentially. Each of these holds a whole recording in memory while it
    // uploads, and ten at once on a small container is the sweep killing the
    // process that is running it.
    let pushed = 0;
    for (const row of stale) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await push(row.id);
      if (outcome.pushed) pushed += 1;
    }

    if (given.length > 0 || stale.length > 0) {
      console.log(
        `[offhand_push] swept ${stale.length} abandoned push(es), ${pushed} delivered; `
        + `gave up on ${given.length}`,
      );
    }
    return stale.length + given.length;
  } catch (err) {
    console.error('[offhand_push] sweep failed:', err.message);
    return 0;
  }
}

module.exports = {
  isConfigured, queue, push, claim, run,
  markPushed, markFailed, markUnmapped, outcomeFor, sweepStalePushes,
  MIN_KEY_LENGTH, STALE_AFTER_MS, GIVE_UP_AFTER_MS, SWEEP_BATCH,
  DOWNLOAD_TIMEOUT_MS, UPLOAD_TIMEOUT_MS, PARTNER_TIMEOUT_MS, MAX_AUDIO_BYTES,
};
