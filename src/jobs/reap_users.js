/**
 * Reaper job — hard-deletes users whose 14-day soft-delete window has
 * elapsed. Cascades through posts, reactions, friends, zones, devices,
 * refresh tokens via FK ON DELETE CASCADE.
 *
 * Wired into a daily node-cron schedule in src/server.js (3am UTC).
 */

const pool = require('../db/pool');

async function reapDeletedUsers() {
  try {
    const { rows } = await pool.query(
      `DELETE FROM users
         WHERE deletion_pending_at IS NOT NULL
           AND deletion_pending_at < NOW() - INTERVAL '14 days'
         RETURNING id`
    );
    if (rows.length > 0) {
      console.log(`[reap_users] hard-deleted ${rows.length} users`);
    }
    return rows.length;
  } catch (err) {
    console.error('[reap_users] failed:', err.message);
    return 0;
  }
}

module.exports = { reapDeletedUsers };
