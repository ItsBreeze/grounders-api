const cron = require('node-cron');
const app  = require('./app');
const { reapDeletedUsers } = require('./jobs/reap_users');
const { migrate } = require('./db/migrate');

const PORT = process.env.PORT || 3000;

// Daily reaper — 3am UTC. Hard-deletes users past their 14-day window.
cron.schedule('0 3 * * *', () => {
  console.log('[reap_users] starting daily run');
  reapDeletedUsers();
}, { timezone: 'UTC' });

// Run idempotent schema migration before listening — safe to repeat.
migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Grounders API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    });
  })
  .catch(err => {
    console.error('[migrate] failed at boot:', err);
    process.exit(1);
  });
