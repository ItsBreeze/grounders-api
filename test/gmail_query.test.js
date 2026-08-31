/**
 * Gmail API query-string construction.
 *   npm run test:query
 *
 * The array case is a real regression: metadataHeaders passed as a single
 * comma-joined value makes Gmail return messages with no headers, so every
 * search result comes back with empty from/subject/date.
 */

const { _internal } = require('../src/services/gmail_api');
const { buildUrl } = _internal;

let fail = 0;
const check = (name, cond, extra = '') => {
  cond || fail++;
  console.log(`${cond ? ' ok  ' : 'FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
};

const params = (path, query) => buildUrl(path, query).searchParams;

const metadata = params('/messages/abc', {
  format: 'metadata',
  metadataHeaders: ['From', 'To', 'Subject', 'Date'],
});

check('array becomes repeated params',
  metadata.getAll('metadataHeaders').join('|') === 'From|To|Subject|Date',
  metadata.getAll('metadataHeaders').join('|'));

check('array is not comma-joined',
  !metadata.get('metadataHeaders').includes(','));

check('scalar params still set once',
  metadata.getAll('format').length === 1 && metadata.get('format') === 'metadata');

const search = params('/messages', { q: 'is:unread newer_than:7d', maxResults: 5 });
check('query string is encoded', search.get('q') === 'is:unread newer_than:7d');
check('numbers stringify', search.get('maxResults') === '5');

const sparse = params('/messages', { q: 'x', pageToken: '', missing: null, absent: undefined });
check('empty and nullish params are dropped',
  [...sparse.keys()].join(',') === 'q', [...sparse.keys()].join(','));

check('no query object is safe', buildUrl('/labels').searchParams.size === 0);

console.log(fail ? `\n${fail} FAILED` : '\nquery construction correct');
process.exit(fail ? 1 : 0);
