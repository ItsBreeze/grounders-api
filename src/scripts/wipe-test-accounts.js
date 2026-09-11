/**
 * Grounders — wipe test accounts
 *
 * Removes seeded/throwaway accounts from the users table. Written for the
 * one-off "clear the test signups" job, not for routine operation. The daily
 * reaper (src/jobs/reap_users.js) remains the only automatic deleter.
 *
 * Run with:
 *   node src/scripts/wipe-test-accounts.js --empty --never-authed
 *       — dry run: lists every candidate and everything that would go with it
 *   node src/scripts/wipe-test-accounts.js --empty --never-authed --confirm
 *       — soft-deletes them, exactly as DELETE /users/me does
 *   node src/scripts/wipe-test-accounts.js --ids=<uuid,uuid> --hard --confirm
 *       — hard-deletes them, as the reaper would after 14 days
 *
 * Without --confirm the script opens no transaction and issues no write.
 * With no rule flag at all it selects nothing and says so — it never guesses
 * what "test account" means.
 *
 * TWO MODES
 *
 *   soft (default)  the three statements DELETE /users/me runs, in that
 *                   order: stamp deletion_pending_at, drop device_tokens,
 *                   drop refresh_tokens. NOTHING ELSE GOES — posts, friends,
 *                   blocks, Radio memberships, connector grants and OTPs all
 *                   stay until the reaper hard-deletes 14 days later, and a
 *                   sign-in before then cancels the whole thing
 *                   (src/routes/auth.js), so a mis-selected real account can
 *                   still save itself. The dry run marks every dependent
 *                   count with whether the mode you actually named removes
 *                   it, because the two are not the same list.
 *   --hard          the same two deletes first, then every child row
 *                   explicitly, then the reaper's own
 *                   DELETE FROM users ... RETURNING id. Irreversible.
 *
 * WHAT IT DOES NOT REMOVE
 *
 *   Cloudflare R2 objects. Nothing in this codebase deletes post media, and
 *   the radio routes only delete radio objects on their own explicit paths.
 *   That is not a gap here: neverDelete() below refuses any account that
 *   holds posts, radio_files or a radio workspace, so a candidate has no R2
 *   object to orphan in the first place.
 *
 * A NOTE ON SIGNALS, because it is not obvious
 *
 *   src/scripts/wipe-posts.js deleted every post AND zeroed
 *   total_distance_m / last_post_lat / last_post_lng / last_post_at for every
 *   row. So "has no posts", "zero distance" and "never posted" now describe
 *   100% of the table, the operator's own account included. --no-posts is
 *   kept because it is still literally true, but on this database it selects
 *   everybody and is only useful ANDed with something else.
 *
 * Everything is one transaction: either every selected account is gone and
 * every dependent row with it, or nothing changed.
 */

require('dotenv').config();

// Fail before touching pg if there is nothing to connect to — an unset
// DATABASE_URL otherwise becomes a confusing "connect ECONNREFUSED
// 127.0.0.1:5432" against whatever happens to be on localhost.
if (!process.env.DATABASE_URL) {
  console.error('wipe-test-accounts: DATABASE_URL is not set — refusing to run.');
  console.error('Set it in .env, or run through Railway: railway run node src/scripts/wipe-test-accounts.js');
  process.exit(1);
}

const pool = require('../db/pool');

// ─── The exclusion list ────────────────────────────────────────────────────
//
// Read this function and nothing else to know what can never be deleted.
// It is ANDed into every candidate query, re-asserted in JS over the resolved
// id list before BEGIN, re-checked inside the transaction against the rows as
// they stand at that moment, and verified once more after the deletes and
// before COMMIT. No rule flag, --ids included, can reach past it.
//
// Phones are compared as a NANP key — the LAST TEN DIGITS — not as raw
// strings and not as raw digit strings. /auth/verify-otp stores whatever the
// client sent, verbatim and un-normalised (src/routes/auth.js), and
// users.phone is UNIQUE on that raw text, so one person can legitimately hold
// two rows: "+17809011304" and "7809011304" are different strings, the same
// number, and ALSO different digit strings — eleven digits against ten.
// Comparing raw digits would protect the first row and delete the second,
// which is exactly the duplicate-row hazard documented at
// src/routes/partner.js:67-71. Taking the last ten digits collapses every
// stored formatting to one key. A foreign number that happens to end in the
// same ten digits is protected too; that is the safe direction to be wrong.

