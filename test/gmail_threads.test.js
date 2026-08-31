/**
 * Thread search: address-list parsing, thread summarisation, and the
 * cross-account fan-out that both search tools share.
 *   npm run test:threads
 *
 * No network and no database — the Gmail client and the account store are
 * both stubbed, so this asserts the shaping logic and nothing else.
 */

const { _internal: api } = require('../src/services/gmail_api');
const { parseAddresses, addressOf, summarizeThread } = api;

let fail = 0;
const check = (name, cond, extra = '') => {
  cond || fail++;
  console.log(`${cond ? ' ok  ' : 'FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
};

// ─── Address-list parsing ───────────────────────────────────────────────────

check('plain list splits',
  parseAddresses('a@x.com, b@y.com').join('|') === 'a@x.com|b@y.com');

const quoted = parseAddresses('"Kim, Jamie" <j@x.com>, Sam <s@y.com>');
check('comma inside a quoted display name does not split', quoted.length === 2, quoted.join(' | '));
check('quoted name kept whole', quoted[0] === '"Kim, Jamie" <j@x.com>', quoted[0]);

check('empty header yields nothing', parseAddresses('').length === 0);
check('missing header yields nothing', parseAddresses(undefined).length === 0);

check('address extracted from angle form', addressOf('Sam <S@Y.com>') === 's@y.com');
check('bare address lowercased', addressOf('  A@X.com ') === 'a@x.com');

// ─── Thread summarisation ───────────────────────────────────────────────────

const msg = (headers, labelIds = [], snippet = '') => ({
  labelIds,
  snippet,
  payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
});

const thread = {
  id: 'th1',
  messages: [
    msg({ From: 'Ann <ann@x.com>', To: 'me@y.com', Subject: 'Roof quote', Date: 'Mon, 1 Sep 2025 09:00:00 -0600' },
        ['INBOX', 'UNREAD'], 'first'),
    msg({ From: 'me@y.com', To: 'Ann <ann@x.com>', Cc: 'Bo <bo@z.com>', Subject: 'Re: Roof quote', Date: 'Mon, 1 Sep 2025 10:00:00 -0600' },
        ['SENT'], 'second'),
    msg({ From: 'Bo <bo@z.com>', To: 'me@y.com, ANN@X.COM', Subject: 'Re: Roof quote', Date: 'Tue, 2 Sep 2025 08:00:00 -0600' },
        ['INBOX', 'UNREAD'], 'don&#39;t forget'),
  ],
};

const sum = summarizeThread(thread);

check('thread id carried', sum.id === 'th1');
check('subject comes from the first message', sum.subject === 'Roof quote', sum.subject);
check('message count is the whole thread', sum.message_count === 3, String(sum.message_count));
check('first_date is the opening message', sum.first_date.startsWith('Mon, 1 Sep 2025 09:00'), sum.first_date);
check('last_date is the latest message', sum.last_date.startsWith('Tue, 2 Sep 2025 08:00'), sum.last_date);
check('last_from is who spoke last', sum.last_from === 'Bo <bo@z.com>', sum.last_from);

check('participants deduped across From/To/Cc and case',
  sum.participants.length === 3, sum.participants.join(' | '));
check('participants cover every party',
  ['ann@x.com', 'me@y.com', 'bo@z.com'].every(a => sum.participants.some(p => addressOf(p) === a)),
  sum.participants.join(' | '));

check('labels are the union across messages',
  ['INBOX', 'UNREAD', 'SENT'].every(l => sum.labels.includes(l)) && sum.labels.length === 3,
  sum.labels.join(','));
check('unread_count counts only unread messages', sum.unread_count === 2, String(sum.unread_count));
check('snippet comes from the latest message, entity-decoded',
  sum.snippet === "don't forget", sum.snippet);

const empty = summarizeThread({ id: 'th2', messages: [] });
check('empty thread does not throw', empty.message_count === 0 && empty.subject === '');

// ─── searchThreads over a stubbed transport ─────────────────────────────────

const gmail = require('../src/services/gmail_api');

const requested = [];
const realFetch = global.fetch;
global.fetch = async (url) => {
  requested.push(String(url));
  const path = new URL(String(url)).pathname;
  const body = path.endsWith('/threads')
    ? { threads: [{ id: 'th1' }, { id: 'th2' }], nextPageToken: 'next-abc' }
    : { id: path.split('/').pop(), messages: thread.messages };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

(async () => {
  const page = await gmail.searchThreads('tok', { query: 'from:ann', maxResults: 200 });
  global.fetch = realFetch;

  check('list call hits /threads with the query',
    requested.some(u => u.includes('/threads?') && u.includes('q=from%3Aann')), requested[0]);
  check('maxResults is clamped to 50',
    requested[0].includes('maxResults=50'), requested[0]);
  check('each listed thread is fetched once',
    requested.filter(u => /\/threads\/th[12]/.test(u)).length === 2, String(requested.length));
  check('threads are fetched as metadata, not full bodies',
    requested.filter(u => u.includes('/threads/th')).every(u => u.includes('format=metadata')));
  check('Cc is among the requested headers',
    requested[1].includes('metadataHeaders=Cc'), requested[1]);
  check('every listed thread is summarised', page.threads.length === 2, String(page.threads.length));
  check('summaries are shaped, not raw', page.threads[0].message_count === 3 && page.threads[0].participants.length === 3);
  check('nextPageToken is passed through', page.nextPageToken === 'next-abc', String(page.nextPageToken));

  const emptyFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({}) });
  global.fetch = emptyFetch;
  const none = await gmail.searchThreads('tok', { query: 'from:nobody' });
  global.fetch = realFetch;
  check('no matches is an empty list, not a throw',
    Array.isArray(none.threads) && none.threads.length === 0 && none.nextPageToken === null);

// ─── Bounded concurrency ────────────────────────────────────────────────────

  const { mapLimit } = api;

  let inFlight = 0;
  let peak     = 0;
  const order  = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });

  check('mapLimit never exceeds its concurrency limit', peak <= 3, `peak ${peak}`);
  check('mapLimit actually runs in parallel', peak > 1, `peak ${peak}`);
  check('mapLimit preserves input order', order.join(',') === '2,4,6,8,10,12,14,16,18,20', order.join(','));
  check('mapLimit on an empty list is fine', (await mapLimit([], 3, async () => 1)).length === 0);

  // A thread whose detail fetch fails is counted, not silently dropped.
  global.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/threads')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ threads: [{ id: 'th1' }, { id: 'bad' }] }) };
    }
    if (path.endsWith('/bad')) return { ok: false, status: 429, text: async () => '{"error":{"message":"rate limit"}}' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'th1', messages: thread.messages }) };
  };
  const partial = await gmail.searchThreads('tok', { query: 'x' });
  global.fetch = realFetch;

  check('a failed thread fetch does not sink the page', partial.threads.length === 1, String(partial.threads.length));
  check('the dropped thread is counted, not hidden', partial.unavailable === 1, String(partial.unavailable));

// ─── Cross-account fan-out ──────────────────────────────────────────────────

const accountsModule = require('../src/services/gmail_accounts');
const { _internal: tools } = require('../src/mcp/tools');

const linked = ['one@x.com', 'two@x.com', 'dead@x.com'];
accountsModule.emailsFor      = async () => linked;
accountsModule.accessTokenFor = async (_owner, email) => {
  if (email === 'dead@x.com') throw new Error('refresh token expired');
  return `token-${email}`;
};

  const all = await tools.fanOut('owner', undefined, 'gmail', async (token, email) => ({ token, email }));
  check('fan-out targets every linked mailbox', all.targets.length === 3, all.targets.join(','));
  check('a dead grant does not blank out the others', all.ok.length === 2, String(all.ok.length));
  check('the dead mailbox is named in errors',
    all.failed.length === 1 && all.failed[0].startsWith('dead@x.com: '), all.failed.join(';'));
  check('each mailbox gets its own token',
    all.ok.every(r => r.value.token === `token-${r.email}`));

  const one = await tools.fanOut('owner', 'two', 'gmail', async token => token);
  check('naming an account narrows the fan-out', one.targets.length === 1 && one.targets[0] === 'two@x.com',
    one.targets.join(','));

  accountsModule.emailsFor = async () => [];
  let threw = '';
  try { await tools.fanOut('owner', undefined, 'gmail', async () => 1); } catch (e) { threw = e.message; }
  check('no accounts linked is an error, not an empty result',
    threw.includes('No accounts are linked'), threw);

  console.log(fail ? `\n${fail} FAILED` : '\nthread search and fan-out correct');
  process.exit(fail ? 1 : 0);
})();
