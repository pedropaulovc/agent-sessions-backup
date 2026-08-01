import { runModelPriceSync } from './cron/model-prices';
import { runDailyPricing } from './cron/pricing';
import { runDailyPrune, runPrune } from './cron/prune';
import { runWatchdog } from './cron/watchdog';
import { consumeParseBatch } from './ingest/consumer';
import { route } from './router';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(request, env, ctx);
  },

  async queue(batch: MessageBatch<ParseMessage>, env: Env): Promise<void> {
    await consumeParseBatch(batch, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // */15 = observability watchdog (per-machine heartbeat-age gauge + D1 size).
    // 30 4 * * * = daily prune: sweep leaked multipart staging objects (mpu-staging/) older than 7d.
    // It also revokes rotated-out client certs whose grace window elapsed. Incomplete multipart
    // uploads themselves are auto-aborted by R2 after 7 days.
    // Audit-log polling (CF Audit Logs API) is a later M4 step, wired here once added.
    if (controller.cron === '*/15 * * * *') {
      ctx.waitUntil(runWatchdog(env));
      return;
    }

    if (controller.cron !== '30 4 * * *') {
      return;
    }

    ctx.waitUntil(runPrune(env));
    ctx.waitUntil(runDailyPrune(env));
    // Refresh model pricing from LiteLLM (ccusage's source), THEN fill in `usage.usd` for rows
    // that still have none. Chained rather than a third waitUntil: the pass reads the catalog the
    // sync just wrote, so running them concurrently would price today's rows against yesterday's
    // rates and, worse, mark a model that upstream published TODAY as unpriceable for another
    // full day. `.then` and not `await` — the two prunes above should not queue behind this.
    ctx.waitUntil(runModelPriceSync(env).then(() => runDailyPricing(env)));
  },
} satisfies ExportedHandler<Env, ParseMessage>;