const NEVER_DELETE_PHONE_KEYS = [
  '7809011304', // the operator's own account (+1 780 901 1304), in whatever
                // formatting it happens to be stored in
  '7777777777', // 'App Reviewer' — seeded by src/db/migrate.js and used by
                // the /auth/verify-otp store-review backdoor. Deleting it
                // breaks review sign-in, and the next migration silently
                // recreates it with a fresh id.
];

// Email-only rows carry no phone key at all: users.phone is nullable and the
// phone_or_email CHECK requires only one of the two, so --email-like, or
// --empty --never-authed, can select a row this guard cannot see. Put any
// address that must never be deleted here; matching is case-insensitive. It
// is empty because no address has been named — and because of that, the dry
// run prints a warning for every candidate with no phone, so an unguarded
// email-only row cannot slip by unnoticed.
const NEVER_DELETE_EMAILS = [];

const PROTECTED_EMAILS = NEVER_DELETE_EMAILS.map(e => e.toLowerCase());

// Last ten digits of whatever is in the column — the key that
// "+17809011304", "7809011304" and "(780) 901-1304" all collapse to.
// Anything shorter than ten digits is compared whole.
function phoneKeySql(alias) {
  const d = `regexp_replace(COALESCE(${alias}.phone, ''), '[^0-9]', '', 'g')`;
  return `CASE WHEN length(${d}) >= 10 THEN right(${d}, 10) ELSE ${d} END`;
}

