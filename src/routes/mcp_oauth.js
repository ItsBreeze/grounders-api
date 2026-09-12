/**
 * OAuth 2.1 endpoints for the MCP connector.
 *
 * The browser-facing part is deliberately plain HTML: this page is rendered
 * inside an OAuth popup by Claude, ChatGPT or Gemini, and anything that needs
 * a bundler is a liability there.
 *
 * Sign-in at the consent page is the app's own phone-code flow (same `otps`
 * table, same Twilio sender, same bcrypt). Connecting never creates an
 * account: there would be nothing to read, and it would let anyone mint
 * accounts through the OAuth flow.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const oauth = require('../services/mcp_oauth');
const authRoutes = require('./auth');
const { phoneFrom } = require('../utils/phone');

const router = express.Router();

const OTP_EXPIRY_MS = (parseInt(process.env.OTP_EXPIRY_MINUTES) || 10) * 60 * 1000;

// The consent pages post real HTML forms, which arrive urlencoded. The app's
// global json parser does not touch those, so without this every form submit
// lands with an empty body — and the whole OAuth flow dies at the first step.
router.use(express.urlencoded({ extended: false }));

// Never let the consent HTML be cached — a client (or the OAuth popup) serving
// a stale version is how a design change looks like it "didn't take".
router.use('/oauth/authorize', (req, res, next) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  next();
});

function baseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`)
    .replace(/\/$/, '');
}

// ─── Discovery ───────────────────────────────────────────────────────────────

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: [oauth.SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

/**
 * Tells a client which authorization server guards this resource. Newer
 * clients ask at the path-suffixed URL (…/oauth-protected-resource/mcp),
 * older ones at the root; both answer the same document.
 */
function protectedResource(req, res) {
  const base = baseUrl(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [oauth.SCOPE],
    bearer_methods_supported: ['header'],
  });
}
router.get('/.well-known/oauth-protected-resource', protectedResource);
router.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

// ─── Dynamic client registration ─────────────────────────────────────────────

// Open by necessity — Claude Desktop registers on every connect and has no
// fallback — so it is rate limited and the real protection is PKCE plus the
// user's explicit approval on the page below.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/oauth/register', registerLimiter, async (req, res, next) => {
  try {
    res.status(201).json(await oauth.registerClient(req.body || {}));
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: err.message });
    }
    next(err);
  }
});

// ─── Brand marks ─────────────────────────────────────────────────────────────
// The two apps' real icons, copied verbatim from their generators
// (grounders/tool/icon/generate.js → assets/icon/app_icon.svg and
// grounders-radio/assets/icon/generate.py → app_icon.svg) into src/assets.
// Both are the suite's reversed lockup: paper on the shared ink ground, with
// the O's face cut through to the ground. The page is painted that same ink,
// so here the 1024-canvas ground rect is stripped and the viewBox cropped to
// the glyph; the cut-through faces then read as holes in the page, which is
// the point of the construction. Regenerate the apps' icons and re-copy;
// never edit the SVGs here.
const ASSETS = path.join(__dirname, '..', 'assets');
const INK = '#1B1A17';

function mark(file, viewBox, cls) {
  return fs.readFileSync(path.join(ASSETS, file), 'utf8')
    .replace(/<\?xml[^>]*\?>\s*/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<rect width="1024" height="1024" fill="#1B1A17"\/>\s*/, '')
    .replace(/<svg[^>]*>/, `<svg class="${cls}" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`)
    .replace(/\s+/g, ' ');
}

// Grounders: the paper map tile spans 182–842 with a short soft shadow.
const GROUNDERS_MARK = mark('grounders-icon.svg', '156 160 712 720', 'mark');
// Radio: body 72–952 × 248–862 plus the antenna up to y=64.
const RADIO_MARK = mark('radio-icon.svg', '48 52 928 832', 'mark');

