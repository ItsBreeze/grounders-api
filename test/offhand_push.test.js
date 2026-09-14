/**
 * Pushing a kept call to Offhand.
 *
 * This is the one path in the repository that sends a user's audio to another
 * service, and it is the only copy of that audio in the world by the time it
 * runs — the phone deletes its local recording the moment the R2 upload
 * returns. So the checks here are about two things: that what goes over the
 * wire is exactly what was agreed, and that a recording somebody chose to keep
 * can never be silently dropped. None of them should be removed:
 *
 *   1. With no OFFHAND_BASE_URL or no real partner key the whole thing is
 *      inert — nothing claimed, no status written, no request attempted, and
 *      the kept call is recorded exactly as it was before this existed. That
 *      is the state of a fresh deploy and of every other suite in this repo.
 *
 *   2. The wire is the contract. Both partner calls carry the bearer key, the
 *      key is minted by Offhand and never named by this side, the bytes go
 *      straight to R2 on the presigned PUT with the content type the presign
 *      signed, and the capture call is small JSON naming that key — never the
 *      audio itself, which would die on Offhand's 2 MB express.json limit and
 *      hold one recording in two processes at once.
 *
 *   3. Only a kept call goes. A voice memo pushes nothing, because `call_id`
 *      is the one thing that puts a row on this path and a memo has none.
 *
 *   4. A terminal refusal is recorded AND flagged. 404/403/400 mean there is
 *      no Offhand account to deliver to ('unmapped'); 401/402/413 mean it was
 *      refused ('failed'); both stamp offhand_requested_at so the recording
 *      reaches Offhand through the MCP connector instead. A push that ends in
 *      a log line and nothing else is a kept call that never arrives.
 *
 *   5. A retryable failure is NOT terminal. A 5xx, a timeout, a dropped
 *      socket, and Offhand's own 503 partner_unconfigured all leave the row
 *      'pending' with its claim stamp, and the hourly sweep re-drives it —
 *      re-runs it, not merely marks it, because nothing else can. The retries
 *      end after a day, into the same flag.
 *
 *   6. One recording is delivered once. A row already pushed, and a row inside
 *      somebody else's live claim, are not claimable; an expired claim is.
 *
 * The partner calls are stubbed at global.fetch and asserted on the wire — the
 * URL, the Authorization header, and the body that was about to be sent —
 * because the failure worth catching here is a request that succeeds while
 * saying the wrong thing. R2 is stubbed at S3Client.prototype.send for the
 * same reason, and because a suite that reached a real bucket would be a suite
 * that could not run.
 *
 * Two of the guarantees live half in SQL the harness cannot execute — it stubs
 * pool.query, so the stub decides what a WHERE clause would have matched. The
 * stub models them faithfully, which is what makes the behavioural checks
 * readable, but a model cannot notice a clause being deleted from the real
 * statement. So the claim's eligibility arms and the flag-stamping UPDATE are
 * also asserted as text, the same way the transcription and calling suites pin
 * theirs.
 */

// Before anything loads: a developer's real .env must not point this suite at
// the real Offhand and push a harness recording into somebody's account under
// a real partner key. Emptied here as well as in the harness — dotenv never
// overrides a key that is already present, so this holds even if the harness's
// list is ever edited — and each phase below sets the configuration it wants.
process.env.OFFHAND_BASE_URL = '';
process.env.GROUNDERS_PARTNER_KEY = '';
process.env.OFFHAND_PARTNER_KEY = '';
// The S3 client refuses to construct without credentials at all. Obvious
// nonsense, so that anything reaching a real network fails loudly.
process.env.R2_ACCOUNT_ID = 'harness-account';
process.env.R2_ACCESS_KEY_ID = 'harness-key';
process.env.R2_SECRET_ACCESS_KEY = 'harness-secret';
process.env.R2_BUCKET_NAME = 'harness-bucket';

const jwt = require('jsonwebtoken');
const { S3Client } = require('@aws-sdk/client-s3');
const { boot, check, run } = require('./harness');
const offhandPush = require('../src/services/offhand_push');

