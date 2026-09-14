const cron = require('node-cron');
const app  = require('./app');
const { reapDeletedUsers } = require('./jobs/reap_users');
const { sweepStaleClaims } = require('./services/radio_transcribe');
const { sweepStalePushes } = require('./services/offhand_push');
const { migrate } = require('./db/migrate');

const PORT = process.env.PORT || 3000;

// Daily reaper — 3am UTC. Hard-deletes users past their 14-day window.
cron.schedule('0 3 * * *', () => {
  console.log('[reap_users] starting daily run');
  reapDeletedUsers();
}, { timezone: 'UTC' });

// Hourly — the two jobs that clean up after a process that did not come back.
//
// sweepStaleClaims turns transcription claims abandoned by a dead process into
// 'failed', which is the state the app offers a retry on. Hourly rather than
// daily because the staleness window is ten minutes, not fourteen days; see
// services/radio_transcribe.sweepStaleClaims.
//
// sweepStalePushes does the harder half of the same job for a kept call on its
// way to Offhand: it re-runs the push rather than only marking it, because the
// phone deleted its copy of the recording the moment the upload finished and
// nothing else will ever try again. Same hour, same reasoning, and it gives up
// after a day into the connector flag rather than retrying forever. Neither
// throws at the scheduler, and both are inert on a deploy without the relevant
// credentials.
cron.schedule('30 * * * *', () => {
  sweepStaleClaims();
  sweepStalePushes();
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
