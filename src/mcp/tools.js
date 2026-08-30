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

const TOOLS = [
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
      'Omit `account` to search EVERY linked mailbox at once and get merged, date-sorted results.',
    inputSchema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Gmail search query.' },
        account:     { type: 'string', description: 'Mailbox to search. Omit to search all linked mailboxes.' },
        max_results: { type: 'number', description: 'Max results per mailbox (1-50, default 10).' },
      },
      required: ['query'],
    },
    handler: async ({ ownerKey, args }) => {
      const targets = args.account
        ? [await resolveAccount(ownerKey, args.account)]
        : await accounts.emailsFor(ownerKey);

      // Hard error, not an empty result: "no matches" and "nothing was
      // searched" must never look the same to the model.
      if (!targets.length) throw new Error('No mailboxes are linked yet. Visit /gmail/connect to link one.');

      // allSettled: one dead grant must not blank out results from the others.
      const settled = await Promise.allSettled(targets.map(async (email) => {
        const token = await accounts.accessTokenFor(ownerKey, email);
        const hits  = await gmail.searchMessages(token, { query: args.query, maxResults: args.max_results || 10 });
        return hits.map(h => ({ account: email, ...h }));
      }));

      const found  = settled.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
      const failed = settled
        .map((r, i) => (r.status === 'rejected' ? `${targets[i]}: ${r.reason.message}` : null))
        .filter(Boolean);

      found.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

      if (!found.length && failed.length) throw new Error(`All mailboxes failed — ${failed.join('; ')}`);

      return text({
        searched: targets,
        ...(failed.length ? { errors: failed } : {}),
        count: found.length,
        messages: found,
      });
    },
  },

  {
    name: 'get_message',
    description: 'Fetch one message in full, including its body text.',
    inputSchema: {
      type: 'object',
      properties: {
        account:    { type: 'string', description: 'Mailbox holding the message.' },
        message_id: { type: 'string', description: 'Gmail message id.' },
      },
      required: ['message_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const email = await resolveAccount(ownerKey, args.account);
      const token = await accounts.accessTokenFor(ownerKey, email);
      return text({ account: email, ...(await gmail.getMessage(token, args.message_id)) });
    },
  },

  {
    name: 'get_thread',
    description: 'Fetch an entire conversation thread with every message body.',
    inputSchema: {
      type: 'object',
      properties: {
        account:   { type: 'string', description: 'Mailbox holding the thread.' },
        thread_id: { type: 'string', description: 'Gmail thread id.' },
      },
      required: ['thread_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const email = await resolveAccount(ownerKey, args.account);
      const token = await accounts.accessTokenFor(ownerKey, email);
      return text({ account: email, ...(await gmail.getThread(token, args.thread_id)) });
    },
  },

  {
    name: 'send_message',
    description: 'Send a new email from a specific linked mailbox.',
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
      const email = await resolveAccount(ownerKey, args.account);
      const token = await accounts.accessTokenFor(ownerKey, email);
      const sent  = await gmail.sendMessage(token, {
        from: email, to: args.to, cc: args.cc, bcc: args.bcc,
        subject: args.subject, body: args.body,
      });
      return text({ sent_from: email, message_id: sent.id, thread_id: sent.threadId });
    },
  },

  {
    name: 'reply_to_message',
    description: 'Reply in-thread to a message, preserving subject and threading headers.',
    inputSchema: {
      type: 'object',
      properties: {
        account:    { type: 'string', description: 'Mailbox holding the message.' },
        message_id: { type: 'string', description: 'Message being replied to.' },
        body:       { type: 'string', description: 'Plain-text reply body.' },
        reply_all:  { type: 'boolean', description: 'Include original To and Cc recipients. Default false.' },
      },
      required: ['message_id', 'body'],
    },
    handler: async ({ ownerKey, args }) => {
      const email   = await resolveAccount(ownerKey, args.account);
      const token   = await accounts.accessTokenFor(ownerKey, email);
      const ctx     = await gmail.getReplyContext(token, args.message_id);

      // Drop our own address from a reply-all so we don't mail ourselves.
      const others  = [ctx.to, ctx.cc].filter(Boolean).join(', ')
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
    name: 'modify_labels',
    description:
      'Add or remove labels on a message. Use label ids from list_labels, or built-ins ' +
      'like UNREAD, STARRED, IMPORTANT, INBOX. Removing INBOX archives the message.',
    inputSchema: {
      type: 'object',
      properties: {
        account:       { type: 'string' },
        message_id:    { type: 'string' },
        add_labels:    { type: 'array', items: { type: 'string' } },
        remove_labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['message_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const email  = await resolveAccount(ownerKey, args.account);
      const token  = await accounts.accessTokenFor(ownerKey, email);
      const result = await gmail.modifyLabels(token, args.message_id, {
        add: args.add_labels || [], remove: args.remove_labels || [],
      });
      return text({ account: email, message_id: result.id, labels: result.labelIds });
    },
  },

  {
    name: 'trash_message',
    description: 'Move a message to Trash. Recoverable for 30 days — this server cannot delete permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        account:    { type: 'string' },
        message_id: { type: 'string' },
      },
      required: ['message_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const email = await resolveAccount(ownerKey, args.account);
      const token = await accounts.accessTokenFor(ownerKey, email);
      await gmail.trashMessage(token, args.message_id);
      return text({ account: email, message_id: args.message_id, status: 'moved to trash' });
    },
  },

  {
    name: 'list_labels',
    description: 'List label ids and names for a mailbox.',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string' } },
    },
    handler: async ({ ownerKey, args }) => {
      const email = await resolveAccount(ownerKey, args.account);
      const token = await accounts.accessTokenFor(ownerKey, email);
      return text({ account: email, labels: await gmail.listLabels(token) });
    },
  },
];

const descriptors = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

async function callTool(name, args, ownerKey) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler({ ownerKey, args: args || {} });
}

module.exports = { descriptors, callTool, _internal: { resolveAccount, TOOLS } };
