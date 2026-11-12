// The scheduled-handler cron strings, which must equal hub/wrangler.jsonc `triggers.crons`
// (asserted in worker-cron.test.ts). They live here rather than in worker.ts because workerd
// rejects any named export of the entry module that is not a handler or class.

// Observability watchdog plus catalog reconcile.
export const WATCHDOG_CRON = '*/15 * * * *';

// Daily maintenance. Minute 37 keeps it out of every quarter-hour watchdog minute.
export const DAILY_CRON = '37 4 * * *';
