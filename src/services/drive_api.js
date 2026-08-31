/**
 * Thin Google Drive v3 client.
 *
 * Drive's own query language is powerful and easy to get subtly wrong, so
 * callers pass plain text and an optional raw filter; the two are combined
 * here with the quoting handled in one place.
 */

const http = require('./google_http');

const BASE   = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const call   = http.clientFor('Drive API', BASE);
const upload = http.clientFor('Drive upload', UPLOAD);

// Text pulled out of a document is capped like a mail body.
const MAX_TEXT_CHARS  = 60000;
// Binary downloads have to fit in a tool result once base64-expanded.
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,createdTime,webViewLink,iconLink,parents,trashed,shared,owners(emailAddress,displayName)';

const encode = (id) => encodeURIComponent(String(id));

/** Google-native documents have no bytes to download — they must be exported. */
const EXPORT_AS = {
  'application/vnd.google-apps.document':     'text/plain',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.script':       'application/vnd.google-apps.script+json',
};

/** Drive string literals are single-quoted, so a quote in the text must be escaped. */
const quote = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Combine free text with an optional raw Drive filter.
 *
 * Free text goes to fullText, which covers names and body content. Trashed
 * files are excluded unless the caller's own filter mentions trashed.
 */
function buildQuery({ query, filter }) {
  const clauses = [];
  if (query)  clauses.push(`fullText contains ${quote(query)}`);
  if (filter) clauses.push(`(${filter})`);
  if (!/trashed/.test(filter || '')) clauses.push('trashed = false');
  return clauses.join(' and ');
}

function summarizeFile(file) {
  return {
    id:            file.id,
    name:          file.name,
    mime_type:     file.mimeType,
    size_bytes:    file.size ? Number(file.size) : null,
    modified:      file.modifiedTime || null,
    created:       file.createdTime || null,
    owners:        (file.owners || []).map(o => o.emailAddress).filter(Boolean),
    shared:        Boolean(file.shared),
    trashed:       Boolean(file.trashed),
    is_folder:     file.mimeType === 'application/vnd.google-apps.folder',
    google_native: String(file.mimeType || '').startsWith('application/vnd.google-apps'),
    link:          file.webViewLink || null,
  };
}

async function searchFiles(accessToken, { query, filter, maxResults = 10, pageToken, orderBy } = {}) {
  const res = await call(accessToken, '/files', {
    query: {
      q:         buildQuery({ query, filter }),
      pageSize:  Math.min(Math.max(maxResults, 1), 50),
      orderBy:   orderBy || undefined,
      pageToken,
      fields:    `nextPageToken,files(${FILE_FIELDS})`,
      spaces:    'drive',
    },
  });

  return {
    files: (res.files || []).map(summarizeFile),
    nextPageToken: res.nextPageToken || null,
  };
}

const listRecent = (accessToken, { maxResults = 10, pageToken } = {}) =>
  searchFiles(accessToken, { maxResults, pageToken, orderBy: 'modifiedTime desc' });

async function getMetadata(accessToken, fileId) {
  const file = await call(accessToken, `/files/${encode(fileId)}`, { query: { fields: FILE_FIELDS } });
  return summarizeFile(file);
}

/**
 * File content as bytes.
 *
 * Google-native docs are exported to a text format; everything else downloads
 * as-is. Returns the buffer plus the mime type it actually came back as, which
 * is not the file's own type when an export happened.
 */
async function getContent(accessToken, fileId) {
  const meta   = await getMetadata(accessToken, fileId);
  const asText = EXPORT_AS[meta.mime_type];

  if (meta.is_folder) throw new Error(`"${meta.name}" is a folder, not a file.`);

  if (!asText && meta.size_bytes && meta.size_bytes > MAX_DOWNLOAD_BYTES) {
    throw new Error(`"${meta.name}" is ${meta.size_bytes} bytes — over the ${MAX_DOWNLOAD_BYTES} byte limit for tool results.`);
  }

  const data = asText
    ? await call(accessToken, `/files/${encode(fileId)}/export`, { query: { mimeType: asText }, raw: true })
    : await call(accessToken, `/files/${encode(fileId)}`, { query: { alt: 'media' }, raw: true });

  if (data.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`"${meta.name}" came back as ${data.length} bytes — over the ${MAX_DOWNLOAD_BYTES} byte limit.`);
  }

  return { meta, data, mimeType: asText || meta.mime_type, exported: Boolean(asText) };
}

