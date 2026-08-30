/**
 * Thin Gmail REST v1 client.
 *
 * Deliberately dependency-free — Node's global fetch is enough, and pulling in
 * googleapis for six endpoints would be a large tree for no gain.
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function call(accessToken, path, { method = 'GET', query, body } = {}) {
  const url = new URL(`${BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text   = await res.text().catch(() => '');
    let   detail = `HTTP ${res.status}`;
    try { detail = JSON.parse(text).error?.message || detail; } catch { /* keep status */ }
    throw new Error(`Gmail API ${method} ${path}: ${detail}`);
  }

  return res.status === 204 ? null : res.json();
}

const header = (msg, name) =>
  msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Flatten a MIME tree to its best plain-text rendering.
 * Prefers a text/plain part; falls back to de-tagged text/html.
 */
function extractBody(payload) {
  if (!payload) return '';

  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, 'base64url').toString('utf8');
    return payload.mimeType === 'text/html' ? htmlToText(decoded) : decoded;
  }

  const parts = payload.parts || [];

  // multipart/alternative carries both; plain text is the better source.
  const plain = parts.find(p => p.mimeType === 'text/plain');
  if (plain) return extractBody(plain);

  const html = parts.find(p => p.mimeType === 'text/html');
  if (html) return extractBody(html);

  for (const part of parts) {
    const nested = extractBody(part);
    if (nested) return nested;
  }
  return '';
}

function summarize(msg) {
  return {
    id:       msg.id,
    thread_id: msg.threadId,
    from:     header(msg, 'From'),
    to:       header(msg, 'To'),
    subject:  header(msg, 'Subject'),
    date:     header(msg, 'Date'),
    snippet:  msg.snippet || '',
    labels:   msg.labelIds || [],
    unread:   (msg.labelIds || []).includes('UNREAD'),
  };
}

async function searchMessages(accessToken, { query, maxResults = 10 }) {
  const listed = await call(accessToken, '/messages', {
    query: { q: query, maxResults: Math.min(Math.max(maxResults, 1), 50) },
  });

  const ids = (listed.messages || []).map(m => m.id);
  if (!ids.length) return [];

  // Metadata format keeps these cheap — full bodies come from get_message.
  const detailed = await Promise.all(ids.map(id =>
    call(accessToken, `/messages/${id}`, {
      query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] },
    }).catch(() => null),
  ));

  return detailed.filter(Boolean).map(summarize);
}

async function getMessage(accessToken, id) {
  const msg = await call(accessToken, `/messages/${id}`, { query: { format: 'full' } });
  return { ...summarize(msg), cc: header(msg, 'Cc'), body: extractBody(msg.payload) };
}

async function getThread(accessToken, id) {
  const thread = await call(accessToken, `/threads/${id}`, { query: { format: 'full' } });
  return {
    id: thread.id,
    messages: (thread.messages || []).map(m => ({ ...summarize(m), body: extractBody(m.payload) })),
  };
}

/** RFC 2047 encode a header value only when it needs it. */
function encodeHeader(value) {
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildMime({ from, to, cc, bcc, subject, body, inReplyTo, references }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc  ? [`Cc: ${cc}`]   : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encodeHeader(subject || '')}`,
    ...(inReplyTo  ? [`In-Reply-To: ${inReplyTo}`]  : []),
    ...(references ? [`References: ${references}`]  : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body || '', 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

async function sendMessage(accessToken, { from, to, cc, bcc, subject, body, threadId, inReplyTo, references }) {
  return call(accessToken, '/messages/send', {
    method: 'POST',
    body: {
      raw: buildMime({ from, to, cc, bcc, subject, body, inReplyTo, references }),
      ...(threadId ? { threadId } : {}),
    },
  });
}

/** Headers needed to thread a reply correctly (RFC 5322 In-Reply-To/References). */
async function getReplyContext(accessToken, id) {
  const msg = await call(accessToken, `/messages/${id}`, {
    query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'] },
  });

  const subject = header(msg, 'Subject');

  return {
    threadId:   msg.threadId,
    messageId:  header(msg, 'Message-ID'),
    references: header(msg, 'References'),
    from:       header(msg, 'From'),
    to:         header(msg, 'To'),
    cc:         header(msg, 'Cc'),
    subject:    /^re:/i.test(subject) ? subject : `Re: ${subject}`,
  };
}

const modifyLabels = (accessToken, id, { add = [], remove = [] }) =>
  call(accessToken, `/messages/${id}/modify`, {
    method: 'POST',
    body: { addLabelIds: add, removeLabelIds: remove },
  });

const trashMessage = (accessToken, id) =>
  call(accessToken, `/messages/${id}/trash`, { method: 'POST' });

const listLabels = async (accessToken) =>
  (await call(accessToken, '/labels')).labels?.map(l => ({ id: l.id, name: l.name, type: l.type })) || [];

const getProfile = (accessToken) => call(accessToken, '/profile');

module.exports = {
  searchMessages, getMessage, getThread, sendMessage, getReplyContext,
  modifyLabels, trashMessage, listLabels, getProfile,
  _internal: { buildMime, extractBody, encodeHeader },
};
