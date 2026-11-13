import { DEFAULT_ROLLUP_LIMITS, runSessionRollup, type RollupLimits, type SessionRollupResult } from '../session-rollup';

export interface RollupRun {
  run_id: string;
  trigger: 'scheduled' | 'manual';
}

export type RollupOutcome =
  | { outcome: 'complete' | 'partial'; result: SessionRollupResult; ms: number }
  | { outcome: 'failed'; error: string; ms: number };

export function logRollupOutcome(run: RollupRun, outcome: RollupOutcome): void {
  const event = { event: 'hub.session_rollup.run', ...run, outcome: outcome.outcome,
    ...('result' in outcome ? outcome.result : { error: outcome.error }), ms: outcome.ms };
  if (outcome.outcome === 'complete') console.log(JSON.stringify(event));
  else console.error(JSON.stringify(event));
}

/** Each pass bounds both pages and blocks; committed checkpoints resume giant sessions
 * on later passes. Shard pages and main usage/commit queries share the invocation budget.
 * The scheduled pass runs DEFAULT_ROLLUP_LIMITS; a manual job runs the limits it was submitted
 * with (carried in its queue message, so a redelivery reruns the same bounds). The effective
 * limits are logged at start and returned as `result.options`. No preview cron is enabled here. */
export async function runSessionRollupPass(
  env: Env,
  run: RollupRun,
  limits: RollupLimits,
  persist?: (outcome: RollupOutcome) => Promise<void>,
): Promise<RollupOutcome> {
  const started = Date.now();
  console.log(JSON.stringify({ event: 'hub.session_rollup.started', ...run, options: limits }));
  let outcome: RollupOutcome;
  try {
    const result = await runSessionRollup(env, { ...limits, run });
    outcome = { outcome: result.failed > 0 ? 'partial' : 'complete', result, ms: Date.now() - started };
  } catch (error) {
    // Committed checkpoints survive; do not report zero pending work after an interrupted pass.
    outcome = { outcome: 'failed', ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error) };
  }
  // Manual success is observable only after its durable result commits. A persistence outage
  // leaves a recoverable running job, never a completion event claiming an unpollable success.
  await persist?.(outcome);
  logRollupOutcome(run, outcome);
  return outcome;
}

/** The daily chain's rollup step. A pass that `failed` throws so the chain records the step as
 * failed; `partial` is a completed pass with per-session failures, already logged as such. The
 * pass's own error text is thrown unchanged so the chain can recognise a D1 overload and retry. */
export async function runScheduledSessionRollup(env: Env): Promise<void> {
  const outcome = await runSessionRollupPass(env, { run_id: crypto.randomUUID(), trigger: 'scheduled' },
    DEFAULT_ROLLUP_LIMITS);
  if (outcome.outcome === 'failed') throw new Error(outcome.error);
}
