/**
 * Transcribing a Radio voice note.
 *
 * The checks that matter are the ones about not doing damage and not spending
 * money, and they should never be removed:
 *
 *   1. Recording a voice note transcribes it, and the message is sent whether
 *      or not that works. Transcription is a passenger on the send, never a
 *      condition of it.
 *
 *   2. The same R2 object is never transcribed twice. copy-to-self puts a
 *      second radio_files row over one recording, and paying again would also
 *      let the two copies drift apart.
 *
 *   3. With no provider key the whole thing is inert — no status written, no
 *      call attempted, nothing thrown. That is the state of a fresh deploy
 *      and of every other suite in this repo.
 *
 *   4. A provider failure marks the transcript failed and leaves the message
 *      exactly as it was sent.
 *
 *   5. A claim expires. A process killed between the claim and the outcome
 *      must not leave the row 'pending' forever — but a job that is genuinely
 *      still running must never be stolen either, because that is paying the
 *      provider twice for one recording. Both halves are checked.
 *
 *   6. One account cannot spend without limit. The ceiling is in audio
 *      seconds per rolling 24 hours, hitting it is a reason the app can show
 *      rather than an error, and it lets go when the window moves. The length
 *      it charges by is client-supplied and never range-checked, so all three
 *      ways of declaring nothing - omitting it, sending 0, sending a negative
 *      - are charged the assumed minute. Any one of them summing as declared
 *      is the ceiling gone for the cost of one field in a JSON body.
 *
 * Two of those live half in SQL the harness cannot execute — it stubs
 * pool.query, so the stub decides what a WHERE clause would have matched. The
 * stub models both faithfully, which is what makes the behavioural checks
 * readable, but a model cannot catch the clause being deleted from the real
 * statement. So the statements are also asserted on as text, the same way the
 * "never writes text_content" check already is: the behaviour checks say the
 * rule is right, the SQL checks say the rule is the one the database is
 * actually asked to apply.
 *
 * The provider call is stubbed at global.fetch and asserted on the wire — the
 * URL, the header and the body Deepgram was about to be sent — because the
 * failure worth catching here is a request that succeeds while asking for the
 * wrong thing. R2 is stubbed at S3Client.prototype.send for the same reason:
 * the check is that the job asks for the object key the row names.
 */

// Before anything loads: a developer's real .env must not turn this suite
// into a paying Deepgram customer. Each phase sets the key it wants.
process.env.DEEPGRAM_API_KEY = '';
process.env.TRANSCRIBE_PROVIDER = 'deepgram';
// A small ceiling so it can be reached in a test without pretending to record
// five hours of audio. The service reads this once at load, so it has to be
// set before the harness pulls the app in below; every assertion works off
// radioTranscribe.DAILY_LIMIT_MS rather than off 300, so the checks keep
// meaning the same thing if the production default moves.
process.env.TRANSCRIBE_DAILY_SECONDS_PER_USER = '300';

const jwt = require('jsonwebtoken');
const { S3Client } = require('@aws-sdk/client-s3');
const { boot, check, run } = require('./harness');
const radioTranscribe = require('../src/services/radio_transcribe');
const transcribeSvc = require('../src/services/transcribe');

const LIMIT_MS = radioTranscribe.DAILY_LIMIT_MS;
const ASSUMED_MS = radioTranscribe.ASSUMED_DURATION_MS;
const STALE_MS = radioTranscribe.STALE_AFTER_MS;
const DAY_MS = 24 * 60 * 60 * 1000;

const ME = '11111111-1111-4111-8111-111111111111';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const WS = '44444444-4444-4444-8444-444444444444';

const KEY_ONE = `radio/${WS}/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.m4a`;
const KEY_TWO = `radio/${WS}/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.m4a`;
// A key nothing else shares, so a check about spending is about spending and
// not about the r2_key reuse path quietly making the call free.
let keySeq = 0;
const freshKey = () => `radio/${WS}/cccccccc-${String(++keySeq).padStart(4, '0')}-4ccc-8ccc-cccccccccccc.m4a`;

const AUDIO = Buffer.from('not really audio, but the right number of bytes');
const SPOKEN = 'Speaker 0: The gate code is on the fridge.';

const DEEPGRAM_OK = {
  metadata: { duration: 4.25 },
  results: {
    channels: [{ alternatives: [{ transcript: 'flat', paragraphs: { transcript: SPOKEN } }] }],
  },
};

