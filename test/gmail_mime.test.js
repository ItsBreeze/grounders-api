/**
 * MIME construction, entity decoding, attachment collection, body truncation.
 *   npm run test:mime
 */

const { _internal, MAX_BODY_CHARS } = require('../src/services/gmail_api');
const { buildMime, decodeEntities, collectAttachments, truncateBody, extractBody } = _internal;

let fail = 0;
const check = (n, c, e = '') => { c || fail++; console.log(`${c ? ' ok  ' : 'FAIL '} ${n}${e ? ' — ' + e : ''}`); };
const b64u = s => Buffer.from(s).toString('base64url');

// ─── Entities ────────────────────────────────────────────────────────────────
check('named entities decode', decodeEntities('don&amp;t &lt;b&gt; &quot;x&quot;') === 'don&t <b> "x"');
check('numeric decimal decodes', decodeEntities('don&#39;t') === "don't");
check('numeric hex decodes', decodeEntities('don&#x27;t') === "don't");
check('unknown entity left alone', decodeEntities('&bogus;') === '&bogus;');
check('empty safe', decodeEntities('') === '');

// ─── Truncation ──────────────────────────────────────────────────────────────
const huge = 'x'.repeat(MAX_BODY_CHARS + 500);
const cut = truncateBody(huge);
check('long body truncated with note', cut.length < huge.length && cut.includes('[truncated 500 more characters]'));
check('short body untouched', truncateBody('hello') === 'hello');

// ─── Attachments ─────────────────────────────────────────────────────────────
const tree = {
  mimeType: 'multipart/mixed',
  parts: [
    { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/plain', body: { data: b64u('the body') } },
      { mimeType: 'text/html', body: { data: b64u('<p>the body</p>') } },
    ]},
    { mimeType: 'application/pdf', filename: 'resume.pdf', body: { attachmentId: 'att1', size: 12345 } },
    { mimeType: 'image/png', filename: 'photo.png', body: { attachmentId: 'att2', size: 999 } },
    { mimeType: 'text/plain', filename: '', body: { data: b64u('inline, not attachment') } },
  ],
};
const atts = collectAttachments(tree);
check('finds both attachments', atts.length === 2, JSON.stringify(atts.map(a => a.filename)));
check('attachment metadata complete',
  atts[0].filename === 'resume.pdf' && atts[0].attachment_id === 'att1' &&
  atts[0].mime_type === 'application/pdf' && atts[0].size_bytes === 12345);
check('inline parts not treated as attachments', !atts.some(a => a.filename === ''));
check('body still extracts alongside attachments', extractBody(tree) === 'the body');

// ─── Plain MIME ──────────────────────────────────────────────────────────────
const plain = Buffer.from(buildMime({ from: 'a@x.com', to: 'b@y.com', subject: 'Hi', body: 'text' }), 'base64url').toString();
check('plain message is not multipart', !plain.includes('multipart/mixed'));
check('plain message carries body', plain.includes(Buffer.from('text').toString('base64')));

// ─── Multipart MIME ──────────────────────────────────────────────────────────
const raw = Buffer.from(buildMime({
  from: 'a@x.com', to: 'b@y.com', subject: 'With file', body: 'see attached',
  attachments: [{ filename: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('file content here') }],
}), 'base64url').toString();

check('multipart declared', /multipart\/mixed; boundary="[^"]+"/.test(raw));
const boundary = raw.match(/boundary="([^"]+)"/)?.[1];
check('boundary used for parts', boundary && raw.split(`--${boundary}`).length >= 4);
check('closing boundary present', raw.includes(`--${boundary}--`));
check('attachment disposition set', raw.includes('Content-Disposition: attachment; filename="notes.txt"'));
check('attachment content encoded', raw.includes(Buffer.from('file content here').toString('base64')));
check('body part present too', raw.includes(Buffer.from('see attached').toString('base64')));

// ─── Snippet decoding in summaries ──────────────────────────────────────────
const gmail = require('../src/services/gmail_api');
// summarize is not exported directly; verify through the entity decoder the
// search path now uses.
check('snippet-style entities decode', decodeEntities('Anthropic is letting everyone know you used Claude&#39;s API') .includes("Claude's"));

console.log(fail ? `\n${fail} FAILED` : '\nMIME and decoding correct');
process.exit(fail ? 1 : 0);
