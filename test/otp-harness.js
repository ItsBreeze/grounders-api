/**
 * Mounts the real auth router over an in-memory stand-in for pg, so the OTP
 * flow can be exercised without a database. The stub understands only the
 * handful of statements auth.js issues; anything else throws rather than
 * silently returning no rows, which would look like a passing test.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POOL = require.resolve(path.join(ROOT, 'src/db/pool.js'));

function startAuthServer() {
  const otps = [], users = [];

  const stub = {
    query: async (sql, params = []) => {
      const q = sql.replace(/\s+/g, ' ').trim();

      if (q.startsWith('INSERT INTO otps')) {
        otps.push({
          id: params[0], target: params[1], code_hash: params[2],
          expires_at: params[3], used: false,
          // Monotonic, so newest-first ordering is deterministic even when two
          // codes are issued inside the same millisecond — which is the case
          // the race regression below depends on.
          created_at: new Date(Date.now() + otps.length),
        });
        return { rows: [] };
      }
      if (q.startsWith('SELECT * FROM otps')) {
        const limit = /LIMIT (\d+)/.exec(q);
        const rows = otps
          .filter((o) => o.target === params[0] && !o.used && o.expires_at > new Date())
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, limit ? Number(limit[1]) : 1);
        return { rows };
      }
      if (/^UPDATE otps SET used = true WHERE target/.test(q)) {
        otps.forEach((o) => { if (o.target === params[0] && !o.used) o.used = true; });
        return { rows: [] };
      }
      if (/^UPDATE otps SET used = true WHERE id/.test(q)) {
        otps.forEach((o) => { if (o.id === params[0]) o.used = true; });
        return { rows: [] };
      }
      if (q.startsWith('SELECT * FROM users')) {
        const col = q.includes('phone') ? 'phone' : 'email';
        return { rows: users.filter((u) => u[col] === params[0]) };
      }
      if (q.startsWith('INSERT INTO users')) {
        const col = q.includes('phone') ? 'phone' : 'email';
        const u = {
          id: params[0], display_name: params[1], [col]: params[2],
          total_distance_m: 0, created_at: new Date(),
        };
        users.push(u);
        return { rows: [u] };
      }
      if (q.startsWith('UPDATE users')) return { rows: [] };
      if (q.startsWith('DELETE FROM refresh_tokens')) return { rows: [] };
      if (q.startsWith('INSERT INTO refresh_tokens')) return { rows: [] };

      throw new Error('unstubbed SQL: ' + q.slice(0, 120));
    },
  };

  require.cache[POOL] = {
    id: POOL, filename: POOL, loaded: true, exports: stub, children: [], paths: [],
  };

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/auth', require(path.join(ROOT, 'src/routes/auth.js')));
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0);
  const ready = new Promise((resolve) => server.once('listening', resolve));

  const post = async (p, body) => {
    await ready;
    const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  return { post, close: () => server.close(), otps };
}

module.exports = { startAuthServer };