/**
 * Text from a file Google can convert but this server cannot read locally —
 * a scan, an image, or a PDF whose fonts hide the characters.
 *
 * Drive converts to a Google Doc on copy, and that conversion runs Google's own
 * OCR. There is no read-only way to ask for it, so this makes a temporary copy,
 * exports its text, and deletes the copy in a finally block.
 *
 * That delete is permanent rather than a trash, and it is the only permanent
 * delete anywhere in this server: its target is a file created seconds earlier
 * by this function, never anything the user put there. If the cleanup itself
 * fails, the id comes back so the caller can say what was left behind.
 */
async function ocrViaConversion(accessToken, fileId) {
  const source = await getMetadata(accessToken, fileId);

  const copy = await call(accessToken, `/files/${encode(fileId)}/copy`, {
    method: 'POST',
    query:  { fields: 'id,name' },
    body:   { name: `[temporary OCR copy] ${source.name}`, mimeType: 'application/vnd.google-apps.document' },
  });

  let text;
  try {
    const data = await call(accessToken, `/files/${encode(copy.id)}/export`, {
      query: { mimeType: 'text/plain' },
      raw:   true,
    });
    text = data.toString('utf8');
  } finally {
    // The copy must not outlive this call, whether the export worked or not.
    // Cleanup failure is reported rather than thrown: it must not mask an
    // export error, and it must not turn a successful read into a failure.
    var orphaned = await call(accessToken, `/files/${encode(copy.id)}`, { method: 'DELETE' })
      .then(() => null, () => copy.id);
  }

  return {
    name: source.name,
    text,
    source_mime_type: source.mime_type,
    ...(orphaned ? { orphaned_copy: orphaned } : {}),
  };
}

function truncateText(value) {
  return value.length <= MAX_TEXT_CHARS
    ? value
    : `${value.slice(0, MAX_TEXT_CHARS)}\n\n[truncated — ${value.length} characters total]`;
}

