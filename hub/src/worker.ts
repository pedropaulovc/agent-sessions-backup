import { runModelPriceSync } from './cron/model-prices';
import { runDailyPricing } from './cron/pricing';
import { pruneOmpQaReports, runDailyPrune, runPrune } from './cron/prune';
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

const DAILY_CRON = '37 4 * * *';

/** Daily maintenance, strictly in this order. Every step reads or writes the main D1, so running
 * them concurrently (as separate waitUntil promises) overloaded it once a day; one at a time keeps
 * the load to a single query stream. The price sync precedes pricing because the pass reads the
 * catalog the sync just wrote: a model upstream published TODAY would otherwise be recorded as
 * unpriceable for another full day. A step that throws is logged and the next step still runs —
 * runModelPriceSync rethrows after writing its audit row, and a stale catalog is no reason to stop
 * pricing rows whose rates already exist. */
const DAILY_STEPS: ReadonlyArray<{ step: string; failureEvent: string; run: (env: Env) => Promise<unknown> }> = [
  { step: 'prune', failureEvent: 'hub.cron.daily_step_failed', run: runPrune },
  { step: 'omp_qa_reports_prune', failureEvent: 'hub.cron.daily_step_failed', run: pruneOmpQaReports },
  { step: 'cert_prune', failureEvent: 'hub.cron.daily_step_failed', run: runDailyPrune },
  { step: 'session_rollup', failureEvent: 'hub.cron.daily_step_failed', run: runScheduledSessionRollup },
  { step: 'model_price_sync', failureEvent: 'hub.model_prices.sync_failed_before_pricing', run: runModelPriceSync },
  { step: 'pricing', failureEvent: 'hub.cron.daily_step_failed', run: runDailyPricing },
  { step: 'catalog_reconcile', failureEvent: 'hub.cron.daily_step_failed', run: reconcileCatalog },
];

async function runDailyMaintenance(env: Env): Promise<void> {
  for (const { step, failureEvent, run } of DAILY_STEPS) {
    try {
      await run(env);
    } catch (error) {
      console.error(JSON.stringify({
        event: failureEvent,
        step,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
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
    // */15 = observability watchdog (per-machine heartbeat-age gauge + D1 size).
    // DAILY_CRON = sequential daily maintenance (runDailyMaintenance). Its minute is deliberately
    // off the quarter hour so it never fires in the same minute as the */15 watchdog.
    if (controller.cron === '*/15 * * * *') {
      ctx.waitUntil(runWatchdog(env));
      ctx.waitUntil(reconcileCatalog(env));
      return;
    }

    if (controller.cron !== DAILY_CRON) {
      return;
    }

    ctx.waitUntil(runDailyMaintenance(env));
  },
} satisfies ExportedHandler<Env, HubQueueMessage>;
