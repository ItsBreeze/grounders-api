/**
 * GET /users/:id/friends must not carry phone numbers.
 *
 * Any signed-in user can call it for any target, so a phone column in that
 * response would let one user harvest every number in someone else's friend
 * list. The client never read it. Postgres returns exactly the columns the
 * SELECT names, so the SQL that goes over the wire is the contract — the
 * checks below read it off the stubbed pool, then confirm the JSON follows.
 */

const jwt = require('jsonwebtoken');
const { boot, check, run } = require('./harness');

const ME     = 'user-me';
const TARGET = 'user-a';
const FRIEND = { id: 'user-b', display_name: 'Bee', is_mutual: true };

run('friends_phone', async () => {
  const h = await boot();
  h.setQueryHandler((text) =>
    (/FROM friendships f\s+JOIN users u/.test(text) ? { rows: [FRIEND] } : { rows: [] }));

  const anon = await h.request('GET', `/users/${TARGET}/friends`);
  check('friends list without a token is 401', anon.status === 401, anon.status);
  check('no SQL ran for the anonymous request', h.queries.length === 0, h.queries.length);

  const token = jwt.sign({ sub: ME }, process.env.JWT_SECRET);
  const res = await h.request('GET', `/users/${TARGET}/friends`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check('friends list with a token is 200 with an array',
    res.status === 200 && Array.isArray(res.json), { status: res.status, body: res.json });

  const sql = h.queries[0];
  check('exactly one query went to the pool', h.queries.length === 1 && !!sql, h.queries.length);
  check('that query is the friendships join', !!sql && /FROM friendships f\s+JOIN users u/.test(sql.text));
  check('that query does not select phone (or email)',
    !!sql && !/\b(phone|email)\b/i.test(sql.text), sql && sql.text);
  check('that query still selects id, display_name and is_mutual',
    !!sql && /u\.id,/.test(sql.text) && /u\.display_name,/.test(sql.text) && /AS is_mutual/.test(sql.text));
  check('that query is parameterised as [me, target]',
    !!sql && sql.params[0] === ME && sql.params[1] === TARGET, sql && sql.params);

  check('response rows carry no phone',
    Array.isArray(res.json) && res.json.length === 1 && !('phone' in res.json[0]), res.json);
  check('response rows keep id, display_name, is_mutual',
    Array.isArray(res.json) && res.json[0] && res.json[0].id === FRIEND.id
      && res.json[0].display_name === FRIEND.display_name && res.json[0].is_mutual === true, res.json);

  await h.close();
});
