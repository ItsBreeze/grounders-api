/**
 * Gmail tools.
 *
 * Every mailbox the operator has linked, reachable in one call — `account`
 * selects one, and omitting it on a search fans out across all of them.
 */

const accounts = require('../../services/gmail_accounts');
const gmail    = require('../../services/gmail_api');
const extract  = require('../../services/text_extract');
const {
  text, resolveAccount, tokenFor, fanOut, mergeSearch, oneTarget,
  ACCOUNT_PROP, SEARCH_PROPS, checkPageToken,
} = require('../shared');

const TOOLS = [
  // ─── Accounts & search ────────────────────────────────────────────────────
  {
    name: 'list_accounts',
    description: 'List every Gmail account linked to this server, with link status and token health.',
    inputSchema: { type: 'object', properties: {} },
    handler: async ({ ownerKey }) => {
      const rows = await accounts.list(ownerKey);
      if (!rows.length) return text('No mailboxes linked yet.');

      const listed = rows.map((r) => {
        const access = accounts.productAccess(r.scopes);
        return {
          email: r.email,
          linked_at: r.created_at,
          refresh_token_stored: r.has_refresh_token,
          access_token_expires: r.token_expires_at,
          access: access.granted,
          ...(access.missing.length ? { missing_access: access.missing } : {}),
          ...(access.recorded ? {} : { note: 'No scopes were recorded for this account; what it can do is unknown until a call is tried.' }),
        };
      });

      // Say it once, plainly, rather than leaving it to be inferred from rows.
      const incomplete = listed.filter(a => a.missing_access);

      return text({
        accounts: listed,
        ...(incomplete.length ? {
          action_needed:
            `${incomplete.map(a => `${a.email} is missing ${a.missing_access.join(', ')}`).join('; ')}. ` +
            'Re-link at /gmail/connect to add them. If a product is still missing after re-linking, its API ' +
            'is not enabled on the Google Cloud project — Google drops scopes for APIs that are switched off.',
        } : {}),
      });
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
      properties: { query: { type: 'string', description: 'Gmail search query.' }, ...SEARCH_PROPS },
      required: ['query'],
    },
    handler: async ({ ownerKey, args }) => {
      checkPageToken(args);

      const fanned = await fanOut(ownerKey, args.account, 'gmail', token =>
        gmail.searchMessages(token, {
          query: args.query,
          maxResults: args.max_results || 10,
          pageToken: args.page_token,
        }));

      return text(mergeSearch(fanned, {
        key: 'messages', dateField: 'date', unavailableKey: 'unavailable_messages',
      }));
    },
  },

  {
    name: 'search_threads',
    description:
      'Search whole conversations instead of individual messages, using the same Gmail query syntax. ' +
      'A thread matches when any message in it does, and comes back as one row: subject, every participant, ' +
      'message count, unread count and when it last moved — the shape to use for "where does my thread with X stand". ' +
      'Omit `account` to search EVERY linked mailbox at once, merged and sorted by latest activity. ' +
      'Follow up with get_thread for the message bodies.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Gmail search query.' }, ...SEARCH_PROPS },
      required: ['query'],
    },
    handler: async ({ ownerKey, args }) => {
      checkPageToken(args);

      const fanned = await fanOut(ownerKey, args.account, 'gmail', token =>
        gmail.searchThreads(token, {
          query: args.query,
          maxResults: args.max_results || 10,
          pageToken: args.page_token,
        }));

      // Latest activity first — the last message's date, not the thread's start.
      return text(mergeSearch(fanned, {
        key: 'threads', dateField: 'last_date', unavailableKey: 'unavailable_threads',
      }));
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
      return text({ account: email, ...(await gmail.getThread(token, args.thread_id)) });
    },
  },

  {
    name: 'get_attachment',
    description:
      'Read one attachment. PDFs, Word, Excel, PowerPoint, OpenDocument and text-like files come back as ' +
      'TEXT, so an emailed contract or invoice can be read directly; anything else comes back base64-encoded ' +
      '(2 MB limit). Get attachment ids from get_message or get_thread.',
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
      const data = await gmail.getAttachmentData(token, args.message_id, args.attachment_id);

      const MAX = 2 * 1024 * 1024;
      if (data.length > MAX) {
        throw new Error(`Attachment is ${data.length} bytes — over the ${MAX} byte limit for tool results.`);
      }

      // Look the type up from the message so the caller doesn't have to pass it.
      const msg = await gmail.getMessage(token, args.message_id);
      const meta = msg.attachments.find(a => a.attachment_id === args.attachment_id) || {};
      const mime = meta.mime_type || 'application/octet-stream';

      const filename = meta.filename || '(unknown)';
      const result   = extract.extract(data, { mimeType: mime, filename });

      return text({
        account:    email,
        filename,
        mime_type:  mime,
        size_bytes: data.length,
        ...(result.text !== null
          ? {
              ...(result.kind !== 'text' ? { read_as: result.kind } : {}),
              ...(result.pages ? { pages: result.pages } : {}),
              text: gmail._internal.truncateBody(result.text),
            }
          : {
              base64: data.toString('base64'),
              note: `Returned as base64 because the text could not be read: ${result.reason}` +
                    (result.recoverable
                      ? ' Saving it to Drive and reading it with ocr: true would extract the text.'
                      : ''),
            }),
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');

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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');

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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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
      const { email, token } = await tokenFor(ownerKey, args.account, 'gmail');
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

module.exports = TOOLS;
