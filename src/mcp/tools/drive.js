/**
 * Google Drive tools.
 *
 * Searching fans out across every linked account — one query over a personal
 * and a work Drive at the same time. Writes always name one account.
 */

const drive = require('../../services/drive_api');
const {
  text, tokenFor, fanOut, mergeSearch, ACCOUNT_PROP, SEARCH_PROPS, checkPageToken,
} = require('../shared');

const FILE_PROP = { file_id: { type: 'string', description: 'Drive file id, from search_files or list_recent_files.' } };

const ROLES = ['reader', 'commenter', 'writer'];

/**
 * Sharing beyond a named person — a whole domain, or anyone holding the link —
 * is off unless the operator turns it on.
 *
 * Claude's first-party Drive connector shares with one email address and a role,
 * full stop: it has no way to publish a file. Matching that default matters
 * because the failure is silent and one-way — a model that misreads "share this
 * with the team" as a public link produces a URL that works for anyone who ever
 * sees it, and nothing about the result looks alarming.
 */
const PUBLIC_SHARING = /^(1|true|yes|on)$/i.test(String(process.env.DRIVE_ALLOW_PUBLIC_SHARING || '').trim());

const SHARE_TARGET_PROPS = PUBLIC_SHARING
  ? {
      email:  { type: 'string', description: 'Person to share with.' },
      domain: { type: 'string', description: 'Share with everyone at this domain instead.' },
      anyone: { type: 'boolean', description: 'PUBLISH: anyone holding the link can open it. Confirm with the user first.' },
    }
  : {
      email:  { type: 'string', description: 'Person to share with, by email address.' },
    };

