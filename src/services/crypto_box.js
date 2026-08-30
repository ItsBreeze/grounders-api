/**
 * Authenticated encryption for OAuth tokens at rest.
 *
 * AES-256-GCM. Ciphertexts are self-describing strings:
 *   v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>
 * The version prefix lets us rotate the algorithm later without a
 * migration — decrypt() dispatches on it.
 *
 * TOKEN_ENC_KEY must be 32 bytes, supplied as base64 or hex. Generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

const crypto = require('crypto');

let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;

  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error('TOKEN_ENC_KEY is not set — refusing to handle mailbox tokens');
  }

  // Accept either encoding; length after decode is what matters.
  let buf = /^[0-9a-fA-F]{64}$/.test(raw.trim())
    ? Buffer.from(raw.trim(), 'hex')
    : Buffer.from(raw.trim(), 'base64');

  if (buf.length !== 32) {
    throw new Error(`TOKEN_ENC_KEY must decode to 32 bytes, got ${buf.length}`);
  }

  cachedKey = buf;
  return cachedKey;
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;

  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct     = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();

  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

function decrypt(packed) {
  if (packed === null || packed === undefined) return null;

  const [version, ivB64, tagB64, ctB64] = String(packed).split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) {
    throw new Error('Malformed ciphertext');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** True when a usable key is configured — lets routes fail loudly at boot instead of mid-request. */
function isConfigured() {
  try { key(); return true; } catch { return false; }
}

module.exports = { encrypt, decrypt, isConfigured };
