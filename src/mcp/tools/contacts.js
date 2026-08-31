/**
 * Google Contacts tools, read-only.
 *
 * These exist to turn a name into an address before sending mail or an
 * invitation. Searching fans out, because the person you mean may be a saved
 * contact on one account and only a past correspondent on another.
 */

const people = require('../../services/people_api');
const { text, fanOut, mergeSearch, SEARCH_PROPS } = require('../shared');

const TOOLS = [
  {
    name: 'search_contacts',
    description:
      'Find someone by name, email or company across saved contacts AND people the account has corresponded ' +
      'with. Omit `account` to search every linked account. Use this to resolve "email Ann" into an address ' +
      'rather than guessing one.',
    inputSchema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Name, partial email, or company.' },
        account: { type: 'string', description: 'Account to search. Omit for all linked accounts.' },
        max_results: { type: 'number', description: 'Max people per account (1-30, default 10).' },
      },
      required: ['query'],
    },
    handler: async ({ ownerKey, args }) => {
      const fanned = await fanOut(ownerKey, args.account, 'contacts', token =>
        people.searchContacts(token, { query: args.query, maxResults: args.max_results || 10 }));

      return text(mergeSearch(fanned, { key: 'people' }));
    },
  },

  {
    name: 'list_contacts',
    description: 'Recently updated contacts. Omit `account` to merge every linked address book.',
    inputSchema: { type: 'object', properties: { ...SEARCH_PROPS } },
    handler: async ({ ownerKey, args }) => {
      const fanned = await fanOut(ownerKey, args.account, 'contacts', token =>
        people.listContacts(token, { maxResults: args.max_results || 25, pageToken: args.page_token }));

      return text(mergeSearch(fanned, { key: 'people' }));
    },
  },
];

module.exports = TOOLS;
