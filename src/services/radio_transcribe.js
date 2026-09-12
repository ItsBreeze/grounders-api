/**
 * Turning a Radio voice note into text.
 *
 * Split from services/transcribe.js on purpose: that file is the provider
 * client and knows nothing about Radio — a Buffer in, `{ text, durationMs }`
 * out — while this one is the Radio job around it: which rows are eligible,
 * where the bytes come from, what a second copy of the same recording should
 * do, and what lands back in radio_files. Keeping the provider separate is
 * what lets the tests exercise this job without a network at all.
 *
 * Where the bytes come from. The server has never held voice-note bytes: the
 * phone PUTs straight to R2 with a presigned URL, and playback is an unsigned
 * public URL built by string concatenation. This job is the one place that
 * needs the audio itself, and it asks R2 for it with GetObjectCommand through
 * the S3 client rather than fetching the public URL over HTTP. Two reasons:
 * the bytes stay on a credentialed path instead of going out to the public
 * internet and back, and the day the bucket stops being public — which is the
 * direction that setting only ever moves — this keeps working while an HTTP
 * fetch of R2_PUBLIC_URL would start 403ing. (GetObjectCommand was already
 * imported and unused in routes/radio.js; a signed download was considered
 * once and never shipped. This is its first real use.)
 *
 * Background work. The repo's one existing pattern is
 * notifications.fireAndForget: an un-awaited promise with a catch that logs
 * and nothing more. `queue()` below is the same shape with a transcription
 * log prefix — it never rejects, never blocks the request that created the
 * message, and a provider failure marks the row 'failed' and leaves the
 * message itself exactly as it was sent.
 *
 * Inert without a key. If the configured provider has no credentials nothing
 * is claimed, no status is written, nothing throws: transcript_status stays
 * NULL and every route behaves as it did before this file existed.
 *
 * A claim expires. 'pending' is written by one process and cleared by the
 * same one; if that process dies in between — a deploy, a crash, a Railway
 * restart, all of which happen — nothing is left to clear it. So the claim is
 * stamped with transcript_claimed_at and claim() will take over one older than
 * STALE_AFTER_MS, and an hourly sweeper turns the abandoned ones into 'failed'
 * so the app shows a retry rather than a spinner nobody can get out of.
 *
 * A spend ceiling. The per-file guards stop one file being large and one row
 * being claimed twice; neither stops an account asking a thousand times. The
 * ceiling below is per owner, per rolling 24 hours, measured in the unit the
 * provider bills — audio seconds — and it answers with a reason rather than an
 * error, the way 'not_configured' does, so the app has something to show.
 */

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const pool = require('../db/pool');
const transcribe = require('./transcribe');