/** A multipart/related upload body: JSON metadata, then the bytes. */
function multipartBody(metadata, content, mimeType, boundary) {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
    Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

async function createFile(accessToken, { name, content = '', mimeType = 'text/plain', parents, description }) {
  const boundary = `grounders-${Date.now().toString(36)}`;
  const metadata = {
    name,
    ...(parents && parents.length ? { parents } : {}),
    ...(description ? { description } : {}),
    ...(mimeType ? { mimeType } : {}),
  };

  const file = await upload(accessToken, '/files', {
    method:  'POST',
    query:   { uploadType: 'multipart', fields: FILE_FIELDS },
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body:    multipartBody(metadata, content, mimeType, boundary),
  });

  return summarizeFile(file);
}

/** Rename/move/describe, replace the content, or both. */
async function updateFile(accessToken, fileId, { name, content, mimeType, description, addParents, removeParents }) {
  const metadata = {
    ...(name        !== undefined ? { name }        : {}),
    ...(description !== undefined ? { description } : {}),
  };

  if (content === undefined) {
    if (!Object.keys(metadata).length && !addParents && !removeParents) {
      throw new Error('Nothing to update — pass name, description, content or a parent change.');
    }
    const file = await call(accessToken, `/files/${encode(fileId)}`, {
      method: 'PATCH',
      query:  { fields: FILE_FIELDS, addParents, removeParents },
      body:   metadata,
    });
    return summarizeFile(file);
  }

  const boundary = `grounders-${Date.now().toString(36)}`;
  const file = await upload(accessToken, `/files/${encode(fileId)}`, {
    method:  'PATCH',
    query:   { uploadType: 'multipart', fields: FILE_FIELDS, addParents, removeParents },
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body:    multipartBody(metadata, content, mimeType || 'text/plain', boundary),
  });

  return summarizeFile(file);
}

async function copyFile(accessToken, fileId, { name, parents }) {
  const file = await call(accessToken, `/files/${encode(fileId)}/copy`, {
    method: 'POST',
    query:  { fields: FILE_FIELDS },
    body:   { ...(name ? { name } : {}), ...(parents && parents.length ? { parents } : {}) },
  });
  return summarizeFile(file);
}

async function listPermissions(accessToken, fileId) {
  const res = await call(accessToken, `/files/${encode(fileId)}/permissions`, {
    query: { fields: 'permissions(id,type,role,emailAddress,domain,displayName,deleted)' },
  });

  return (res.permissions || []).map(p => ({
    id:      p.id,
    type:    p.type,
    role:    p.role,
    who:     p.emailAddress || p.domain || (p.type === 'anyone' ? 'anyone with the link' : p.type),
    name:    p.displayName || null,
  }));
}

async function share(accessToken, fileId, { email, domain, anyone, role = 'reader', notify = false, message }) {
  const body = anyone
    ? { type: 'anyone', role }
    : domain
      ? { type: 'domain', role, domain }
      : { type: 'user', role, emailAddress: email };

  const created = await call(accessToken, `/files/${encode(fileId)}/permissions`, {
    method: 'POST',
    query:  {
      sendNotificationEmail: notify ? 'true' : 'false',
      ...(notify && message ? { emailMessage: message } : {}),
      fields: 'id,type,role,emailAddress,domain',
    },
    body,
  });

  return { id: created.id, type: created.type, role: created.role, who: created.emailAddress || created.domain || 'anyone with the link' };
}

/**
 * Withdraw access that was granted earlier.
 *
 * The counterpart to `share`, and the reason sharing can be offered at all: an
 * access grant nobody can take back is a one-way door. A permission is named
 * either by id, or by who holds it — a person, a domain, or the public link.
 */
async function unshare(accessToken, fileId, { permissionId, email, domain, publicLink }) {
  let id      = permissionId;
  let matched = null;

  if (!id) {
    const permissions = await listPermissions(accessToken, fileId);
    const wanted = permissions.filter(p =>
      (email      && p.who.toLowerCase() === String(email).toLowerCase()) ||
      (domain     && p.type === 'domain' && p.who.toLowerCase() === String(domain).toLowerCase()) ||
      (publicLink && p.type === 'anyone'));

    if (!wanted.length) {
      throw new Error('No matching permission on that file — get_file_permissions shows what is actually there.');
    }
    if (wanted.length > 1) {
      throw new Error(`That matches ${wanted.length} permissions — pass permission_id from get_file_permissions instead.`);
    }

    matched = wanted[0];
    id      = matched.id;
  }

  await call(accessToken, `/files/${encode(fileId)}/permissions/${encode(id)}`, { method: 'DELETE' });
  return { permission_id: id, ...(matched ? { removed: matched } : {}) };
}

async function untrashFile(accessToken, fileId) {
  const file = await call(accessToken, `/files/${encode(fileId)}`, {
    method: 'PATCH',
    query:  { fields: FILE_FIELDS },
    body:   { trashed: false },
  });
  return summarizeFile(file);
}

async function trashFile(accessToken, fileId) {
  const file = await call(accessToken, `/files/${encode(fileId)}`, {
    method: 'PATCH',
    query:  { fields: FILE_FIELDS },
    body:   { trashed: true },
  });
  return summarizeFile(file);
}

module.exports = {
  searchFiles, listRecent, getMetadata, getContent, createFile, updateFile,
  copyFile, listPermissions, share, unshare, trashFile, untrashFile, ocrViaConversion,
  MAX_TEXT_CHARS, MAX_DOWNLOAD_BYTES, EXPORT_AS,
  _internal: { buildQuery, quote, summarizeFile, multipartBody, truncateText },
};
