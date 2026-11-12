import { runModelPriceSync } from './cron/model-prices';
import { runDailyPricing } from './cron/pricing';
import { pruneOmpQaReports, runDailyPrune, runPrune } from './cron/prune';
import { DAILY_CRON, WATCHDOG_CRON } from './cron/schedule';
import { runScheduledSessionRollup } from './cron/session-rollup';
import { runWatchdog } from './cron/watchdog';
import { consumeParseBatch } from './ingest/consumer';
import { assertIndexLayout } from './index-shards';
import { route } from './router';
import { consumeSessionRollup } from './session-rollup-jobs';
import { drainIndexCatalog } from './session-catalog';

async function reconcileCatalog(env: Env): Promise<void> {
  try {
    // Leave room for the parse/maintenance work that triggered this backstop.
    const result = await drainIndexCatalog(env, { maxSubrequests: 64 });
    if (result.state === 'pending') await env.ROLLUP_QUEUE.send({ kind: 'index-catalog' });
  } catch (error) {
    // The durable outbox remains pending; the next request, queue delivery, or cron retries it.
    console.error(JSON.stringify({
      event: 'hub.index_catalog.reconcile_failed',
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

interface DailyStep {
  step: string;
  run: (env: Env) => Promise<unknown>;
}

/** The daily D1 maintenance, run one step at a time: running these concurrently (as separate
 * waitUntil promises) overloaded the main D1 once a day. Most valuable first, so a run cut off by
 * the invocation's wall-clock or subrequest limits loses the cheapest work: the price sync precedes
 * pricing because the pass reads the catalog the sync just wrote (a model upstream published TODAY
 * would otherwise stay unpriceable for another full day); the catalog backstop, rollup and the two
 * prunes follow. A step that throws is logged and the next step still runs — runModelPriceSync
 * rethrows after writing its audit row, and a stale catalog is no reason to stop pricing rows whose
 * rates already exist. */
const DAILY_D1_STEPS: ReadonlyArray<DailyStep> = [
  { step: 'model_price_sync', run: runModelPriceSync },
  { step: 'pricing', run: runDailyPricing },
  { step: 'catalog_reconcile', run: reconcileCatalog },
  { step: 'session_rollup', run: runScheduledSessionRollup },
  { step: 'cert_prune', run: runDailyPrune },
  { step: 'omp_qa_reports_prune', run: pruneOmpQaReports },
];

/** The staging sweep touches only R2, so it runs alongside the D1 chain instead of queueing in it. */
const STAGING_PRUNE: DailyStep = { step: 'staging_prune', run: runPrune };

/** One start line and one completion line (`hub.cron.daily_step`, with `ms` and `outcome`) per
 * step, so a run truncated mid-chain shows exactly which step it stopped in. A failure also emits
 * `hub.cron.daily_step_failed` with the error. */
async function runDailyStep(env: Env, { step, run }: DailyStep): Promise<void> {
  console.log(JSON.stringify({ event: 'hub.cron.daily_step_started', step }));
  const started = Date.now();
  try {
    await run(env);
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

async function runDailyD1Maintenance(env: Env): Promise<void> {
  for (const step of DAILY_D1_STEPS) await runDailyStep(env, step);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/healthz' || env.INDEX_MODE === 'maintenance') return route(request, env, ctx);
    await assertIndexLayout(env);
    try {
      return await route(request, env, ctx);
    } finally {
      if (request.method !== 'GET' && request.method !== 'HEAD') ctx.waitUntil(reconcileCatalog(env));
    }
  },

  async queue(batch: MessageBatch<HubQueueMessage>, env: Env): Promise<void> {
    if (env.INDEX_MODE === 'maintenance') {
      for (const message of batch.messages) message.retry({ delaySeconds: 60 });
      return;
    }
    await assertIndexLayout(env);
    const catalog = batch.messages.find((message) => 'kind' in message.body && message.body.kind === 'index-catalog');
    if (catalog) {
      for (const message of batch.messages) {
        if (message !== catalog) message.retry();
      }
      try {
        const result = await drainIndexCatalog(env);
        if (result.state === 'pending') catalog.retry({ delaySeconds: 1 });
        else catalog.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'hub.index_catalog.delivery_failed',
          error: error instanceof Error ? error.message : String(error),
        }));
        catalog.retry({ delaySeconds: 60 });
      }
      return;
    }
    const rollup = batch.messages.find((message) => 'kind' in message.body && message.body.kind === 'session-rollup');
    if (rollup) {
      // Rollup work shares the queue with catalog reconciliation; each delivery has its own budget.
      for (const message of batch.messages) {
        if (message !== rollup) message.retry();
      }
      try {
        await consumeSessionRollup(rollup as Message<SessionRollupMessage>, env);
      } finally {
        await reconcileCatalog(env);
      }
      return;
    }
    try {
      await consumeParseBatch({ messages: batch.messages as Message<ParseMessage>[] }, env);
    } finally {
      await reconcileCatalog(env);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.INDEX_MODE === 'maintenance') return;
    await assertIndexLayout(env);
    // WATCHDOG_CRON = observability watchdog (per-machine heartbeat-age gauge + D1 size).
    // DAILY_CRON = the R2 staging sweep alongside the sequential D1 maintenance chain.
    if (controller.cron === WATCHDOG_CRON) {
      ctx.waitUntil(runWatchdog(env));
      ctx.waitUntil(reconcileCatalog(env));
      return;
    }

    if (controller.cron !== DAILY_CRON) {
      return;
    }

    ctx.waitUntil(runDailyStep(env, STAGING_PRUNE));
    ctx.waitUntil(runDailyD1Maintenance(env));
  },
} satisfies ExportedHandler<Env, HubQueueMessage>;
