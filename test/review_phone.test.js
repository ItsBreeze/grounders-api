/**
 * The App Review demo login survives the number being typed with one digit
 * too many (the 21 Oct 2026 rejection), and only that: any other +1 number
 * or the same digits under another country code go to the OTP table.
 */

const { boot, check, run } = require('./harness');

const REVIEW_PHONE = '+17777777777';
const REVIEW_OTP = '424242';
const TYPO = '+177777777777';
const REVIEWER = { id: 'user-reviewer', display_name: 'Reviewer', phone: REVIEW_PHONE };

run('review_phone', async () => {
  process.env.APP_REVIEW_PHONE = REVIEW_PHONE;
  process.env.APP_REVIEW_OTP = REVIEW_OTP;
  const h = await boot();
  h.setQueryHandler((text) => (/FROM users WHERE phone/.test(text) ? { rows: [REVIEWER] } : { rows: [] }));

  const sent = await h.request('POST', '/auth/request-otp', { body: { phone: TYPO, client: 'radio' } });
  check('request-otp with the extra digit is "sent" without touching the database',
    sent.status === 200 && h.queries.length === 0, { status: sent.status, queries: h.queries.length });

  const ok = await h.request('POST', '/auth/verify-otp', { body: { phone: TYPO, code: REVIEW_OTP } });
  check('verify-otp with the extra digit signs in as the reviewer', ok.status === 200 && !!ok.json.token, ok.json);
  check('the reviewer row is looked up by the canonical demo number',
    h.queries[0] && h.queries[0].params[0] === REVIEW_PHONE, h.queries[0] && h.queries[0].params);

  for (const phone of ['+17777777770', '+447777777777']) {
    h.queries.length = 0;
    const no = await h.request('POST', '/auth/verify-otp', { body: { phone, code: REVIEW_OTP } });
    check(`${phone} with the demo code is not the reviewer`,
      no.status === 401 && /FROM otps/.test(h.queries[0] && h.queries[0].text), { status: no.status, sql: h.queries[0] && h.queries[0].text });
  }

  await h.close();
});
