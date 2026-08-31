/**
 * Document text extraction.
 *   npm run test:extract
 *
 * Fixtures are real containers, not hand-built ones: the Office files were
 * written by an independent ZIP implementation, and sample.pdf is a genuine
 * 10-page PDF with a Flate + ASCII85 filter chain. A ZIP reader tested only
 * against its own writer proves nothing.
 */

const fs     = require('fs');
const path   = require('path');
const office = require('../src/services/office_text');
const pdf    = require('../src/services/pdf_text');
const extract = require('../src/services/text_extract');

let fail = 0;
const check = (name, cond, extraInfo = '') => {
  cond || fail++;
  console.log(`${cond ? ' ok  ' : 'FAIL '} ${name}${extraInfo ? ' — ' + String(extraInfo).slice(0, 90) : ''}`);
};

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// ─── Word ───────────────────────────────────────────────────────────────────

const doc = office.extract(fixture('contract.docx'), { mimeType: DOCX });

check('paragraphs become lines', doc.startsWith('Roof Replacement Agreement'), doc.slice(0, 40));
check('runs split mid-sentence are rejoined', doc.includes('Total: $14,250 due on completion.'));
check('entities are decoded', doc.includes("Ann's note") && doc.includes('materials & labour <all>'));
check('a tab stays a tab', doc.includes("Ann's note\tmaterials"));
check('a line break inside a paragraph breaks the line', doc.includes('line one\nline two'));
check('unicode survives', doc.includes('café 你好'));
check('text outside the document body is not picked up', !doc.includes('NOT BODY TEXT'), doc);

// ─── Excel ──────────────────────────────────────────────────────────────────

const sheet = office.extract(fixture('quote.xlsx'), { mimeType: XLSX });

check('sheet names come from the workbook relationships', sheet.includes('--- Quote ---') && sheet.includes('--- Notes ---'));
check('shared strings resolve', sheet.includes('Item,Qty,Price'));
check('numbers keep their precision', sheet.includes('Shingles,40,1200.5'));
check('a comma inside a value is quoted', sheet.includes('"Labour, installed"'));
check('an embedded quote is doubled', sheet.includes('"Say ""hello"""'));
check('a gap in the middle of a row stays a gap', sheet.includes('"Labour, installed",,9500'), sheet);
check('a cell far along a row lands in the right column', sheet.includes(',,,14250'), sheet);
check('booleans read as words', sheet.includes('TRUE'));
check('inline strings are read too', sheet.includes('Second sheet'));

// ─── PowerPoint ─────────────────────────────────────────────────────────────

const deck = office.extract(fixture('deck.pptx'), { mimeType: PPTX });

check('slides are labelled', deck.includes('--- Slide 1 ---'));
check('slide text is extracted', deck.includes('Title slide') && deck.includes('subtitle here'));
check('slide 10 sorts after slide 2, not after slide 1',
  deck.indexOf('Second') < deck.indexOf('Tenth, not third'), deck.replace(/\n/g, ' '));

// ─── OpenDocument ───────────────────────────────────────────────────────────

const odt = office.extract(fixture('lease.odt'), { mimeType: 'application/vnd.oasis.opendocument.text' });

check('stored (uncompressed) ZIP entries are read', odt.includes('Lease Summary'));
check('an archive comment does not defeat the directory scan', odt.includes('Signed by Ann & Bo.'));
check('odf tabs survive', odt.includes('$2,400\tmonthly'));
check('style definitions are not treated as content', !odt.includes('IGNORED STYLE TEXT'), odt);

// ─── Format detection ───────────────────────────────────────────────────────

check('a docx is recognised by mime type', office.supports(DOCX, null));
check('a docx is recognised by extension when the mime type lies',
  office.supports('application/octet-stream', 'contract.docx'));
check('an unrelated type is not claimed', !office.supports('image/png', 'a.png'));

// Gmail hands out application/octet-stream constantly; the extension must win.
const byName = extract.extract(fixture('contract.docx'), { mimeType: 'application/octet-stream', filename: 'contract.docx' });
check('an octet-stream attachment is still read by its name', byName.text.includes('Roof Replacement'), byName.reason);

let threw = '';
try { office.extract(Buffer.from('not a zip at all'), { mimeType: DOCX }); } catch (e) { threw = e.message; }
check('a non-ZIP is rejected clearly', threw.includes('Not a ZIP archive'), threw);

const corrupt = extract.extract(Buffer.from('still not a zip'), { mimeType: DOCX });
check('a corrupt Office file reports rather than throws', corrupt.text === null && corrupt.kind === 'office', corrupt.reason);
check('a corrupt Office file is not offered to OCR', corrupt.recoverable === false);

// ─── PDF ────────────────────────────────────────────────────────────────────

const real = pdf.extract(fixture('sample.pdf'));

