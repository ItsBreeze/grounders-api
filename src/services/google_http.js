/**
 * Shared HTTP for every Google API this server talks to.
 *
 * Gmail, Calendar, Drive, People and Tasks are five different hosts with the
 * same conventions: bearer auth, JSON in and out, and an error body whose
 * `error.message` is the only part worth surfacing. This is that, once.
 *
 * Deliberately dependency-free — Node's global fetch is enough, and pulling in
 * googleapis for these endpoints would be a large tree for no gain.
 */

/**
 * Build a Google API URL.
 *
 * Array values become repeated parameters, not a comma-joined one: Gmail
 * expects metadataHeaders=From&metadataHeaders=Subject&… and silently returns
 * a message with no headers at all if given "From,Subject" as a single value.
 * Drive and People have the same convention for their repeated fields.
 */
function buildUrl(base, path, query) {
  const url = new URL(`${base}${path}`);
  if (!query) return url;

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;

    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

/**
 * One Google API call.
 *
 * `raw: true` returns a Buffer instead of parsed JSON — file downloads and
 * attachment bytes come back as octets, not JSON.
 */
async function call(label, base, accessToken, path, { method = 'GET', query, body, headers, raw } = {}) {
  const url = buildUrl(base, path, query);

  // A Buffer or string is already the wire format — only an object gets
  // serialised. Re-encoding an upload buffer as UTF-8 would corrupt every
  // byte above 127.
  const prepared = body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: prepared } : {}),
  });

  if (!res.ok) {
    const text   = await res.text().catch(() => '');
    let   detail = `HTTP ${res.status}`;
    try { detail = JSON.parse(text).error?.message || detail; } catch { /* keep status */ }
    throw new Error(`${label} ${method} ${path}: ${detail}`);
  }

  if (res.status === 204) return null;
  if (raw) return Buffer.from(await res.arrayBuffer());

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** A client bound to one API: `client('/files', { query })` and nothing else. */
function clientFor(label, base) {
  const bound = (accessToken, path, opts) => call(label, base, accessToken, path, opts);
  bound.url   = (path, query) => buildUrl(base, path, query);
  return bound;
}

/**
 * Async map with bounded concurrency.
 *
 * Google meters quota per user per second — a Gmail threads.get costs 10 units
 * against a 250/s ceiling — so firing 50 detail fetches at once buys 429s,
 * not speed.
 */
async function mapLimit(items, limit, run) {
  const out = new Array(items.length);
  let next  = 0;

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  }));

  return out;
}

// How many per-item detail fetches to have in flight at once. See mapLimit.
const DETAIL_CONCURRENCY = 5;

module.exports = { buildUrl, call, clientFor, mapLimit, DETAIL_CONCURRENCY };
