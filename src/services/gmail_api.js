/**
 * Thin Gmail REST v1 client.
 *
 * Transport, URL building and the bounded-concurrency helper are shared with
 * the Calendar, Drive, People and Tasks clients — see google_http.
 */

const http = require('./google_http');

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Bodies larger than this are truncated in tool results so one huge thread
// cannot swamp a conversation. The cut is flagged, never silent.
const MAX_BODY_CHARS = 60000;

const { mapLimit, DETAIL_CONCURRENCY } = http;

const call     = http.clientFor('Gmail API', BASE);
const buildUrl = call.url;

const header = (msg, name) =>
  msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

/** Decode the HTML entities Gmail leaves in snippets (&amp;, &#39;, &#x27;…). */
function decodeEntities(text) {
  if (!text) return '';
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\n{3,}/g, '\n\n').trim();
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

  // multipart/alternative carries the same content twice; plain text is the
  // better source than de-tagged HTML.
  if (payload.mimeType === 'multipart/alternative') {
    const plain = parts.find(p => p.mimeType === 'text/plain');
    if (plain) return extractBody(plain);
    const html = parts.find(p => p.mimeType === 'text/html');
    if (html) return extractBody(html);
  }

  // Everything else (mixed, related): MIME order is meaningful — the first
  // extractable part is the primary body. Parts with filenames are
  // attachments, never the body.
  for (const part of parts) {
    if (part.filename) continue;
    const nested = extractBody(part);
    if (nested) return nested;
  }
  return '';
}