// The JS twin of phoneKeySql, for the checks that happen outside SQL.
function phoneKey(raw) {
  const d = String(raw || '').replace(/[^0-9]/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

/**
 * SQL predicate: true for a row that is safe to consider. Anything here is
 * off limits whatever the rules say.
 */
function neverDelete(alias = 'u') {
  const keys = NEVER_DELETE_PHONE_KEYS.map(k => `'${k}'`).join(', ');
  const clauses = [
    // 1. The named accounts, by NANP key so no formatting can dodge it.
    `${phoneKeySql(alias)} NOT IN (${keys})`,
  ];
  // 1b. The named addresses, when any have been configured above.
  if (PROTECTED_EMAILS.length > 0) {
    const quoted = PROTECTED_EMAILS.map(e => `'${e}'`).join(', ');
    clauses.push(`LOWER(COALESCE(${alias}.email, '')) NOT IN (${quoted})`);
  }
  clauses.push(
    // 2. Anyone holding posts. Post media is never deleted from R2 by
    //    anything, so deleting the rows would orphan objects unrecoverably.
    `NOT EXISTS (SELECT 1 FROM posts p WHERE p.user_id = ${alias}.id)`,
    // 3. Anyone with a friend, in either direction. friendships cascades, so
    //    deleting here silently edits a real person's friend list.
    `NOT EXISTS (SELECT 1 FROM friendships f
                  WHERE f.user_id_a = ${alias}.id OR f.user_id_b = ${alias}.id)`,
    // 4. Anyone holding a Radio message — voice notes, files and typed
    //    messages all live in radio_files.
    `NOT EXISTS (SELECT 1 FROM radio_files rf WHERE rf.owner_id = ${alias}.id)`,
    // 5. Anyone who OWNS a workspace. radio_workspaces.owner_id CASCADE is
    //    the one FK that can destroy another user's data: it takes the
    //    workspace, its members, every radio_files row in it including files
    //    uploaded by real users, and its message groups — and refunds nobody's
    //    radio_storage_used_bytes, because that logic lives only in the route
    //    (src/routes/radio.js). Delete the workspace through
    //    DELETE /radio/workspaces/:id first if an account really must go.
    `NOT EXISTS (SELECT 1 FROM radio_workspaces w WHERE w.owner_id = ${alias}.id)`
  );
  return clauses.join('\n           AND ');
}

// ─── Arguments ─────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2);
const CONFIRM = ARGV.includes('--confirm');
const HARD = ARGV.includes('--hard');

function flagValue(name) {
  const hit = ARGV.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
}

// Every dependent table a delete touches, in the order the summary prints
// them. One list so the dry-run table and the post-delete counts cannot
// drift apart.
//
// The third column is whether SOFT mode removes it. Soft mode runs what
// DELETE /users/me runs and no more, so it clears device_tokens and
// refresh_tokens and leaves everything else exactly where it is — the dry run
// has to say so per line, or it reads as a list of things about to be
// deleted when most of them are not.
const DEPENDENTS = [
  ['posts',             'posts',                  false],
  ['reactions',         'reactions',              false],
  ['reports',           'reports filed',          false],
  ['friendships',       'friendships',            false],
  ['friend_requests',   'friend requests',        false],
  ['blocks',            'blocks',                 false],
  ['device_tokens',     'device tokens',          true],
  ['refresh_tokens',    'refresh tokens',         true],
  ['protected_zones',   'protected zones',        false],
  ['radio_workspaces',  'radio workspaces owned', false],
  ['radio_memberships', 'radio memberships',      false],
  ['radio_files',       'radio files',            false],
  ['oauth_codes',       'oauth codes',            false],
  ['oauth_grants',      'oauth grants',           false],
  ['otps',              'otps',                   false],
];

// Each rule is its own flag and OFF unless named. A candidate must match
// EVERY rule given — AND, not OR — so adding a flag can only ever narrow the
// selection. The operator decides what "test" means; the script does not.
const RULES = [
  {
    flag: '--empty',
    help: 'display_name is empty or whitespace',
    // NOT a test marker on its own: auth.js inserts '' whenever a signup
    // omits a name, so this is also the shape of a real abandoned signup.
    sql: () => `COALESCE(TRIM(u.display_name), '') = ''`,
  },
  {
    flag: '--no-posts',
    help: 'has never posted (see the header — matches everyone on this database)',
    sql: () => `NOT EXISTS (SELECT 1 FROM posts p WHERE p.user_id = u.id)`,
  },
  {
    flag: '--no-friends',
    help: 'no friendship and no friend request, either direction',
    sql: () => `NOT EXISTS (SELECT 1 FROM friendships f
                             WHERE f.user_id_a = u.id OR f.user_id_b = u.id)
           AND NOT EXISTS (SELECT 1 FROM friend_requests fr
                             WHERE fr.from_user_id = u.id OR fr.to_user_id = u.id)`,
  },
  {
    flag: '--no-footprint',
    help: 'no social, device or Radio row of any kind — the strongest single rule',
    sql: () => `NOT EXISTS (SELECT 1 FROM friendships f
                             WHERE f.user_id_a = u.id OR f.user_id_b = u.id)
           AND NOT EXISTS (SELECT 1 FROM friend_requests fr
                             WHERE fr.from_user_id = u.id OR fr.to_user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM blocks b
                             WHERE b.blocker_id = u.id OR b.blocked_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM device_tokens d WHERE d.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM reactions rc WHERE rc.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM reports rp WHERE rp.reporter_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM protected_zones pz WHERE pz.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM radio_workspace_members m WHERE m.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM radio_files rf WHERE rf.owner_id = u.id)
           AND u.radio_enabled = false
           AND u.radio_storage_used_bytes = 0`,
  },
  {
    flag: '--never-authed',
    help: 'no refresh_tokens row — approximately "never signed in"',
    // storeRefreshToken deletes prior rows then inserts (src/routes/auth.js),
    // so this table holds exactly one row per user and is rewritten on every
    // sign-in and every /auth/refresh. It is an approximation, not a fact:
    // it also matches anyone who called DELETE /users/me, anyone past the
    // 365-day expiry, and anyone who only ever held the 30-day access JWT.
    sql: () => `NOT EXISTS (SELECT 1 FROM refresh_tokens rt WHERE rt.user_id = u.id)`,
  },
  {
    flag: '--reserved-phone',
    help: 'phone in the NANP fiction range 555-0100..555-0199',
    // 1 + area code + 555 + 01 + two digits. Deliberately not "any 555
    // exchange" — widen it and it starts matching assignable real numbers.
    // Matched on the NANP key (last ten digits), so a number stored with or
    // without its country code reads the same.
    sql: () => `${phoneKeySql('u')} ~ '^[2-9][0-9]{2}55501[0-9]{2}$'`,
  },
];

// Rules that carry a value rather than being a bare switch.
const VALUE_RULES = [
  {
    flag: '--name-like',
    help: 'display_name ILIKE the pattern, e.g. --name-like=%test%',
    sql: (v, push) => `u.display_name ILIKE ${push(v)}`,
  },
  {
    flag: '--email-like',
    help: 'email ILIKE the pattern, e.g. --email-like=%@example.com',
    sql: (v, push) => `u.email ILIKE ${push(v)}`,
  },
  {
    flag: '--before',
    help: 'created_at < this timestamp, e.g. --before=2026-08-01',
    sql: (v, push) => `u.created_at < ${push(v)}::timestamptz`,
  },
  {
    flag: '--after',
    help: 'created_at >= this timestamp, e.g. --after=2026-07-01',
    sql: (v, push) => `u.created_at >= ${push(v)}::timestamptz`,
  },
  {
    flag: '--ids',
    help: 'these exact ids, comma separated — the honest escape hatch: read the dry run, paste the ids back',
    sql: (v, push) => `u.id = ANY(${push(v.split(',').map(s => s.trim()).filter(Boolean))}::uuid[])`,
  },
];

const KNOWN_SWITCHES = ['--confirm', '--hard', ...RULES.map(r => r.flag)];
const KNOWN_VALUES = ['--limit', ...VALUE_RULES.map(r => r.flag)];

// Reject anything unrecognised rather than ignoring it. A mistyped --limit=5
// would otherwise silently mean "no limit", which is the expensive direction
// to be wrong in.
function checkArgs() {
  const bad = ARGV.filter(a =>
    !KNOWN_SWITCHES.includes(a) &&
    !KNOWN_VALUES.some(v => a.startsWith(`${v}=`)));
  if (bad.length > 0) {
    console.error(`wipe-test-accounts: unrecognised argument(s): ${bad.join(' ')}`);
    console.error('');
    printUsage();
    process.exit(1);
  }

  // A repeated value flag would silently keep the first and drop the rest —
  // "--ids=a,b --ids=c,d" reads as four accounts and means two. Refuse it.
  const seen = new Map();
  for (const a of ARGV) {
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    seen.set(name, (seen.get(name) || 0) + 1);
  }
  const repeated = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
  if (repeated.length > 0) {
    console.error(`wipe-test-accounts: repeated argument(s): ${repeated.join(' ')} — give each at most once.`);
    process.exit(1);
  }
}

function printUsage() {
  console.error('Rule flags (all OFF by default; a candidate must match every one given):');
  for (const r of RULES) console.error(`  ${r.flag.padEnd(18)} ${r.help}`);
  for (const r of VALUE_RULES) console.error(`  ${`${r.flag}=<v>`.padEnd(18)} ${r.help}`);
  console.error('');
  console.error('Other flags:');
  console.error('  --limit=<n>        take at most n accounts, oldest first');
  console.error('  --hard             hard-delete instead of soft-delete (irreversible)');
  console.error('  --confirm          actually write; without it this is a dry run');
}

/**
 * Turns the flags into a WHERE fragment plus its bind parameters.
 * Returns { clause: null } when no rule was named.
 */
function buildSelection() {
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };

  const clauses = [];
  const named = [];

  for (const r of RULES) {
    if (!ARGV.includes(r.flag)) continue;
    clauses.push(r.sql());
    named.push(r.flag);
  }
  for (const r of VALUE_RULES) {
    const v = flagValue(r.flag.slice(2));
    if (v === null) continue;
    if (v === '') {
      console.error(`wipe-test-accounts: ${r.flag}= was given with no value.`);
      process.exit(1);
    }
    clauses.push(r.sql(v, push));
    named.push(`${r.flag}=${v}`);
  }

  if (clauses.length === 0) return { clause: null, params, named };
  return { clause: clauses.join('\n           AND '), params, named };
}

function parseLimit() {
  const raw = flagValue('limit');
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`wipe-test-accounts: --limit=${raw} is not a positive integer.`);
    process.exit(1);
  }
  return n;
}

