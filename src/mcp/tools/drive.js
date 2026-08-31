/**
 * Google Drive tools.
 *
 * Searching fans out across every linked account — one query over a personal
 * and a work Drive at the same time. Writes always name one account.
 */

const drive   = require('../../services/drive_api');
const extract = require('../../services/text_extract');
const {
  text, tokenFor, fanOut, mergeSearch, ACCOUNT_PROP, SEARCH_PROPS, checkPageToken,
} = require('../shared');

const DRIVE_PROP = {
  drive_id: {
    type: 'string',
    description: 'Restrict to one shared drive, by id from list_shared_drives. Omit to cover My Drive and every shared drive at once.',
  },
};

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
      domain: { type: 'string', description: 'Share with everyone at this Workspace domain instead. Requires confirm_public.' },
      anyone: { type: 'boolean', description: 'PUBLISH: anyone holding the link can open it, no sign-in. Requires confirm_public.' },
      confirm_public: { type: 'boolean', description: 'Confirms the user asked for access beyond a named person. Required with domain or anyone.' },
    }
  : {
      email:  { type: 'string', description: 'Person to share with, by email address.' },
    };

/**
 * Writes land on files you own.
 *
 * A file owned by someone else — or by an organisation, which is every file in
 * a shared drive — is not this connector's to change on a model's judgement.
 * The default is therefore to work on a private copy, which answers "fix the
 * typo in that spreadsheet" without touching the spreadsheet.
 *
 * The original is still reachable, because sometimes editing it is exactly what
 * was asked for. It just cannot happen in one step: `edit_original` returns a
 * draft of the change and applies nothing, and only a repeat with `confirm_edit`
 * writes. The point is that a person sees the specific change before it lands,
 * rather than being told afterwards which of their colleague's documents moved.
 */
async function resolveWrite(token, fileId, args, { copyable = false } = {}) {
  const target = await drive.writeTarget(token, fileId);

  if (target.owned_by_me)              return { target, mode: 'direct' };
  if (args.confirm_edit)               return { target, mode: 'direct' };
  if (copyable && !args.edit_original) return { target, mode: 'copy' };
  return { target, mode: 'draft' };
}

/** The shape of every "nothing happened yet" answer, so they read alike. */
const asDraft = (target, action, detail) => ({
  applied: false,
  status: 'DRAFT — nothing has been changed',
  reason: `"${target.name}" belongs to ${drive.describeHolder(target)}, not to this account.`,
  would: action,
  ...detail,
  to_apply: 'Show this to the user. If they approve, repeat the same call with confirm_edit: true.',
});

const OWNERSHIP_PROPS = {
  confirm_edit: {
    type: 'boolean',
    description:
      'The user has seen the draft of this change and approved it. Only ever set this after showing them ' +
      'what the draft said — it is their approval, not yours.',
  },
};

const EDIT_ORIGINAL_PROP = {
  edit_original: {
    type: 'boolean',
    description:
      "Act on someone else's file itself rather than on a private copy. Returns a draft of the change and " +
      'writes nothing; repeat with confirm_edit: true once the user approves.',
  },
};

