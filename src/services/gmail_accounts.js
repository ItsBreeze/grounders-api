/**
 * Linked-mailbox store.
 *
 * One row per Gmail account the operator has connected. Refresh tokens are
 * encrypted at rest (crypto_box); access tokens are cached alongside and
 * refreshed lazily when within EXPIRY_SKEW_MS of expiry.
 */

const pool   = require('../db/pool');
const crypt  = require('./crypto_box');
const google = require('./google_oauth');

// Refresh a minute early so a token can't expire mid-request.
const EXPIRY_SKEW_MS = 60 * 1000;

async function upsertFromGrant({ ownerKey, email, googleSub, tokens }) {
  // Google omits refresh_token when re-consenting an already-granted app.
  // COALESCE keeps the stored one rather than nulling out working access.
  const { rows } = await pool.query(
    `INSERT INTO gmail_accounts
       (owner_key, email, google_sub, access_token_enc, refresh_token_enc, token_expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (owner_key, email) DO UPDATE SET
       google_sub        = EXCLUDED.google_sub,
       access_token_enc  = EXCLUDED.access_token_enc,
       refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, gmail_accounts.refresh_token_enc),
       token_expires_at  = EXCLUDED.token_expires_at,
       scopes            = EXCLUDED.scopes,
       updated_at        = NOW()
     RETURNING id, email, created_at, updated_at`,
    [
      ownerKey,
      email.toLowerCase(),
      googleSub || null,
      crypt.encrypt(tokens.access_token),
      tokens.refresh_token ? crypt.encrypt(tokens.refresh_token) : null,
      tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      tokens.scope || null,
    ],
  );

  return rows[0];
}

async function list(ownerKey) {
  const { rows } = await pool.query(
    `SELECT email, scopes, token_expires_at, created_at, updated_at,
            (refresh_token_enc IS NOT NULL) AS has_refresh_token
       FROM gmail_accounts
      WHERE owner_key = $1
      ORDER BY email`,
    [ownerKey],
  );
  return rows;
}

async function remove(ownerKey, email) {
  const { rows } = await pool.query(
    `DELETE FROM gmail_accounts
      WHERE owner_key = $1 AND email = $2
      RETURNING refresh_token_enc`,
    [ownerKey, email.toLowerCase()],
  );

  if (!rows.length) return false;

  if (rows[0].refresh_token_enc) {
    try { await google.revoke(crypt.decrypt(rows[0].refresh_token_enc)); } catch { /* already gone */ }
  }
  return true;
}

/**
 * Does this account's stored grant cover `product`?
 *
 * An account linked before a product's scope existed holds a token that Google
 * will reject with a bare 403 — unrecognisable from a real permission problem.
 * Checking the recorded scopes first turns that into "re-link this account".
 *
 * A row with no recorded scopes is treated as permitted: absence of a record
 * is not evidence of absence of the grant, and a false block is worse than
 * letting Google have the final say.
 */
function grantCovers(scopes, product) {
  const required = google.PRODUCT_SCOPES[product];
  if (!required || !scopes) return true;
  return scopes.split(/\s+/).includes(required);
}

/**
 * A usable access token for one mailbox, refreshing if needed.
 * Throws a caller-friendly error when the account isn't linked, the grant
 * has been revoked at Google's end, or it predates the product being asked for.
 */
async function accessTokenFor(ownerKey, email, product) {
  const { rows } = await pool.query(
    `SELECT id, access_token_enc, refresh_token_enc, token_expires_at, scopes
       FROM gmail_accounts
      WHERE owner_key = $1 AND email = $2`,
    [ownerKey, email.toLowerCase()],
  );

  if (!rows.length) throw new Error(`No linked account for ${email}. Link it first, then retry.`);

  const row     = rows[0];

  if (!grantCovers(row.scopes, product)) {
    throw new Error(
      `${email} was linked before ${product} access was added, so its grant does not cover it. ` +
      'Re-link it at /gmail/connect — nothing else about the account changes.',
    );
  }

  const expires = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;

  if (row.access_token_enc && expires - EXPIRY_SKEW_MS > Date.now()) {
    return crypt.decrypt(row.access_token_enc);
  }

  if (!row.refresh_token_enc) {
    throw new Error(`Access for ${email} expired and no refresh token is stored — re-link the account.`);
  }

  let fresh;
  try {
    fresh = await google.refreshAccessToken(crypt.decrypt(row.refresh_token_enc));
  } catch (err) {
    // invalid_grant means the user revoked us, changed password, or the app is
    // still in Testing and blew past the 7-day refresh-token window.
    throw new Error(`Could not refresh ${email}: ${err.message}. Re-link the account.`);
  }

  await pool.query(
    `UPDATE gmail_accounts
        SET access_token_enc = $1, token_expires_at = $2, updated_at = NOW()
      WHERE id = $3`,
    [
      crypt.encrypt(fresh.access_token),
      fresh.expires_in ? new Date(Date.now() + fresh.expires_in * 1000) : null,
      row.id,
    ],
  );

  return fresh.access_token;
}

/** Every linked address for an owner — the fan-out list for cross-account search. */
async function emailsFor(ownerKey) {
  const { rows } = await pool.query(
    'SELECT email FROM gmail_accounts WHERE owner_key = $1 ORDER BY email',
    [ownerKey],
  );
  return rows.map(r => r.email);
}

/**
 * Which products a stored grant covers, and which it does not.
 *
 * Google silently drops a requested scope when its API is not enabled on the
 * Cloud project, so "we asked for Drive" and "we have Drive" are different
 * facts. This reports the second one, which is the only one that matters.
 */
function productAccess(scopes) {
  const products = Object.keys(google.PRODUCT_SCOPES);
  return {
    granted: products.filter(p => scopes && grantCovers(scopes, p)),
    missing: scopes ? products.filter(p => !grantCovers(scopes, p)) : [],
    recorded: Boolean(scopes),
  };
}

module.exports = { upsertFromGrant, list, remove, accessTokenFor, emailsFor, productAccess, _internal: { grantCovers } };
