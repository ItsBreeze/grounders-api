/**
 * Regression tests for "Incorrect code" — reported by users who had typed the
 * code exactly as it arrived.
 *
 * Every case below fails against the code as it stood before the fix; four of
 * them are the bug itself, in four different disguises.
 */
process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-chars-long';
process.env.OTP_EXPIRY_MINUTES = '10';
delete process.env.TWILIO_ACCOUNT_SID;   // keep the router in its dev path, so
delete process.env.RESEND_API_KEY;       // the code comes back in the response

const test = require('node:test');
const assert = require('node:assert');
const { startAuthServer } = require('./otp-harness');

const { post, close } = startAuthServer();
test.after(() => close());

const request = async (target) => (await post('/auth/request-otp', target)).body._dev_otp;

test('a code typed exactly as sent signs in', async () => {
  const phone = '+16040000001';
  const code = await request({ phone });
  const r = await post('/auth/verify-otp', { phone, code, display_name: 'A' });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
});

test('a pasted code carrying whitespace signs in', async () => {
  // SMS autofill and clipboard pastes bring padding with them. bcrypt.compare
  // reads " 123456\n" as a different secret entirely.
  const phone = '+16040000002';
  const code = await request({ phone });
  const r = await post('/auth/verify-otp', { phone, code: `  ${code}\n`, display_name: 'B' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token);
});

test('a code sent as a JSON number signs in', async () => {
  // bcryptjs throws "Illegal arguments: number, string" rather than returning
  // false, so this used to surface as a 500 instead of a sign-in.
  const phone = '+16040000003';
  const code = await request({ phone });
  const r = await post('/auth/verify-otp', { phone, code: Number(code), display_name: 'C' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token);
});

test('the first of two requested codes still signs in', async () => {
  // The headline bug. request-otp used to mark every outstanding code used
  // before inserting the new one, so a double tap or a retried request killed
  // the code the user had already received by SMS.
  const phone = '+16040000004';
  const first  = await request({ phone });
  const second = await request({ phone });
  assert.notEqual(first, second);

  const r = await post('/auth/verify-otp', { phone, code: first, display_name: 'D' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token);
});

test('signing in burns every other outstanding code', async () => {
  const phone = '+16040000005';
  const first  = await request({ phone });
  const second = await request({ phone });

  const ok = await post('/auth/verify-otp', { phone, code: second, display_name: 'E' });
  assert.equal(ok.status, 200);

  const reuse = await post('/auth/verify-otp', { phone, code: first });
  assert.equal(reuse.status, 401, 'a superseded code must not sign in afterwards');
});

test('a wrong code is still refused', async () => {
  const phone = '+16040000006';
  const code = await request({ phone });
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
  const r = await post('/auth/verify-otp', { phone, code: wrong });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Incorrect code');
});

test('a code with no digits at all is a bad request, not a wrong code', async () => {
  const phone = '+16040000007';
  await request({ phone });
  const r = await post('/auth/verify-otp', { phone, code: '   ' });
  assert.equal(r.status, 400);
});

test('an email sign-in gets a code and can use it', async () => {
  // request-otp only ever called sendSms, so an email target had a code
  // generated and stored that nothing ever delivered.
  const email = 'someone@example.com';
  const code = await request({ email });
  assert.ok(code, 'email request must yield a usable code');
  const r = await post('/auth/verify-otp', { email, code, display_name: 'F' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token);
});
