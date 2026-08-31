/**
 * Account linking flow — run once per Google account, in a browser.
 *
 * Gated by the same operator password as the connector: anyone who could reach
 * /gmail/connect unprotected could attach their own mailbox to this server, or
 * read which addresses are linked.
 */

const express  = require('express');
const jwt      = require('jsonwebtoken');
const google   = require('../services/google_oauth');
const accounts = require('../services/gmail_accounts');
const oauth    = require('../services/mcp_oauth');

const router = express.Router();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (title, inner) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 -apple-system, system-ui, sans-serif; margin: 0;
         display: grid; place-items: center; min-height: 100dvh; padding: 24px; }
  .card { width: 100%; max-width: 420px; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; opacity: .75; font-size: .95rem; }
  input[type=password], input[type=email] { width: 100%; padding: .8rem; font-size: 1rem;
    box-sizing: border-box; border: 1px solid rgba(128,128,128,.5); border-radius: 10px;
    background: transparent; color: inherit; margin-bottom: .6rem; }
  button, .btn { display: block; width: 100%; box-sizing: border-box; text-align: center;
    padding: .85rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: 10px;
    background: #2563eb; color: #fff; text-decoration: none; margin-top: .5rem; }
  ul { padding-left: 1.1rem; } li { margin: .3rem 0; }
  code { background: rgba(128,128,128,.15); padding: .15rem .35rem; border-radius: 5px; font-size: .9em; }
  .err { color: #dc2626; font-size: .9rem; margin-bottom: .6rem; }
  .ok { color: #16a34a; font-weight: 600; }
</style></head>
<body><div class="card">${inner}</div></body></html>`;

/** The exact redirect URI this deployment sends — a public value, safe to show. */
function redirectUriInUse() {
  try { return google.config().redirectUri; } catch { return '(unavailable — check PUBLIC_BASE_URL)'; }
}

const passwordForm = (error) => page('Link a Google account', `
  <h1>Link a Google account</h1>
  <p>Sign in with the operator password, then pick which Google account to link.
     Repeat this once per account.</p>
  <p>Linking grants this server <strong>Gmail</strong> (read, send, label, archive, trash —
     never permanent delete), <strong>Calendar</strong> and <strong>Tasks</strong> (read and write),
     <strong>Drive</strong> (read, create, edit, share, trash) and <strong>Contacts</strong>
     (read only), for that account.</p>
  <p>An account linked before a product was added holds an older grant. Linking it
     again here adds the missing access and changes nothing else.</p>
  <p>This server will send Google the redirect URI below. It must appear
     <em>character for character</em> in your OAuth client's authorized redirect
     URIs, or consent fails with <code>redirect_uri_mismatch</code>.</p>
  <p><code>${escapeHtml(redirectUriInUse())}</code></p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  <form method="POST" action="/gmail/connect">
    <input type="password" name="password" placeholder="Operator password" autofocus required autocomplete="current-password">
    <input type="email" name="login_hint" placeholder="Account to link (optional)" autocomplete="off">
    <button type="submit">Continue to Google</button>
  </form>`);

router.get('/connect', (req, res) => res.type('html').send(passwordForm(null)));

router.post('/connect', express.urlencoded({ extended: false }), (req, res, next) => {
  try {
    if (!oauth.checkAdminPassword(req.body?.password)) {
      return res.status(401).type('html').send(passwordForm('Incorrect password.'));
    }

    // Short-lived signed state — CSRF protection for the callback.
    const state = jwt.sign({ purpose: 'gmail_link' }, process.env.JWT_SECRET, { expiresIn: '10m' });

    res.redirect(302, google.authUrl({ state, loginHint: req.body?.login_hint || undefined }));
  } catch (err) {
    next(err);
  }
});

/**
 * Credential self-check — verifies GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 * against Google without running a full consent round-trip. Password-gated
 * because it reports on configuration.
 */
const checkForm = (error) => page('Check credentials', `
  <h1>Check Google credentials</h1>
  <p>Verifies the client ID and secret against Google without linking anything.</p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  <form method="POST" action="/gmail/check">
    <input type="password" name="password" placeholder="Operator password" autofocus required autocomplete="current-password">
    <button type="submit">Run check</button>
  </form>`);

router.get('/check', (req, res) => res.type('html').send(checkForm(null)));

router.post('/check', express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    if (!oauth.checkAdminPassword(req.body?.password)) {
      return res.status(401).type('html').send(checkForm('Incorrect password.'));
    }

    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const secret   = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const result   = await google.verifyCredentials();

    // Shape checks catch the common paste mistakes before Google even matters.
    const notes = [];
    if (!clientId.endsWith('.apps.googleusercontent.com')) {
      notes.push('GOOGLE_CLIENT_ID does not end in .apps.googleusercontent.com — wrong value or a pasted "KEY=" prefix.');
    }
    if (!secret.startsWith('GOCSPX-')) {
      notes.push('GOOGLE_CLIENT_SECRET does not start with GOCSPX- — wrong value or a pasted "KEY=" prefix.');
    }
    if (/^GOOGLE_CLIENT_(ID|SECRET)=/.test(clientId) || /^GOOGLE_CLIENT_(ID|SECRET)=/.test(secret)) {
      notes.push('A variable still contains its own name — store only the value.');
    }

    res.type('html').send(page('Credential check', `
      <h1>${result.ok ? '<span class="ok">✓</span> Credentials accepted' : 'Credentials rejected'}</h1>
      <p>${escapeHtml(result.detail)}</p>
      ${result.culprit ? `<p class="err">Fix <code>${escapeHtml(result.culprit)}</code> in your host's environment.</p>` : ''}
      ${notes.length ? `<ul>${notes.map(n => `<li class="err">${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
      <p>Client ID: <code>${escapeHtml(clientId || '(unset)')}</code></p>
      <p>Secret: <code>${secret ? `${secret.length} chars, starts "${escapeHtml(secret.slice(0, 7))}…"` : '(unset)'}</code></p>
      <p>Redirect URI: <code>${escapeHtml(redirectUriInUse())}</code></p>
      <a class="btn" href="/gmail/connect">Back to linking</a>`));
  } catch (err) {
    next(err);
  }
});

router.get('/oauth/callback', async (req, res, next) => {
  try {
    if (req.query.error) {
      return res.status(400).type('html').send(page('Link failed', `
        <h1>Google declined</h1>
        <p>${escapeHtml(req.query.error_description || req.query.error)}</p>
        <a class="btn" href="/gmail/connect">Try again</a>`));
    }

    try {
      jwt.verify(req.query.state || '', process.env.JWT_SECRET);
    } catch {
      return res.status(400).type('html').send(page('Link failed', `
        <h1>Expired or invalid link attempt</h1>
        <p>Start again — the request must be completed within 10 minutes.</p>
        <a class="btn" href="/gmail/connect">Start over</a>`));
    }

    const tokens = await google.exchangeCode(req.query.code);
    const info   = await google.fetchUserinfo(tokens.access_token);

    if (!info.email) throw new Error('Google did not return an email address for this account');

    await accounts.upsertFromGrant({
      ownerKey:  oauth.OWNER_KEY,
      email:     info.email,
      googleSub: info.sub,
      tokens,
    });

    const linked = await accounts.list(oauth.OWNER_KEY);
    const warning = tokens.refresh_token
      ? ''
      : '<p class="err">Google returned no refresh token. If access stops working, unlink and re-link this account.</p>';

    // What Google actually granted, not what was asked for: it drops scopes for
    // APIs that are not enabled on the Cloud project, and does so silently.
    const access  = accounts.productAccess(tokens.scope);
    const missing = access.missing.length
      ? `<p class="err">Google did not grant: <strong>${escapeHtml(access.missing.join(', '))}</strong>.
         That almost always means those APIs are not enabled on the Google Cloud project.
         Enable them under APIs &amp; Services → Library, then link this account again.</p>`
      : '<p>All five products granted.</p>';

    res.type('html').send(page('Linked', `
      <h1><span class="ok">✓</span> ${escapeHtml(info.email)} linked</h1>
      ${warning}
      <p>Access granted: <code>${escapeHtml(access.granted.join(', ') || 'none')}</code></p>
      ${missing}
      <p>Accounts now connected (${linked.length}):</p>
      <ul>${linked.map(a => `<li><code>${escapeHtml(a.email)}</code></li>`).join('')}</ul>
      <a class="btn" href="/gmail/connect">Link another account</a>`));
  } catch (err) {
    next(err);
  }
});

/** Linked-account list for the operator; the MCP tool covers the model's needs. */
router.post('/accounts', express.urlencoded({ extended: false }), express.json(), async (req, res, next) => {
  try {
    if (!oauth.checkAdminPassword(req.body?.password)) return res.status(401).json({ error: 'unauthorized' });
    res.json({ accounts: await accounts.list(oauth.OWNER_KEY) });
  } catch (err) { next(err); }
});

router.post('/unlink', express.urlencoded({ extended: false }), express.json(), async (req, res, next) => {
  try {
    if (!oauth.checkAdminPassword(req.body?.password)) return res.status(401).json({ error: 'unauthorized' });
    if (!req.body?.email) return res.status(400).json({ error: 'email is required' });

    const removed = await accounts.remove(oauth.OWNER_KEY, req.body.email);
    res.status(removed ? 200 : 404).json({ removed, email: req.body.email });
  } catch (err) { next(err); }
});

module.exports = router;