// Favicon: the two apps' O rings side by side — Grounders' pine, Radio's
// blue — each the construction their own favicons use.
const FAVICON = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512">
    <path d="M 256 59 a 197 197 0 1 0 0.001 0 z M 256 133 a 123 123 0 1 1 -0.001 0 z" fill="#3A7D44"/>
    <circle cx="256" cy="256" r="195" fill="none" stroke="${INK}" stroke-width="12"/>
    <circle cx="256" cy="256" r="125" fill="none" stroke="${INK}" stroke-width="12"/>
    <path fill="#2E7BFF" fill-rule="evenodd" d="M 768 56 a 200 200 0 1 0 0.001 0 z M 768 136 a 120 120 0 1 1 -0.001 0 z"/>
    <circle cx="768" cy="256" r="200" fill="none" stroke="${INK}" stroke-width="12"/>
    <circle cx="768" cy="256" r="120" fill="none" stroke="${INK}" stroke-width="12"/>
  </svg>`, 'utf8',
).toString('base64');

// ─── Authorization ───────────────────────────────────────────────────────────

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Grounders + Radio</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${FAVICON}">
<style>
  /* The suite's reversed lockup: paper on ink (offhand/BRAND.md). Pine is
     Grounders' accent, blue is Radio's; each colours the "o" in its name,
     the way both apps' own wordmarks do. */
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:${INK}; color:#F5F1EA; font:16px/1.55 -apple-system,system-ui,sans-serif;
         padding:20px; box-sizing:border-box; }
  .wrap { width:100%; max-width:380px; }
  .brand { display:flex; align-items:center; gap:14px; margin:0 4px 18px; }
  .brand .mark { height:44px; width:auto; display:block; flex:0 0 auto; }
  .brand .word { font-weight:700; font-size:21px; letter-spacing:-.01em; white-space:nowrap;
                 margin-left:4px; }
  .brand .word .plus { color:#9B948A; font-weight:500; margin:0 .18em; }
  .brand .word .g { color:#4FA35E; font-style:normal; }
  .brand .word .b { color:#2E7BFF; font-style:normal; }
  .card { padding:30px 28px; background:#26241F; border:1px solid #3A3730; border-radius:16px; }
  .row { display:flex; gap:10px; align-items:stretch; margin-bottom:14px; }
  .row input { margin-bottom:0; flex:1 1 auto; min-width:0; }
  select { box-sizing:border-box; flex:0 0 64px; width:64px; background:${INK};
           border:1px solid #3A3730; border-radius:10px; padding:13px 4px;
           color:#F5F1EA; font-size:16px; text-align:center; text-align-last:center;
           -webkit-appearance:none; -moz-appearance:none; appearance:none; }
  select:focus { outline:none; border-color:#4FA35E; }
  h1 { font-size:22px; margin:0 0 8px; }
  p { color:#9B948A; margin:0 0 22px; }
  label { display:block; font-size:13px; color:#9B948A; margin-bottom:6px; }
  input { width:100%; box-sizing:border-box; background:${INK}; border:1px solid #3A3730;
          border-radius:10px; padding:13px 14px; color:#F5F1EA; font-size:16px; margin-bottom:14px; }
  input:focus { outline:none; border-color:#4FA35E; }
  button { width:100%; background:#3A7D44; border:0; border-radius:10px; padding:14px;
           color:#fff; font-size:16px; font-weight:600; cursor:pointer; }
  button:active { background:#2C6B3A; }
  .err { background:#3A1F22; color:#F5B5AE; border-radius:8px;
         padding:10px 12px; font-size:14px; margin-bottom:16px; }
  .grant { background:#1F2E22; border:1px solid #2C4A32; border-radius:10px;
           padding:14px; font-size:14px; color:#CFE6D3; margin-bottom:20px; }
  .grant strong { color:#F5F1EA; font-weight:600; }
  strong { color:#F5F1EA; }
</style></head><body><div class="wrap">
  <div class="brand">
    ${GROUNDERS_MARK}
    ${RADIO_MARK}
    <span class="word">Gr<i class="g">o</i>unders<span class="plus">+</span>Radi<i class="b">o</i></span>
  </div>
  <div class="card">
  ${body}
  </div>
</div>
<script>
(function () {
  // No submit button: the phone auto-sends once the full number is in, and the
  // code auto-submits at six digits. Fix a mistake by backspacing before the
  // last digit. Also focuses the field so you can just start typing.
  var LEN = { '+1':10,'+44':10,'+61':9,'+64':9,'+353':9,'+91':10,'+49':11,'+33':9,
    '+34':9,'+39':10,'+31':9,'+46':9,'+47':8,'+45':8,'+41':9,'+32':9,'+351':9,
    '+52':10,'+55':11,'+81':10,'+82':10,'+65':8,'+852':8,'+971':9,'+27':9,
    '+234':10,'+254':9,'+63':10 };
  var submit = function (f) { try { f.requestSubmit ? f.requestSubmit() : f.submit(); } catch (e) { f.submit(); } };
  var phone = document.getElementById('phone');
  if (phone) {
    var cc = phone.form.querySelector('select[name=cc]');
    phone.focus();
    phone.addEventListener('input', function () {
      var digits = phone.value.replace(/\\D/g, '');
      var need = (cc && LEN[cc.value]) || 10;
      if (digits.length >= need) submit(phone.form);
    });
  }
  var code = document.getElementById('code');
  if (code) {
    code.focus();
    code.addEventListener('input', function () {
      if (code.value.replace(/\\D/g, '').length >= 6) submit(code.form);
    });
  }
})();
</script>
</body></html>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const hidden = (params) => Object.entries(params)
  .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v ?? '')}">`)
  .join('');