function truncateBody(body) {
  if (!body || body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n…[truncated ${body.length - MAX_BODY_CHARS} more characters]`;
}

/** Every real attachment in a MIME tree: filename + id + type + size. */
function collectAttachments(payload, found = []) {
  if (!payload) return found;

  if (payload.filename && payload.body?.attachmentId) {
    found.push({
      attachment_id: payload.body.attachmentId,
      filename:      payload.filename,
      mime_type:     payload.mimeType || 'application/octet-stream',
      size_bytes:    payload.body.size || 0,
    });
  }
  for (const part of payload.parts || []) collectAttachments(part, found);
  return found;
}

function summarize(msg) {
  return {
    id:        msg.id,
    thread_id: msg.threadId,
    from:      header(msg, 'From'),
    to:        header(msg, 'To'),
    subject:   header(msg, 'Subject'),
    date:      header(msg, 'Date'),
    snippet:   decodeEntities(msg.snippet || ''),
    labels:    msg.labelIds || [],
    unread:    (msg.labelIds || []).includes('UNREAD'),
  };
}

// ─── Search ─────────────────────────────────────────────────────────────────

async function searchMessages(accessToken, { query, maxResults = 10, pageToken }) {
  const listed = await call(accessToken, '/messages', {
    query: {
      q: query,
      maxResults: Math.min(Math.max(maxResults, 1), 50),
      pageToken,
    },
  });

  const ids = (listed.messages || []).map(m => m.id);
  if (!ids.length) return { messages: [], nextPageToken: null };

  // Metadata format keeps these cheap — full bodies come from get_message.
  const detailed = await mapLimit(ids, DETAIL_CONCURRENCY, id =>
    call(accessToken, `/messages/${id}`, {
      query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] },
    }).catch(() => null),
  );

  const messages = detailed.filter(Boolean).map(summarize);

  return {
    messages,
    nextPageToken: listed.nextPageToken || null,
    // A dropped detail fetch is reported, never passed off as "no such message".
    ...(detailed.length - messages.length ? { unavailable: detailed.length - messages.length } : {}),
  };
}

/**
 * Split an address-list header into individual addresses.
 *
 * A quoted display name may itself contain a comma ("Kim, Jamie" <j@x.com>),
 * so a bare split on "," would cut one address in half. Track quoting and
 * angle brackets and only break on the commas that actually separate.
 */
function parseAddresses(value) {
  const out = [];
  let current = '';
  let quoted  = false;
  let angled  = false;

  for (const ch of value || '') {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angled = true;
    else if (ch === '>' && !quoted) angled = false;
    else if (ch === ',' && !quoted && !angled) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The bare address out of "Name <a@b.com>", lowercased, for deduping. */
function addressOf(entry) {
  const angled = entry.match(/<([^>]+)>/);
  return (angled ? angled[1] : entry).trim().toLowerCase();
}

/**
 * Collapse a whole thread into one row: who is in it, how many messages, and
 * where it currently stands. Built from metadata-format messages, so no body
 * is fetched.
 */
function summarizeThread(thread) {
  const messages = thread.messages || [];
  const first    = messages[0] || {};
  const last     = messages[messages.length - 1] || {};

  const participants = [];
  const seen         = new Set();
  for (const msg of messages) {
    for (const field of ['From', 'To', 'Cc']) {
      for (const entry of parseAddresses(header(msg, field))) {
        const key = addressOf(entry);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        participants.push(entry);
      }
    }
  }

  return {
    id:            thread.id,
    subject:       header(first, 'Subject'),
    participants,
    message_count: messages.length,
    first_date:    header(first, 'Date'),
    last_date:     header(last, 'Date'),
    last_from:     header(last, 'From'),
    snippet:       decodeEntities(last.snippet || ''),
    labels:        [...new Set(messages.flatMap(m => m.labelIds || []))],
    unread_count:  messages.filter(m => (m.labelIds || []).includes('UNREAD')).length,
  };
}

/**
 * Search conversations rather than messages. Same Gmail query syntax; a thread
 * matches when any message in it does, and comes back whole.
 */
async function searchThreads(accessToken, { query, maxResults = 10, pageToken }) {
  const listed = await call(accessToken, '/threads', {
    query: {
      q: query,
      maxResults: Math.min(Math.max(maxResults, 1), 50),
      pageToken,
    },
  });

  const ids = (listed.threads || []).map(t => t.id);
  if (!ids.length) return { threads: [], nextPageToken: null };

  // Metadata format: headers and label ids only, so summarising a 40-message
  // thread costs no more than a short one.
  const detailed = await mapLimit(ids, DETAIL_CONCURRENCY, id =>
    call(accessToken, `/threads/${id}`, {
      query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] },
    }).catch(() => null),
  );

  const threads = detailed.filter(Boolean).map(summarizeThread);

  return {
    threads,
    nextPageToken: listed.nextPageToken || null,
    ...(detailed.length - threads.length ? { unavailable: detailed.length - threads.length } : {}),
  };
}

// ─── Read ───────────────────────────────────────────────────────────────────

async function getMessage(accessToken, id) {
  const msg = await call(accessToken, `/messages/${id}`, { query: { format: 'full' } });
  return {
    ...summarize(msg),
    cc:          header(msg, 'Cc'),
    body:        truncateBody(extractBody(msg.payload)),
    attachments: collectAttachments(msg.payload),
  };
}

async function getThread(accessToken, id) {
  const thread = await call(accessToken, `/threads/${id}`, { query: { format: 'full' } });
  return {
    id: thread.id,
    messages: (thread.messages || []).map(m => ({
      ...summarize(m),
      body:        truncateBody(extractBody(m.payload)),
      attachments: collectAttachments(m.payload),
    })),
  };
}

/** Raw bytes of one attachment. Returned as a Buffer. */
async function getAttachmentData(accessToken, messageId, attachmentId) {
  const res = await call(accessToken, `/messages/${messageId}/attachments/${attachmentId}`);
  return Buffer.from(res.data, 'base64url');
}

// ─── MIME construction ──────────────────────────────────────────────────────

/** RFC 2047 encode a header value only when it needs it. */
function encodeHeader(value) {
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

const wrap76 = (b64) => b64.replace(/(.{76})/g, '$1\r\n');

/**
 * Build a raw RFC 5322 message, base64url-encoded for the Gmail API.
 * With `attachments` ([{filename, mimeType, data:Buffer}]) it produces
 * multipart/mixed; without, a simple text/plain message.
 */
function buildMime({ from, to, cc, bcc, subject, body, inReplyTo, references, attachments }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc  ? [`Cc: ${cc}`]   : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encodeHeader(subject || '')}`,
    ...(inReplyTo  ? [`In-Reply-To: ${inReplyTo}`]  : []),
    ...(references ? [`References: ${references}`]  : []),
    'MIME-Version: 1.0',
  ];

  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(body || '', 'utf8').toString('base64')),
  ];

  let lines;
  if (attachments?.length) {
    const boundary = `----=_grounders_${Date.now().toString(36)}`;
    lines = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      ...textPart,
      ...attachments.flatMap(att => [
        `--${boundary}`,
        `Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${encodeHeader(att.filename)}"`,
        `Content-Disposition: attachment; filename="${encodeHeader(att.filename)}"`,
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(att.data.toString('base64')),
      ]),
      `--${boundary}--`,
    ];
  } else {
    lines = [...headers, ...textPart];
  }

  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

