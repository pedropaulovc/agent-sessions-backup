import { runSessionRollup, type SessionRollupResult } from '../session-rollup';

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

/** At most 80 pages: <= 4 round trips/page (5 if failure bookkeeping is needed), plus the
 * final pending count. D1 batch statements still each consume a subrequest: <= 8/page,
 * leaving room for pricing and prunes in the same 04:30 invocation.
 * Giant sessions resume next night rather than restarting. No preview cron is enabled here. */
export async function runSessionRollupPass(
  env: Env,
  run: RollupRun,
  persist?: (outcome: RollupOutcome) => Promise<void>,
): Promise<RollupOutcome> {
  const started = Date.now();
  console.log(JSON.stringify({ event: 'hub.session_rollup.started', ...run }));
  let outcome: RollupOutcome;
  try {
    const result = await runSessionRollup(env.DB, { maxBlocks: 20_000, maxPages: 80, pageSize: 250, run });
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

export async function runScheduledSessionRollup(env: Env): Promise<void> {
  await runSessionRollupPass(env, { run_id: crypto.randomUUID(), trigger: 'scheduled' });
}