// Country dialing codes for the connect form's picker, +1 default. Kept short —
// the common ones — rather than an exhaustive ISO list.
const COUNTRY_CODES = [
  ['+1', 'US / Canada'], ['+44', 'UK'], ['+61', 'Australia'], ['+64', 'New Zealand'],
  ['+353', 'Ireland'], ['+91', 'India'], ['+49', 'Germany'], ['+33', 'France'],
  ['+34', 'Spain'], ['+39', 'Italy'], ['+31', 'Netherlands'], ['+46', 'Sweden'],
  ['+47', 'Norway'], ['+45', 'Denmark'], ['+41', 'Switzerland'], ['+32', 'Belgium'],
  ['+351', 'Portugal'], ['+52', 'Mexico'], ['+55', 'Brazil'], ['+81', 'Japan'],
  ['+82', 'South Korea'], ['+65', 'Singapore'], ['+852', 'Hong Kong'], ['+971', 'UAE'],
  ['+27', 'South Africa'], ['+234', 'Nigeria'], ['+254', 'Kenya'], ['+63', 'Philippines'],
];
const countryOptions = COUNTRY_CODES
  .map(([code, name]) => `<option value="${code}" title="${name}"${code === '+1' ? ' selected' : ''}>${code}</option>`)
  .join('');

/** Everything the flow has to carry across the two form posts. */
function flowParams(src) {
  return {
    client_id: src.client_id,
    redirect_uri: src.redirect_uri,
    state: src.state,
    code_challenge: src.code_challenge,
    code_challenge_method: src.code_challenge_method || 'S256',
  };
}

const GRANT_TEXT = (name) => `
  <div class="grant">
    <strong>${escapeHtml(name)}</strong> will be able to read your Grounders posts
    (photos, videos, captions, where and when), your friends list, and your
    Radio workspaces — messages and shared files. It is read-only: it cannot
    post, message, react, add friends or delete anything. It never hears a
    voice note — it reads the text of one only where a transcript has been
    made, and never the audio — and it never sees your phone number or
    anyone else's.
  </div>`;

router.get('/oauth/authorize', async (req, res, next) => {
  try {
    const p = flowParams(req.query);
    const client = await oauth.getClient(p.client_id);

    // A bad client or redirect must render an error here, never redirect —
    // redirecting to an unverified URI is the open-redirect bug itself.
    if (!client) return res.status(400).send(page('Error', '<h1>Unknown app</h1><p>That application is not registered.</p>'));
    if (!oauth.redirectAllowed(client, p.redirect_uri)) {
      return res.status(400).send(page('Error', '<h1>Bad redirect</h1><p>That redirect address is not registered for this app.</p>'));
    }
    if (!p.code_challenge) {
      return res.status(400).send(page('Error', '<h1>Missing PKCE</h1><p>This server requires a code challenge.</p>'));
    }

    res.send(page('Connect', `
      <h1>Connect your Grounders</h1>
      <p><strong>${escapeHtml(client.client_name || 'An app')}</strong> wants to read your Grounders posts, friends and Radio messages.</p>
      <form method="post" action="/oauth/authorize/code">
        ${hidden(p)}
        <label for="phone">The phone number you sign in with</label>
        <div class="row">
          <select name="cc" aria-label="Country code">${countryOptions}</select>
          <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel-national"
                 placeholder="780 555 0123" required autofocus>
        </div>
        <button type="submit" style="display:none" aria-hidden="true"></button>
      </form>`));
  } catch (err) { next(err); }
});

// Same budget as the app's own verify step: sending codes costs SMS money and
// guessing them is what the limit is for.
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

