/**
 * Grounders — wipe every post
 *
 * Removes ALL posts from the database, every user's included: the public
 * test's worth. Written for the one-off "clear the test data" job, not for
 * routine operation.
 *
 * Run with:
 *   node src/scripts/wipe-posts.js             — dry run, counts only, no writes
 *   node src/scripts/wipe-posts.js --confirm   — actually deletes
 *
 * Without --confirm the script opens no transaction and issues no write.
 *
 * What it removes, matching what DELETE /posts/:id does for a single post
 * (src/routes/posts.js):
 *
 *   - reactions on those posts   (FK ON DELETE CASCADE — deleted explicitly
 *   - reports  about those posts  here as well, so the summary can count them
 *                                 and so the script survives a schema change
 *                                 that drops the cascade)
 *   - the posts themselves, archived ones included
 *   - users.total_distance_m / last_post_lat / last_post_lng / last_post_at
 *
 * The per-user distance recomputation in the single-post delete walks the
 * author's remaining posts. Here no post survives, so the recomputation
 * collapses to zeroing those four columns for everyone — one UPDATE, no loop.
 *
 * It does NOT delete the media behind posts.media_url / media_thumb_url from
 * Cloudflare R2. Neither does DELETE /posts/:id; the objects are orphaned
 * either way and are cleaned up out of band.
 *
 * Everything is one transaction: either every post is gone and every
 * aggregate is zeroed, or nothing changed.
 */

require('dotenv').config();

// Fail before touching pg if there is nothing to connect to — an unset
// DATABASE_URL otherwise becomes a confusing "connect ECONNREFUSED
// 127.0.0.1:5432" against whatever happens to be on localhost.
if (!process.env.DATABASE_URL) {
  console.error('wipe-posts: DATABASE_URL is not set — refusing to run.');
  console.error('Set it in .env, or run through Railway: railway run node src/scripts/wipe-posts.js');
  process.exit(1);
}

const pool = require('../db/pool');

const CONFIRM = process.argv.includes('--confirm');

// Host and database name only — never the credentials in DATABASE_URL.
function describeTarget(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function counts(client) {
  const { rows: [totals] } = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM posts)                                   AS posts,
       (SELECT COUNT(*)::int FROM posts WHERE archived_at IS NOT NULL)     AS archived,
       (SELECT COUNT(*)::int FROM reactions r
          JOIN posts p ON p.id = r.post_id)                                AS reactions,
       (SELECT COUNT(*)::int FROM reports rp
          JOIN posts p ON p.id = rp.post_id)                               AS reports,
       (SELECT COUNT(*)::int FROM posts
         WHERE COALESCE(media_url, '') <> ''
            OR COALESCE(media_thumb_url, '') <> '')                        AS media_objects,
       (SELECT COUNT(*)::int FROM users
         WHERE total_distance_m <> 0
            OR last_post_lat IS NOT NULL
            OR last_post_lng IS NOT NULL
            OR last_post_at  IS NOT NULL)                                  AS users_with_aggregates`
  );

  const { rows: perUser } = await client.query(
    `SELECT u.id,
            u.display_name,
            CAST(COUNT(p.id) AS int)                                          AS post_count,
            CAST(COUNT(p.id) FILTER (WHERE p.archived_at IS NOT NULL) AS int) AS archived_count,
            u.total_distance_m,
            MAX(p.posted_at)                                                  AS last_post_at
       FROM users u
       JOIN posts p ON p.user_id = u.id
      GROUP BY u.id, u.display_name, u.total_distance_m
      ORDER BY COUNT(p.id) DESC, u.display_name`
  );

  return { totals, perUser };
}

function printSummary({ totals, perUser }) {
  console.log(`Authors with posts:        ${perUser.length}`);
  console.log('');
  for (const u of perUser) {
    const name = (u.display_name || '').trim() || '(no name)';
    const archived = u.archived_count ? ` (${u.archived_count} archived)` : '';
    const last = u.last_post_at ? new Date(u.last_post_at).toISOString().slice(0, 10) : '—';
    console.log(
      `  ${String(u.post_count).padStart(5)} posts${archived.padEnd(16)}` +
      `${Math.round(Number(u.total_distance_m) || 0).toString().padStart(9)} m   ` +
      `last ${last}   ${name}  [${u.id}]`
    );
  }
  console.log('');
  console.log(`Posts:                     ${totals.posts} (${totals.archived} archived)`);
  console.log(`Reactions on them:         ${totals.reactions}`);
  console.log(`Reports about them:        ${totals.reports}`);
  console.log(`Users to reset to zero:    ${totals.users_with_aggregates}`);
  console.log(`R2 objects left orphaned:  ${totals.media_objects} (media is not deleted by this script)`);
}

async function wipePosts() {
  const client = await pool.connect();
  try {
    console.log(`Target database: ${describeTarget(process.env.DATABASE_URL)}`);
    console.log(CONFIRM ? 'Mode: DELETE (--confirm)' : 'Mode: dry run (no --confirm)');
    console.log('');

    const before = await counts(client);
    printSummary(before);
    console.log('');

    if (!CONFIRM) {
      console.log('Dry run — nothing was deleted and no transaction was opened.');
      console.log('Re-run with --confirm to delete everything listed above.');
      return;
    }

    if (before.totals.posts === 0) {
      console.log('No posts to delete — nothing to do.');
      return;
    }

    await client.query('BEGIN');

    // Children first. Both cascade from posts anyway; deleting them here
    // gives an exact rowCount for the summary and keeps the script correct
    // if a cascade is ever dropped. (The reactions delete fires the
    // posts.reaction_count trigger on rows that are about to disappear —
    // wasted work, no effect.)
    const rx = await client.query(`DELETE FROM reactions WHERE post_id IN (SELECT id FROM posts)`);
    const rp = await client.query(`DELETE FROM reports   WHERE post_id IN (SELECT id FROM posts)`);
    const ps = await client.query(`DELETE FROM posts`);

    // Every post is gone, so the per-author recomputation is a constant.
    const us = await client.query(
      `UPDATE users
          SET total_distance_m = 0,
              last_post_lat    = NULL,
              last_post_lng    = NULL,
              last_post_at     = NULL
        WHERE total_distance_m <> 0
           OR last_post_lat IS NOT NULL
           OR last_post_lng IS NOT NULL
           OR last_post_at  IS NOT NULL`
    );

    const { rows: [{ remaining }] } = await client.query(
      `SELECT COUNT(*)::int AS remaining FROM posts`
    );
    if (remaining !== 0) {
      throw new Error(`${remaining} posts still present after the delete — rolling back`);
    }

    await client.query('COMMIT');

    console.log(`Deleted ${ps.rowCount} posts, ${rx.rowCount} reactions, ${rp.rowCount} reports.`);
    console.log(`Reset distance/last-post columns on ${us.rowCount} users.`);
    console.log('Done ✓');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// CLI only — this script has no library use.
if (require.main === module) {
  wipePosts()
    .then(() => pool.end())
    .catch(err => {
      console.error('wipe-posts failed:', err.message);
      pool.end();
      process.exit(1);
    });
}

module.exports = { wipePosts };