const BASE = 'https://offhand.test';
const KEY = 'k'.repeat(40);

const ME = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const EMAIL_ONLY = '33333333-3333-4333-8333-333333333333';
const WS = '44444444-4444-4444-8444-444444444444';
const CALL = '55555555-5555-4555-8555-555555555555';

const MY_PHONE = '+17805550134';
const NOTE = 'note_9f3c1a';

// What Offhand answers the presign with: a key inside the resolved user's own
// namespace, which is the whole reason this side never names one.
const OFFHAND_KEY = 'audio/8ad0c2f1-user/1757800000000-9c1f.aac';
const UPLOAD_URL = `https://r2.offhand.test/${OFFHAND_KEY}?X-Amz-Signature=deadbeef`;

const AUDIO = Buffer.from('not really a call, but the right number of bytes');

const HOUR_MS = 60 * 60 * 1000;

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

run('offhand_push', async () => {
  const h = await boot();

  // ── The world the job runs in ──────────────────────────────────────────
  /** file id → the columns this job reads and writes. */
  const files = new Map();
  let nextFileId = null;

  const seed = (id, over = {}) => {
    files.set(id, {
      id,
      owner_id: ME,
      workspace_id: WS,
      call_id: CALL,
      r2_key: `radio/${WS}/${id}.aac`,
      mime_type: 'audio/aac',
      filename: 'Call with Alex',
      duration_ms: 840000,
      created_at: Date.now(),
      offhand_push_status: null,
      offhand_push_claimed_at: null,
      offhand_requested_at: null,
      offhand_note_id: null,
      ...over,
    });
    return files.get(id);
  };

  const phones = new Map([[ME, MY_PHONE], [FRIEND, '+17805550199'], [EMAIL_ONLY, null]]);

  h.setQueryHandler((text, params) => {
    if (/SELECT 1 FROM radio_workspace_members WHERE workspace_id = \$1 AND user_id = \$2/.test(text)) {
      return { rows: params[0] === WS && (params[1] === ME || params[1] === FRIEND) ? [{ '?column?': 1 }] : [] };
    }
    // The files route's own check that the uploader was on the call it names.
    if (/FROM radio_call_participants p\s+JOIN radio_calls c/.test(text)) {
      return { rows: params[0] === CALL && params[1] === ME ? [{ '?column?': 1 }] : [] };
    }
    // recordFile's insert-and-charge CTE.
    if (/INSERT INTO radio_files/.test(text) && /radio_storage_used_bytes/.test(text)) {
      const row = seed(nextFileId, {
        owner_id: params[2],
        r2_key: params[4],
        mime_type: params[5],
        filename: params[6],
        duration_ms: params[8],
        call_id: params[9],
      });
      return { rows: [{ ...row, kind: params[3], size_bytes: params[7], created_at: new Date().toISOString() }] };
    }

    // claim(): one conditional UPDATE, and the whole of "one recording is
    // delivered once". Modelled exactly, including the arm that takes over an
    // expired claim — the only thing standing between a killed process and a
    // kept call nobody ever delivers. The window comes out of the statement's
    // own parameter so this stub cannot drift from the service.
    if (/SET offhand_push_status = 'pending'/.test(text)) {
      const [id, staleMs] = params;
      const row = files.get(id);
      if (!row || !row.call_id || !row.r2_key) return { rows: [] };
      const stamp = row.offhand_push_claimed_at;
      const eligible = row.offhand_push_status === null
        || (row.offhand_push_status === 'pending'
            && (stamp === null || stamp < Date.now() - staleMs));
      if (!eligible) return { rows: [] };
      row.offhand_push_status = 'pending';
      row.offhand_push_claimed_at = Date.now();
      return { rows: [{ ...row }] };
    }

    // The sweep's give-up, which is a literal 'failed' rather than markFailed's
    // parameter — matched first for that reason.
    if (/SET offhand_push_status = 'failed'/.test(text)) {
      const [giveUpMs, staleMs] = params;
      const out = [];
      for (const row of files.values()) {
        if (row.offhand_push_status !== 'pending') continue;
        if (!(row.created_at < Date.now() - giveUpMs)) continue;
        const stamp = row.offhand_push_claimed_at;
        if (stamp !== null && stamp >= Date.now() - staleMs) continue;
        row.offhand_push_status = 'failed';
        row.offhand_requested_at = row.offhand_requested_at ?? new Date().toISOString();
        out.push({ id: row.id });
      }
      return { rows: out };
    }

    if (/SET offhand_push_status = 'pushed'/.test(text)) {
      const row = files.get(params[0]);
      if (row) { row.offhand_push_status = 'pushed'; row.offhand_note_id = params[1]; }
      return { rows: [] };
    }

    // markFailed / markUnmapped: the status, and the flag that gives the
    // recording its second road to Offhand.
    if (/SET offhand_push_status = \$2/.test(text)) {
      const row = files.get(params[0]);
      if (row) {
        row.offhand_push_status = params[1];
        row.offhand_requested_at = row.offhand_requested_at ?? new Date().toISOString();
      }
      return { rows: [] };
    }

    if (/SELECT id\s+FROM radio_files/.test(text) && /offhand_push_status = 'pending'/.test(text)) {
      const [staleMs, limit] = params;
      const out = [];
      for (const row of files.values()) {
        if (row.offhand_push_status !== 'pending') continue;
        const stamp = row.offhand_push_claimed_at;
        if (stamp !== null && stamp >= Date.now() - staleMs) continue;
        out.push({ id: row.id });
      }
      out.sort();
      return { rows: out.slice(0, limit) };
    }

    if (/SELECT phone FROM users WHERE id = \$1/.test(text)) {
      return { rows: [{ phone: phones.has(params[0]) ? phones.get(params[0]) : null }] };
    }
    if (/FROM radio_call_participants p\s+JOIN users u/.test(text)) {
      return { rows: [{ display_name: 'Sam' }, { display_name: 'Alex' }] };
    }
    if (/SELECT user_id FROM radio_workspace_members WHERE workspace_id = \$1 AND user_id != \$2/.test(text)) {
      return { rows: [{ user_id: FRIEND }] };
    }
    if (/SELECT display_name FROM users WHERE id = \$1/.test(text)) {
      return { rows: [{ display_name: 'Sam' }] };
    }
    if (/SELECT name FROM radio_workspaces WHERE id = \$1/.test(text)) {
      return { rows: [{ name: 'Field Notes' }] };
    }
    return { rows: [], rowCount: 0 };
  });

  // ── R2: where the only copy of a kept call lives ───────────────────────
  const gets = [];
  const getOpts = [];
  let contentLength = AUDIO.length;
  S3Client.prototype.send = async (cmd, opts) => {
    gets.push(cmd.input);
    getOpts.push(opts);
    return {
      ContentLength: contentLength,
      ContentType: 'audio/aac',
      Body: { transformToByteArray: async () => new Uint8Array(AUDIO) },
    };
  };

  // ── Offhand, and the R2 bucket it signs for ────────────────────────────
  // The harness drives the app over real HTTP with this same global, so
  // anything that is not the partner goes through untouched.
  const wire = [];
  const realFetch = global.fetch;
  let presign = async () => jsonResponse(200, { uploadUrl: UPLOAD_URL, key: OFFHAND_KEY, mimeType: 'audio/aac' });
  let upload = async () => new Response('', { status: 200 });
  let capture = async () => jsonResponse(202, { note_id: NOTE, status: 'pending', display_name: 'Sam' });

  global.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.startsWith(BASE) && !u.startsWith('https://r2.offhand.test')) return realFetch(url, opts);
    wire.push({ url: u, opts });
    if (u.endsWith('/capture/upload-url')) return presign(u, opts);
    if (u.endsWith('/partner/grounders/capture')) return capture(u, opts);
    return upload(u, opts);
  };

  const defaults = () => {
    presign = async () => jsonResponse(200, { uploadUrl: UPLOAD_URL, key: OFFHAND_KEY, mimeType: 'audio/aac' });
    upload = async () => new Response('', { status: 200 });
    capture = async () => jsonResponse(202, { note_id: NOTE, status: 'pending', display_name: 'Sam' });
    contentLength = AUDIO.length;
  };

  const sent = (suffix) => wire.filter((c) => c.url.includes(suffix));
  const bodyOf = (call) => JSON.parse(call.opts.body);
  const lastQuery = (re) => [...h.queries].reverse().find((q) => re.test(q.text));
  const waitFor = async (fn, what) => {
    for (let i = 0; i < 400; i += 1) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const token = jwt.sign({ sub: ME }, process.env.JWT_SECRET);
  const auth = { Authorization: `Bearer ${token}` };
  /** The finalize call a phone makes after its own R2 upload. */
  const finalize = (id, body) => {
    nextFileId = id;
    return h.request('POST', `/radio/workspaces/${WS}/files`, {
      headers: auth,
      body: {
        kind: 'voice_note', r2_key: `radio/${WS}/${id}.aac`, size_bytes: AUDIO.length,
        mime_type: 'audio/aac', duration_ms: 840000, filename: 'Call with Alex',
        ...body,
      },
    });
  };

  // ── 1. Inert without configuration ─────────────────────────────────────
  {
    process.env.OFFHAND_BASE_URL = '';
    process.env.OFFHAND_PARTNER_KEY = KEY;
    check('inert: no base URL means not configured, whatever keys are lying around',
      offhandPush.isConfigured() === false);

    process.env.OFFHAND_BASE_URL = BASE;
    process.env.OFFHAND_PARTNER_KEY = '';
    process.env.GROUNDERS_PARTNER_KEY = 'k'.repeat(offhandPush.MIN_KEY_LENGTH - 1);
    check('inert: a key shorter than 32 characters is a placeholder, not a secret',
      offhandPush.isConfigured() === false);

    // One secret, two names: this repo stores it as OFFHAND_PARTNER_KEY (the
    // key Offhand presents when it links a user) and Offhand stores the same
    // string as GROUNDERS_PARTNER_KEY, which is the name its capture routes
    // check. A deploy that already has the link working therefore has the
    // value under the second name only — and since this job is inert without a
    // key, demanding a rename would make the upgrade fail by doing nothing at
    // all, with no status on any row to explain it.
    process.env.GROUNDERS_PARTNER_KEY = '';
    process.env.OFFHAND_PARTNER_KEY = KEY;
    check('key: the partner key this API already holds is enough — only the base URL is new',
      offhandPush.isConfigured() === true);

    process.env.GROUNDERS_PARTNER_KEY = `${KEY}-wire-contract-name`;
    const named = await (async () => {
      const probe = seed('9999aaaa-9999-4999-8999-999999999999');
      defaults();
      wire.length = 0;
      await offhandPush.push(probe.id);
      return wire[0];
    })();
    check('key: the name the wire contract uses wins when both are set',
      named.opts.headers.Authorization === `Bearer ${KEY}-wire-contract-name`,
      named.opts.headers.Authorization);

    process.env.GROUNDERS_PARTNER_KEY = '';
    process.env.OFFHAND_PARTNER_KEY = '';
    process.env.OFFHAND_BASE_URL = '';
    wire.length = 0; gets.length = 0;

    const A = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const before = h.queries.length;
    const r = await finalize(A, { call_id: CALL });
    await new Promise((r2) => setTimeout(r2, 30));
    check('inert: a kept call still uploads and answers 201', r.status === 201, r.status);
    check('inert: nothing was claimed and no push status was written',
      files.get(A).offhand_push_status === null
        && !h.queries.slice(before).some((q) => /offhand_push_status/.test(q.text)),
      files.get(A).offhand_push_status);
    check('inert: nothing was sent to Offhand and nothing was read from R2',
      wire.length === 0 && gets.length === 0, { wire: wire.length, gets: gets.length });

    const swept = await offhandPush.sweepStalePushes();
    check('inert: the sweep does not mark rows it never tried', swept === 0, swept);
  }

  process.env.OFFHAND_BASE_URL = BASE;
  process.env.GROUNDERS_PARTNER_KEY = KEY;
  check('configured: both halves present', offhandPush.isConfigured() === true);

  // ── 2. The wire, end to end from the phone's finalize call ─────────────
  {
    defaults();
    wire.length = 0; gets.length = 0;
    const B = 'bbbb1111-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const r = await finalize(B, { call_id: CALL });
    check('push: the upload answers 201 without waiting on Offhand', r.status === 201, r.status);

    await waitFor(() => files.get(B).offhand_push_status === 'pushed', 'the push to land');

    // Two S3 commands now, not one: a HeadObject to learn the size before
    // Offhand is asked for anywhere to put it, then the GetObject for the
    // bytes. Both address the key on the row.
    check('push: the bytes came from R2 through the S3 client, by the key on the row',
      gets.length === 2 && gets.every((g) => g.Key === `radio/${WS}/${B}.aac`), gets);
    check('push: the download carries an abort signal, so a stalled stream cannot outlive the claim',
      !!getOpts[getOpts.length - 1]?.abortSignal
        && typeof getOpts[getOpts.length - 1].abortSignal.aborted === 'boolean');

    const pre = sent('/capture/upload-url')[0];
    check('wire: the presign is one POST to the partner route',
      sent('/capture/upload-url').length === 1
        && pre.url === `${BASE}/partner/grounders/capture/upload-url`
        && pre.opts.method === 'POST',
      pre && pre.url);
    check('wire: it carries the partner key as a bearer token',
      pre.opts.headers.Authorization === `Bearer ${KEY}`
        && pre.opts.headers['Content-Type'] === 'application/json',
      pre.opts.headers);
    check('wire: the presign asks with the phone and the mime type, and nothing else',
      JSON.stringify(bodyOf(pre)) === JSON.stringify({ phone: MY_PHONE, mime_type: 'audio/aac' }),
      bodyOf(pre));

    const put = sent('r2.offhand.test')[0];
    check('wire: the audio goes straight to R2 on the URL Offhand signed',
      sent('r2.offhand.test').length === 1 && put.url === UPLOAD_URL && put.opts.method === 'PUT',
      put && put.url);
    // Offhand signs the presigned PUT with a ContentType, which puts
    // content-type into the signature's signed headers. Anything else is a 403
    // from R2 that reads like a permissions problem and is not one.
    check('wire: the PUT sends the content type the presign signed, and the exact bytes',
      put.opts.headers['Content-Type'] === 'audio/aac'
        && Buffer.isBuffer(put.opts.body) && put.opts.body.equals(AUDIO),
      put.opts.headers);
    check('wire: no partner key is sent to the bucket',
      !JSON.stringify(put.opts.headers || {}).includes(KEY), put.opts.headers);

    const cap = sent('/partner/grounders/capture')
      .filter((c) => !c.url.includes('upload-url'))[0];
    const capBody = bodyOf(cap);
    check('wire: the capture is one POST with the bearer key',
      cap.url === `${BASE}/partner/grounders/capture` && cap.opts.method === 'POST'
        && cap.opts.headers.Authorization === `Bearer ${KEY}`,
      cap && cap.url);
    // The audio must never travel in this body: Offhand's express.json caps at
    // 2 MB, and a kept call is tens of megabytes.
    check('wire: the capture names the key Offhand minted and carries no audio',
      Array.isArray(capBody.keys) && capBody.keys.length === 1 && capBody.keys[0] === OFFHAND_KEY
        && typeof cap.opts.body === 'string' && cap.opts.body.length < 1024,
      capBody.keys);
    check('wire: it carries the call, its length, the title and the attendees',
      capBody.call_id === CALL && capBody.duration_ms === 840000
        && capBody.title === 'Call with Alex'
        && JSON.stringify(capBody.attendees) === JSON.stringify(['Sam', 'Alex']),
      capBody);
    // Names, not identifiers. One phone number leaves this server — the
    // keeper's own, which is how Offhand finds the account — and nobody
    // else's number or id goes with it.
    check('wire: only the keeper\'s own phone number leaves, never the other participants\'',
      capBody.phone === MY_PHONE
        && !JSON.stringify(capBody.attendees).includes('+')
        && !JSON.stringify(capBody).includes(FRIEND),
      capBody.attendees);

    check('push: the note id Offhand answered with is kept on the row',
      files.get(B).offhand_note_id === NOTE, files.get(B));
    check('push: a delivered call is not flagged for the connector',
      files.get(B).offhand_requested_at === null, files.get(B).offhand_requested_at);

    // Asserted as text as well as behaviour: the harness stubs pool.query, so
    // a stub decides what this WHERE matches, and deleting an arm from the
    // real statement would leave every behavioural check green.
    const claimSql = lastQuery(/SET offhand_push_status = 'pending'/).text;
    check('sql: the claim only ever takes a call recording',
      /AND call_id IS NOT NULL/.test(claimSql) && /AND r2_key IS NOT NULL/.test(claimSql), claimSql);
    check('sql: and only a row nothing has attempted, or a claim past its window',
      /offhand_push_status IS NULL/.test(claimSql)
        && /offhand_push_claimed_at < NOW\(\) - /.test(claimSql), claimSql);
  }

  // ── 3. A second attempt on a delivered row does nothing ────────────────
  {
    const B = 'bbbb1111-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const wireBefore = wire.length;
    const again = await offhandPush.push(B);
    check('once: a row already pushed is not claimable',
      again.pushed === false && again.reason === 'already', again);
    check('once: and nothing was sent a second time', wire.length === wireBefore);

    const live = seed('cccc1111-cccc-4ccc-8ccc-cccccccccccc', {
      offhand_push_status: 'pending', offhand_push_claimed_at: Date.now(),
    });
    const stolen = await offhandPush.push(live.id);
    check('once: a live claim is not stolen from the process holding it',
      stolen.pushed === false && stolen.reason === 'already', stolen);

    live.offhand_push_claimed_at = Date.now() - offhandPush.STALE_AFTER_MS - 1000;
    const taken = await offhandPush.push(live.id);
    check('once: a claim past its window is taken over, because a dead process cleared nothing',
      taken.pushed === true && live.offhand_push_status === 'pushed', taken);
  }

  // ── 4. Only a kept call goes ───────────────────────────────────────────
  {
    defaults();
    wire.length = 0;
    const D = 'dddd1111-dddd-4ddd-8ddd-dddddddddddd';
    const r = await finalize(D, {});          // a voice memo: no call_id
    await new Promise((res) => setTimeout(res, 30));
    check('memo: an ordinary voice note sends', r.status === 201, r.status);
    check('memo: and nothing of it reaches Offhand',
      wire.length === 0 && files.get(D).offhand_push_status === null,
      { wire: wire.length, status: files.get(D).offhand_push_status });

    const refused = await offhandPush.push(D);
    check('memo: even asked directly, a row with no call_id is not claimable',
      refused.pushed === false && refused.reason === 'already', refused);
  }

  // ── 5. An account Offhand cannot name ──────────────────────────────────
  {
    defaults();
    wire.length = 0;
    const E = seed('eeee1111-eeee-4eee-8eee-eeeeeeeeeeee', { owner_id: EMAIL_ONLY });
    const out = await offhandPush.push(E.id);
    // users.phone is NULLABLE — the constraint is phone_or_email — so an
    // email-only account is a legal account and an unmappable one.
    check('unmapped: an account with no phone number records unmapped',
      out.reason === 'unmapped' && E.offhand_push_status === 'unmapped', E);
    check('unmapped: and asks Offhand nothing, because there is nobody to ask about',
      wire.length === 0, wire.length);
    check('unmapped: the recording is flagged for the connector instead',
      E.offhand_requested_at !== null, E.offhand_requested_at);
    check('unmapped: and it is terminal — the sweep will not pick it up again',
      (await offhandPush.push(E.id)).reason === 'already');
  }

  // ── 6. Terminal refusals, each by the name Offhand uses ────────────────
  {
    const cases = [
      ['no_account', 404, 'unmapped', 'nobody with those digits has an Offhand account'],
      ['link_disabled', 403, 'unmapped', 'the user broke the link and has to reconnect it'],
      ['invalid_phone', 400, 'unmapped', 'the number we hold is not one Offhand can use'],
      ['unauthorized', 401, 'failed', 'the partner key is wrong; retrying only hammers'],
      [null, 413, 'failed', 'the object is over the ceiling and will not shrink'],
    ];
    let n = 0;
    for (const [name, status, expected, why] of cases) {
      defaults();
      wire.length = 0;
      n += 1;
      const id = `ffff${String(n).padStart(4, '0')}-ffff-4fff-8fff-ffffffffffff`;
      const row = seed(id);
      presign = async () => jsonResponse(status, name ? { error: name } : { error: 'too large' });
      // eslint-disable-next-line no-await-in-loop
      const out = await offhandPush.push(id);
      check(`terminal: ${status}${name ? ` ${name}` : ''} is ${expected} — ${why}`,
        out.reason === expected && row.offhand_push_status === expected, out);
      check(`terminal: ${status}${name ? ` ${name}` : ''} flags the recording for the connector`,
        row.offhand_requested_at !== null, row);
      // eslint-disable-next-line no-await-in-loop
      const retried = await offhandPush.push(id);
      check(`terminal: ${status}${name ? ` ${name}` : ''} is not retried`,
        retried.reason === 'already', retried);
    }

    // 402 is deliberately NOT in that list. Offhand's free tier compares a
    // monotonic lifetime total against its cap, so a refusal is a statement
    // about an account's billing today, not about this recording — and the
    // person may subscribe tomorrow. Abandoning it on the first 402 would lose
    // a call somebody chose to keep because of a state that was temporary.
    {
      defaults();
      wire.length = 0; gets.length = 0;
      const P = seed('ffff9002-ffff-4fff-8fff-ffffffffffff');
      presign = async () => jsonResponse(402, { error: 'monthly_limit', allowance: { allowed: false } });
      const out = await offhandPush.push(P.id);
      check('allowance: a 402 is retried, not abandoned — the account may subscribe tomorrow',
        out.reason === 'retry' && P.offhand_push_status === 'pending', out);
      check('allowance: and it is NOT flagged for the connector yet, because it has not been given up on',
        P.offhand_requested_at === null, P);
      // The refusal comes from the presign call, which is asked BEFORE the
      // bytes are fetched — so a retried 402 costs the HeadObject that checks
      // the size and nothing else, rather than a 25 MB download thrown away
      // every time the sweep comes round.
      check('allowance: the refusal cost a size check and no download',
        gets.length === 1, gets.length);
    }

    const flagSql = lastQuery(/SET offhand_push_status = \$2/).text;
    check('sql: a terminal push stamps the flag without overwriting one the user set',
      /offhand_requested_at = COALESCE\(offhand_requested_at, NOW\(\)\)/.test(flagSql), flagSql);
  }

  // ── 7. An object too big to push ───────────────────────────────────────
  {
    defaults();
    wire.length = 0;
    const G = seed('11112222-1111-4111-8111-111122221111');
    contentLength = offhandPush.MAX_AUDIO_BYTES + 1;
    const out = await offhandPush.push(G.id);
    check('size: an object over the ceiling is refused on its ContentLength, before a byte is read',
      out.reason === 'failed' && G.offhand_push_status === 'failed', out);
    check('size: and no key was minted in Offhand for bytes that were never going to arrive',
      wire.length === 0, wire.length);
  }

  // ── 8. Retryable failures stay pending, and the sweep re-drives them ───
  {
    const retryables = [
      ['503 partner_unconfigured — the other end has not been given its key yet',
        async () => jsonResponse(503, { error: 'partner_unconfigured' })],
      ['a 500 from Offhand', async () => jsonResponse(500, { error: 'server_error' })],
      ['a dropped socket', async () => { throw new Error('fetch failed'); }],
    ];
    let n = 0;
    for (const [what, responder] of retryables) {
      defaults();
      n += 1;
      const id = `22223333-${String(n).padStart(4, '0')}-4222-8222-222233332222`;
      const row = seed(id);
      capture = responder;
      // eslint-disable-next-line no-await-in-loop
      const out = await offhandPush.push(id);
      check(`retry: ${what} leaves the row pending for the sweep`,
        out.reason === 'retry' && row.offhand_push_status === 'pending', out);
      check(`retry: ${what} writes no terminal status and no flag`,
        row.offhand_requested_at === null && row.offhand_note_id === null, row);
    }

    // The sweep is the durability guarantee: the phone deleted its copy, so if
    // this does not re-run the push, the call is gone.
    defaults();
    wire.length = 0;
    const stale = [...files.values()].filter((f) => f.offhand_push_status === 'pending');
    for (const row of stale) row.offhand_push_claimed_at = Date.now() - offhandPush.STALE_AFTER_MS - 1000;
    const swept = await offhandPush.sweepStalePushes();
    check('sweep: it re-runs abandoned pushes rather than only marking them',
      swept === stale.length && stale.every((f) => f.offhand_push_status === 'pushed'),
      stale.map((f) => f.offhand_push_status));
    check('sweep: and each delivered one carries its note id',
      stale.every((f) => f.offhand_note_id === NOTE));

    const quiet = await offhandPush.sweepStalePushes();
    check('sweep: with nothing abandoned it does nothing at all', quiet === 0, quiet);
  }

  // ── 9. The retries end, into the flag ──────────────────────────────────
  {
    defaults();
    wire.length = 0;
    const old = seed('33334444-3333-4333-8333-333344443333', {
      offhand_push_status: 'pending',
      offhand_push_claimed_at: Date.now() - offhandPush.STALE_AFTER_MS - 1000,
      created_at: Date.now() - offhandPush.GIVE_UP_AFTER_MS - HOUR_MS,
    });
    const fresh = seed('44445555-4444-4444-8444-444455554444', {
      offhand_push_status: 'pending',
      offhand_push_claimed_at: Date.now() - offhandPush.STALE_AFTER_MS - 1000,
      created_at: Date.now() - HOUR_MS,
    });
    await offhandPush.sweepStalePushes();
    check('give up: a push still failing after a day is marked failed',
      old.offhand_push_status === 'failed', old.offhand_push_status);
    check('give up: and flagged, so the recording still reaches Offhand through the connector',
      old.offhand_requested_at !== null, old);
    check('give up: a younger row is re-driven rather than given up on',
      fresh.offhand_push_status === 'pushed', fresh.offhand_push_status);
    check('give up: the old row was not downloaded again on its way to being abandoned',
      gets.every((g) => g.Key !== old.r2_key), gets.map((g) => g.Key));
  }

  // ── 10. The classifier, stated once ────────────────────────────────────
  {
    check('classify: a partner name decides over the status it arrived with',
      offhandPush.outcomeFor({ status: 403, partner: 'link_disabled' }) === 'unmapped'
        && offhandPush.outcomeFor({ status: 503, partner: 'partner_unconfigured' }) === 'retry');
    check('classify: an unnamed 5xx, a timeout and a bare network error are all retryable',
      offhandPush.outcomeFor({ status: 502 }) === 'retry'
        && offhandPush.outcomeFor({ status: 408 }) === 'retry'
        && offhandPush.outcomeFor(new Error('fetch failed')) === 'retry');
    check('classify: an unnamed 4xx is terminal, because sending it again asks the same thing',
      offhandPush.outcomeFor({ status: 422 }) === 'failed');
  }

  global.fetch = realFetch;
  await h.close();
});
