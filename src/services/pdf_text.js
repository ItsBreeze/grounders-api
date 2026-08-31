/**
 * Text out of a PDF's text layer, without a dependency.
 *
 * A PDF is a set of objects; the ones that matter here are content streams,
 * usually Flate-compressed, holding drawing operators. Text arrives through a
 * handful of them — Tj, TJ, ' and " — and position operators imply the line
 * breaks, since a PDF has no concept of a line of text.
 *
 * What this deliberately does NOT do is pretend to always succeed. Two common
 * PDFs have no text to extract: a scan, which is an image of a page, and one
 * using CID-keyed fonts, where the bytes are glyph indexes needing a font's own
 * CMap to become characters. Both would yield confident-looking nonsense, so
 * the result is scored and refused rather than returned as text.
 */

const zlib = require('zlib');

/** Turn a PDF literal string's escapes into the bytes they stand for. */
function decodeLiteral(body) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { out.push(body.charCodeAt(i)); continue; }

    const next = body[++i];
    if (next === undefined) break;

    if (next >= '0' && next <= '7') {
      // Octal escape, one to three digits.
      let digits = next;
      while (digits.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') digits += body[++i];
      out.push(parseInt(digits, 8));
      continue;
    }

    // A backslash before a newline is a line continuation, not a character.
    if (next === '\n') continue;
    if (next === '\r') { if (body[i + 1] === '\n') i++; continue; }

    const simple = { n: 10, r: 13, t: 9, b: 8, f: 12 }[next];
    out.push(simple !== undefined ? simple : next.charCodeAt(0));
  }
  return Buffer.from(out).toString('latin1');
}

const decodeHex = (body) => {
  const hex = body.replace(/[^0-9A-Fa-f]/g, '');
  const even = hex.length % 2 ? `${hex}0` : hex;
  return Buffer.from(even, 'hex').toString('latin1');
};

/**
 * Read the text-showing operators out of one content stream.
 *
 * TJ arrays interleave strings with kerning numbers; a large negative kern is
 * how PDFs render a space, so anything past the threshold becomes one.
 */
function readContentStream(content) {
  const out = [];

  const token = /(\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]*>)\s*(Tj|'|")|\[((?:\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]*>|[^\][])*)\]\s*TJ|(T\*|\bTd\b|\bTD\b|\bET\b)/g;

  let match;
  while ((match = token.exec(content))) {
    const [, single, operator, array, positioning] = match;

    if (single) {
      // ' and " both start a new line before showing their string.
      if (operator === "'" || operator === '"') out.push('\n');
      out.push(single[0] === '(' ? decodeLiteral(single.slice(1, -1)) : decodeHex(single.slice(1, -1)));
      continue;
    }

    if (array !== undefined) {
      const parts = array.matchAll(/\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]*>|(-?\d+(?:\.\d+)?)/g);
      for (const [piece, number] of parts) {
        if (number !== undefined) { if (Number(number) < -100) out.push(' '); continue; }
        out.push(piece[0] === '(' ? decodeLiteral(piece.slice(1, -1)) : decodeHex(piece.slice(1, -1)));
      }
      continue;
    }

    if (positioning) out.push('\n');
  }

  return out.join('');
}

/** ASCII85, as PDFs write it: five characters per four bytes, "z" for four zeros. */
function decodeAscii85(input) {
  const body = input.replace(/^<~/, '').replace(/~>[\s\S]*$/, '').replace(/\s+/g, '');
  const out   = [];
  let group  = [];

  for (const ch of body) {
    if (ch === 'z' && !group.length) { out.push(0, 0, 0, 0); continue; }
    if (ch < '!' || ch > 'u') continue;

    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group = [];
    }
  }

  // A trailing partial group encodes one fewer byte than it has characters.
  if (group.length > 1) {
    const short = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...bytes.slice(0, short - 1));
  }

  return Buffer.from(out);
}

const decodeAsciiHex = (input) => {
  const hex = input.replace(/>[\s\S]*$/, '').replace(/[^0-9A-Fa-f]/g, '');
  return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
};

/**
 * Run a stream through its /Filter chain, in order.
 *
 * Filters compose — `/Filter [ /ASCII85Decode /FlateDecode ]` is common, and
 * treating it as "contains FlateDecode" hands zlib base-85 text and loses the
 * stream. Returns null when the chain includes something unsupported, which
 * for a content stream almost always means it is an image.
 */
