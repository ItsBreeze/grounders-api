# Project log — Google Multi-Account Connector

Why this exists in the shape it does. The reasoning behind a decision is the
part that does not survive in a diff, and it is what you need when changing that
decision later.

Chronological. Each entry is the problem, what was decided, and why the
alternative was rejected.

---

## 1 — The reason for building it at all

Claude's first-party Google connectors hold **exactly one account each**.
Linking a second replaces the first. Anyone with a personal address and a work
address therefore cannot ask a question that spans both, and the workaround —
relinking, asking, relinking back — is worse than not asking.

This server holds as many accounts as you link, and every search tool fans out
across all of them in one call and merges the results by date. That single
property is the justification for the whole thing; everything else follows from
it.

**Kept deliberately self-contained.** Four tables with no foreign keys into the
Grounders schema, its own env vars, its own route prefixes. Deleting the routes
and the migration block removes it entirely, and without its env vars its routes
answer `503` while the rest of the API runs unaffected. It shares a deployment
with the Grounders API for convenience, not by dependency.

## 2 — Security decisions made early, because they are hard to reverse

- **Tokens are AES-256-GCM encrypted at rest** under `TOKEN_ENC_KEY`. The
  database never holds a usable Google token.
- **MCP tokens are signed with a key derived from `JWT_SECRET` by HMAC, not with
  `JWT_SECRET` itself.** This is not paranoia: `middleware/auth.js` verifies
  user tokens with no audience check, so sharing the key would have made every
  connector token a valid Grounders *user* token. The suite `test:tokens` asserts
  this in both directions, and it should never be deleted.
- **The Gmail scope is `gmail.modify`, excluding `mail.google.com`.** Mail
  therefore *cannot* be permanently deleted — a structural guarantee rather than
  a promise about which tools exist.
- PKCE S256 required; authorization codes single-use and hashed; refresh tokens
  rotated on use; `redirect_uri` matched exactly against registration.

## 3 — Bugs that only production found

Worth recording because each was invisible to a passing test suite.

- **Array query parameters were comma-joined instead of repeated.** Google
  expects `metadataHeaders=From&metadataHeaders=Subject&…` and silently returns a
  message with *no headers at all* when handed `"From,To,Subject,Date"`. Every
  search result came back with empty from/to/subject/date, and the cross-account
  date sort was a no-op because every date compared equal. The same bug sat in
  `getReplyContext`, where it would have broken threading on the first reply
  sent. This is the origin of the rule below about asserting on the wire.
- Diagnosing a bad `GOOGLE_CLIENT_SECRET` meant running the whole consent
  round-trip to fail at the last step. `/gmail/check` posts a deliberately bogus
  authorization code: Google validates client credentials *before* the grant, so
  `invalid_client` and `invalid_grant` cleanly separate "your secret is wrong"
  from "both fine".
- A pasted `PUBLIC_BASE_URL=` prefix or a stray space surfaced as Google's
  `redirect_uri_mismatch`, which points at the OAuth client rather than at the
  real cause. Now validated as a bare origin at both read sites.
- `MCP_ADMIN_PASSWORD` now trims both sides before the constant-time compare.
  Copying a passphrase picks up whitespace, and the resulting "incorrect
  password" is unfixable by careful retyping.

## 4 — Extending past Gmail, and the extraction refusal

Calendar, Drive, Contacts and Tasks each have their own first-party connector
with the same one-account limit, so the argument for mail applied unchanged.

**Document text extraction uses only Node's standard library.** Office formats
are ZIP archives of XML and zlib is in `node:zlib`; PDFs are parsed from their
content streams. The alternative was a parsing dependency to vendor, audit and
keep current, for a job the standard library can do.

**The important decision here is the refusal.** Two kinds of PDF have no text to
recover: a scan, and one whose fonts are CID-keyed or subset, where the content
stream holds glyph numbers rather than characters. A union of the document's
ToUnicode tables would often fix the second case — but subset fonts reuse codes
with different meanings, so it would *sometimes* produce text that reads
correctly and says something the document does not. That is the worst available
failure, so the output is scored for readability and **refused** instead, naming
the cause. `ocr: true` routes those through Drive's own conversion.

