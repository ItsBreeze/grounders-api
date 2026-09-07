/**
 * Rate limiting at the wire: which /auth route sits under which bucket, and
 * that the bucket key is the caller behind Railway's edge, not the edge.
 *
 * Every request here reaches the server from 127.0.0.1 carrying an
 * X-Forwarded-For header, exactly as Railway delivers traffic. Without
 * `trust proxy` the limiters would key every one of them on 127.0.0.1 — one
 * bucket for all users — and express-rate-limit would log
 * ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on the first request.
 *
 * Buckets under test (src/app.js):
 *   /auth/request-otp   5 per 15 min
 *   /auth/verify-otp   10 per 15 min, successful verifies refunded
 *   /auth/refresh      general 120 per min only
 */

const bcrypt = require('bcryptjs');
const { boot, check, run } = require('./harness');

const OTP_MESSAGE    = 'Too many OTP requests — try again in 15 minutes';
const VERIFY_MESSAGE = 'Too many verification attempts — try again in 15 minutes';

// The route runs bcrypt.compare against whatever hash is in the row; low
// rounds keep the fixture cheap without changing what the route does.
const CODE      = '123456';
const CODE_HASH = bcrypt.hashSync(CODE, 4);

const USER = {
  id: 'user-c', display_name: 'Cee', phone: '+16045550103', email: null,
  total_distance_m: 0, created_at: '2026-01-01T00:00:00.000Z', deletion_pending_at: null,
};

// Three callers, one socket. Railway appends the real client address as the
// last hop; anything a client sends itself lands to the left of it.
const A = '203.0.113.1';
const B = '203.0.113.2';
const C = '203.0.113.3';
const via = (xff) => ({ 'X-Forwarded-For': xff });