function applyFilters(data, dict) {
  const declared = (dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/) || [])[1];
  if (!declared) return data;

  for (const [, name] of declared.matchAll(/\/(\w+)/g)) {
    if (name === 'FlateDecode') {
      try { data = zlib.inflateSync(data); }
      catch {
        // Truncated or wrongly-lengthed streams are common; salvage what inflates.
        try { data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
        catch { return null; }
      }
    } else if (name === 'ASCII85Decode') {
      data = decodeAscii85(data.toString('latin1'));
    } else if (name === 'ASCIIHexDecode') {
      data = decodeAsciiHex(data.toString('latin1'));
    } else {
      return null; // DCTDecode, JPXDecode, LZWDecode, CCITTFax — not text.
    }
  }

  return data;
}

/**
 * Every stream in the file, inflated where it is Flate-compressed.
 *
 * Streams are found by their `stream` keyword and their dictionary read
 * backwards from there, rather than by matching `<< … >> stream` forwards: a
 * page dictionary nests `/Resources << … >>` inside itself, so a forward match
 * spans several objects and picks up whichever /Length it meets first.
 */
function contentStreams(buffer) {
  const raw     = buffer.toString('latin1');
  const streams = [];
  const keyword = /\bstream\r?\n/g;

  let match;
  while ((match = keyword.exec(raw))) {
    const start = match.index + match[0].length;

    // The dictionary is whatever sits between this object's header and here.
    const objectAt = raw.lastIndexOf(' obj', match.index);
    const dict     = raw.slice(objectAt > 0 && match.index - objectAt < 4000 ? objectAt : Math.max(0, match.index - 4000), match.index);

    // /Length counts only when it is a direct integer; "/Length 12 0 R" points
    // at another object this reader does not resolve.
    const declared = (dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/) || [])[1];
    const fallback = raw.indexOf('endstream', start);
    const end      = declared ? start + Number(declared) : fallback;

    if (end <= start || end > buffer.length) continue;

    const data = applyFilters(buffer.subarray(start, end), dict);
    if (!data) continue;

    streams.push(data.toString('latin1'));
    keyword.lastIndex = Math.max(keyword.lastIndex, end);
  }

  return streams;
}

/**
 * How much of this looks like language rather than glyph indexes.
 *
 * Text from a CID-keyed font decoded as bytes is mostly NULs and control
 * characters; real prose is overwhelmingly printable.
 */
function readability(text) {
  if (!text.length) return 0;
  const printable = (text.match(/[\x20-\x7E\n\r\t -ɏͰ-￿]/g) || []).length;
  return printable / text.length;
}

const clean = (text) => text
  .replace(/\r\n?/g, '\n')
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const MIN_READABILITY = 0.85;
const MIN_LETTERS     = 16;

/**
 * Text from a PDF, or a refusal saying which kind of PDF defeated it.
 *
 * Returns { text } on success, or { text: null, reason } — never a plausible
 * string built from glyph indexes, because a caller cannot tell that apart from
 * a genuinely odd document.
 */
function extract(buffer) {
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { text: null, reason: 'Not a PDF — the file does not start with %PDF-.' };
  }

  const streams = contentStreams(buffer);
  if (!streams.length) {
    return { text: null, reason: 'No readable content streams — the PDF may use an unsupported filter or encryption.' };
  }

  const pages = streams
    .filter(stream => /\bBT\b[\s\S]*?\bET\b/.test(stream))
    .map(readContentStream)
    .filter(Boolean);

  if (!pages.length) {
    return {
      text: null,
      reason: 'No text layer — this is very likely a scan or an image-only PDF. ' +
              'Pass ocr: true to convert it through Google Drive, which runs OCR.',
    };
  }

  const joined = pages.join('\n\n');
  const score  = readability(joined);
  const letters = (joined.match(/[A-Za-zÀ-￿]/g) || []).length;

  if (score < MIN_READABILITY || letters < MIN_LETTERS) {
    return {
      text: null,
      reason: 'The text layer did not decode to readable characters — this usually means CID-keyed ' +
              'or subset fonts, whose bytes are glyph numbers rather than letters. ' +
              'Pass ocr: true to convert it through Google Drive instead.',
      readability: Number(score.toFixed(2)),
    };
  }

  return { text: clean(joined), pages: pages.length, readability: Number(score.toFixed(2)) };
}

module.exports = { extract, _internal: { decodeLiteral, decodeHex, readContentStream, contentStreams, readability, clean, decodeAscii85, decodeAsciiHex, applyFilters } };
