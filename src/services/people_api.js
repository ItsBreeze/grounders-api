/**
 * Thin Google People v1 client — contacts, read-only.
 *
 * This exists so "email Ann about the lease" resolves to an address without
 * the user spelling it out. Nothing here writes to an address book.
 */

const http = require('./google_http');

const BASE = 'https://people.googleapis.com/v1';
const call = http.clientFor('People API', BASE);

const READ_MASK  = 'names,emailAddresses,phoneNumbers,organizations';
const OTHER_MASK = 'names,emailAddresses';

function summarizePerson(person) {
  const org = (person.organizations || [])[0] || {};
  return {
    name:    ((person.names || [])[0] || {}).displayName || null,
    emails:  (person.emailAddresses || []).map(e => e.value).filter(Boolean),
    phones:  (person.phoneNumbers || []).map(p => p.value).filter(Boolean),
    company: org.name || null,
    title:   org.title || null,
  };
}

/**
 * Search saved contacts, then the "other contacts" Google accumulates from
 * people you have corresponded with.
 *
 * The empty-query call is not a mistake: Google's searchContacts reads from a
 * per-session cache that is only populated by a warmup request, and skipping it
 * makes the first real search of a session come back empty.
 */
async function searchContacts(accessToken, { query, maxResults = 10 }) {
  await call(accessToken, '/people:searchContacts', { query: { query: '', readMask: READ_MASK } })
    .catch(() => null);

  const pageSize = Math.min(Math.max(maxResults, 1), 30);

  const [saved, other] = await Promise.allSettled([
    call(accessToken, '/people:searchContacts', { query: { query, readMask: READ_MASK, pageSize } }),
    call(accessToken, '/otherContacts:search',  { query: { query, readMask: OTHER_MASK, pageSize } }),
  ]);

  // "Nobody by that name" and "the API refused us" must not look alike. One
  // source failing is a note on the result; both failing is an error.
  if (saved.status === 'rejected' && other.status === 'rejected') {
    throw new Error(saved.reason.message);
  }

  const errors = [saved, other]
    .filter(r => r.status === 'rejected')
    .map(r => r.reason.message);

  const people = [];
  const seen   = new Set();

  for (const [source, result] of [['contacts', saved], ['correspondents', other]]) {
    const res = result.status === 'fulfilled' ? (result.value || {}) : {};
    for (const { person } of res.results || []) {
      const summary = summarizePerson(person || {});
      // Someone in both lists is one person; the saved contact wins.
      const key = (summary.emails[0] || summary.name || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      people.push({ ...summary, source });
    }
  }

  return { people, ...(errors.length ? { partial: errors } : {}) };
}

async function listContacts(accessToken, { maxResults = 25, pageToken } = {}) {
  const res = await call(accessToken, '/people/me/connections', {
    query: {
      personFields: READ_MASK,
      pageSize:     Math.min(Math.max(maxResults, 1), 100),
      sortOrder:    'LAST_MODIFIED_DESCENDING',
      pageToken,
    },
  });

  return {
    people: (res.connections || []).map(summarizePerson),
    nextPageToken: res.nextPageToken || null,
    total: res.totalItems ?? null,
  };
}

module.exports = { searchContacts, listContacts, _internal: { summarizePerson } };