const TOOLS = [
  {
    name: 'search_files',
    description:
      'Search Drive by text across file names and contents. Omit `account` to search EVERY linked Drive at ' +
      'once. Add `filter` for Drive query syntax (mimeType, modifiedTime, starred, "\'me\' in owners"). ' +
      'Trashed files are excluded unless your filter says otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'Text to find in names and contents.' },
        filter: { type: 'string', description: "Raw Drive query, ANDed with the text, e.g. \"mimeType='application/pdf'\"." },
        ...SEARCH_PROPS,
      },
    },
    handler: async ({ ownerKey, args }) => {
      checkPageToken(args);
      if (!args.query && !args.filter) throw new Error('Pass `query`, `filter`, or both.');

      const fanned = await fanOut(ownerKey, args.account, 'drive', token =>
        drive.searchFiles(token, {
          query:      args.query,
          filter:     args.filter,
          maxResults: args.max_results || 10,
          pageToken:  args.page_token,
        }));

      return text(mergeSearch(fanned, { key: 'files', dateField: 'modified' }));
    },
  },

  {
    name: 'list_recent_files',
    description: 'Most recently modified files, newest first. Omit `account` to merge every linked Drive.',
    inputSchema: { type: 'object', properties: { ...SEARCH_PROPS } },
    handler: async ({ ownerKey, args }) => {
      checkPageToken(args);
      const fanned = await fanOut(ownerKey, args.account, 'drive', token =>
        drive.listRecent(token, { maxResults: args.max_results || 10, pageToken: args.page_token }));

      return text(mergeSearch(fanned, { key: 'files', dateField: 'modified' }));
    },
  },

  {
    name: 'get_file_metadata',
    description: 'Everything about one file except its contents: type, size, owners, timestamps, sharing state, link.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...FILE_PROP }, required: ['file_id'] },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      return text({ account: email, ...(await drive.getMetadata(token, args.file_id)) });
    },
  },

  {
    name: 'read_file_content',
    description:
      'Read a file as text. Google Docs, Sheets and Slides are exported (Sheets as CSV), and plain text, ' +
      'Markdown, JSON, CSV and code come back as-is. Capped at 60 KB with the cut flagged. ' +
      'For a PDF or an image, use download_file_content.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...FILE_PROP }, required: ['file_id'] },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const { meta, data, mimeType, exported } = await drive.getContent(token, args.file_id);

      const textLike = /^text\/|[/+](json|csv|xml|javascript)$|^application\/(json|xml|csv|x-sh)/.test(mimeType);
      if (!textLike) {
        throw new Error(
          `"${meta.name}" is ${mimeType}, which is not text. Use download_file_content to get it base64-encoded.`,
        );
      }

      return text({
        account: email,
        name: meta.name,
        mime_type: mimeType,
        ...(exported ? { exported_from: meta.mime_type } : {}),
        content: drive._internal.truncateText(data.toString('utf8')),
      });
    },
  },

  {
    name: 'download_file_content',
    description:
      'Download a file as base64 — PDFs, images, archives, anything not text. 2 MB limit. ' +
      'Google-native docs are exported to text first, so prefer read_file_content for those.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...FILE_PROP }, required: ['file_id'] },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const { meta, data, mimeType } = await drive.getContent(token, args.file_id);

      return text({
        account: email,
        name: meta.name,
        mime_type: mimeType,
        size_bytes: data.length,
        base64: data.toString('base64'),
      });
    },
  },

  {
    name: 'create_file',
    description:
      'Create a file in Drive from text content. Pass `parents` to put it in a folder (a folder id from ' +
      'search_files). To make a folder instead, set mime_type to application/vnd.google-apps.folder.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        name:        { type: 'string' },
        content:     { type: 'string', description: 'Text content. Omit for an empty file or a folder.' },
        mime_type:   { type: 'string', description: 'Defaults to text/plain.' },
        description: { type: 'string' },
        parents:     { type: 'array', items: { type: 'string' }, description: 'Folder ids to create it in.' },
      },
      required: ['name'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const file = await drive.createFile(token, {
        name:        args.name,
        content:     args.content || '',
        mimeType:    args.mime_type || 'text/plain',
        description: args.description,
        parents:     args.parents,
      });
      return text({ account: email, created: true, ...file });
    },
  },

  {
    name: 'update_file',
    description:
      'Rename a file, change its description, or move it between folders. ' +
      'Replacing the contents is possible but deliberately awkward: it needs BOTH `content` and ' +
      'replace_content: true, so a rename can never overwrite a document by accident.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...FILE_PROP,
        name:            { type: 'string' },
        content:         { type: 'string', description: 'New content. Requires replace_content: true.' },
        replace_content: { type: 'boolean', description: 'Confirms that `content` should overwrite what is in the file now.' },
        mime_type:       { type: 'string' },
        description:     { type: 'string' },
        add_parents:    { type: 'string', description: 'Folder id to move it into.' },
        remove_parents: { type: 'string', description: 'Folder id to move it out of.' },
      },
      required: ['file_id'],
    },
    handler: async ({ ownerKey, args }) => {
      if (args.content !== undefined && !args.replace_content) {
        throw new Error(
          'Replacing a file\'s contents needs replace_content: true alongside `content`. ' +
          'To rename or move it instead, pass `name` or add_parents and leave `content` out.',
        );
      }

      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const file = await drive.updateFile(token, args.file_id, {
        name:          args.name,
        content:       args.content,
        mimeType:      args.mime_type,
        description:   args.description,
        addParents:    args.add_parents,
        removeParents: args.remove_parents,
      });
      return text({ account: email, updated: true, ...file });
    },
  },

  {
    name: 'copy_file',
    description: 'Copy a file, optionally under a new name or into a different folder.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...FILE_PROP,
        name:    { type: 'string', description: 'Name for the copy. Defaults to "Copy of …".' },
        parents: { type: 'array', items: { type: 'string' }, description: 'Folder ids to put the copy in.' },
      },
      required: ['file_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const file = await drive.copyFile(token, args.file_id, { name: args.name, parents: args.parents });
      return text({ account: email, copied_from: args.file_id, ...file });
    },
  },

  {
    name: 'get_file_permissions',
    description: 'Who can see a file and at what level — the check to run before sharing anything further.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...FILE_PROP }, required: ['file_id'] },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const permissions = await drive.listPermissions(token, args.file_id);
      return text({ account: email, file_id: args.file_id, count: permissions.length, permissions });
    },
  },

  {
    name: 'share_file',
    description: PUBLIC_SHARING
      ? 'Grant access to a file: to one person by email, to a whole domain, or to anyone with the link. ' +
        'This exposes the file outside its current audience — confirm with the user before widening access, ' +
        'and note that `anyone: true` publishes it to anybody holding the URL.'
      : 'Share a file with one person by email address, at reader, commenter or writer level. ' +
        'Publishing to a whole domain or to anyone with the link is disabled on this server.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...FILE_PROP,
        ...SHARE_TARGET_PROPS,
        role:    { type: 'string', enum: ROLES, description: 'Access level. Defaults to reader.' },
        notify:  { type: 'boolean', description: 'Email the person about it. Default false.' },
        message: { type: 'string', description: 'Note to include, when notify is true.' },
      },
      required: ['file_id'],
    },
    handler: async ({ ownerKey, args }) => {
      if (!PUBLIC_SHARING && (args.domain || args.anyone)) {
        throw new Error(
          'This server shares with named people only. Domain-wide and public-link sharing are off; ' +
          'set DRIVE_ALLOW_PUBLIC_SHARING=true to enable them.',
        );
      }
      if (!args.email && !args.domain && !args.anyone) {
        throw new Error('Pass `email`, `domain`, or anyone: true — who is this being shared with?');
      }
      if (args.role && !ROLES.includes(args.role)) {
        throw new Error(`role must be one of ${ROLES.join(', ')}.`);
      }

      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const permission = await drive.share(token, args.file_id, {
        email:  args.email,
        domain: args.domain,
        anyone: args.anyone,
        role:   args.role || 'reader',
        notify: Boolean(args.notify),
        message: args.message,
      });

      return text({ account: email, file_id: args.file_id, shared_with: permission });
    },
  },

  {
    name: 'trash_file',
    description: 'Move a file to the Drive trash, where it is recoverable for 30 days. Nothing here deletes permanently.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...FILE_PROP }, required: ['file_id'] },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const file = await drive.trashFile(token, args.file_id);
      return text({ account: email, ...file, status: 'moved to trash — recoverable for 30 days' });
    },
  },
];

module.exports = TOOLS;