run('radio_transcribe', async () => {
  const h = await boot();

  // ── The world the job runs in ──────────────────────────────────────────
  const status = new Map();   // file id → transcript_status, as the column would hold it
  const transcripts = new Map();
  const keyOf = new Map();
  const ownerOf = new Map();  // file id → owner_id, which is who the cap charges
  const durationOf = new Map(); // file id → duration_ms, null where none was declared
  const claimedAt = new Map();  // file id → transcript_claimed_at, in epoch ms
  const ready = [];           // markReady calls: { id, text, durationMs }
  const failed = [];          // markFailed calls
  let nextFileId = null;

  /**
   * Put a row on the table without going through the send path — a voice note
   * somebody already has, in whatever state the check needs it in.
   */
  const seed = (id, { state = null, durationMs = null, key = null, claimed = null, owner = ME } = {}) => {
    keyOf.set(id, key || freshKey());
    ownerOf.set(id, owner);
    durationOf.set(id, durationMs);
    status.set(id, state);
    if (claimed === null) claimedAt.delete(id); else claimedAt.set(id, claimed);
    if (state === 'ready') transcripts.set(id, SPOKEN); else transcripts.delete(id);
  };

  /**
   * Move every claim stamp back past the window — what the passage of a day
   * does, without a test that takes a day.
   */
  const rollWindowPast = () => {
    for (const id of claimedAt.keys()) claimedAt.set(id, Date.now() - DAY_MS - 60000);
  };

  /** What the cap's own SELECT would answer right now, for an assertion. */
  const spentMsFor = (ownerId, exceptId) => {
    let ms = 0;
    const cutoff = Date.now() - DAY_MS;
    for (const [id, st] of status) {
      if (id === exceptId) continue;
      if ((ownerOf.get(id) ?? ME) !== ownerId) continue;
      if (!(claimedAt.get(id) > cutoff)) continue;
      if (st !== 'pending' && st !== 'ready') continue;
      const d = durationOf.get(id);
      ms += (d === null || d === undefined || d <= 0) ? ASSUMED_MS : d;
    }
    return ms;
  };

  h.setQueryHandler((text, params) => {
    if (/UPDATE users SET radio_enabled/.test(text)) return { rows: [] };

    if (/SELECT 1 FROM radio_workspace_members WHERE workspace_id = \$1 AND user_id = \$2/.test(text)) {
      return { rows: params[0] === WS && params[1] === ME ? [{ '?column?': 1 }] : [] };
    }

    // recordFile's insert-and-charge CTE.
    if (/INSERT INTO radio_files/.test(text) && /radio_storage_used_bytes/.test(text)) {
      const id = nextFileId;
      keyOf.set(id, params[4]);
      ownerOf.set(id, params[2]);
      durationOf.set(id, params[8] ?? null);
      return { rows: [{
        id, workspace_id: params[1], owner_id: params[2], kind: params[3],
        r2_key: params[4], mime_type: params[5], filename: params[6],
        size_bytes: params[7], duration_ms: params[8],
        transcript: null, transcript_status: null,
        created_at: new Date().toISOString(),
      }] };
    }

    // claim(): the real thing is one conditional UPDATE, and the whole
    // "asking twice starts one job" guarantee rests on it. Model it exactly —
    // including the arm that takes over an expired claim, which is the only
    // thing standing between a killed process and a row wedged forever. The
    // staleness cutoff is read out of the statement's own parameter, so this
    // stub cannot drift from the window the service actually asks for.
    if (/UPDATE radio_files\s+SET transcript_status = 'pending',\s+transcript_claimed_at = NOW\(\)/.test(text)) {
      const [id, staleMs] = params;
      const now = status.get(id) ?? null;
      const stamp = claimedAt.has(id) ? claimedAt.get(id) : null;
      const eligible = now === null
        || now === 'failed'
        || (now === 'pending' && (stamp === null || stamp < Date.now() - staleMs));
      if (!eligible) return { rows: [] };
      status.set(id, 'pending');
      claimedAt.set(id, Date.now());   // SET transcript_claimed_at = NOW()
      return { rows: [{
        id, owner_id: ownerOf.get(id) ?? ME, workspace_id: WS,
        r2_key: keyOf.get(id), mime_type: 'audio/mp4',
        duration_ms: durationOf.get(id) ?? null,
        transcript: null, transcript_status: 'pending',
      }] };
    }

    // The daily spend lookup. Sums the same rows the real SELECT sums: this
    // owner, claimed inside the window, 'pending' or 'ready', with a duration
    // that is missing, zero or negative charged the assumed one rather than
    // taken at its word. bigint comes back from node-postgres as a string, so
    // it goes back as one here too.
    if (/SELECT COALESCE\(SUM\(CASE WHEN duration_ms IS NULL OR duration_ms <= 0/.test(text)) {
      const [ownerId, exceptId, assumed] = params;
      let ms = 0;
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [id, st] of status) {
        if (id === exceptId) continue;
        if ((ownerOf.get(id) ?? ME) !== ownerId) continue;
        if (!(claimedAt.get(id) > cutoff)) continue;
        if (st !== 'pending' && st !== 'ready') continue;
        const d = durationOf.get(id);
        ms += (d === null || d === undefined || d <= 0) ? assumed : d;
      }
      return { rows: [{ spent_ms: String(ms) }] };
    }

    // The hourly sweeper. Matched before markFailed's by-id update, which it
    // would otherwise look like.
    if (/SET transcript_status = 'failed'/.test(text) && /WHERE transcript_status = 'pending'/.test(text)) {
      const staleMs = params[0];
      const swept = [];
      for (const [id, st] of status) {
        if (st !== 'pending') continue;
        const stamp = claimedAt.has(id) ? claimedAt.get(id) : null;
        if (stamp !== null && stamp >= Date.now() - staleMs) continue;
        status.set(id, 'failed');
        swept.push({ id });
      }
      return { rows: swept };
    }

    if (/FROM radio_files\s+WHERE r2_key = \$1/.test(text)) {
      const [key, exceptId] = params;
      for (const [id, t] of transcripts) {
        if (id !== exceptId && keyOf.get(id) === key && status.get(id) === 'ready') {
          return { rows: [{ transcript: t, duration_ms: 4250 }] };
        }
      }
      return { rows: [] };
    }

    if (/SET transcript = \$2/.test(text)) {
      status.set(params[0], 'ready');
      transcripts.set(params[0], params[1]);
      // duration_ms = COALESCE(duration_ms, $3) — the provider's measurement
      // fills in the one the client never sent, and the cap reads it after.
      if (durationOf.get(params[0]) == null && params[2] != null) {
        durationOf.set(params[0], params[2]);
      }
      ready.push({ id: params[0], text: params[1], durationMs: params[2] });
      return { rows: [] };
    }
    if (/SET transcript_status = 'failed'/.test(text)) {
      status.set(params[0], 'failed');
      failed.push(params[0]);
      return { rows: [] };
    }
    if (/SET transcript_status = NULL/.test(text)) {
      status.set(params[0], null);
      // …, transcript_claimed_at = NULL — a claim handed back unspent must
      // not keep sitting in the day's total.
      claimedAt.delete(params[0]);
      return { rows: [] };
    }

    // The endpoint's two reads.
    if (/SELECT id, workspace_id, kind FROM radio_files WHERE id = \$1/.test(text)) {
      const id = params[0];
      return { rows: keyOf.has(id) ? [{ id, workspace_id: WS, kind: 'voice_note' }] : [] };
    }
    if (/SELECT transcript, transcript_status, transcribed_at/.test(text)) {
      const id = params[0];
      return { rows: [{
        transcript: transcripts.get(id) ?? null,
        transcript_status: status.get(id) ?? null,
        transcribed_at: status.get(id) === 'ready' ? new Date().toISOString() : null,
      }] };
    }

    return { rows: [], rowCount: 0 };
  });

  // R2: the only place the server ever holds voice-note bytes.
  const gets = [];
  const getOpts = [];
  S3Client.prototype.send = async (cmd, opts) => {
    gets.push(cmd.input);
    getOpts.push(opts);
    return {
      ContentLength: AUDIO.length,
      ContentType: 'audio/mp4',
      Body: { transformToByteArray: async () => new Uint8Array(AUDIO) },
    };
  };

  // Deepgram. The harness drives the app over real HTTP with this same
  // global, so anything that is not the provider goes through untouched.
  const calls = [];
  const realFetch = global.fetch;
  let respond = async () => new Response(JSON.stringify(DEEPGRAM_OK), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  global.fetch = async (url, opts) => {
    if (!String(url).includes('api.deepgram.com')) return realFetch(url, opts);
    calls.push({ url: String(url), opts });
    return respond(url, opts);
  };

  const token = jwt.sign({ sub: ME }, process.env.JWT_SECRET);
  const auth = { Authorization: `Bearer ${token}` };
  const sendVoiceNote = (id, r2Key, durationMs) => {
    nextFileId = id;
    return h.request('POST', `/radio/workspaces/${WS}/files`, {
      headers: auth,
      body: {
        kind: 'voice_note', r2_key: r2Key, size_bytes: AUDIO.length, mime_type: 'audio/mp4',
        ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      },
    });
  };
  const okAgain = () => { respond = async () => new Response(JSON.stringify(DEEPGRAM_OK), {
    status: 200, headers: { 'content-type': 'application/json' },
  }); };
  /** The most recent statement the app actually handed the database. */
  const lastQuery = (re) => [...h.queries].reverse().find((q) => re.test(q.text));

  const waitFor = async (fn, what) => {
    for (let i = 0; i < 400; i += 1) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  // ── 1. A voice note transcribes itself on send ─────────────────────────
  process.env.DEEPGRAM_API_KEY = 'test-key';
  const A = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sentA = await sendVoiceNote(A, KEY_ONE);
  check('sending a voice note answers 201 without waiting on a transcript',
    sentA.status === 201 && sentA.json.r2_key === KEY_ONE
      && sentA.json.transcript_status === null,
    sentA.json);

  await waitFor(() => ready.length === 1, 'the transcript to land');
  check('the transcript is stored on the row it belongs to',
    ready[0].id === A && ready[0].text === SPOKEN, ready[0]);
  check('the duration the provider reported fills in the one the client omitted',
    ready[0].durationMs === 4250, ready[0].durationMs);

  check('the bytes came from R2 through the S3 client, by the key on the row',
    gets.length === 1 && gets[0].Key === KEY_ONE, gets);
  // The AWS SDK ships requestTimeout = 0, so without a signal of its own this
  // download has no wall-clock ceiling - and a job that outlives the staleness
  // window is a job that gets re-claimed underneath it and billed twice.
  check('the download carries an abort signal, so a stalled stream cannot outlive the claim',
    !!getOpts[0] && !!getOpts[0].abortSignal
      && typeof getOpts[0].abortSignal.aborted === 'boolean',
    getOpts[0]);

  const dg = calls[0];
  check('Deepgram was asked for nova-3 with smart formatting, punctuation, diarization and paragraphs',
    calls.length === 1
      && dg.url.startsWith('https://api.deepgram.com/v1/listen?')
      && /[?&]model=nova-3(&|$)/.test(dg.url)
      && /[?&]smart_format=true(&|$)/.test(dg.url)
      && /[?&]punctuate=true(&|$)/.test(dg.url)
      && /[?&]diarize=true(&|$)/.test(dg.url)
      && /[?&]paragraphs=true(&|$)/.test(dg.url),
    dg && dg.url);
  check('the audio went up as a raw body with its own content type and a token header',
    dg.opts.method === 'POST'
      && dg.opts.headers.Authorization === 'Token test-key'
      && dg.opts.headers['Content-Type'] === 'audio/mp4'
      && Buffer.isBuffer(dg.opts.body) && dg.opts.body.equals(AUDIO),
    dg && dg.opts && dg.opts.headers);

  // ── 2. A second row over the same object costs nothing ─────────────────
  const B = 'bbbb1111-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const sentB = await sendVoiceNote(B, KEY_ONE);   // what copy-to-self makes
  await waitFor(() => ready.length === 2, 'the copy to be filled in');
  check('a row sharing an r2_key reuses the transcript already made for it',
    sentB.status === 201 && ready[1].id === B && ready[1].text === SPOKEN, ready[1]);
  check('reusing it cost no provider call and no download',
    calls.length === 1 && gets.length === 1, { calls: calls.length, gets: gets.length });

  // ── 3. No key: inert ───────────────────────────────────────────────────
  process.env.DEEPGRAM_API_KEY = '';
  const C = 'cccc1111-cccc-4ccc-8ccc-cccccccccccc';
  const before = h.queries.length;
  const sentC = await sendVoiceNote(C, KEY_TWO);
  await new Promise((r) => setTimeout(r, 30));
  check('with no provider key the voice note still sends',
    sentC.status === 201 && sentC.json.id === C, sentC.json);
  check('with no provider key nothing is claimed and the status stays null',
    (status.get(C) ?? null) === null
      && !h.queries.slice(before).some((q) => /transcript_status = 'pending'/.test(q.text)),
    status.get(C));
  check('with no provider key no call was attempted',
    calls.length === 1 && gets.length === 1, { calls: calls.length, gets: gets.length });

  const askedWithNoKey = await h.request('POST', `/radio/files/${C}/transcribe`, { headers: auth });
  check('asking for one anyway answers, rather than erroring, and says why not',
    askedWithNoKey.status === 200 && askedWithNoKey.json.started === false
      && askedWithNoKey.json.reason === 'not_configured'
      && askedWithNoKey.json.transcript_status === null,
    askedWithNoKey.json);

  // ── 4. A provider failure loses nothing ────────────────────────────────
  process.env.DEEPGRAM_API_KEY = 'test-key';
  respond = async () => new Response('upstream exploded', { status: 502 });
  const D = 'dddd1111-dddd-4ddd-8ddd-dddddddddddd';
  const sentD = await sendVoiceNote(D, KEY_TWO);
  await waitFor(() => failed.includes(D), 'the failure to be recorded');
  check('a provider failure never fails the send — the message is there, intact',
    sentD.status === 201 && sentD.json.id === D && sentD.json.kind === 'voice_note'
      && sentD.json.r2_key === KEY_TWO,
    sentD.json);
  check('the row is marked failed, and no transcript is invented for it',
    status.get(D) === 'failed' && !transcripts.has(D), status.get(D));
  check('nothing in the transcription path ever writes text_content',
    !h.queries.some((q) => /text_content\s*=/.test(q.text)));
  check('a failure is retryable — the endpoint claims a failed row again',
    (await h.request('POST', `/radio/files/${D}/transcribe`, { headers: auth })).json.started === true);
  await waitFor(() => failed.filter((id) => id === D).length === 2, 'the retry to finish');

  // ── 5. Only members may ask ────────────────────────────────────────────
  const strangerToken = jwt.sign({ sub: STRANGER }, process.env.JWT_SECRET);
  const refused = await h.request('POST', `/radio/files/${A}/transcribe`, {
    headers: { Authorization: `Bearer ${strangerToken}` },
  });
  check('someone who is not in the workspace cannot ask for a transcript',
    refused.status === 403 && /not a member/i.test(refused.json.error), refused);

  const missing = await h.request('POST', '/radio/files/eeee1111-eeee-4eee-8eee-eeeeeeeeeeee/transcribe', { headers: auth });
  check('a file that does not exist is a 404, not a job', missing.status === 404, missing.json);

  // ── 6. Asking twice while pending starts one job ───────────────────────
  let release;
  respond = () => new Promise((r) => { release = () => r(new Response(JSON.stringify(DEEPGRAM_OK), {
    status: 200, headers: { 'content-type': 'application/json' },
  })); });
  const F = 'ffff1111-ffff-4fff-8fff-ffffffffffff';
  status.set(F, null);
  keyOf.set(F, KEY_TWO);
  transcripts.delete(F);

  const callsBefore = calls.length;
  const first = await h.request('POST', `/radio/files/${F}/transcribe`, { headers: auth });
  const second = await h.request('POST', `/radio/files/${F}/transcribe`, { headers: auth });
  check('the first ask starts the job and reports it pending',
    first.status === 200 && first.json.started === true
      && first.json.transcript_status === 'pending',
    first.json);
  check('asking again while it is pending starts nothing and says so',
    second.status === 200 && second.json.started === false && second.json.reason === 'already'
      && second.json.transcript_status === 'pending',
    second.json);
  await waitFor(() => calls.length > callsBefore, 'the one provider call');
  check('exactly one provider call was made for the two asks',
    calls.length === callsBefore + 1, calls.length - callsBefore);

  release();
  await waitFor(() => status.get(F) === 'ready', 'the held job to finish');

  // ── 7. A claim expires — but only after it has had its chance ──────────
  // The two halves are one decision and have to be checked together: an
  // expiry short enough to unstick a dead process is also short enough to rob
  // a live one, and robbing a live one means paying Deepgram twice for one
  // recording. So the window is asserted against the provider's own timeout,
  // then both sides of it are exercised.
  okAgain();

  check('the staleness window sits well clear of the provider timeout, so a running job is never stolen',
    STALE_MS >= 4 * transcribeSvc.TRANSCRIBE_TIMEOUT_MS,
    { staleMs: STALE_MS, providerTimeoutMs: transcribeSvc.TRANSCRIBE_TIMEOUT_MS });
  // That comparison is only a proof if every step a running job takes is
  // bounded. The provider POST always was; the download is what had to be
  // given a ceiling of its own. Both together have to fit inside the window
  // with room, or the window is a guess about network weather.
  check('the download is bounded too, and both bounds together still fit inside the window',
    Number.isFinite(radioTranscribe.DOWNLOAD_TIMEOUT_MS)
      && radioTranscribe.DOWNLOAD_TIMEOUT_MS > 0
      && radioTranscribe.DOWNLOAD_TIMEOUT_MS + transcribeSvc.TRANSCRIBE_TIMEOUT_MS < STALE_MS,
    { downloadMs: radioTranscribe.DOWNLOAD_TIMEOUT_MS,
      providerMs: transcribeSvc.TRANSCRIBE_TIMEOUT_MS, staleMs: STALE_MS });

  const G = 'aaaa7777-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const freshClaimAt = Date.now();
  seed(G, { state: 'pending', durationMs: 1000, claimed: freshClaimAt });

  const callsBeforeFresh = calls.length;
  const notStolen = await h.request('POST', `/radio/files/${G}/transcribe`, { headers: auth });
  check('a claim taken moments ago is not stolen — the second ask is still just "already"',
    notStolen.status === 200 && notStolen.json.started === false
      && notStolen.json.reason === 'already'
      && notStolen.json.transcript_status === 'pending',
    notStolen.json);
  check('and the live claim keeps its original stamp, so the window is not quietly extended',
    claimedAt.get(G) === freshClaimAt, { was: freshClaimAt, now: claimedAt.get(G) });
  check('refusing to steal it costs no provider call',
    calls.length === callsBeforeFresh, calls.length - callsBeforeFresh);

  // Now the same row, claimed by a process that never came back.
  claimedAt.set(G, Date.now() - STALE_MS - 1000);
  const takenOver = await h.request('POST', `/radio/files/${G}/transcribe`, { headers: auth });
  check('a claim older than the window is re-claimable — a wedged row is not permanent',
    takenOver.status === 200 && takenOver.json.started === true
      && takenOver.json.transcript_status === 'pending',
    takenOver.json);
  check('taking it over re-stamps the claim, so the next caller waits the full window again',
    claimedAt.get(G) > Date.now() - STALE_MS, claimedAt.get(G));
  await waitFor(() => status.get(G) === 'ready', 'the re-claimed row to finish');
  check('and it finishes for real — the row that could never move now holds a transcript',
    transcripts.get(G) === SPOKEN, transcripts.get(G));

  // The other half of the same problem: nobody should have to press anything.
  const H = 'aaaa8888-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const I = 'aaaa9999-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  seed(H, { state: 'pending', durationMs: 1000, claimed: Date.now() - STALE_MS - 1000 });
  seed(I, { state: 'pending', durationMs: 1000, claimed: Date.now() });
  const swept = await radioTranscribe.sweepStaleClaims();
  check('the sweeper turns an abandoned claim into a failure, which is the state the app offers a retry on',
    swept === 1 && status.get(H) === 'failed', { swept, H: status.get(H) });
  check('the sweeper leaves a claim that is still inside its window alone',
    status.get(I) === 'pending', status.get(I));

  // …and the same two rules, read off the statements themselves. The stub
  // above decides what the WHERE clause would have matched; these decide that
  // the WHERE clause exists.
  const claimQ = lastQuery(/UPDATE radio_files\s+SET transcript_status = 'pending'/);
  check('the claim is still one conditional UPDATE that stamps the moment it took the row',
    !!claimQ
      && /SET transcript_status = 'pending',\s+transcript_claimed_at = NOW\(\)/.test(claimQ.text)
      && /WHERE id = \$1/.test(claimQ.text),
    claimQ && claimQ.text);
  check('its WHERE clause expires a claim — pending with a stamp past the window, or no stamp at all',
    !!claimQ
      && /transcript_status = 'pending'\s+AND \(transcript_claimed_at IS NULL\s+OR transcript_claimed_at < NOW\(\) - \(\$2::double precision \* INTERVAL '1 millisecond'\)/.test(claimQ.text)
      && claimQ.params[1] === STALE_MS,
    claimQ && { sql: claimQ.text, staleParam: claimQ.params[1] });
  check('and it returns owner_id, which is who the ceiling is charged to',
    !!claimQ && /RETURNING id, owner_id,/.test(claimQ.text), claimQ && claimQ.text);

  const sweepQ = lastQuery(/UPDATE radio_files\s+SET transcript_status = 'failed'\s+WHERE transcript_status = 'pending'/);
  check('the sweeper only ever touches pending rows whose claim has expired',
    !!sweepQ
      && /\(transcript_claimed_at IS NULL\s+OR transcript_claimed_at < NOW\(\) - \(\$1::double precision \* INTERVAL '1 millisecond'\)\)/.test(sweepQ.text)
      && sweepQ.params[0] === STALE_MS,
    sweepQ && { sql: sweepQ.text, staleParam: sweepQ.params[0] });

  // ── 8. One account cannot spend without limit ──────────────────────────
  // Everything above falls out of the rolling window first, so each of these
  // reads a total it set up itself.
  status.set(I, 'failed');            // stop the held row counting as in flight
  rollWindowPast();
  okAgain();

  // Almost a full day of audio already committed, with ten seconds left.
  const BULK = 'bbbb7777-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  seed(BULK, { state: 'ready', durationMs: LIMIT_MS - 10000, claimed: Date.now() });

  const FITS = 'bbbb8888-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  seed(FITS, { durationMs: 5000 });
  const fits = await h.request('POST', `/radio/files/${FITS}/transcribe`, { headers: auth });
  check('a note that still fits under the ceiling is transcribed — the cap refuses the overshoot, not the day',
    fits.json.started === true, { answer: fits.json, spent: spentMsFor(ME, FITS) });
  await waitFor(() => status.get(FITS) === 'ready', 'the last note that fits');

  const OVER = 'bbbb9999-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  seed(OVER, { durationMs: 6000 });   // 5s left, 6s asked for
  const callsBeforeCap = calls.length;
  const getsBeforeCap = gets.length;
  const capped = await h.request('POST', `/radio/files/${OVER}/transcribe`, { headers: auth });
  check('past the ceiling the ask is refused with a reason the app can show, not an error',
    capped.status === 200 && capped.json.started === false
      && capped.json.reason === 'daily_limit',
    capped.json);
  check('a refused ask hands the row straight back — no pending status, so no spinner with no exit',
    (status.get(OVER) ?? null) === null
      && capped.json.transcript_status === null
      && claimedAt.get(OVER) === undefined,
    { status: status.get(OVER) ?? null, claimed: claimedAt.get(OVER) });
  check('and being refused costs no provider call and no download',
    calls.length === callsBeforeCap && gets.length === getsBeforeCap,
    { calls: calls.length - callsBeforeCap, gets: gets.length - getsBeforeCap });

  // duration_ms comes off the client, and the client can just not send it. If
  // a missing duration counted as nothing, that omission would be the whole
  // way around the ceiling — so it is charged the assumed minute instead.
  rollWindowPast();
  check('there is an assumed duration to charge in the first place',
    Number.isFinite(ASSUMED_MS) && ASSUMED_MS > 0, ASSUMED_MS);
  const silent = [];
  const silentCount = Math.min(64, Math.max(1, Math.ceil(LIMIT_MS / Math.max(1, ASSUMED_MS))));
  for (let i = 0; i < silentCount; i += 1) {
    const id = `cccc${String(i).padStart(4, '0')}-cccc-4ccc-8ccc-cccccccccccc`;
    seed(id, { state: 'ready', durationMs: null, claimed: Date.now() });
    silent.push(id);
  }
  check('the rows set up for this really did declare no duration at all',
    silent.every((id) => durationOf.get(id) === null), silent.length);

  const SNEAK = 'dddd7777-dddd-4ddd-8ddd-dddddddddddd';
  seed(SNEAK, { durationMs: null });
  const sneaked = await h.request('POST', `/radio/files/${SNEAK}/transcribe`, { headers: auth });
  check('a note that declares no duration is charged the assumed minute, so omitting it is not a way past the cap',
    sneaked.json.started === false && sneaked.json.reason === 'daily_limit',
    { answer: sneaked.json, spent: spentMsFor(ME, SNEAK), limit: LIMIT_MS });

  // A declared 0 is the same exploit wearing a better disguise: NULL at least
  // looks like missing data, while 0 looks like a measurement. Summed as
  // declared it makes every note free.
  rollWindowPast();
  const zeros = [];
  for (let i = 0; i < silentCount; i += 1) {
    const id = `ffff${String(i).padStart(4, '0')}-ffff-4fff-8fff-ffffffffffff`;
    seed(id, { state: 'ready', durationMs: 0, claimed: Date.now() });
    zeros.push(id);
  }
  check('the rows set up for this really did declare a duration of zero',
    zeros.every((id) => durationOf.get(id) === 0), zeros.length);
  const ZERO = 'dddd8888-dddd-4ddd-8ddd-dddddddddddd';
  seed(ZERO, { durationMs: 0 });
  const zeroed = await h.request('POST', `/radio/files/${ZERO}/transcribe`, { headers: auth });
  check('a note that declares a zero duration is charged the assumed minute as well, so declaring 0 is not a way past the cap',
    zeroed.json.started === false && zeroed.json.reason === 'daily_limit',
    { answer: zeroed.json, spent: spentMsFor(ME, ZERO), limit: LIMIT_MS });

  // A negative is worse than free. Summed as declared it is a credit: one note
  // claiming minus an hour would pay for the next hour of real ones.
  rollWindowPast();
  const NEAR = 'ffff1111-1111-4fff-8fff-ffffffffffff';
  seed(NEAR, { state: 'ready', durationMs: LIMIT_MS - 10000, claimed: Date.now() });
  const CREDIT = 'ffff2222-2222-4fff-8fff-ffffffffffff';
  seed(CREDIT, { state: 'ready', durationMs: -10 * LIMIT_MS, claimed: Date.now() });
  const AFTER_CREDIT = 'ffff3333-3333-4fff-8fff-ffffffffffff';
  seed(AFTER_CREDIT, { durationMs: 20000 });
  const credited = await h.request('POST', `/radio/files/${AFTER_CREDIT}/transcribe`, { headers: auth });
  check('a negative duration buys no credit against the day - it is charged the assumed minute, not subtracted',
    credited.json.started === false && credited.json.reason === 'daily_limit',
    { answer: credited.json, spent: spentMsFor(ME, AFTER_CREDIT), limit: LIMIT_MS });

  // And the send path never lets the number onto the row in the first place:
  // a non-positive declared duration is stored as "unknown", which is the
  // state the ceiling charges the assumed minute for.
  rollWindowPast();
  const ZED = 'ffff4444-4444-4fff-8fff-ffffffffffff';
  const sentZed = await sendVoiceNote(ZED, freshKey(), 0);
  // Read off the inserted row itself rather than the map, which the provider's
  // own measurement backfills a moment later — that backfill is the proof the
  // column went in NULL.
  check('a voice note sent declaring a zero duration is stored with no duration at all, not with zero',
    sentZed.status === 201 && sentZed.json.duration_ms === null,
    { stored: sentZed.json.duration_ms });
  await waitFor(() => status.get(ZED) === 'ready', 'the zero-duration note to finish');

  // The ceiling read off its own statement, for the same reason as above.
  const spendQ = lastQuery(/SELECT COALESCE\(SUM\(CASE WHEN duration_ms IS NULL OR duration_ms <= 0/);
  check('the spend is summed per account over a rolling twenty-four hours, off the claim stamp',
    !!spendQ
      && /WHERE owner_id = \$1/.test(spendQ.text)
      && /transcript_claimed_at > NOW\(\) - INTERVAL '24 hours'/.test(spendQ.text),
    spendQ && spendQ.text);
  check('work still in flight is counted, so a burst of simultaneous asks cannot all read a cold total',
    !!spendQ && /transcript_status IN \('pending', 'ready'\)/.test(spendQ.text),
    spendQ && spendQ.text);
  check('the assumed minute is the value the SUM is actually handed',
    !!spendQ && spendQ.params[2] === ASSUMED_MS, spendQ && spendQ.params);
  check('and the SUM charges it for every non-duration - missing, zero and negative alike - rather than taking them at their word',
    !!spendQ
      && /SUM\(CASE WHEN duration_ms IS NULL OR duration_ms <= 0\s+THEN \$3 ELSE duration_ms END\)/.test(spendQ.text),
    spendQ && spendQ.text);

  // ── 9. The ceiling lets go ─────────────────────────────────────────────
  // It is a rolling twenty-four hours, not a permanent ban. If it did not
  // reset, one bad afternoon would end transcription for that account.
  rollWindowPast();
  const AFTER = 'eeee7777-eeee-4eee-8eee-eeeeeeeeeeee';
  seed(AFTER, { durationMs: 5000 });
  check('the day\'s spend really has rolled out of the window',
    spentMsFor(ME, AFTER) === 0, spentMsFor(ME, AFTER));
  const afterReset = await h.request('POST', `/radio/files/${AFTER}/transcribe`, { headers: auth });
  check('once the rolling window moves past the spend, the ask works again',
    afterReset.json.started === true && afterReset.json.transcript_status === 'pending',
    afterReset.json);
  await waitFor(() => status.get(AFTER) === 'ready', 'the first note of the new day');

  check('no rate-limit misconfiguration or unhandled error was logged',
    !h.consoleLines.some((l) => /ERR_ERL_|could not record|could not queue/.test(l)),
    h.consoleLines);

  await h.close();
});