/**
 * How long a claim is believed before another caller may take it over.
 *
 * It has to sit above everything a genuinely running job can spend, because
 * the cost of being too short is stealing a live job and paying the provider
 * twice for one recording. That only means anything if every step a running
 * job takes is itself bounded, so both of them are: the R2 GetObject by
 * DOWNLOAD_TIMEOUT_MS below and the provider POST by
 * transcribe.TRANSCRIBE_TIMEOUT_MS. Worst legal case is therefore those two
 * plus the writes — about four minutes — against a ten-minute window.
 *
 * Without that download bound this number would be a guess rather than a
 * proof: the AWS SDK ships requestTimeout = 0 (see @smithy/node-http-handler,
 * which only arms a timer when one is configured), so a stalled socket has no
 * ceiling at all and no retry is ever triggered to replace it. A download that
 * hung past ten minutes would have its row swept to 'failed' and re-claimed
 * underneath it, which is two workers on one row and two Deepgram charges —
 * exactly the thing this window exists to prevent.
 *
 * It also has to sit low enough that a person who lost their job to a deploy
 * is not staring at a spinner for an afternoon. Ten minutes is one coffee, and
 * the manual endpoint becomes a working retry button the moment it passes.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * How long the whole R2 download may take, retries included.
 *
 * Passed to send() as an abortSignal rather than set as a client requestTimeout
 * because the signal bounds the *total*: once it fires every remaining retry
 * attempt fails fast on the already-aborted signal instead of starting its own
 * fresh clock. Two minutes is generous for an object the job would refuse past
 * 25 MB — that is ~1.7 Mbit/s sustained, well under a Railway-to-R2 number —
 * and it is what makes STALE_AFTER_MS above an arithmetic fact rather than a
 * hope about network weather.
 */
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The per-account ceiling, in seconds of audio per rolling 24 hours.
 *
 * Seconds, not files: seconds are what Deepgram bills, so a cap in files would
 * be a cap on the wrong thing — a hundred five-second memos and one hour-long
 * recording are not the same money. Rolling 24 hours rather than a calendar
 * day so there is no midnight at which a burst becomes free again.
 *
 * 7200s = two hours. Two reasons for that number and not a smaller one. It is
 * exactly twice the largest single object this job will accept: 25 MB is about
 * an hour of the AAC/Opus the apps record (see services/transcribe.js), so no
 * recording that passes the per-file cap can ever be refused by the per-day
 * one on its own — a ceiling that can reject a legal file is a ceiling that
 * produces bug reports. And two hours is roughly 240 half-minute memos, which
 * is far past anyone using the app and still bounds a runaway at about half a
 * dollar of provider spend per account per day instead of nothing at all.
 *
 * Charged to the row's owner — whoever recorded the audio — not to whoever
 * pressed the button. That is the axis that is actually unbounded: recording
 * is unbounded and is always charged to the recorder, while the manual
 * endpoint can only ever pay for a given row once, because a 'ready' row is
 * not claimable. Someone walking the button down a large workspace therefore
 * buys each note at most one transcript, and those are notes the send path
 * would have transcribed anyway on any deploy that had a key.
 *
 * One conservative edge, stated so nobody reads it as a bug: a row that turns
 * out to share an r2_key with an existing transcript is counted even though it
 * pays the provider nothing, because the reuse lookup happens after the claim.
 * Erring toward charged can only spend less, and copy-to-self is rare and
 * deliberate; the alternative is a second lookup on every request.
 *
 * Set TRANSCRIBE_DAILY_SECONDS_PER_USER=0 to turn the ceiling off entirely.
 */
const DAILY_LIMIT_MS = Math.max(0, Math.round(
  (Number(process.env.TRANSCRIBE_DAILY_SECONDS_PER_USER ?? 7200) || 0) * 1000,
));

/**
 * What an unknown duration is charged.
 *
 * duration_ms comes off the client on the send path and is never validated
 * there, so the client controls this number completely: it can omit it, send
 * 0, or send a negative. All three are charged this minute, because any of
 * them counting as nothing is the whole exploit — and 0 is the easier one to
 * miss, since NULL at least looks like missing data while 0 looks like a
 * measurement. A negative is worse than free: summed as declared it would be a
 * credit against the account's other notes.
 *
 * So the rule is "a duration is a positive number of milliseconds or it is not
 * a duration", applied in both places the money is counted — the SUM in
 * spentMsForOwner and the row's own length in overDailyLimit. A minute is
 * longer than the memos people actually record, so lying is never cheaper than
 * declaring, and small enough that a genuinely unmeasured note is not charged
 * an absurd share of the day. The guess is short-lived anyway — markReady
 * backfills duration_ms from what the provider measured, so it only ever
 * applies to a row in flight or one the provider never reported on.
 */
