/**
 * The Drive capabilities that were behind the first-party connector, and the
 * two that go past it.
 *   npm run test:drive-parity
 *
 * These assert what actually goes over the wire — the multipart framing, which
 * mime type lands in the metadata versus the body part, which endpoint a reply
 * goes to — because every one of them is a place where a plausible-looking call
 * silently does the wrong thing.
 */

const drive = require('../src/services/drive_api');

let fail = 0;
const check = (name, cond, extra = '') => {
  cond || fail++;
  console.log(`${cond ? ' ok  ' : 'FAIL '} ${name}${extra ? ' — ' + String(extra).slice(0, 100) : ''}`);
};

/** Capture every request, answering with whatever the test needs back. */
function record(reply = () => ({})) {
  const seen = [];
  global.fetch = async (url, opts = {}) => {
    const parsed = new URL(String(url));
    const body   = opts.body;
    seen.push({
      method: opts.method || 'GET',
      path:   parsed.pathname,
      query:  Object.fromEntries(parsed.searchParams),
      headers: opts.headers || {},
      body,
      text:   Buffer.isBuffer(body) ? body.toString('latin1') : (typeof body === 'string' ? body : null),
      json:   typeof body === 'string' && body.startsWith('{') ? JSON.parse(body) : null,
    });
    return { ok: true, status: 200, text: async () => JSON.stringify(reply(parsed, seen)), arrayBuffer: async () => Buffer.from('BYTES') };
  };
  return seen;
}

const FILE = { id: 'f1', name: 'thing', mimeType: 'text/plain', size: '5' };