// ─── Send / reply / forward ─────────────────────────────────────────────────

async function sendMessage(accessToken, { threadId, ...mime }) {
  return call(accessToken, '/messages/send', {
    method: 'POST',
    body: { raw: buildMime(mime), ...(threadId ? { threadId } : {}) },
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

// Forwarded attachments are re-fetched and re-encoded; cap the total so one
// forward cannot try to move a mailbox's worth of data through the server.
const MAX_FORWARD_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Forward a message, carrying its attachments along (up to the size cap).
 * Returns { sent, skippedAttachments } — skipped ones are named, not silent.
 */
async function forwardMessage(accessToken, { from, messageId, to, cc, note }) {
  const original = await call(accessToken, `/messages/${messageId}`, { query: { format: 'full' } });

  const origSubject = header(original, 'Subject');
  const quoted = [
    '---------- Forwarded message ----------',
    `From: ${header(original, 'From')}`,
    `Date: ${header(original, 'Date')}`,
    `Subject: ${origSubject}`,
    `To: ${header(original, 'To')}`,
    '',
    extractBody(original.payload),
  ].join('\n');

  const wanted  = collectAttachments(original.payload);
  const carried = [];
  const skipped = [];
  let   total   = 0;

  for (const att of wanted) {
    if (total + (att.size_bytes || 0) > MAX_FORWARD_ATTACHMENT_BYTES) {
      skipped.push(att.filename);
      continue;
    }
    const data = await getAttachmentData(accessToken, messageId, att.attachment_id);
    total += data.length;
    carried.push({ filename: att.filename, mimeType: att.mime_type, data });
  }

  const sent = await call(accessToken, '/messages/send', {
    method: 'POST',
    body: {
      raw: buildMime({
        from, to, cc,
        subject: /^fwd:/i.test(origSubject) ? origSubject : `Fwd: ${origSubject}`,
        body:    note ? `${note}\n\n${quoted}` : quoted,
        attachments: carried,
      }),
    },
  });

  return { sent, skippedAttachments: skipped };
}

// ─── Labels ─────────────────────────────────────────────────────────────────

const modifyLabels = (accessToken, id, { add = [], remove = [] }) =>
  call(accessToken, `/messages/${id}/modify`, {
    method: 'POST',
    body: { addLabelIds: add, removeLabelIds: remove },
  });

const modifyThreadLabels = (accessToken, id, { add = [], remove = [] }) =>
  call(accessToken, `/threads/${id}/modify`, {
    method: 'POST',
    body: { addLabelIds: add, removeLabelIds: remove },
  });

const listLabels = async (accessToken) =>
  (await call(accessToken, '/labels')).labels?.map(l => ({ id: l.id, name: l.name, type: l.type })) || [];

const createLabel = (accessToken, name) =>
  call(accessToken, '/labels', {
    method: 'POST',
    body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });

const updateLabel = (accessToken, id, name) =>
  call(accessToken, `/labels/${id}`, { method: 'PATCH', body: { name } });

const deleteLabel = (accessToken, id) =>
  call(accessToken, `/labels/${id}`, { method: 'DELETE' });

// ─── Trash / untrash ────────────────────────────────────────────────────────

const trashMessage   = (t, id) => call(t, `/messages/${id}/trash`,   { method: 'POST' });
const untrashMessage = (t, id) => call(t, `/messages/${id}/untrash`, { method: 'POST' });
const trashThread    = (t, id) => call(t, `/threads/${id}/trash`,    { method: 'POST' });
const untrashThread  = (t, id) => call(t, `/threads/${id}/untrash`,  { method: 'POST' });

// ─── Drafts ─────────────────────────────────────────────────────────────────

async function listDrafts(accessToken, { maxResults = 15 } = {}) {
  const listed = await call(accessToken, '/drafts', {
    query: { maxResults: Math.min(Math.max(maxResults, 1), 50) },
  });

  const drafts = listed.drafts || [];
  const detailed = await Promise.all(drafts.map(d =>
    call(accessToken, `/drafts/${d.id}`, {
      query: { format: 'metadata', metadataHeaders: ['To', 'Subject', 'Date'] },
    }).catch(() => null),
  ));

  return detailed.filter(Boolean).map(d => ({
    draft_id:   d.id,
    message_id: d.message?.id,
    thread_id:  d.message?.threadId,
    to:         header(d.message || {}, 'To'),
    subject:    header(d.message || {}, 'Subject'),
    snippet:    decodeEntities(d.message?.snippet || ''),
  }));
}

async function getDraft(accessToken, draftId) {
  const d = await call(accessToken, `/drafts/${draftId}`, { query: { format: 'full' } });
  return {
    draft_id: d.id,
    ...summarize(d.message),
    cc:   header(d.message, 'Cc'),
    body: truncateBody(extractBody(d.message.payload)),
  };
}

async function createDraft(accessToken, { threadId, ...mime }) {
  const d = await call(accessToken, '/drafts', {
    method: 'POST',
    body: { message: { raw: buildMime(mime), ...(threadId ? { threadId } : {}) } },
  });
  return { draft_id: d.id, message_id: d.message?.id, thread_id: d.message?.threadId };
}

async function updateDraft(accessToken, draftId, { threadId, ...mime }) {
  const d = await call(accessToken, `/drafts/${draftId}`, {
    method: 'PUT',
    body: { message: { raw: buildMime(mime), ...(threadId ? { threadId } : {}) } },
  });
  return { draft_id: d.id, message_id: d.message?.id, thread_id: d.message?.threadId };
}

const sendDraft = (accessToken, draftId) =>
  call(accessToken, '/drafts/send', { method: 'POST', body: { id: draftId } });

const deleteDraft = (accessToken, draftId) =>
  call(accessToken, `/drafts/${draftId}`, { method: 'DELETE' });

const getProfile = (accessToken) => call(accessToken, '/profile');

module.exports = {
  searchMessages, searchThreads, getMessage, getThread, getAttachmentData,
  sendMessage, getReplyContext, forwardMessage,
  modifyLabels, modifyThreadLabels,
  listLabels, createLabel, updateLabel, deleteLabel,
  trashMessage, untrashMessage, trashThread, untrashThread,
  listDrafts, getDraft, createDraft, updateDraft, sendDraft, deleteDraft,
  getProfile,
  MAX_BODY_CHARS,
  _internal: { buildMime, extractBody, encodeHeader, buildUrl, decodeEntities, collectAttachments, truncateBody,
              parseAddresses, addressOf, summarizeThread, mapLimit },
};