const ASSUMED_DURATION_MS = 60 * 1000;

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
 * Take the row for transcription, atomically. Returns the row if this call is
 * the one that claimed it, null if it was not eligible — no such row, not a
 * voice note, or already 'ready', or 'pending' with a claim still inside its
 * window (someone asked a moment ago).
 * (r2_key is NOT NULL on the table; the check below is belt and braces.) That WHERE clause is the whole of the "asking twice starts one
 * job" guarantee; a 'failed' row is claimable again, which is what makes the
 * endpoint a re-run button.
 *
 * The fourth arm of that clause is what keeps a wedged row from being
 * permanent. A claim is a promise by one process to finish or record a
 * failure, and a process that is killed mid-job keeps neither. So the claim
 * carries the moment it was taken and expires: past STALE_AFTER_MS the row is
 * claimable again and this UPDATE re-stamps it, which hands the claim to the
 * new caller and starts the window over. A pending row with no stamp at all
 * predates the column and is treated as expired — it cannot be anything else.
 *
 * The window is long enough (see STALE_AFTER_MS) that a job which is genuinely
 * still running is never taken from under itself. The atomicity is unchanged:
 * two callers racing a stale row still produce exactly one winner, because
 * this is still one conditional UPDATE.
 */
async function claim(fileId) {
  const { rows: [row] } = await pool.query(
    `UPDATE radio_files
        SET transcript_status = 'pending',
            transcript_claimed_at = NOW()
      WHERE id = $1
        AND kind = 'voice_note'
        AND r2_key IS NOT NULL
        AND (transcript_status IS NULL
             OR transcript_status = 'failed'
             OR (transcript_status = 'pending'
                 AND (transcript_claimed_at IS NULL
                      OR transcript_claimed_at < NOW() - ($2::double precision * INTERVAL '1 millisecond'))))
      RETURNING id, owner_id, workspace_id, r2_key, mime_type, duration_ms, transcript, transcript_status`,
    [fileId, STALE_AFTER_MS],
  );
  return row || null;
}

/**
 * Audio seconds this owner has already committed the provider to inside the
 * window, in milliseconds, ignoring one row (the one just claimed, which the
 * caller adds itself).
 *
 * Counted off transcript_claimed_at rather than created_at or transcribed_at:
 * the claim is the moment the money was committed, it is stamped on every row
 * that reaches a provider, and it is the same column on a row still running as
 * on one that finished. 'pending' rows are in the sum deliberately — work in
 * flight is spend already incurred, and leaving it out would let a burst of
 * simultaneous asks all read a cold total and all pass.
 *
 * 'failed' rows are NOT in the sum. A failure is usually a provider that never
 * billed, it is re-claimable by design, and counting failures would turn a
 * Deepgram outage into a day-long lockout for the people who hit it hardest.
 *
 * The CASE is the client-controlled-duration case: see ASSUMED_DURATION_MS.
 * A row whose declared length is missing, zero or negative is charged a
 * minute, because all three are a way of declaring nothing and the last is a
 * way of declaring less than nothing.
 */
