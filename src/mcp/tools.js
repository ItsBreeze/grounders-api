/**
 * MCP tool surface over every linked mailbox.
 *
 * The `account` argument selects a mailbox by email address. Where it is
 * optional, omitting it fans the call out across all linked accounts — that
 * cross-account reach is the reason this server exists, since Claude's
 * first-party Gmail connector holds exactly one Google account.
 */

const accounts = require('../services/gmail_accounts');
const gmail    = require('../services/gmail_api');

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

/** Resolve the caller's `account` argument to a linked address, with a helpful error. */
async function resolveAccount(ownerKey, requested) {
  const linked = await accounts.emailsFor(ownerKey);

  if (!linked.length) {
    throw new Error('No mailboxes are linked yet. Visit /gmail/connect to link one.');
  }

  if (!requested) {
    if (linked.length === 1) return linked[0];
    throw new Error(`Which account? Linked: ${linked.join(', ')}`);
  }

  const wanted = String(requested).toLowerCase().trim();
  const exact  = linked.find(e => e === wanted);
  if (exact) return exact;

  // Tolerate a bare local-part ("work" for work@example.com) — Claude often
  // passes whatever the user said rather than the full address.
  const partial = linked.filter(e => e.startsWith(`${wanted}@`) || e.includes(wanted));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`"${requested}" matches ${partial.join(', ')} — be specific.`);

  throw new Error(`"${requested}" is not linked. Linked: ${linked.join(', ')}`);
}

/** account + access token in one step — nearly every tool starts this way. */
async function tokenFor(ownerKey, requested) {
  const email = await resolveAccount(ownerKey, requested);
  return { email, token: await accounts.accessTokenFor(ownerKey, email) };
}

/** Exactly one of message_id / thread_id, so a tool can act on either level. */
function oneTarget(args) {
  if (args.message_id && args.thread_id) throw new Error('Pass message_id OR thread_id, not both.');
  if (!args.message_id && !args.thread_id) throw new Error('Pass message_id or thread_id.');
  return args.message_id ? { kind: 'message', id: args.message_id } : { kind: 'thread', id: args.thread_id };
}

const ACCOUNT_PROP = { account: { type: 'string', description: 'Mailbox holding the item. May be omitted when only one mailbox is linked.' } };