(async () => {
  // ─── Binary upload ────────────────────────────────────────────────────────
  let seen = record(() => FILE);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
  await drive.createFile('tok', { name: 'shot.png', contentBase64: png.toString('base64'), mimeType: 'image/png' });

  const upload = seen[0];
  check('a binary upload goes to the upload endpoint', upload.path.includes('/upload/drive/v3/files'), upload.path);
  check('it is sent as multipart', String(upload.headers['Content-Type']).startsWith('multipart/related'), upload.headers['Content-Type']);
  check('the body is raw bytes, not a re-encoded string', Buffer.isBuffer(upload.body));
  check('the binary survives the framing byte for byte', upload.body.includes(png), JSON.stringify(upload.text.slice(-40)));
  check('the part declares the real content type', upload.text.includes('Content-Type: image/png'));

  // ─── Conversion to a Google-native type ───────────────────────────────────
  seen = record(() => FILE);
  await drive.createFile('tok', { name: 'Notes', content: '<h1>Hi</h1>', mimeType: 'text/html', convertTo: 'document' });

  const convert = seen[0];
  check('the metadata asks for the Google type',
    convert.text.includes('"mimeType":"application/vnd.google-apps.document"'), convert.text.slice(0, 160));
  check('the body part still declares what was actually sent',
    convert.text.includes('Content-Type: text/html'), convert.text.slice(0, 260));
  check('metadata type and part type differ — that is what triggers conversion',
    convert.text.indexOf('google-apps.document') < convert.text.indexOf('Content-Type: text/html'));

  let threw = '';
  try { await drive.createFile('tok', { name: 'x', content: 'y', convertTo: 'nonsense' }); }
  catch (e) { threw = e.message; }
  check('an unknown convert_to is rejected with the list', threw.includes('Unknown convert_to') && threw.includes('spreadsheet'), threw);

  // ─── Empty containers need no upload at all ───────────────────────────────
  seen = record(() => ({ id: 'd1', name: 'Receipts', mimeType: 'application/vnd.google-apps.folder' }));
  await drive.createFile('tok', { name: 'Receipts', convertTo: 'folder' });
  check('a folder is metadata only, not an empty upload',
    seen[0].path === '/drive/v3/files' && !seen[0].path.includes('upload'), seen[0].path);
  check('the folder type is set', seen[0].json.mimeType === 'application/vnd.google-apps.folder', JSON.stringify(seen[0].json));

  // ─── Export on the way out ────────────────────────────────────────────────
  seen = record(() => ({ id: 'f1', name: 'Report', mimeType: 'application/vnd.google-apps.document' }));
  const exported = await drive.getContent('tok', 'f1', { exportAs: 'pdf' });
  check('export hits the export endpoint', seen[1].path.endsWith('/export'), seen[1].path);
  check('export asks for the right mime type', seen[1].query.mimeType === 'application/pdf', JSON.stringify(seen[1].query));
  check('the exported bytes come back', exported.data.toString() === 'BYTES');

  seen = record(() => ({ id: 'f1', name: 'photo.png', mimeType: 'image/png' }));
  threw = '';
  try { await drive.getContent('tok', 'f1', { exportAs: 'pdf' }); } catch (e) { threw = e.message; }
  check('exporting a file that is already binary is refused', threw.includes('only Google Docs'), threw);

  seen = record(() => ({ id: 'f1', name: 'Doc', mimeType: 'application/vnd.google-apps.document' }));
  threw = '';
  try { await drive.getContent('tok', 'f1', { exportAs: 'wingdings' }); } catch (e) { threw = e.message; }
  check('an unknown export format lists the real ones', threw.includes('docx') && threw.includes('pdf'), threw);

  // ─── Comments ─────────────────────────────────────────────────────────────
  seen = record(() => ({
    comments: [
      { id: 'c1', author: { displayName: 'Ann', me: false }, content: 'Is this the final number?',
        quotedFileContent: { value: '$14,250' }, resolved: false, createdTime: '2026-08-30T10:00:00Z',
        replies: [{ id: 'r1', author: { displayName: 'Me', me: true }, content: 'Yes.', createdTime: '2026-08-30T11:00:00Z' }] },
      { id: 'c2', author: {}, content: 'Old point', resolved: true, replies: [] },
    ],
  }));
  const comments = await drive.listComments('tok', 'f1');

  check('comments come back shaped', comments.length === 2 && comments[0].author === 'Ann');
  check('the anchored text is kept', comments[0].on_text === '$14,250', comments[0].on_text);
  check('replies are nested under their thread', comments[0].replies.length === 1 && comments[0].replies[0].content === 'Yes.');
  check('resolved state is surfaced', comments[1].resolved === true && comments[0].resolved === false);
  check('a missing author does not blank the comment', comments[1].author === 'Unknown', comments[1].author);
  check('the field list asks for quoted text and replies',
    seen[0].query.fields.includes('quotedFileContent') && seen[0].query.fields.includes('replies'), seen[0].query.fields);

  const unresolvedOnly = await drive.listComments('tok', 'f1', { includeResolved: false });
  check('resolved threads can be filtered out', unresolvedOnly.length === 1 && unresolvedOnly[0].id === 'c1');

  // ─── Commenting, and replying ─────────────────────────────────────────────
  seen = record(() => ({ id: 'c9', content: 'Looks right to me', createdTime: '2026-08-31T09:00:00Z' }));
  await drive.addComment('tok', 'f1', { content: 'Looks right to me' });
  check('a new comment posts to the comments collection',
    seen[0].method === 'POST' && seen[0].path === '/drive/v3/files/f1/comments', `${seen[0].method} ${seen[0].path}`);

  seen = record(() => ({ id: 'r9', content: 'Agreed', createdTime: '2026-08-31T09:05:00Z' }));
  const reply = await drive.addComment('tok', 'f1', { content: 'Agreed', replyTo: 'c1' });
  check('a reply posts to that thread, not as a new comment',
    seen[0].path === '/drive/v3/files/f1/comments/c1/replies', seen[0].path);
  check('the reply records what it answered', reply.reply_to === 'c1');

  // ─── The tool surface agrees ──────────────────────────────────────────────
  const tools  = require('../src/mcp/tools/drive');
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));

  check('create_file offers binary content', 'content_base64' in byName.create_file.inputSchema.properties);
  check('create_file offers conversion', 'convert_to' in byName.create_file.inputSchema.properties);
  check('update_file offers binary content', 'content_base64' in byName.update_file.inputSchema.properties);
  check('download_file_content offers export', 'export_as' in byName.download_file_content.inputSchema.properties);
  check('read_file_content offers comments', 'include_comments' in byName.read_file_content.inputSchema.properties);
  check('there is a tool for commenting', Boolean(byName.comment_on_file));

  const call = async (name, args) => {
    try { await byName[name].handler({ ownerKey: 'o', args }); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
  };
  require('../src/services/gmail_accounts').emailsFor = async () => [];

  const both = await call('create_file', { name: 'x', content: 'a', content_base64: 'YQ==' });
  check('passing both content forms is refused', !both.ok && both.message.includes('not both'), both.message);

  const binaryOverwrite = await call('update_file', { file_id: 'f1', content_base64: 'YQ==' });
  check('a binary overwrite is guarded exactly like a text one',
    !binaryOverwrite.ok && binaryOverwrite.message.includes('replace_content: true'), binaryOverwrite.message);

  console.log(fail ? `\n${fail} FAILED` : '\ndrive parity holds');
  process.exit(fail ? 1 : 0);
})();