async function spentMsForOwner(ownerId, exceptFileId) {
  const { rows: [row] } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN duration_ms IS NULL OR duration_ms <= 0
                              THEN $3 ELSE duration_ms END), 0)::bigint AS spent_ms
       FROM radio_files
      WHERE owner_id = $1
        AND id <> $2
        AND transcript_claimed_at > NOW() - INTERVAL '24 hours'
        AND transcript_status IN ('pending', 'ready')`,
    [ownerId, exceptFileId, ASSUMED_DURATION_MS],
  );
  // bigint comes back as a string from node-postgres.
  const spent = Number(row && row.spent_ms);
  return Number.isFinite(spent) ? spent : 0;
}

/**
 * Whether transcribing this claimed row would put its owner past the ceiling.
 * The row's own length is added to the total rather than checked after the
 * fact, so the last call that fits is allowed and the one that would overshoot
 * is the one refused.
 */
async function overDailyLimit(row) {
  if (!DAILY_LIMIT_MS) return false;
  const declared = Number(row.duration_ms);
  const thisRowMs = Number.isFinite(declared) && declared > 0 ? declared : ASSUMED_DURATION_MS;
  const spent = await spentMsForOwner(row.owner_id, row.id);
  return spent + thisRowMs > DAILY_LIMIT_MS;
}

/** A transcript already made for this same R2 object, on any row. */
async function existingForKey(r2Key, exceptId) {
  if (!r2Key) return null;
  const { rows: [row] } = await pool.query(
    `SELECT transcript, duration_ms
       FROM radio_files
      WHERE r2_key = $1
        AND id <> $2
        AND transcript_status = 'ready'
        AND transcript IS NOT NULL
      ORDER BY transcribed_at DESC NULLS LAST
      LIMIT 1`,
    [r2Key, exceptId],
  );
  return row || null;
}

async function markReady(fileId, text, durationMs) {
  await pool.query(
    `UPDATE radio_files
        SET transcript = $2,
            transcript_status = 'ready',
            transcribed_at = NOW(),
            duration_ms = COALESCE(duration_ms, $3)
      WHERE id = $1`,
    [fileId, text, Number.isFinite(durationMs) ? Math.round(durationMs) : null],
  );
}

async function markFailed(fileId) {
  await pool.query(
    `UPDATE radio_files SET transcript_status = 'failed' WHERE id = $1`,
    [fileId],
  );
}

/**
 * Put the row back to "never asked" — the state a deploy with no key is in.
 * The claim stamp goes with it: nothing was spent, so nothing should count
 * against the day, and a row left stamped would sit in the spend window for
 * twenty-four hours having cost the provider nothing.
 */
async function markUnasked(fileId) {
  await pool.query(
    `UPDATE radio_files
        SET transcript_status = NULL,
            transcript_claimed_at = NULL
      WHERE id = $1`,
    [fileId],
  );
}

/** The object's bytes, refused before they are read if the object is too big. */
async function fetchAudio(r2Key) {
  // The signal bounds the request and the reading of its body: it is wired to
  // req.destroy() by the SDK's node handler, so a stream that stops arriving
  // half way through fails rather than hanging. Without it this step has no
  // wall-clock ceiling at all; see DOWNLOAD_TIMEOUT_MS.
  const obj = await r2().send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: r2Key,
  }), { abortSignal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });

  // R2 tells us the size in the response head, so an object that would blow
  // the cap costs one request and no memory rather than being streamed in and
  // then thrown away.
  const declared = Number(obj.ContentLength);
  if (Number.isFinite(declared) && declared > transcribe.MAX_AUDIO_BYTES) {
    throw Object.assign(
      new Error(`object is ${declared} bytes; the transcription limit is ${transcribe.MAX_AUDIO_BYTES}`),
      { status: 413 },
    );
  }

  const bytes = await obj.Body.transformToByteArray();
  return {
    buffer: Buffer.from(bytes),
    mimeType: (obj.ContentType || '').split(';')[0] || null,
  };
}

/**
 * The job itself, for a row this process has already claimed. Throws on
 * failure; `queue` is what swallows that.
 */
async function run(row) {
  const reused = await existingForKey(row.r2_key, row.id);
  if (reused) {
    // The same recording, already paid for — copy-to-self rows share an
    // r2_key, and two copies drifting apart would be worse than the cost.
    await markReady(row.id, reused.transcript, row.duration_ms ?? reused.duration_ms);
    return { reused: true };
  }

  const { buffer, mimeType } = await fetchAudio(row.r2_key);
  const { text, durationMs } = await transcribe.transcribe(buffer, row.mime_type || mimeType || 'audio/mp4');
  if (!text) throw new Error('the provider returned an empty transcript');
  await markReady(row.id, text, row.duration_ms ?? durationMs);
  return { reused: false };
}

/**
 * Ask for a transcript, awaiting only the claim and the spend check. Resolves
 * `{ started, reason }`: `started` is true when this call is the one that
 * took the row, and `reason` says why not when it is false — 'not_configured'
 * (no provider key: nothing was written), 'daily_limit' (this account has
 * committed its day's audio seconds: nothing was written either), or 'already'
 * (a live claim, a transcript already there, or not a transcribable row).
 *
 * All three of those are answers, not errors. The route hands the reason
 * straight to the app, which needs a sentence to show under the tile;
 * a 500 there would only read as "the app is broken".
 *
 * Callers that must not block — recordFile — should not await even this; see
 * `queue`.
 */
async function request(fileId) {
  if (!transcribe.isConfigured()) return { started: false, reason: 'not_configured' };

  const row = await claim(fileId);
  if (!row) return { started: false, reason: 'already' };

  // The ceiling is checked after the claim, not before it, so that the owner
  // and the duration are read from the row this call actually holds rather
  // than from a separate select that a concurrent claim could invalidate. The
  // cost is that a refused call has to hand the row back — which is exactly
  // what markUnasked is, and it leaves the row in "nobody has asked", so the
  // ask button returns and works again once the window rolls forward.
  if (await overDailyLimit(row)) {
    await markUnasked(row.id);
    return { started: false, reason: 'daily_limit' };
  }

  // Un-awaited from here: the caller gets its answer as soon as the row says
  // 'pending'.
  run(row)
    .catch(async (err) => {
      // A key that vanished between the claim and the call is not a failure of
      // this recording — put the row back to "never asked" so it is inert
      // again rather than showing the user a permanent error.
      const unasked = err && (err.code === 'not_configured' || err.status === 501);
      try {
        if (unasked) await markUnasked(fileId); else await markFailed(fileId);
      } catch (e) {
        console.error('[transcribe] could not record the outcome:', e.message);
      }
      if (!unasked) console.error('[transcribe] voice note', fileId, 'failed:', err.message);
    });

  return { started: true };
}

/**
 * Fire-and-forget, for the send path. Never blocks, never rejects, never
 * fails the message it belongs to — same contract as
 * notifications.fireAndForget.
 */
function queue(fileId) {
  request(fileId).catch((err) => {
    console.error('[transcribe] could not queue voice note', fileId, '—', err.message);
  });
}

/**
 * Turn abandoned claims into failures. Wired to an hourly node-cron schedule
 * in src/server.js, the same shape as jobs/reap_users: one statement, its own
 * try/catch, a count logged only when there is something to say, and it never
 * throws at the scheduler.
 *
 * The expiring claim above already makes a wedged row recoverable — but only
 * by someone pressing the button. Until they do, the row still says 'pending'
 * and the feed still draws a spinner, because a row cannot fix its own status
 * without something running. That is what this adds and the claim alone does
 * not: an abandoned job becomes 'failed' on its own, which is the state the
 * app renders as "couldn't transcribe — tap to retry", and which claim() has
 * always treated as claimable. Nobody has to know the deploy ate their job.
 *
 * Hourly rather than reap_users' daily 3am: that job's window is fourteen days
 * and does not care about hours, this one's is ten minutes, and a daily sweep
 * would leave someone unlucky looking at a spinner until the small hours. An
 * hour bounds it at about seventy minutes untouched, and instantly if they tap.
 */
async function sweepStaleClaims() {
  try {
    const { rows } = await pool.query(
      `UPDATE radio_files
          SET transcript_status = 'failed'
        WHERE transcript_status = 'pending'
          AND (transcript_claimed_at IS NULL
               OR transcript_claimed_at < NOW() - ($1::double precision * INTERVAL '1 millisecond'))
        RETURNING id`,
      [STALE_AFTER_MS],
    );
    if (rows.length > 0) {
      console.log(`[transcribe] swept ${rows.length} abandoned claim(s) to failed`);
    }
    return rows.length;
  } catch (err) {
    console.error('[transcribe] sweep failed:', err.message);
    return 0;
  }
}

module.exports = {
  queue, request, run, claim, existingForKey, sweepStaleClaims,
  STALE_AFTER_MS, DOWNLOAD_TIMEOUT_MS, DAILY_LIMIT_MS, ASSUMED_DURATION_MS,
};
