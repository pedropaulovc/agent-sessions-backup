import { runPrune } from './cron/prune';
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
    // (Incomplete multipart uploads themselves are auto-aborted by R2 after 7 days.)
    // Audit-log polling is a later M4 step, wired here once added.
    if (controller.cron === '*/15 * * * *') {
      ctx.waitUntil(runWatchdog(env));
    }
    if (controller.cron === '30 4 * * *') {
      ctx.waitUntil(runPrune(env));
    }
  },
} satisfies ExportedHandler<Env, ParseMessage>;