router.post('/oauth/authorize/code', otpLimiter, async (req, res, next) => {
  try {
    const p = flowParams(req.body);
    const client = await oauth.getClient(p.client_id);
    if (!client || !oauth.redirectAllowed(client, p.redirect_uri)) {
      return res.status(400).send(page('Error', '<h1>Bad request</h1>'));
    }

    // The connect form posts a country code + local number; combine them. (A
    // retry from the approve step still posts a full `phone`.)
    const phone = phoneFrom(req.body.cc ? `${req.body.cc}${req.body.phone || ''}` : req.body.phone);
    if (!phone) return res.status(400).send(page('Error', '<h1>Enter your phone number</h1>'));

    // Exactly the app's request-otp path: retire any live code for this
    // number, store a bcrypt hash of the new one, text it.
    const code = authRoutes.generateOtp();
    const hash = await bcrypt.hash(code, 10);
    await pool.query(`UPDATE otps SET used = true WHERE target = $1 AND used = false`, [phone]);
    await pool.query(
      `INSERT INTO otps (id, target, code_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [uuid(), phone, hash, new Date(Date.now() + OTP_EXPIRY_MS)],
    );
    await authRoutes.sendSms(phone, code, 'Grounders');

    res.send(page('Enter code', `
      <h1>Check your phone</h1>
      <p>We texted a six-digit code to ${escapeHtml(phone)}.
      ${!authRoutes.smsEnabled() ? `<br><br>Dev code: <strong>${code}</strong>` : ''}</p>
      <form method="post" action="/oauth/authorize/approve">
        ${hidden({ ...p, phone })}
        ${GRANT_TEXT(client.client_name || 'This app')}
        <label for="code">Six-digit code</label>
        <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus>
        <button type="submit" style="display:none" aria-hidden="true"></button>
      </form>`));
  } catch (err) { next(err); }
});

router.post('/oauth/authorize/approve', otpLimiter, async (req, res, next) => {
  try {
    const p = flowParams(req.body);
    const client = await oauth.getClient(p.client_id);
    if (!client || !oauth.redirectAllowed(client, p.redirect_uri)) {
      return res.status(400).send(page('Error', '<h1>Bad request</h1>'));
    }

    const phone = phoneFrom(req.body.phone);
    if (!phone) return res.status(400).send(page('Error', '<h1>Bad request</h1>'));

    const { rows: otpRows } = await pool.query(
      `SELECT id, code_hash FROM otps
        WHERE target = $1 AND used = false AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1`,
      [phone],
    );
    const typed = String(req.body.code || '').replace(/\D/g, '');
    const valid = otpRows[0] && typed.length === 6 && await bcrypt.compare(typed, otpRows[0].code_hash);

    if (!valid) {
      return res.status(401).send(page('Connect', `
        <h1>Check your phone</h1>
        <div class="err">That code was wrong or has expired.</div>
        <form method="post" action="/oauth/authorize/approve">
          ${hidden({ ...p, phone })}
          <label for="code">Six-digit code</label>
          <input id="code" name="code" inputmode="numeric" required autofocus>
          <button type="submit" style="display:none" aria-hidden="true"></button>
        </form>`));
    }

    await pool.query('UPDATE otps SET used = true WHERE id = $1', [otpRows[0].id]);

    // Match the way the app does (digits only, so formatting never matters),
    // and never create an account here.
    const { rows: users } = await pool.query(
      `SELECT id, deletion_pending_at FROM users
        WHERE regexp_replace(phone, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g')
        LIMIT 1`,
      [phone],
    );
    const user = users[0];
    if (!user) {
      return res.status(404).send(page('No account', `
        <h1>Nothing here yet</h1>
        <p>There is no Grounders or Radio account for ${escapeHtml(phone)}.
        Sign in to one of the apps first, then connect.</p>`));
    }
    // Signing in to the app cancels a pending deletion; connecting from a
    // third-party assistant should not quietly do the same.
    if (user.deletion_pending_at) {
      return res.status(403).send(page('Account closing', `
        <h1>This account is closing</h1>
        <p>Deletion is pending for ${escapeHtml(phone)}. Sign in to the app to
        keep the account, then come back and connect.</p>
        <div class="grant">Nothing has been shared with
        <strong>${escapeHtml(client.client_name || 'this app')}</strong>.</div>`));
    }

    const code = await oauth.issueCode({
      clientId: p.client_id,
      userId: user.id,
      redirectUri: p.redirect_uri,
      codeChallenge: p.code_challenge,
      method: p.code_challenge_method,
    });

    const to = new URL(p.redirect_uri);
    to.searchParams.set('code', code);
    if (p.state) to.searchParams.set('state', p.state);
    res.redirect(to.toString());
  } catch (err) { next(err); }
});

// ─── Token ───────────────────────────────────────────────────────────────────

router.post('/oauth/token', async (req, res) => {
  const body = req.body || {};
  const fail = (code, description) =>
    res.status(400).json({ error: code, error_description: description });

  try {
    if (body.grant_type === 'authorization_code') {
      return res.json(await oauth.redeemCode({
        code: body.code,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
      }));
    }
    if (body.grant_type === 'refresh_token') {
      return res.json(await oauth.refresh({
        refreshToken: body.refresh_token,
        clientId: body.client_id,
      }));
    }
    return fail('unsupported_grant_type', 'Use authorization_code or refresh_token');
  } catch (err) {
    if (err.status === 400) return fail('invalid_grant', 'That grant is not valid');
    console.error('token endpoint:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
