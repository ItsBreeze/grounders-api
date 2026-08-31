/**
 * Account resolution + token-at-rest checks.
 * Needs a Postgres with the migration applied:
 *   DATABASE_URL=... npm run test:accounts
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres@localhost:55432/grounders_test';
process.env.TOKEN_ENC_KEY = require('crypto').randomBytes(32).toString('base64');
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3999';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long';

const pool = require('../src/db/pool');
const accounts = require('../src/services/gmail_accounts');
const { _internal } = require('../src/mcp/tools');
const { resolveAccount } = _internal;

let pass = 0, fail = 0;
const check = (n, c, e='') => { c ? pass++ : fail++; console.log(`${c?' ok  ':'FAIL '} ${n}${e?' — '+e:''}`); };
const expectThrow = async (n, fn, needle) => {
  try { const r = await fn(); check(n, false, `no throw, got ${r}`); }
  catch (err) { check(n, err.message.includes(needle), err.message); }
};

(async () => {
  await pool.query("DELETE FROM gmail_accounts WHERE owner_key = 'testowner'");

  await expectThrow('no accounts → clear guidance',
    () => resolveAccount('testowner', undefined), 'No accounts are linked');

  for (const email of ['brisebyme@gmail.com', 'work@company.com', 'josh.personal@gmail.com']) {
    await accounts.upsertFromGrant({ ownerKey:'testowner', email, googleSub:'sub-'+email,
      tokens: { access_token:'at-'+email, refresh_token:'rt-'+email, expires_in:3600, scope:'gmail.modify' } });
  }

  check('exact address resolves', await resolveAccount('testowner','work@company.com') === 'work@company.com');
  check('case-insensitive', await resolveAccount('testowner','WORK@Company.com') === 'work@company.com');
  check('bare local-part resolves', await resolveAccount('testowner','work') === 'work@company.com');
  check('unique substring resolves', await resolveAccount('testowner','company') === 'work@company.com');

  await expectThrow('ambiguous substring refuses to guess',
    () => resolveAccount('testowner','gmail.com'), 'be specific');
  await expectThrow('unknown account lists the real ones',
    () => resolveAccount('testowner','nope@nowhere.com'), 'is not linked');
  await expectThrow('multiple linked + no account arg → asks which',
    () => resolveAccount('testowner', undefined), 'Which account?');

  // Tokens must not be readable from the table itself.
  const { rows } = await pool.query("SELECT access_token_enc, refresh_token_enc FROM gmail_accounts WHERE email='work@company.com' AND owner_key='testowner'");
  check('access token encrypted at rest', !rows[0].access_token_enc.includes('at-work') && rows[0].access_token_enc.startsWith('v1.'));
  check('refresh token encrypted at rest', !rows[0].refresh_token_enc.includes('rt-work'));

  // Re-consent without a refresh token must not wipe the stored one.
  await accounts.upsertFromGrant({ ownerKey:'testowner', email:'work@company.com', googleSub:'s',
    tokens: { access_token:'at-new', expires_in:3600 } });
  const after = await pool.query("SELECT refresh_token_enc FROM gmail_accounts WHERE email='work@company.com' AND owner_key='testowner'");
  check('re-link without refresh_token preserves the stored one', after.rows[0].refresh_token_enc !== null);

  const cached = await accounts.accessTokenFor('testowner','work@company.com');
  check('unexpired access token served from cache', cached === 'at-new', cached);

  const emails = await accounts.emailsFor('testowner');
  check('fan-out list covers all three', emails.length === 3, emails.join(','));

  // Single linked account → account arg optional.
  await pool.query("DELETE FROM gmail_accounts WHERE owner_key='testowner' AND email <> 'work@company.com'");
  check('single account → account arg optional', await resolveAccount('testowner', undefined) === 'work@company.com');

  await pool.query("DELETE FROM gmail_accounts WHERE owner_key = 'testowner'");
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