Bugs found only by testing against real files: a word boundary after `T*` in the
PDF operator pattern can never match (`*` is not a word character), so every PDF
would have come back as one run-on line; content streams had to be found by
scanning *back* from the `stream` keyword, because a page dictionary nests
`/Resources` inside itself and a forward match spans objects and picks up the
wrong `/Length`.

## 5 — Shared drives, and what the default corpus hides

Drive's `files.list` defaults to `corpora=user`: My Drive plus files shared
directly with the account. Drives owned by an *organisation* are excluded, and a
request naming a file inside one returns `404 File not found` without
`supportsAllDrives` — an error that reads as a wrong id rather than as a missing
capability.

Verified against the live deployment afterwards: for the work account, **the
three most recently modified files in the entire Drive were all invisible**, and
"what did I touch most recently" returned a five-day-old answer with nothing to
indicate anything was missing.

`supportsAllDrives` is applied in one wrapper rather than at each of the eighteen
call sites, so a later endpoint cannot silently reintroduce the gap. Which
methods accept it comes from the v3 discovery document, not from memory:
`files.export`, `comments` and `replies` do **not** take it.

## 6 — Writes land on files you own

Reaching shared drives widened writes as well as reads, and a shared drive holds
colleagues' documents. The rule now:

| Situation | What happens |
|---|---|
| You own the file | The write just happens |
| You do not own it | A **private copy** is made in your My Drive and edited there |
| You want the original | `edit_original` returns a **draft** and writes nothing |
| The user approves the draft | `confirm_edit` applies it |

Three things worth keeping straight:

- **Everything in a shared drive counts as not yours**, including files you
  created there, because a shared drive is owned by the organisation. That is
  the correct reading for this purpose: those documents are colleagues' to lose.
- **The copy must name `parents: ['root']`.** `files.copy` with no parent puts
  the copy beside the source, which for a shared-drive file means the copy lands
  in that same shared drive — still not private. This is easy to get wrong and
  there is a test for it.
- **Sharing and trashing have no copy path**, only a draft. Copying a colleague's
  document and sharing *that* spreads their content further, not less.

**Revoking and restoring are never gated.** `unshare_file` and `untrash_file`
work without confirmation even on files you do not own. The asymmetry is the
point: widening access needs approval, narrowing never does, and a brake that
needs permission is not a brake.

## Principles that keep applying

1. **Every outward action needs an undo, and that is the condition for offering
   it.** `unshare_file` and `untrash_file` exist because `share_file` and
   `trash_file` do. Claude's first-party connector has neither.
2. **Refuse rather than return plausible nonsense.** Text that reads correctly
   and says the wrong thing is worse than an error.
3. **Assert on what goes over the wire, not on the return value.** The failures
   worth catching here are calls that succeed while asking the wrong question,
   and only a wire-level assertion sees those. Hence `global.fetch` stubs
   throughout the suites.
4. **Prefer a structural guarantee to a convention.** `gmail.modify` makes
   permanent deletion impossible; a rule saying "don't call the delete endpoint"
   would not.
5. **Check the API's own discovery document rather than recalling it.** It
   settled which Drive methods accept `supportsAllDrives`, and it disproved an
   assumed conflict between `corpora=allDrives` and `orderBy`.
6. **A count in a README is a test.** Tool counts and check totals are asserted
   in the suites, so documentation that drifts fails the build.

## Operational notes

- Deployed on **Railway**, which auto-deploys from `main`.
- While the Google app stays in **Testing**, refresh tokens expire after 7 days
  and accounts must be re-linked. Publishing stops that, but Gmail, Drive and
  Contacts are restricted scopes, so Google verification applies.
- Granted scopes are fixed at link time and Google will not extend them
  retroactively. Adding a product means re-visiting `/gmail/connect` per account;
  `list_accounts` reports which products each grant actually covers.
- `npm run smoke` is a read-only live check against the deployment, allow-listed
  by construction, reporting counts rather than contents.