const TOOLS = [
  // ─── Accounts & search ────────────────────────────────────────────────────
  {
    name: 'list_accounts',
    description: 'List every Gmail account linked to this server, with link status and token health.',
    inputSchema: { type: 'object', properties: {} },
    handler: async ({ ownerKey }) => {
      const rows = await accounts.list(ownerKey);
      if (!rows.length) return text('No mailboxes linked yet.');
      return text(rows.map(r => ({
        email: r.email,
        linked_at: r.created_at,
        refresh_token_stored: r.has_refresh_token,
        access_token_expires: r.token_expires_at,
      })));
    },
  },

  {
    name: 'search_messages',
    description:
      'Search mail using Gmail query syntax (from:, subject:, is:unread, newer_than:7d, has:attachment). ' +
      'Omit `account` to search EVERY linked mailbox at once and get merged, date-sorted results. ' +
      'For more results from one mailbox, pass its next_page_token back as page_token with that account.',
    inputSchema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Gmail search query.' },
        account:     { type: 'string', description: 'Mailbox to search. Omit to search all linked mailboxes.' },
        max_results: { type: 'number', description: 'Max results per mailbox (1-50, default 10).' },
        page_token:  { type: 'string', description: 'Continue a previous search. Requires `account`.' },
      },
      required: ['query'],
    },
    handler: async ({ ownerKey, args }) => {
      if (args.page_token && !args.account) {
        throw new Error('page_token requires `account` — pagination is per-mailbox.');
      }

      const targets = args.account
        ? [await resolveAccount(ownerKey, args.account)]
        : await accounts.emailsFor(ownerKey);

      // Hard error, not an empty result: "no matches" and "nothing was
      // searched" must never look the same to the model.
      if (!targets.length) throw new Error('No mailboxes are linked yet. Visit /gmail/connect to link one.');

      // allSettled: one dead grant must not blank out results from the others.
      const settled = await Promise.allSettled(targets.map(async (email) => {
        const token = await accounts.accessTokenFor(ownerKey, email);
        const page  = await gmail.searchMessages(token, {
          query: args.query,
          maxResults: args.max_results || 10,
          pageToken: args.page_token,
        });
        return { email, page };
      }));

      const found      = [];
      const nextTokens = {};
      const failed     = [];

      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          found.push(...r.value.page.messages.map(m => ({ account: r.value.email, ...m })));
          if (r.value.page.nextPageToken) nextTokens[r.value.email] = r.value.page.nextPageToken;
        } else {
          failed.push(`${targets[i]}: ${r.reason.message}`);
        }
      });

      found.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

      if (!found.length && failed.length) throw new Error(`All mailboxes failed — ${failed.join('; ')}`);

      return text({
        searched: targets,
        ...(failed.length ? { errors: failed } : {}),
        ...(Object.keys(nextTokens).length ? { next_page_token: nextTokens } : {}),
        count: found.length,
        messages: found,
      });
    },
  },

  // ─── Reading ──────────────────────────────────────────────────────────────
  {
    name: 'get_message',
    description: 'Fetch one message in full: body text plus attachment metadata (use get_attachment for the file itself).',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, message_id: { type: 'string', description: 'Gmail message id.' } },
      required: ['message_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      return text({ account: email, ...(await gmail.getMessage(token, args.message_id)) });
    },
  },

  {
    name: 'get_thread',
    description: 'Fetch an entire conversation thread with every message body and attachment metadata.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, thread_id: { type: 'string', description: 'Gmail thread id.' } },
      required: ['thread_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      return text({ account: email, ...(await gmail.getThread(token, args.thread_id)) });
    },
  },

  {
    name: 'get_attachment',
    description:
      'Download one attachment from a message. Text-like files (text/*, JSON, CSV, XML) come back as text; ' +
      'binary files come back base64-encoded (2 MB limit). Get attachment ids from get_message or get_thread.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        message_id:    { type: 'string' },
        attachment_id: { type: 'string' },
      },
      required: ['message_id', 'attachment_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      const data = await gmail.getAttachmentData(token, args.message_id, args.attachment_id);

      const MAX = 2 * 1024 * 1024;
      if (data.length > MAX) {
        throw new Error(`Attachment is ${data.length} bytes — over the ${MAX} byte limit for tool results.`);
      }

      // Look the type up from the message so the caller doesn't have to pass it.
      const msg = await gmail.getMessage(token, args.message_id);
      const meta = msg.attachments.find(a => a.attachment_id === args.attachment_id) || {};
      const mime = meta.mime_type || 'application/octet-stream';

      const textLike = /^text\/|[/+](json|csv|xml)$|^application\/(json|xml|csv)/.test(mime);

      return text({
        account:    email,
        filename:   meta.filename || '(unknown)',
        mime_type:  mime,
        size_bytes: data.length,
        ...(textLike
          ? { text: data.toString('utf8') }
          : { base64: data.toString('base64'), note: 'Binary content, base64-encoded.' }),
      });
    },
  },

  // ─── Sending ──────────────────────────────────────────────────────────────
  {
    name: 'send_message',
    description: 'Send a new email immediately from a specific linked mailbox. To let the user review first, use create_draft instead.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Mailbox to send FROM — this sets the From address.' },
        to:      { type: 'string', description: 'Recipient(s), comma-separated.' },
        subject: { type: 'string' },
        body:    { type: 'string', description: 'Plain-text body.' },
        cc:      { type: 'string' },
        bcc:     { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      const sent = await gmail.sendMessage(token, {
        from: email, to: args.to, cc: args.cc, bcc: args.bcc,
        subject: args.subject, body: args.body,
      });
      return text({ sent_from: email, message_id: sent.id, thread_id: sent.threadId });
    },
  },

  {
    name: 'reply_to_message',
    description: 'Reply in-thread immediately, preserving subject and threading headers. To let the user review first, use create_draft with reply_to_message_id.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        message_id: { type: 'string', description: 'Message being replied to.' },
        body:       { type: 'string', description: 'Plain-text reply body.' },
        reply_all:  { type: 'boolean', description: 'Include original To and Cc recipients. Default false.' },
      },
      required: ['message_id', 'body'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      const ctx = await gmail.getReplyContext(token, args.message_id);

      // Drop our own address from a reply-all so we don't mail ourselves.
      const others = [ctx.to, ctx.cc].filter(Boolean).join(', ')
        .split(',').map(s => s.trim())
        .filter(s => s && !s.toLowerCase().includes(email.toLowerCase()));

      const sent = await gmail.sendMessage(token, {
        from: email,
        to: ctx.from,
        cc: args.reply_all && others.length ? others.join(', ') : undefined,
        subject: ctx.subject,
        body: args.body,
        threadId: ctx.threadId,
        inReplyTo: ctx.messageId,
        references: [ctx.references, ctx.messageId].filter(Boolean).join(' '),
      });

      return text({ replied_from: email, message_id: sent.id, thread_id: sent.threadId });
    },
  },

  {
    name: 'forward_message',
    description: 'Forward a message to new recipients, carrying its attachments along (10 MB total cap; larger ones are named as skipped).',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        message_id: { type: 'string', description: 'Message to forward.' },
        to:         { type: 'string', description: 'Recipient(s), comma-separated.' },
        cc:         { type: 'string' },
        note:       { type: 'string', description: 'Optional text placed above the forwarded content.' },
      },
      required: ['message_id', 'to'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      const { sent, skippedAttachments } = await gmail.forwardMessage(token, {
        from: email, messageId: args.message_id, to: args.to, cc: args.cc, note: args.note,
      });
      return text({
        forwarded_from: email,
        message_id: sent.id,
        thread_id: sent.threadId,
        ...(skippedAttachments.length ? { attachments_skipped_for_size: skippedAttachments } : {}),
      });
    },
  },

  // ─── Drafts ───────────────────────────────────────────────────────────────
  {
    name: 'create_draft',
    description:
      'Create a draft for the user to review and send from Gmail (or via send_draft). ' +
      'Pass reply_to_message_id to draft an in-thread reply — subject and threading headers are handled, ' +
      'and `to` defaults to the original sender.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Mailbox the draft belongs to (sets the From address).' },
        to:      { type: 'string', description: 'Recipient(s). Optional when replying — defaults to the original sender.' },
        subject: { type: 'string', description: 'Ignored when replying — the thread subject is kept.' },
        body:    { type: 'string', description: 'Plain-text body.' },
        cc:      { type: 'string' },
        bcc:     { type: 'string' },
        reply_to_message_id: { type: 'string', description: 'Draft a reply to this message, in its thread.' },
      },
      required: ['body'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);

      let mime;
      if (args.reply_to_message_id) {
        const ctx = await gmail.getReplyContext(token, args.reply_to_message_id);
        mime = {
          from: email,
          to: args.to || ctx.from,
          cc: args.cc, bcc: args.bcc,
          subject: ctx.subject,
          body: args.body,
          threadId: ctx.threadId,
          inReplyTo: ctx.messageId,
          references: [ctx.references, ctx.messageId].filter(Boolean).join(' '),
        };
      } else {
        if (!args.to) throw new Error('`to` is required for a new (non-reply) draft.');
        if (!args.subject) throw new Error('`subject` is required for a new (non-reply) draft.');
        mime = { from: email, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body };
      }

      const draft = await gmail.createDraft(token, mime);
      return text({ account: email, ...draft, note: 'Draft saved — visible in Gmail. Send with send_draft or from Gmail itself.' });
    },
  },

  {
    name: 'list_drafts',
    description: 'List drafts in a mailbox.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, max_results: { type: 'number', description: '1-50, default 15.' } },
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      return text({ account: email, drafts: await gmail.listDrafts(token, { maxResults: args.max_results }) });
    },
  },

  {
    name: 'get_draft',
    description: 'Fetch one draft in full, including its body.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, draft_id: { type: 'string' } },
      required: ['draft_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      return text({ account: email, ...(await gmail.getDraft(token, args.draft_id)) });
    },
  },

  {
    name: 'update_draft',
    description: 'Replace a draft\'s content entirely. Provide the complete new to/subject/body — this overwrites, not merges.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        draft_id: { type: 'string' },
        to:       { type: 'string' },
        subject:  { type: 'string' },
        body:     { type: 'string' },
        cc:       { type: 'string' },
        bcc:      { type: 'string' },
      },
      required: ['draft_id', 'to', 'subject', 'body'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);

      // Preserve the thread a reply-draft belongs to.
      const existing = await gmail.getDraft(token, args.draft_id);

      const updated = await gmail.updateDraft(token, args.draft_id, {
        from: email, to: args.to, cc: args.cc, bcc: args.bcc,
        subject: args.subject, body: args.body,
        threadId: existing.thread_id,
      });
      return text({ account: email, ...updated });
    },
  },

  {
    name: 'send_draft',
    description: 'Send an existing draft as-is.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, draft_id: { type: 'string' } },
      required: ['draft_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      const sent = await gmail.sendDraft(token, args.draft_id);
      return text({ sent_from: email, message_id: sent.id, thread_id: sent.threadId });
    },
  },

  {
    name: 'delete_draft',
    description: 'Delete a draft permanently. Only affects the draft — never sent mail.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, draft_id: { type: 'string' } },
      required: ['draft_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      await gmail.deleteDraft(token, args.draft_id);
      return text({ account: email, draft_id: args.draft_id, status: 'deleted' });
    },
  },

  // ─── Labels ───────────────────────────────────────────────────────────────
  {
    name: 'modify_labels',
    description:
      'Add or remove labels on a message (message_id) or a whole thread (thread_id). ' +
      'Use label ids from list_labels, or built-ins like UNREAD, STARRED, IMPORTANT, INBOX. ' +
      'Removing INBOX archives.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        message_id:    { type: 'string', description: 'Target one message…' },
        thread_id:     { type: 'string', description: '…or a whole thread. Exactly one of the two.' },
        add_labels:    { type: 'array', items: { type: 'string' } },
        remove_labels: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: async ({ ownerKey, args }) => {
      const target = oneTarget(args);
      const { email, token } = await tokenFor(ownerKey, args.account);
      const change = { add: args.add_labels || [], remove: args.remove_labels || [] };

      const result = target.kind === 'message'
        ? await gmail.modifyLabels(token, target.id, change)
        : await gmail.modifyThreadLabels(token, target.id, change);

      return text({ account: email, [target.kind === 'message' ? 'message_id' : 'thread_id']: target.id,
                    labels: result.labelIds || 'updated' });
    },
  },

  {
    name: 'list_labels',
    description: 'List label ids and names for a mailbox.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP } },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      return text({ account: email, labels: await gmail.listLabels(token) });
    },
  },

  {
    name: 'create_label',
    description: 'Create a new label in a mailbox.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, name: { type: 'string', description: 'Label name. Use "/" for nesting, e.g. "Work/Receipts".' } },
      required: ['name'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      const label = await gmail.createLabel(token, args.name);
      return text({ account: email, id: label.id, name: label.name });
    },
  },

  {
    name: 'update_label',
    description: 'Rename a user label.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, label_id: { type: 'string' }, name: { type: 'string', description: 'New name.' } },
      required: ['label_id', 'name'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      const label = await gmail.updateLabel(token, args.label_id, args.name);
      return text({ account: email, id: label.id, name: label.name });
    },
  },

  {
    name: 'delete_label',
    description: 'Delete a user label. Messages keep the rest of their labels; none are deleted.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, label_id: { type: 'string' } },
      required: ['label_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account);
      await gmail.deleteLabel(token, args.label_id);
      return text({ account: email, label_id: args.label_id, status: 'deleted' });
    },
  },

  // ─── Trash & spam ─────────────────────────────────────────────────────────
  {
    name: 'trash_message',
    description: 'Move a message (message_id) or whole thread (thread_id) to Trash. Recoverable for 30 days — this server cannot delete permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        message_id: { type: 'string' },
        thread_id:  { type: 'string', description: 'Trash the whole thread instead. Exactly one of the two.' },
      },
    },
    handler: async ({ ownerKey, args }) => {
      const target = oneTarget(args);
      const { email, token } = await tokenFor(ownerKey, args.account);
      if (target.kind === 'message') await gmail.trashMessage(token, target.id);
      else await gmail.trashThread(token, target.id);
      return text({ account: email, [target.kind === 'message' ? 'message_id' : 'thread_id']: target.id, status: 'moved to trash' });
    },
  },

  {
    name: 'untrash_message',
    description: 'Restore a message (message_id) or whole thread (thread_id) from Trash.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        message_id: { type: 'string' },
        thread_id:  { type: 'string', description: 'Restore the whole thread instead. Exactly one of the two.' },
      },
    },
    handler: async ({ ownerKey, args }) => {
      const target = oneTarget(args);
      const { email, token } = await tokenFor(ownerKey, args.account);
      if (target.kind === 'message') await gmail.untrashMessage(token, target.id);
      else await gmail.untrashThread(token, target.id);
      return text({ account: email, [target.kind === 'message' ? 'message_id' : 'thread_id']: target.id, status: 'restored from trash' });
    },
  },

  {
    name: 'mark_spam',
    description: 'Mark a message (message_id) or thread (thread_id) as spam — or undo it with unmark: true, which restores it to the inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        message_id: { type: 'string' },
        thread_id:  { type: 'string', description: 'Whole thread instead. Exactly one of the two.' },
        unmark:     { type: 'boolean', description: 'true = not spam: remove SPAM, restore to INBOX.' },
      },
    },
    handler: async ({ ownerKey, args }) => {
      const target = oneTarget(args);
      const { email, token } = await tokenFor(ownerKey, args.account);
      const change = args.unmark
        ? { add: ['INBOX'], remove: ['SPAM'] }
        : { add: ['SPAM'], remove: ['INBOX'] };

      if (target.kind === 'message') await gmail.modifyLabels(token, target.id, change);
      else await gmail.modifyThreadLabels(token, target.id, change);

      return text({ account: email, [target.kind === 'message' ? 'message_id' : 'thread_id']: target.id,
                    status: args.unmark ? 'unmarked as spam' : 'marked as spam' });
    },
  },
];

const descriptors = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

async function callTool(name, args, ownerKey) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler({ ownerKey, args: args || {} });
}

module.exports = { descriptors, callTool, _internal: { resolveAccount, oneTarget, TOOLS } };