// Host and database name only — never the credentials in DATABASE_URL.
function describeTarget(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

// ─── Selection ─────────────────────────────────────────────────────────────

async function candidates(client, selection, limit) {
  const params = selection.params.slice();
  const limitSql = limit === null ? '' : `LIMIT $${params.push(limit)}`;

  const { rows } = await client.query(
    `WITH candidate AS (
       SELECT u.id, u.display_name, u.phone, u.email, u.created_at, u.deletion_pending_at
         FROM users u
        WHERE ${neverDelete('u')}
          AND ${selection.clause}
        ORDER BY u.created_at, u.id
        ${limitSql}
     )
     SELECT c.*,
       (SELECT COUNT(*)::int FROM posts t            WHERE t.user_id = c.id)      AS posts,
       (SELECT COUNT(*)::int FROM reactions t        WHERE t.user_id = c.id)      AS reactions,
       (SELECT COUNT(*)::int FROM reports t          WHERE t.reporter_id = c.id)  AS reports,
       (SELECT COUNT(*)::int FROM friendships t
          WHERE t.user_id_a = c.id OR t.user_id_b = c.id)                         AS friendships,
       (SELECT COUNT(*)::int FROM friend_requests t
          WHERE t.from_user_id = c.id OR t.to_user_id = c.id)                     AS friend_requests,
       (SELECT COUNT(*)::int FROM blocks t
          WHERE t.blocker_id = c.id OR t.blocked_id = c.id)                       AS blocks,
       (SELECT COUNT(*)::int FROM device_tokens t    WHERE t.user_id = c.id)      AS device_tokens,
       (SELECT COUNT(*)::int FROM refresh_tokens t   WHERE t.user_id = c.id)      AS refresh_tokens,
       (SELECT COUNT(*)::int FROM protected_zones t  WHERE t.user_id = c.id)      AS protected_zones,
       (SELECT COUNT(*)::int FROM radio_workspaces t WHERE t.owner_id = c.id)     AS radio_workspaces,
       (SELECT COUNT(*)::int FROM radio_workspace_members t
          WHERE t.user_id = c.id)                                                 AS radio_memberships,
       (SELECT COUNT(*)::int FROM radio_files t      WHERE t.owner_id = c.id)     AS radio_files,
       (SELECT COUNT(*)::int FROM oauth_codes t      WHERE t.user_id = c.id)      AS oauth_codes,
       (SELECT COUNT(*)::int FROM oauth_refresh_tokens t
          WHERE t.user_id = c.id)                                                 AS oauth_grants,
       -- Matched exactly as the delete below matches: address
       -- case-insensitively, number on its last ten digits. otps.target is a
       -- bare string with no FK, and the app stores it as typed, so comparing
       -- it raw would count rows the delete then leaves behind.
       (SELECT COUNT(*)::int FROM otps t
          WHERE (NULLIF(c.email, '') IS NOT NULL
                 AND LOWER(t.target) = LOWER(c.email))
             OR (NULLIF(c.phone, '') IS NOT NULL
                 AND t.target NOT LIKE '%@%'
                 AND regexp_replace(t.target, '[^0-9]', '', 'g') <> ''
                 AND right(regexp_replace(t.target, '[^0-9]', '', 'g'), 10)
                     = right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)))    AS otps
       FROM candidate c
      ORDER BY c.created_at, c.id`,
    params
  );
  return rows;
}

// Every row carrying a protected number or address — by NANP key, so a
// duplicate of one stored in a different format is found too.
const PROTECTED_ROWS_SQL =
  `SELECT id FROM users u
     WHERE ${phoneKeySql('u')} = ANY($1::text[])
        OR LOWER(COALESCE(u.email, '')) = ANY($2::text[])`;
const PROTECTED_PARAMS = [NEVER_DELETE_PHONE_KEYS, PROTECTED_EMAILS];

// How many such rows exist. Captured before the deletes and compared after,
// as a receipt that nothing reached them.
async function protectedRowCount(client) {
  const { rows } = await client.query(PROTECTED_ROWS_SQL, PROTECTED_PARAMS);
  return rows.length;
}

// The JS half of the exclusion: re-resolve the protected rows and refuse if
// any id we are about to touch is one of them. Cheap, and it means a mistake
// in the SQL fragment alone cannot be fatal.
async function assertNotProtected(client, ids) {
  const { rows } = await client.query(PROTECTED_ROWS_SQL, PROTECTED_PARAMS);
  const guarded = new Set(rows.map(r => r.id));
  const hit = ids.filter(id => guarded.has(id));
  if (hit.length > 0) {
    throw new Error(`selection reached a protected account (${hit.join(', ')}) — refusing to continue`);
  }
}

// The exclusion, re-run inside the transaction against the rows as they are
// right now. The candidate SELECT ran before BEGIN, and with --ids the
// operator is pasting a list from a dry run that may be hours old: an account
// that was empty this morning can hold a post, a friend or a workspace by
// tonight. Anything that no longer passes rolls the whole batch back rather
// than being quietly deleted on the strength of a stale reading.
async function assertStillSafe(client, ids) {
  const { rows } = await client.query(
    `SELECT u.id FROM users u
      WHERE u.id = ANY($1::uuid[])
        AND NOT (${neverDelete('u')})`,
    [ids]
  );
  if (rows.length > 0) {
    throw new Error(
      `${rows.length} selected account(s) no longer pass the exclusion check ` +
      `(${rows.map(r => r.id).join(', ')}) — rolling back`
    );
  }
}

// ─── Reporting ─────────────────────────────────────────────────────────────

function formatCounts(row) {
  return DEPENDENTS.map(([key, label]) => `${label} ${row[key]}`).join(', ');
}

function printSummary(rows, { limit, named }) {
  console.log(`Rules applied:             ${named.join(' ')}`);
  console.log(`Limit:                     ${limit === null ? 'none (every match)' : limit}`);
  console.log(`Candidate accounts:        ${rows.length}`);
  console.log('');

  for (const [i, r] of rows.entries()) {
    const name = (r.display_name || '').trim() || '(no name)';
    const contact = r.phone || r.email || '(no phone or email)';
    const created = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16);
    const pending = r.deletion_pending_at ? '  [already soft-deleted]' : '';
    console.log(`  ${String(i + 1).padStart(4)}. ${r.id}${pending}`);
    console.log(`        ${name}   ${contact}   created ${created}`);
    console.log(`        ${formatCounts(r)}`);
  }

  // An email-only row has no phone key, so NEVER_DELETE_PHONE_KEYS cannot see
  // it. Say so rather than let it pass as just another candidate.
  const emailOnly = rows.filter(r => !r.phone);
  if (emailOnly.length > 0) {
    console.log('');
    console.log(`!! ${emailOnly.length} candidate(s) have no phone number, only an email address.`);
    console.log('!! The phone exclusion cannot see those rows. Check each one by eye, and');
    console.log('!! add any address that must survive to NEVER_DELETE_EMAILS before --confirm.');
  }

  if (rows.length > 0) console.log('');

  const totals = {};
  for (const [key] of DEPENDENTS) totals[key] = rows.reduce((n, r) => n + r[key], 0);

  console.log(`Accounts:                  ${rows.length}`);
  console.log(HARD
    ? '  (--hard: every line below is deleted)'
    : '  (soft delete: only the two lines marked "removed" go — the rest stay put)');
  for (const [key, label, softRemoves] of DEPENDENTS) {
    const fate = (HARD || softRemoves) ? 'removed' : 'left in place';
    console.log(`  ${(label + ':').padEnd(25)}${String(totals[key]).padEnd(8)}${fate}`);
  }
  console.log(`R2 objects affected:       0 (no candidate can hold posts or radio files — see neverDelete)`);
}