run('rate_limit', async () => {
  const h = await boot();

  h.setQueryHandler((text, params) => {
    if (/^\s*SELECT \* FROM otps WHERE target = \$1/.test(text)) {
      return { rows: [{
        id: 'otp-1', target: params[0], code_hash: CODE_HASH, used: false,
        created_at: new Date(), expires_at: new Date(Date.now() + 10 * 60 * 1000),
      }] };
    }
    if (/^\s*SELECT \* FROM users WHERE phone = \$1/.test(text)) return { rows: [USER] };
    return { rows: [], rowCount: 0 };
  });

  const requestOtp = (xff, phone) =>
    h.request('POST', '/auth/request-otp', { headers: via(xff), body: { phone } });
  const verifyOtp = (xff, phone, code) =>
    h.request('POST', '/auth/verify-otp', { headers: via(xff), body: { phone, code } });
  const refresh = (xff) =>
    h.request('POST', '/auth/refresh', { headers: via(xff), body: { refresh_token: 'not-a-real-token' } });

  // ── general limiter still wraps everything ────────────────────────────
  const health = await h.request('GET', '/health', { headers: via(A) });
  check('GET /health is 200 under the general limiter (RateLimit-Limit 120)',
    health.status === 200 && health.headers.get('ratelimit-limit') === '120',
    { status: health.status, limit: health.headers.get('ratelimit-limit') });

  // ── /auth/request-otp: 5 per window, keyed on the forwarded address ──
  const sends = [];
  for (let i = 0; i < 5; i += 1) sends.push(await requestOtp(A, '+16045550101'));
  check('request-otp: first 5 from A are 200 "OTP sent"',
    sends.every((r) => r.status === 200 && r.json && r.json.message === 'OTP sent'),
    sends.map((r) => r.status));
  check('request-otp: response advertises RateLimit-Limit 5, Remaining 0 after the fifth',
    sends[4].headers.get('ratelimit-limit') === '5' && sends[4].headers.get('ratelimit-remaining') === '0',
    { limit: sends[4].headers.get('ratelimit-limit'), remaining: sends[4].headers.get('ratelimit-remaining') });

  const sixth = await requestOtp(A, '+16045550101');
  check('request-otp: sixth from A is 429 with the JSON error shape',
    sixth.status === 429 && sixth.json && sixth.json.error === OTP_MESSAGE && Object.keys(sixth.json).length === 1,
    { status: sixth.status, body: sixth.json });
  check('request-otp: 429 carries Retry-After',
    /^\d+$/.test(sixth.headers.get('retry-after') || ''), sixth.headers.get('retry-after'));

  const fromB = await requestOtp(B, '+16045550102');
  check('request-otp: B (same socket, different X-Forwarded-For) still gets 200',
    fromB.status === 200, fromB.status);

  const spoofed = await requestOtp(`198.51.100.7, ${A}`, '+16045550101');
  check('request-otp: A cannot escape its bucket by prepending addresses to X-Forwarded-For',
    spoofed.status === 429, spoofed.status);

  // ── /auth/verify-otp: its own bucket of 10 ───────────────────────────
  const firstVerify = await verifyOtp(A, '+16045550101', '000000');
  check('verify-otp: A (exhausted on request-otp) is still allowed — 401 Incorrect code, not 429',
    firstVerify.status === 401 && firstVerify.json && firstVerify.json.error === 'Incorrect code',
    { status: firstVerify.status, body: firstVerify.json });
  check('verify-otp: response advertises RateLimit-Limit 10, Remaining 9',
    firstVerify.headers.get('ratelimit-limit') === '10' && firstVerify.headers.get('ratelimit-remaining') === '9',
    { limit: firstVerify.headers.get('ratelimit-limit'), remaining: firstVerify.headers.get('ratelimit-remaining') });

  const moreWrong = [];
  for (let i = 2; i <= 10; i += 1) moreWrong.push(await verifyOtp(A, '+16045550101', '000000'));
  check('verify-otp: wrong codes 2-10 from A are 401',
    moreWrong.every((r) => r.status === 401), moreWrong.map((r) => r.status));

  const eleventh = await verifyOtp(A, '+16045550101', '000000');
  check('verify-otp: eleventh wrong code from A is 429 with the JSON error shape',
    eleventh.status === 429 && eleventh.json && eleventh.json.error === VERIFY_MESSAGE && Object.keys(eleventh.json).length === 1,
    { status: eleventh.status, body: eleventh.json });

  // ── /auth/refresh: general limiter only ──────────────────────────────
  const refreshed = await refresh(A);
  check('refresh: A (exhausted on both OTP buckets) reaches the route — 401 invalid token, not 429',
    refreshed.status === 401 && refreshed.json && refreshed.json.error === 'Invalid or expired refresh token',
    { status: refreshed.status, body: refreshed.json });
  check('refresh: response advertises the general RateLimit-Limit 120',
    refreshed.headers.get('ratelimit-limit') === '120', refreshed.headers.get('ratelimit-limit'));

  // ── successful verifies are refunded ─────────────────────────────────
  const good = [];
  for (let i = 0; i < 10; i += 1) good.push(await verifyOtp(C, USER.phone, CODE));
  check('verify-otp: ten correct codes from C are all 200 with a token',
    good.every((r) => r.status === 200 && r.json && typeof r.json.token === 'string'),
    good.map((r) => r.status));

  const afterGood = await verifyOtp(C, USER.phone, '000000');
  check('verify-otp: a wrong code after ten successes is 401 with Remaining 9 (successes did not count)',
    afterGood.status === 401 && afterGood.headers.get('ratelimit-remaining') === '9',
    { status: afterGood.status, remaining: afterGood.headers.get('ratelimit-remaining') });

  // ── express-rate-limit's own misconfiguration checks stayed quiet ───
  const erl = h.consoleLines.filter((l) => /ERR_ERL_/.test(l));
  check('no ERR_ERL_* validation message was logged (trust proxy satisfies express-rate-limit)',
    erl.length === 0, erl);
  check('app trusts exactly one proxy hop, not true',
    h.app.get('trust proxy') === 1, h.app.get('trust proxy'));

  await h.close();
});
