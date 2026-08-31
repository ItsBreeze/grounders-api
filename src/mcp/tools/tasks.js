/**
 * Google Tasks tools.
 *
 * `list_id` is optional everywhere: omitted, it means the account's default
 * list, which is what "add a task" almost always means.
 */

const tasks = require('../../services/tasks_api');
const { text, tokenFor, fanOut, mergeSearch, ACCOUNT_PROP } = require('../shared');

const LIST_PROP = { list_id: { type: 'string', description: 'Task list to use. Defaults to the account\'s first list.' } };

const TOOLS = [
  {
    name: 'list_task_lists',
    description: 'The task lists on one account, or on every linked account when `account` is omitted.',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string', description: 'Account to list. Omit for all linked accounts.' } },
    },
    handler: async ({ ownerKey, args }) => {
      const { targets, ok, failed } = await fanOut(ownerKey, args.account, 'tasks', token =>
        tasks.listTaskLists(token));

      const lists = ok.flatMap(({ email, value }) => value.map(l => ({ account: email, ...l })));
      if (!lists.length && failed.length) throw new Error(`All accounts failed — ${failed.join('; ')}`);

      return text({
        searched: targets,
        ...(failed.length ? { errors: failed } : {}),
        count: lists.length,
        task_lists: lists,
      });
    },
  },

  {
    name: 'list_tasks',
    description:
      'Open tasks, soonest due first. Omit `account` to merge every linked account\'s list into one ' +
      'to-do list. Completed tasks are hidden unless show_completed is true.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LIST_PROP,
        account:        { type: 'string', description: 'Account to read. Omit for all linked accounts.' },
        show_completed: { type: 'boolean', description: 'Include finished tasks. Default false.' },
        due_before:     { type: 'string', description: 'Only tasks due before this date (YYYY-MM-DD).' },
        max_results:    { type: 'number', description: 'Max tasks per account (1-100, default 20).' },
      },
    },
    handler: async ({ ownerKey, args }) => {
      const dueMax = args.due_before
        ? (/^\d{4}-\d{2}-\d{2}$/.test(args.due_before) ? `${args.due_before}T23:59:59.999Z` : args.due_before)
        : undefined;

      const fanned = await fanOut(ownerKey, args.account, 'tasks', token =>
        tasks.listTasks(token, {
          listId:        args.list_id,
          showCompleted: Boolean(args.show_completed),
          maxResults:    args.max_results || 20,
          dueMax,
        }));

      const merged = mergeSearch(fanned, { key: 'tasks' });
      // Soonest due first, with undated tasks last rather than pretending to be urgent.
      merged.tasks.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));

      return text(merged);
    },
  },

  {
    name: 'create_task',
    description: 'Add a task. `due` is a date (YYYY-MM-DD) — Google Tasks ignores any time of day on it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...LIST_PROP,
        title:  { type: 'string' },
        notes:  { type: 'string' },
        due:    { type: 'string', description: 'YYYY-MM-DD.' },
        parent: { type: 'string', description: 'Task id to nest this under as a subtask.' },
      },
      required: ['title'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'tasks');
      const task = await tasks.createTask(token, {
        listId: args.list_id, title: args.title, notes: args.notes, due: args.due, parent: args.parent,
      });
      return text({ account: email, created: true, ...task });
    },
  },

  {
    name: 'update_task',
    description:
      'Change a task, or tick it off with completed: true (completed: false reopens it). ' +
      'Only the fields you pass are touched.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        ...LIST_PROP,
        task_id:   { type: 'string' },
        title:     { type: 'string' },
        notes:     { type: 'string' },
        due:       { type: 'string', description: 'YYYY-MM-DD, or null to clear the due date.' },
        completed: { type: 'boolean', description: 'true ticks it off, false reopens it.' },
      },
      required: ['task_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'tasks');
      const task = await tasks.updateTask(token, {
        listId: args.list_id, taskId: args.task_id,
        title: args.title, notes: args.notes, due: args.due, completed: args.completed,
      });
      return text({ account: email, updated: true, ...task });
    },
  },

  {
    name: 'delete_task',
    description: 'Delete a task outright. Unlike mail and Drive, Google Tasks has no trash — this is permanent.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, ...LIST_PROP, task_id: { type: 'string' } },
      required: ['task_id'],
    },
    handler: async ({ ownerKey, args }) => {
      const { email, token } = await tokenFor(ownerKey, args.account, 'tasks');
      const removed = await tasks.deleteTask(token, { listId: args.list_id, taskId: args.task_id });
      return text({ account: email, ...removed, deleted: true, note: 'Google Tasks has no trash — this cannot be undone.' });
    },
  },
];

module.exports = TOOLS;
