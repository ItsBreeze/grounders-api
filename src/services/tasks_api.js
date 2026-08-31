/**
 * Thin Google Tasks v1 client.
 */

const http = require('./google_http');

const BASE = 'https://tasks.googleapis.com/tasks/v1';
const call = http.clientFor('Tasks API', BASE);

const encode = (id) => encodeURIComponent(String(id));

function summarizeTask(task, listId) {
  return {
    id:        task.id,
    list_id:   listId,
    title:     task.title || '(untitled)',
    notes:     task.notes || null,
    // Google stores due as an RFC 3339 timestamp but only honours the date part.
    due:       task.due ? task.due.slice(0, 10) : null,
    status:    task.status || 'needsAction',
    completed: task.status === 'completed',
    completed_at: task.completed || null,
    updated:   task.updated || null,
    parent:    task.parent || null,
  };
}

async function listTaskLists(accessToken) {
  const res = await call(accessToken, '/users/@me/lists', { query: { maxResults: 100 } });
  return (res.items || []).map(l => ({ id: l.id, title: l.title, updated: l.updated || null }));
}

/** The default list, resolved once so callers can omit list_id. */
async function defaultListId(accessToken) {
  const lists = await listTaskLists(accessToken);
  if (!lists.length) throw new Error('This account has no task lists.');
  return lists[0].id;
}

async function listTasks(accessToken, { listId, showCompleted = false, maxResults = 20, pageToken, dueMax } = {}) {
  const id  = listId || await defaultListId(accessToken);
  const res = await call(accessToken, `/lists/${encode(id)}/tasks`, {
    query: {
      maxResults:    Math.min(Math.max(maxResults, 1), 100),
      showCompleted: showCompleted ? 'true' : 'false',
      showHidden:    showCompleted ? 'true' : 'false',
      dueMax,
      pageToken,
    },
  });

  return {
    tasks: (res.items || []).map(t => summarizeTask(t, id)),
    nextPageToken: res.nextPageToken || null,
    list_id: id,
  };
}

/** Google wants an RFC 3339 timestamp; only the date part has any effect. */
const dueStamp = (due) => (due ? (/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T00:00:00.000Z` : due) : undefined);

async function createTask(accessToken, { listId, title, notes, due, parent }) {
  const id   = listId || await defaultListId(accessToken);
  const task = await call(accessToken, `/lists/${encode(id)}/tasks`, {
    method: 'POST',
    query:  { parent },
    body:   { title, ...(notes ? { notes } : {}), ...(due ? { due: dueStamp(due) } : {}) },
  });
  return summarizeTask(task, id);
}

async function updateTask(accessToken, { listId, taskId, title, notes, due, completed }) {
  const id = listId || await defaultListId(accessToken);

  const body = {
    ...(title !== undefined ? { title } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(due   !== undefined ? { due: due === null ? null : dueStamp(due) } : {}),
    // Clearing `completed` alongside the status is what actually reopens a task.
    ...(completed !== undefined
      ? (completed ? { status: 'completed' } : { status: 'needsAction', completed: null })
      : {}),
  };

  if (!Object.keys(body).length) throw new Error('Nothing to update — pass a field to change.');

  const task = await call(accessToken, `/lists/${encode(id)}/tasks/${encode(taskId)}`, {
    method: 'PATCH',
    body,
  });
  return summarizeTask(task, id);
}

async function deleteTask(accessToken, { listId, taskId }) {
  const id = listId || await defaultListId(accessToken);
  await call(accessToken, `/lists/${encode(id)}/tasks/${encode(taskId)}`, { method: 'DELETE' });
  return { list_id: id, task_id: taskId };
}

module.exports = {
  listTaskLists, listTasks, createTask, updateTask, deleteTask, defaultListId,
  _internal: { summarizeTask, dueStamp },
};
