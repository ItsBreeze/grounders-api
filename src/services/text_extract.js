/**
 * One entry point for "turn these bytes into text a model can read".
 *
 * Used by both Drive and Gmail, so a PDF reads the same whether it is a file in
 * Drive or an attachment on a message.
 *
 * Everything here is local and side-effect free. What it cannot do — scans,
 * images, and PDFs whose fonts encode glyph numbers rather than characters — it
 * refuses in a way the caller can act on, rather than returning plausible
 * nonsense. Drive's own conversion handles those, and costs a temporary file.
 */

const office = require('./office_text');
const pdf    = require('./pdf_text');

const isPdf = (mimeType, filename) =>
  mimeType === 'application/pdf' || /\.pdf$/i.test(String(filename || ''));

const TEXT_LIKE = /^text\/|[/+](json|csv|xml|javascript|yaml)$|^application\/(json|xml|csv|x-sh|x-yaml)/;

/** Does this look like something extract() can turn into text? */
function supports(mimeType, filename) {
  return isPdf(mimeType, filename)
    || office.supports(mimeType, filename)
    || TEXT_LIKE.test(String(mimeType || ''));
}

/**
 * Text from a document, or a reason it could not be read.
 *
 * Returns { text, kind, … } on success and { text: null, reason, recoverable }
 * on failure. `recoverable` marks the failures Drive's OCR can still fix, so a
 * caller knows whether suggesting it is worth the temporary file.
 */
function extract(buffer, { mimeType, filename } = {}) {
  if (isPdf(mimeType, filename)) {
    const result = pdf.extract(buffer);
    return result.text === null
      ? { text: null, kind: 'pdf', reason: result.reason, recoverable: true }
      : { text: result.text, kind: 'pdf', pages: result.pages, readability: result.readability };
  }

  if (office.supports(mimeType, filename)) {
    try {
      return { text: office.extract(buffer, { mimeType, filename }), kind: 'office' };
    } catch (err) {
      return { text: null, kind: 'office', reason: err.message, recoverable: false };
    }
  }

  if (TEXT_LIKE.test(String(mimeType || ''))) {
    return { text: buffer.toString('utf8'), kind: 'text' };
  }

  return {
    text: null,
    kind: 'unsupported',
    reason: `${mimeType || 'This file'} is not a text, Office or PDF format.`,
    // Google converts images too, so OCR is worth offering for them.
    recoverable: /^image\//.test(String(mimeType || '')),
  };
}

module.exports = { extract, supports, _internal: { isPdf, TEXT_LIKE } };
