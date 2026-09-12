/**
 * Boots src/app.js with nothing behind it: no database, no Twilio, no
 * Firebase, no Resend. pool.query is replaced by a handler the suite
 * supplies, and every statement that was *about* to go over the wire is
 * recorded, so a check can assert on the SQL itself rather than only on
 * the JSON a route built from it.
 *
 * console.error / console.warn are collected instead of printed —
 * express-rate-limit reports a misconfiguration (ERR_ERL_*) there on the
 * first request rather than throwing — and console.log is silenced so the
 * one-line-per-check output stays readable. VERBOSE=1 echoes everything.
 */

// Environment first. app.js calls dotenv.config(), which never overrides a
// key that is already present, so these win over any local .env — and they
// keep the auth routes from ever reaching Twilio or a real reviewer account.
process.env.NODE_ENV   = 'test';
process.env.DEV_MODE   = 'true';
process.env.JWT_SECRET = 'harness-secret-not-for-production';
for (const key of [
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER',
  'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY',
  'RESEND_API_KEY', 'APP_REVIEW_PHONE', 'APP_REVIEW_OTP',
  'DEEPGRAM_API_KEY',
]) process.env[key] = '';

const verbose = process.env.VERBOSE === '1';
const consoleLines = [];
const real = { log: console.log, warn: console.warn, error: console.error };
const capture = (level) => (...args) => {
  const line = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ');
  if (level !== 'log') consoleLines.push(line);
  if (verbose) real[level](...args);
};
console.log   = capture('log');
console.warn  = capture('warn');
console.error = capture('error');

// Stub the pool before any route module can touch it.
const pool = require('../src/db/pool');
const queries = [];
let queryHandler = async () => ({ rows: [], rowCount: 0 });
pool.query = async (text, params) => {
  queries.push({ text, params });
  return queryHandler(text, params);
};
pool.connect = async () => { throw new Error('harness: pool.connect() is not stubbed'); };

const app = require('../src/app');

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    process.stdout.write(`ok   ${name}\n`);
  } else {
    failed += 1;
    const extra = detail === undefined ? '' : ` — got ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    process.stdout.write(`FAIL ${name}${extra}\n`);
  }
}

function done(suite) {
  process.stdout.write(`${suite}: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

function boot() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;

      async function request(method, path, { headers = {}, body } = {}) {
        const res = await fetch(base + path, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        return { status: res.status, headers: res.headers, json, text };
      }

      resolve({
        app,
        request,
        queries,
        consoleLines,
        setQueryHandler(fn) { queryHandler = fn; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

function run(suite, body) {
  body().then(() => done(suite)).catch((err) => {
    process.stdout.write(`FAIL ${suite} crashed — ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}

module.exports = { boot, check, done, run };