// ─── The wipe ──────────────────────────────────────────────────────────────

async function wipeTestAccounts() {
  checkArgs();

  const selection = buildSelection();
  const limit = parseLimit();

  console.log(`Target database: ${describeTarget(process.env.DATABASE_URL)}`);
  console.log(`Mode: ${CONFIRM ? (HARD ? 'HARD DELETE (--hard --confirm)' : 'SOFT DELETE (--confirm)') : 'dry run (no --confirm)'}`);
  console.log('');

  if (selection.clause === null) {
    console.log('No rule flag was given, so nothing was selected — and nothing was read or written.');
    console.log('');
    printUsage();
    console.log('');
    console.log('Dry run — nothing was deleted and no transaction was opened.');
    return;
  }

  const client = await pool.connect();
  try {
    const rows = await candidates(client, selection, limit);
    printSummary(rows, { limit, named: selection.named });

    // An id the operator pasted that did not come back was dropped by the
    // exclusion, cut by --limit, filtered out by another rule, or does not
    // exist. Silently running on the remainder is how the wrong set gets
    // deleted while the operator believes they named the right one.
    const requested = (flagValue('ids') || '').split(',').map(t => t.trim()).filter(Boolean);
    if (requested.length > 0) {
      const got = new Set(rows.map(r => r.id));
      const missing = requested.filter(id => !got.has(id));
      if (missing.length > 0) {
        console.log('');
        console.log(`!! ${missing.length} of the ${requested.length} ids you gave were NOT selected:`);
        for (const id of missing) console.log(`!!   ${id}`);
        console.log('!! Excluded by neverDelete, cut by --limit, filtered by another rule, or no such row.');
      }
    }

    console.log('');

    if (!CONFIRM) {
      console.log('Dry run — nothing was deleted and no transaction was opened.');
      console.log(`Re-run with --confirm to ${HARD ? 'hard-delete' : 'soft-delete'} the ${rows.length} account(s) listed above.`);
      return;
    }

    if (rows.length === 0) {
      console.log('No accounts matched — nothing to do.');
      return;
    }

    const ids = rows.map(r => r.id);
    await assertNotProtected(client, ids);

    await client.query('BEGIN');

    const guardedBefore = await protectedRowCount(client);
    await assertStillSafe(client, ids);
    const done = {};

    // The DELETE /users/me recipe, in its order (src/routes/users.js). The
    // route runs these as three bare pool.query calls with no transaction;
    // wrapping them here is a deliberate improvement, not a copy — do not
    // read this as evidence that the route is transactional.
    if (!HARD) {
      // Stamping deletion_pending_at is the whole point of soft mode. In
      // hard mode the row is about to disappear, so it is skipped.
      const up = await client.query(
        `UPDATE users
            SET deletion_pending_at = NOW()
          WHERE id = ANY($1::uuid[])
            AND deletion_pending_at IS NULL`,
        [ids]
      );
      done.soft_deleted = up.rowCount;
    }
    // No more pushes.
    done.device_tokens = (await client.query(
      `DELETE FROM device_tokens WHERE user_id = ANY($1::uuid[])`, [ids])).rowCount;
    // The 30-day access JWT still works until it expires, but they cannot
    // refresh it.
    done.refresh_tokens = (await client.query(
      `DELETE FROM refresh_tokens WHERE user_id = ANY($1::uuid[])`, [ids])).rowCount;

    if (HARD) {
      // Children first. All of these cascade from users anyway; deleting
      // them here gives an exact rowCount for the summary and keeps the
      // script correct if a cascade is ever dropped.
      // radio_workspace_members.added_by is ON DELETE SET NULL rather than
      // CASCADE — the rows it points at are other people's memberships and
      // are left in place, minus the attribution.
      const del = async (key, sql) => {
        done[key] = (await client.query(sql, [ids])).rowCount;
      };
      await del('oauth_grants',      `DELETE FROM oauth_refresh_tokens WHERE user_id = ANY($1::uuid[])`);
      await del('oauth_codes',       `DELETE FROM oauth_codes WHERE user_id = ANY($1::uuid[])`);
      await del('reactions',         `DELETE FROM reactions WHERE user_id = ANY($1::uuid[])`);
      await del('reports',           `DELETE FROM reports WHERE reporter_id = ANY($1::uuid[])`);
      await del('blocks',            `DELETE FROM blocks WHERE blocker_id = ANY($1::uuid[]) OR blocked_id = ANY($1::uuid[])`);
      await del('friend_requests',   `DELETE FROM friend_requests WHERE from_user_id = ANY($1::uuid[]) OR to_user_id = ANY($1::uuid[])`);
      await del('friendships',       `DELETE FROM friendships WHERE user_id_a = ANY($1::uuid[]) OR user_id_b = ANY($1::uuid[])`);
      await del('protected_zones',   `DELETE FROM protected_zones WHERE user_id = ANY($1::uuid[])`);
      await del('radio_memberships', `DELETE FROM radio_workspace_members WHERE user_id = ANY($1::uuid[])`);
      await del('radio_files',       `DELETE FROM radio_files WHERE owner_id = ANY($1::uuid[])`);
      await del('radio_workspaces',  `DELETE FROM radio_workspaces WHERE owner_id = ANY($1::uuid[])`);
      await del('posts',             `DELETE FROM posts WHERE user_id = ANY($1::uuid[])`);

      // otps has no FK — its target is a bare phone/email string — so these
      // rows orphan unless they are named, and nothing later will find them.
      // Matched the way the dry run counted them: address case-insensitively,
      // number on its last ten digits, because /auth/request-otp stores the
      // target exactly as the client typed it and users.phone may hold a
      // different formatting of the same number. A live unused code for a
      // number a real signup later reuses is the reason to bother.
      const otpEmails = rows.map(r => (r.email || '').toLowerCase()).filter(Boolean);
      const otpPhoneKeys = rows.map(r => phoneKey(r.phone)).filter(k => k.length >= 10);
      done.otps = (otpEmails.length + otpPhoneKeys.length) === 0 ? 0 : (await client.query(
        `DELETE FROM otps
           WHERE LOWER(target) = ANY($1::text[])
              OR (target NOT LIKE '%@%'
                  AND regexp_replace(target, '[^0-9]', '', 'g') <> ''
                  AND right(regexp_replace(target, '[^0-9]', '', 'g'), 10) = ANY($2::text[]))`,
        [otpEmails, otpPhoneKeys])).rowCount;

      // The reaper's own statement (src/jobs/reap_users.js), scoped to the
      // selection instead of the 14-day window.
      const { rows: gone } = await client.query(
        `DELETE FROM users WHERE id = ANY($1::uuid[]) RETURNING id`, [ids]);
      done.users = gone.length;

      if (done.users !== ids.length) {
        throw new Error(`deleted ${done.users} users but selected ${ids.length} — rolling back`);
      }
    } else {
      const { rows: [{ pending }] } = await client.query(
        `SELECT COUNT(*)::int AS pending FROM users
          WHERE id = ANY($1::uuid[]) AND deletion_pending_at IS NOT NULL`,
        [ids]
      );
      if (pending !== ids.length) {
        throw new Error(`${ids.length - pending} of ${ids.length} accounts are not marked for deletion — rolling back`);
      }
    }

    const guardedAfter = await protectedRowCount(client);
    if (guardedAfter !== guardedBefore) {
      throw new Error(`protected accounts went from ${guardedBefore} to ${guardedAfter} rows — rolling back`);
    }

    await client.query('COMMIT');

    if (HARD) {
      const detail = DEPENDENTS.map(([key, label]) => `${done[key] || 0} ${label}`).join(', ');
      console.log(`Hard-deleted ${done.users} accounts and ${detail}.`);
      console.log('Gone for good — there is no soft-delete trail and no audit table.');
    } else {
      console.log(`Soft-deleted ${done.soft_deleted} accounts (${ids.length} selected; the rest were already pending).`);
      console.log(`Removed ${done.device_tokens} device tokens and ${done.refresh_tokens} refresh tokens.`);
      console.log('Everything else — posts, friends, blocks, Radio rows, connector grants, OTPs —');
      console.log('is untouched and still there; the reaper takes it with the row in 14 days.');
      console.log('The daily reaper hard-deletes them in 14 days; a sign-in before then cancels it.');
    }
    console.log('Done ✓');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// CLI only — this script has no library use.
if (require.main === module) {
  wipeTestAccounts()
    .then(() => pool.end())
    .catch(err => {
      console.error('wipe-test-accounts failed:', err.message);
      pool.end();
      process.exit(1);
    });
}

module.exports = {
  wipeTestAccounts,
  neverDelete,
  phoneKey,
  NEVER_DELETE_PHONE_KEYS,
  NEVER_DELETE_EMAILS,
};