const TOOLS = [
  {
    name: 'search_files',
    description:
      'Search Drive by text across file names and contents. Omit `account` to search EVERY linked Drive at ' +
      'once. Covers My Drive AND every shared drive the account belongs to; `drive_id` narrows to one shared ' +
      'drive. Add `filter` for Drive query syntax (mimeType, modifiedTime, starred, "\'me\' in owners"). ' +
      'Trashed files are excluded unless your filter says otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'Text to find in names and contents.' },
        filter: { type: 'string', description: "Raw Drive query, ANDed with the text, e.g. \"mimeType='application/pdf'\"." },
        ...DRIVE_PROP,
        ...SEARCH_PROPS,
      },
    },
    handler: async ({ ownerKey, args }) => {
      checkPageToken(args);
      if (!args.query && !args.filter) throw new Error('Pass `query`, `filter`, or both.');

      const fanned = await fanOut(ownerKey, args.account, 'drive', async (token) => {
        const found = await drive.searchFiles(token, {
          query:      args.query,
          filter:     args.filter,
          driveId:    args.drive_id,
          maxResults: args.max_results || 10,
          pageToken:  args.page_token,
        });
        return { ...found, files: await drive.nameSharedDrives(token, found.files) };
      });

      return text(mergeSearch(fanned, { key: 'files', dateField: 'modified' }));
    },
  },

  {
    name: 'list_recent_files',
    description:
      'Most recently modified files, newest first, across My Drive and every shared drive. Omit `account` to ' +
      'merge every linked Drive.',
    inputSchema: { type: 'object', properties: { ...DRIVE_PROP, ...SEARCH_PROPS } },
    handler: async ({ ownerKey, args }) => {
      checkPageToken(args);
      const fanned = await fanOut(ownerKey, args.account, 'drive', async (token) => {
        const found = await drive.listRecent(token, {
          maxResults: args.max_results || 10,
          pageToken:  args.page_token,
          driveId:    args.drive_id,
        });
        return { ...found, files: await drive.nameSharedDrives(token, found.files) };
      });

      return text(mergeSearch(fanned, { key: 'files', dateField: 'modified' }));
    },
  },

  {
    name: 'list_shared_drives',
    description:
      'Shared drives (Team Drives) this account belongs to — the drives owned by an organisation rather than ' +
      'by a person. Omit `account` to list them across every linked account. Use an id here as `drive_id` to ' +
      'confine a search to one drive.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP } },
    handler: async ({ ownerKey, args }) => {
      const fanned = await fanOut(ownerKey, args.account, 'drive', async token =>
        ({ drives: await drive.listDrives(token) }));

      return text(mergeSearch(fanned, { key: 'drives' }));
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
      'Read a file as text. Handles Google Docs, Sheets and Slides (exported, Sheets as CSV), ' +
      'PDFs, Word, Excel, PowerPoint and OpenDocument files, and plain text, Markdown, JSON, CSV and code. ' +
      'Capped at 60 KB with the cut flagged. If a PDF turns out to be a scan, or an image needs reading, ' +
      'retry with ocr: true — that routes it through Google\'s own conversion.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...FILE_PROP,
        ocr: {
          type: 'boolean',
          description: 'Read via Google conversion, which OCRs scans and images. Makes a temporary copy in ' +
                       'the account\'s Drive and deletes it afterwards. Use when a normal read reports no text layer.',
        },
        include_comments: {
          type: 'boolean',
          description: 'Also return the comment threads on the document, with replies and the text each is anchored to.',
        },
      },
      required: ['file_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');

      const comments = args.include_comments
        ? await drive.listComments(token, args.file_id).catch(err => ({ error: err.message }))
        : null;
      const commentField = comments
        ? { comments: Array.isArray(comments) ? comments : [], ...(comments.error ? { comments_error: comments.error } : {}) }
        : {};

      if (args.ocr) {
        const converted = await drive.ocrViaConversion(token, args.file_id);
        return text({
          account: email,
          name: converted.name,
          mime_type: converted.source_mime_type,
          read_via: 'Google Drive conversion (OCR)',
          ...commentField,
          ...(converted.orphaned_copy
            ? { warning: `The temporary copy ${converted.orphaned_copy} could not be deleted — remove it manually.` }
            : {}),
          content: drive._internal.truncateText(converted.text || ''),
        });
      }

      const { meta, data, mimeType, exported } = await drive.getContent(token, args.file_id);
      const result = extract.extract(data, { mimeType, filename: meta.name });

      if (result.text === null) {
        throw new Error(
          `"${meta.name}": ${result.reason}` +
          (result.recoverable ? '' : ' Use download_file_content to get the raw bytes instead.'),
        );
      }

      return text({
        account: email,
        name: meta.name,
        mime_type: mimeType,
        ...(exported ? { exported_from: meta.mime_type } : {}),
        ...(result.kind !== 'text' ? { read_as: result.kind } : {}),
        ...(result.pages ? { pages: result.pages } : {}),
        ...commentField,
        content: drive._internal.truncateText(result.text),
      });
    },
  },

  {
    name: 'download_file_content',
    description:
      'Download a file as base64 — PDFs, images, archives, anything not text. 2 MB limit. ' +
      'For a Google Doc, Sheet or Slides, `export_as` converts it on the way out: pdf, docx, xlsx, pptx, ' +
      'csv, html, md and more. That is how you turn a Doc into a PDF or a Sheet into a spreadsheet file.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...FILE_PROP,
        export_as: {
          type: 'string',
          enum: Object.keys(drive.EXPORT_FORMATS),
          description: 'Convert a Google-native document to this format on the way out.',
        },
      },
      required: ['file_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const { meta, data, mimeType } = await drive.getContent(token, args.file_id, { exportAs: args.export_as });

      return text({
        account: email,
        name: meta.name,
        mime_type: mimeType,
        ...(args.export_as ? { exported_from: meta.mime_type } : {}),
        size_bytes: data.length,
        base64: data.toString('base64'),
      });
    },
  },

  {
    name: 'create_file',
    description:
      'Create a file in Drive. Text goes in `content`; binary (an image, a PDF) goes in `content_base64`. ' +
      'Set convert_to: "document" | "spreadsheet" | "presentation" to have Drive convert the upload into an ' +
      'editable Google Doc, Sheet or Slides — HTML or Markdown makes a good Doc, CSV a good Sheet. ' +
      'convert_to: "folder" with no content makes a folder. Omit content entirely for an empty file.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        name:           { type: 'string' },
        content:        { type: 'string', description: 'Text content.' },
        content_base64: { type: 'string', description: 'Binary content, base64-encoded. Use instead of `content`.' },
        mime_type:      { type: 'string', description: 'Type of the content being uploaded. Defaults to text/plain.' },
        convert_to:     { type: 'string', enum: ['document', 'spreadsheet', 'presentation', 'folder'],
                          description: 'Convert the upload into this Google-native type.' },
        description:    { type: 'string' },
        parents:        { type: 'array', items: { type: 'string' }, description: 'Folder ids to create it in.' },
      },
      required: ['name'],
    },
    handler: async ({ ownerKey, args }) => {
      if (args.content !== undefined && args.content_base64 !== undefined) {
        throw new Error('Pass `content` or `content_base64`, not both.');
      }

      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const file = await drive.createFile(token, {
        name:          args.name,
        content:       args.content,
        contentBase64: args.content_base64,
        mimeType:      args.mime_type || 'text/plain',
        convertTo:     args.convert_to,
        description:   args.description,
        parents:       args.parents,
      });
      return text({ account: email, created: true, ...file });
    },
  },

  {
    name: 'update_file',
    description:
      'Rename a file, change its description, or move it between folders. ' +
      'Replacing the contents is possible but deliberately awkward: it needs BOTH `content` and ' +
      'replace_content: true, so a rename can never overwrite a document by accident. ' +
      'ON A FILE YOU DO NOT OWN this edits a private copy instead and tells you so; to change the ' +
      'original, pass edit_original: true to get a draft, show it to the user, and only then confirm_edit.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...FILE_PROP,
        name:            { type: 'string' },
        content:         { type: 'string', description: 'New text content. Requires replace_content: true.' },
        content_base64:  { type: 'string', description: 'New binary content, base64-encoded. Requires replace_content: true.' },
        replace_content: { type: 'boolean', description: 'Confirms that the new content should overwrite what is in the file now.' },
        mime_type:       { type: 'string' },
        description:     { type: 'string' },
        add_parents:    { type: 'string', description: 'Folder id to move it into.' },
        remove_parents: { type: 'string', description: 'Folder id to move it out of.' },
        ...EDIT_ORIGINAL_PROP,
        ...OWNERSHIP_PROPS,
      },
      required: ['file_id'],
    },
    handler: async ({ ownerKey, args }) => {
      if ((args.content !== undefined || args.content_base64 !== undefined) && !args.replace_content) {
        throw new Error(
          'Replacing a file\'s contents needs replace_content: true alongside the new content. ' +
          'To rename or move it instead, pass `name` or add_parents and leave the content out.',
        );
      }
      if (args.content !== undefined && args.content_base64 !== undefined) {
        throw new Error('Pass `content` or `content_base64`, not both.');
      }

      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');

      const changes = {
        name:          args.name,
        content:       args.content,
        contentBase64: args.content_base64,
        mimeType:      args.mime_type,
        description:   args.description,
        addParents:    args.add_parents,
        removeParents: args.remove_parents,
      };

      const { target, mode } = await resolveWrite(token, args.file_id, args, { copyable: true });

      if (mode === 'draft') {
        return text(asDraft(target, `edit "${target.name}" itself`,
          await drive.draftEdit(token, target, changes)));
      }

      if (mode === 'copy') {
        const copy = await drive.copyToMyDrive(token, args.file_id, { name: args.name || `${target.name} (copy)` });
        const file = await drive.updateFile(token, copy.id, { ...changes, name: undefined });

        return text({
          account: email,
          updated: true,
          edited_a_private_copy: true,
          note: `"${target.name}" belongs to ${drive.describeHolder(target)}, so it was left untouched. ` +
                'A copy was made in your My Drive and the change applied there. ' +
                'To change the original instead, repeat with edit_original: true for a draft.',
          original: { file_id: target.id, name: target.name, owners: target.owners },
          ...file,
        });
      }

      const file = await drive.updateFile(token, args.file_id, changes);
      return text({
        account: email,
        updated: true,
        ...(target.owned_by_me ? {} : { edited_someone_elses_file: drive.describeHolder(target) }),
        ...file,
      });
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
        ...OWNERSHIP_PROPS,
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
      if ((args.domain || args.anyone) && !args.confirm_public) {
        throw new Error(
          'Sharing beyond a named person needs confirm_public: true. ' +
          (args.anyone
            ? 'anyone: true means everyone holding the URL can open it, with no sign-in'
            : `domain sharing means everyone at ${args.domain}`) +
          ' — check that is what the user asked for, then repeat the call with confirm_public: true. ' +
          'unshare_file undoes it.',
        );
      }
      if (!args.email && !args.domain && !args.anyone) {
        throw new Error('Pass `email`, `domain`, or anyone: true — who is this being shared with?');
      }
      if (args.role && !ROLES.includes(args.role)) {
        throw new Error(`role must be one of ${ROLES.join(', ')}.`);
      }

      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const { target, mode } = await resolveWrite(token, args.file_id, args);

      // Widening access to a document that is not yours is the case this guard
      // exists for. Sharing a copy instead would spread their content further,
      // not less, so there is no copy path — only a draft.
      if (mode === 'draft') {
        return text(asDraft(target,
          `give ${args.email || args.domain || 'anyone with the link'} ${args.role || 'reader'} access to ` +
          `"${target.name}", which you do not own`,
          { file: { name: target.name, owners: target.owners, shared_drive_id: target.shared_drive_id } }));
      }

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
    name: 'comment_on_file',
    description:
      'Leave a comment on a document, or reply to an existing thread with reply_to. Use it to raise a ' +
      'question against a draft without editing it — the review path that changes nothing. ' +
      'read_file_content with include_comments: true shows the threads and their ids.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...FILE_PROP,
        content:  { type: 'string', description: 'The comment text.' },
        reply_to: { type: 'string', description: 'Comment id to reply to, from read_file_content with include_comments.' },
      },
      required: ['file_id', 'content'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const comment = await drive.addComment(token, args.file_id, {
        content: args.content,
        replyTo: args.reply_to,
      });
      return text({ account: email, file_id: args.file_id, posted: true, ...comment });
    },
  },

  {
    name: 'unshare_file',
    description:
      'Withdraw access previously granted: from one person by email, from a domain, or by removing the ' +
      'public link entirely (public: true). Name the holder or pass a permission_id from ' +
      'get_file_permissions. This is the undo for share_file — reach for it whenever a file turned out ' +
      'to be shared more widely than intended.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...FILE_PROP,
        email:         { type: 'string', description: 'Revoke this person\'s access.' },
        domain:        { type: 'string', description: 'Revoke a whole domain\'s access.' },
        public:        { type: 'boolean', description: 'Remove the "anyone with the link" permission.' },
        permission_id: { type: 'string', description: 'Exact permission to remove, from get_file_permissions.' },
      },
      required: ['file_id'],
    },
    handler: async ({ ownerKey, args }) => {
      if (!args.email && !args.domain && !args.public && !args.permission_id) {
        throw new Error('Pass `email`, `domain`, public: true, or a `permission_id` — whose access is being removed?');
      }

      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const result = await drive.unshare(token, args.file_id, {
        permissionId: args.permission_id,
        email:        args.email,
        domain:       args.domain,
        publicLink:   args.public,
      });

      return text({ account: email, file_id: args.file_id, revoked: true, ...result });
    },
  },

  {
    name: 'untrash_file',
    description: 'Restore a file from the Drive trash. The undo for trash_file, within the 30-day window.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...FILE_PROP }, required: ['file_id'] },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const file = await drive.untrashFile(token, args.file_id);
      return text({ account: email, ...file, status: 'restored from trash' });
    },
  },

  {
    name: 'trash_file',
    description:
      'Move a file to the Drive trash, where it is recoverable for 30 days. Nothing here deletes permanently. ' +
      'On a file you do not own this returns a draft and removes nothing until confirm_edit is passed.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, ...FILE_PROP, ...OWNERSHIP_PROPS },
      required: ['file_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'drive');
      const { target, mode } = await resolveWrite(token, args.file_id, args);

      // No copy path here: copying a file does not stand in for removing it.
      if (mode === 'draft') {
        return text(asDraft(target, `move "${target.name}" to the trash, removing it from everyone who uses it`,
          { file: { name: target.name, owners: target.owners, shared_drive_id: target.shared_drive_id } }));
      }

      const file = await drive.trashFile(token, args.file_id);
      return text({ account: email, ...file, status: 'moved to trash — recoverable for 30 days' });
    },
  },
];

module.exports = TOOLS;
