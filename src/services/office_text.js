/**
 * Text out of Office and OpenDocument files, without a dependency.
 *
 * .docx, .xlsx, .pptx and .odt are all ZIP archives of XML. Node ships zlib,
 * which is the only hard part of reading a ZIP, so the whole format is
 * reachable with the standard library — no parser to vendor, audit or keep
 * current.
 *
 * The goal is text a model can reason over, not a faithful rendering: styling,
 * images and layout are dropped, and what remains is reading order.
 */

const zlib = require('zlib');

const LOCAL_HEADER   = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD_HEADER    = 0x06054b50;

/** Index a ZIP's central directory: name → where and how the bytes are stored. */
function readZipIndex(buffer) {
  // The end-of-central-directory record is last, but a trailing comment can
  // push it back by up to 64 KB, so scan rather than assume.
  let eocd = -1;
  const earliest = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= earliest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_HEADER) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive — no end-of-central-directory record.');

  const count = buffer.readUInt16LE(eocd + 10);
  let at      = buffer.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let i = 0; i < count && at + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(at) !== CENTRAL_HEADER) break;

    const method    = buffer.readUInt16LE(at + 10);
    const sizeOnDisk = buffer.readUInt32LE(at + 20);
    const nameLen   = buffer.readUInt16LE(at + 28);
    const extraLen  = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const localAt   = buffer.readUInt32LE(at + 42);

    entries.set(buffer.toString('utf8', at + 46, at + 46 + nameLen), { method, sizeOnDisk, localAt });
    at += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** One entry's bytes. The local header repeats the name and extra lengths, and only it is trustworthy for the data offset. */
function readZipEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.localAt) !== LOCAL_HEADER) {
    throw new Error('Damaged ZIP entry — local header missing.');
  }

  const nameLen  = buffer.readUInt16LE(entry.localAt + 26);
  const extraLen = buffer.readUInt16LE(entry.localAt + 28);
  const start    = entry.localAt + 30 + nameLen + extraLen;

  // A size of zero means the writer streamed the entry and put the real size in
  // a trailing data descriptor; inflate to the end and let zlib find the stop.
  const raw = entry.sizeOnDisk
    ? buffer.subarray(start, start + entry.sizeOnDisk)
    : buffer.subarray(start);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
}

const xmlOf = (buffer, entries, name) => {
  const entry = entries.get(name);
  return entry ? readZipEntry(buffer, entry).toString('utf8') : null;
};

/** XML entities, numeric and named. `&amp;` resolves last so `&amp;lt;` stays literal. */
function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Three or more blank lines is always a layout artefact, never meaning. */
const tidy = (text) => text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ─── Word ───────────────────────────────────────────────────────────────────

function docxText(buffer, entries) {
  const xml = xmlOf(buffer, entries, 'word/document.xml');
  if (xml === null) throw new Error('Not a Word document — word/document.xml is missing.');

  const out = [];
  // One pass over the things that carry text or break a line. Anything else in
  // the document — styles, revision marks, drawing frames — is not text.
  const token = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*>|<w:br\b[^>]*>|<\/w:p>/g;

  let match;
  while ((match = token.exec(xml))) {
    if (match[1] !== undefined) out.push(decodeXml(match[1]));
    else if (match[0].startsWith('<w:tab')) out.push('\t');
    else out.push('\n');
  }

  return tidy(out.join(''));
}

// ─── Excel ──────────────────────────────────────────────────────────────────

/** "AB12" → 27. Column letters are base-26 with no zero. */
function columnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/);
  if (!letters) return null;
  return [...letters[0]].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

const csvCell = (value) =>
  /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

function sharedStrings(buffer, entries) {
  const xml = xmlOf(buffer, entries, 'xl/sharedStrings.xml');
  if (!xml) return [];

  // A shared string can be split across runs; concatenate every <t> inside <si>.
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
    [...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1])).join(''));
}

/** Sheet name → path, resolved through the workbook relationships rather than guessed from filenames. */
function sheetOrder(buffer, entries) {
  const workbook = xmlOf(buffer, entries, 'xl/workbook.xml');
  const rels     = xmlOf(buffer, entries, 'xl/_rels/workbook.xml.rels');
  if (!workbook) return [];

  const targets = new Map();
  for (const [, id, target] of (rels || '').matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    targets.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
  }

  const sheets = [];
  for (const [, attrs] of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = (attrs.match(/name="([^"]*)"/) || [])[1];
    const rid  = (attrs.match(/r:id="([^"]*)"/) || [])[1];
    const path = targets.get(rid);
    if (name && path && entries.has(path)) sheets.push({ name: decodeXml(name), path });
  }

  // A workbook with no usable relationships still has its sheets on disk.
  if (!sheets.length) {
    for (const name of [...entries.keys()].filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()) {
      sheets.push({ name: name.replace(/^xl\/worksheets\/|\.xml$/g, ''), path: name });
    }
  }

  return sheets;
}

