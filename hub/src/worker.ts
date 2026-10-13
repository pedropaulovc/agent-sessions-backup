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
    // 30 4 * * * = daily prune: sweep leaked multipart staging objects (mpu-staging/) older than 7d.
    // It also revokes rotated-out client certs whose grace window elapsed. Incomplete multipart
    // uploads themselves are auto-aborted by R2 after 7 days.
    // Audit-log polling (CF Audit Logs API) is a later M4 step, wired here once added.
    if (controller.cron === '*/15 * * * *') {
      ctx.waitUntil(runWatchdog(env));
      ctx.waitUntil(reconcileCatalog(env));
      return;
    }

    if (controller.cron !== '30 4 * * *') {
      return;
    }

    ctx.waitUntil(runPrune(env));
    ctx.waitUntil(pruneOmpQaReports(env));
    ctx.waitUntil(runDailyPrune(env));
    // Block-only accounting has no dependency on the pricing catalog or its upstream network.
    ctx.waitUntil(runScheduledSessionRollup(env));
    // Refresh model pricing from LiteLLM (ccusage's source), THEN fill in `usage.usd` for rows
    // that still have none. Chained rather than independent waitUntil: the pass reads the catalog the
    // sync just wrote, so running them concurrently would price today's rows against yesterday's
    // rates and, worse, mark a model that upstream published TODAY as unpriceable for another
    // full day. `.then` and not `await` — the two prunes above should not queue behind this.
    //
    // `.catch` before the chain, not after: runModelPriceSync RETHROWS after writing its audit
    // row, so a bare `.then` would skip the pricing pass entirely on any upstream hiccup AND
    // reject the waitUntil. A stale catalog is not a reason to stop pricing — the rows that need
    // it mostly need rates that already exist, and a backfill in progress must not be held
    // hostage to a 500 from GitHub raw. The sync's own audit row is what records the failure.
    ctx.waitUntil(
      runModelPriceSync(env)
        .catch((e: unknown) =>
          console.log(
            JSON.stringify({
              event: 'hub.model_prices.sync_failed_before_pricing',
              error: e instanceof Error ? e.message : String(e),
            }),
          ),
        )
        .then(() => runDailyPricing(env))
        .then(() => reconcileCatalog(env)),
    );
  },
} satisfies ExportedHandler<Env, HubQueueMessage>;