check('a real PDF extracts', real.text !== null, real.reason);
check('every page is found', real.pages === 10, String(real.pages));
check('the text is readable, not glyph numbers', real.readability >= 0.95, String(real.readability));
check('actual words come out', real.text.includes('Ocean Depths') && real.text.includes('Typography'));
check('a filter chain (ASCII85 then Flate) is decoded', real.text.includes('professional and calming'));
check('output is not one long run-on', real.text.split('\n').length > 20, String(real.text.split('\n').length));

check('a non-PDF is refused by signature',
  pdf.extract(Buffer.from('%PNG\r\n\x1a\n')).reason.includes('does not start with %PDF-'));

// A PDF with a text layer whose bytes are glyph indexes must be refused, not
// returned as noise — this is the silent-corruption case that matters most.
const cidBody = 'BT /F1 12 Tf <0003000500070009000B000D0011001300150017> Tj ET\n';
const cid = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${cidBody.length} >>\nstream\n${cidBody}endstream\nendobj\n`);
const cidResult = pdf.extract(cid);
check('glyph-index text is refused rather than returned as words',
  cidResult.text === null, JSON.stringify(cidResult.text));
check('the refusal explains CID fonts and points at OCR',
  /CID-keyed|glyph/.test(cidResult.reason) && cidResult.reason.includes('ocr: true'), cidResult.reason);

// An uncompressed PDF with ordinary literal strings — the simplest real case.
const plainBody =
  'BT /F1 12 Tf (Invoice 4472) Tj T* (Amount due: $1,204.55) Tj T* ' +
  '[(Escaped \\(parens\\) and a) -400 (word space)] TJ ET\n';
const plain = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${plainBody.length} >>\nstream\n${plainBody}endstream\nendobj\n`);
const plainResult = pdf.extract(plain);
check('a plain PDF text layer reads', plainResult.text !== null, plainResult.reason);
check('literal strings decode', (plainResult.text || '').includes('Invoice 4472'));
check('positioning operators become line breaks',
  (plainResult.text || '').includes('Invoice 4472\nAmount due: $1,204.55'), JSON.stringify(plainResult.text));
check('escaped parentheses survive', (plainResult.text || '').includes('Escaped (parens) and a'));
check('a wide kern in a TJ array becomes a space',
  (plainResult.text || '').includes('and a word space'), JSON.stringify(plainResult.text));

check('hex strings decode', pdf._internal.decodeHex('48656C6C6F') === 'Hello');
check('octal escapes decode', pdf._internal.decodeLiteral('caf\\351') === 'café');
check('a backslash before a newline is a continuation', pdf._internal.decodeLiteral('one\\\ntwo') === 'onetwo');

// Vectors taken from Python's base64.a85encode, not from this implementation.
check('ascii85 round-trips a known value',
  pdf._internal.decodeAscii85('87cURD_*#TDfTZ)+T').toString('latin1') === 'Hello, world!',
  pdf._internal.decodeAscii85('87cURD_*#TDfTZ)+T').toString('latin1'));
check('ascii85 handles a trailing partial group',
  pdf._internal.decodeAscii85('@:E^').toString('latin1') === 'abc',
  pdf._internal.decodeAscii85('@:E^').toString('latin1'));
check('ascii85 z shorthand expands to four zero bytes',
  pdf._internal.decodeAscii85('z').equals(Buffer.from([0, 0, 0, 0])));

check('an unsupported filter is skipped, not guessed at',
  pdf._internal.applyFilters(Buffer.from('x'), '/Filter /DCTDecode') === null);

// ─── Dispatcher ─────────────────────────────────────────────────────────────

check('pdf routes to the pdf reader', extract.extract(fixture('sample.pdf'), { mimeType: 'application/pdf' }).kind === 'pdf');
check('office routes to the office reader', extract.extract(fixture('contract.docx'), { mimeType: DOCX }).kind === 'office');
check('plain text passes through', extract.extract(Buffer.from('hello'), { mimeType: 'text/plain' }).text === 'hello');
check('csv counts as text', extract.extract(Buffer.from('a,b'), { mimeType: 'text/csv' }).text === 'a,b');

const png = extract.extract(Buffer.from([0x89, 0x50]), { mimeType: 'image/png' });
check('an image is unsupported locally', png.text === null && png.kind === 'unsupported');
check('an image is flagged as worth sending to OCR', png.recoverable === true);

const zip = extract.extract(Buffer.from('x'), { mimeType: 'application/zip', filename: 'a.zip' });
check('an unrelated binary is neither read nor sent to OCR',
  zip.text === null && zip.recoverable === false, zip.reason);

check('supports() agrees with extract() on pdf', extract.supports('application/pdf', 'x.pdf'));
check('supports() agrees on office', extract.supports(XLSX, 'x.xlsx'));
check('supports() rejects images', !extract.supports('image/png', 'x.png'));

console.log(fail ? `\n${fail} FAILED` : '\ntext extraction correct');
process.exit(fail ? 1 : 0);