function xlsxText(buffer, entries) {
  const strings = sharedStrings(buffer, entries);
  const sheets  = sheetOrder(buffer, entries);
  if (!sheets.length) throw new Error('Not a workbook — no worksheets found.');

  const out = [];
  for (const sheet of sheets) {
    const xml  = xmlOf(buffer, entries, sheet.path) || '';
    const rows = [];

    for (const [, rowXml] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const [, attrs, body] of rowXml.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type      = (attrs.match(/\bt="([^"]+)"/) || [])[1];
        const reference = (attrs.match(/\br="([^"]+)"/) || [])[1];
        const stored    = ((body || '').match(/<v>([\s\S]*?)<\/v>/) || [])[1];

        let value = '';
        if (type === 's')            value = strings[Number(stored)] ?? '';
        else if (type === 'inlineStr') value = [...(body || '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1])).join('');
        else if (type === 'b')        value = stored === '1' ? 'TRUE' : 'FALSE';
        else if (stored !== undefined) value = decodeXml(stored);

        // Place by column letter so gaps stay gaps and columns stay aligned.
        const at = columnIndex(reference);
        if (at === null) cells.push(value);
        else { while (cells.length < at) cells.push(''); cells[at] = value; }
      }

      // Trailing empties carry nothing; a blank row still separates blocks.
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      rows.push(cells.map(c => csvCell(c ?? '')).join(','));
    }

    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    out.push(`--- ${sheet.name} ---\n${rows.join('\n')}`);
  }

  return tidy(out.join('\n\n'));
}

// ─── PowerPoint ─────────────────────────────────────────────────────────────

function pptxText(buffer, entries) {
  const slides = [...entries.keys()]
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));

  if (!slides.length) throw new Error('Not a presentation — no slides found.');

  const out = [];
  slides.forEach((path, i) => {
    const xml   = xmlOf(buffer, entries, path) || '';
    const parts = [];

    const token = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<\/a:p>/g;
    let match;
    while ((match = token.exec(xml))) {
      if (match[1] !== undefined) parts.push(decodeXml(match[1]));
      else parts.push('\n');
    }

    out.push(`--- Slide ${i + 1} ---\n${tidy(parts.join(''))}`);
  });

  return tidy(out.join('\n\n'));
}

// ─── OpenDocument ───────────────────────────────────────────────────────────

function odfText(buffer, entries) {
  const xml = xmlOf(buffer, entries, 'content.xml');
  if (xml === null) throw new Error('Not an OpenDocument file — content.xml is missing.');

  // Everything before <office:body> is styles and font declarations.
  const body = (xml.match(/<office:body>([\s\S]*)<\/office:body>/) || [, xml])[1];

  return tidy(decodeXml(
    body
      .replace(/<text:tab\b[^>]*>/g, '\t')
      .replace(/<text:s\b[^>]*>/g, ' ')
      .replace(/<text:line-break\b[^>]*>/g, '\n')
      .replace(/<\/(text:p|text:h)>/g, '\n')
      .replace(/<table:table-cell\b[^>]*>/g, '')
      .replace(/<\/table:table-row>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  ));
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

const BY_MIME = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': docxText,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':       xlsxText,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': pptxText,
  'application/vnd.oasis.opendocument.text':         odfText,
  'application/vnd.oasis.opendocument.spreadsheet':  odfText,
  'application/vnd.oasis.opendocument.presentation': odfText,
};

const BY_EXTENSION = {
  docx: docxText, xlsx: xlsxText, pptx: pptxText,
  odt: odfText, ods: odfText, odp: odfText,
};

const supports = (mimeType, filename) =>
  Boolean(BY_MIME[mimeType] || BY_EXTENSION[String(filename || '').split('.').pop().toLowerCase()]);

/**
 * Text from an Office or OpenDocument file, or null when it is neither.
 *
 * The mime type is trusted first and the extension only as a fallback: Gmail
 * attachments routinely arrive as application/octet-stream regardless of what
 * they actually are.
 */
function extract(buffer, { mimeType, filename } = {}) {
  const reader = BY_MIME[mimeType] || BY_EXTENSION[String(filename || '').split('.').pop().toLowerCase()];
  if (!reader) return null;

  const entries = readZipIndex(buffer);
  return reader(buffer, entries);
}

module.exports = {
  extract, supports,
  _internal: { readZipIndex, readZipEntry, decodeXml, columnIndex, csvCell, docxText, xlsxText, pptxText, odfText, tidy },
};
