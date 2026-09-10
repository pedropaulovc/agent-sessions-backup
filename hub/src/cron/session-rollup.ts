import { runSessionRollup } from '../session-rollup';

/** At most 80 pages: <= 4 round trips/page plus the final pending count, leaving room for
 * the nightly pricing pass and prunes in the same 04:30 invocation. Giant sessions resume
 * next night rather than being skipped or starting over. No preview cron is enabled here. */
export async function runDailySessionRollup(env: Env): Promise<void> {
  const started = Date.now();
  try {
    const result = await runSessionRollup(env.DB, { maxBlocks: 20_000, maxPages: 80, pageSize: 250 });
    console.log(JSON.stringify({ event: 'hub.session_rollup.daily', ...result, ms: Date.now() - started, ok: true }));
  } catch (error) {
    // Committed checkpoints survive; do not report zero pending work after an interrupted pass.
    console.log(JSON.stringify({ event: 'hub.session_rollup.daily', ms: Date.now() - started,
      ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
}
