export interface DailyStep {
  step: string;
  run: (env: Env) => Promise<unknown>;
}

/** How a step waits out a D1 overload before its single retry. D1 rejects with "Too many resources
 * consumed within a 10 second window", so the default waits just past that window. A mutable
 * object so tests can replace `sleep` instead of blocking for 11 seconds. */
export const DAILY_STEP_RETRY = {
  backoffMs: 11_000,
  sleep: (ms: number): Promise<void> => scheduler.wait(ms),
};

/** D1's per-database overload rejection. Every step started inside the same 10-second window
 * fails with it too, so without a wait one overload wipes out the rest of the daily chain. */
function isD1Overload(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return error.message.startsWith('D1_ERROR') && error.message.includes('D1 DB is overloaded');
}

/** One start line and one completion line (`hub.cron.daily_step`, with `ms` and `outcome`) per
 * step, so a run truncated mid-chain shows exactly which step it stopped in. A D1 overload is
 * logged as `hub.cron.daily_step_retry`, waited out, and retried once; any other error, or a
 * second overload, fails the step. A failure also emits `hub.cron.daily_step_failed` with the
 * error. */
export async function runDailyStep(env: Env, { step, run }: DailyStep): Promise<void> {
  console.log(JSON.stringify({ event: 'hub.cron.daily_step_started', step }));
  const started = Date.now();
  try {
    try {
      await run(env);
    } catch (error) {
      if (!isD1Overload(error)) throw error;
      const backoffMs = DAILY_STEP_RETRY.backoffMs;
      console.log(JSON.stringify({
        event: 'hub.cron.daily_step_retry',
        step,
        ms: Date.now() - started,
        error: error.message,
        backoff_ms: backoffMs,
      }));
      await DAILY_STEP_RETRY.sleep(backoffMs);
      await run(env);
    }
    console.log(JSON.stringify({ event: 'hub.cron.daily_step', step, ms: Date.now() - started, outcome: 'ok' }));
  } catch (error) {
    const ms = Date.now() - started;
    console.log(JSON.stringify({ event: 'hub.cron.daily_step', step, ms, outcome: 'failed' }));
    console.error(JSON.stringify({
      event: 'hub.cron.daily_step_failed',
      step,
      ms,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
