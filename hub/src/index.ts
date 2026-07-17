import { consumeParseBatch } from './ingest/consumer';
import { route } from './router';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(request, env, ctx);
  },

  async queue(batch: MessageBatch<ParseMessage>, env: Env): Promise<void> {
    await consumeParseBatch(batch, env);
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // M4: watchdog + prune + audit-log polling.
  },
} satisfies ExportedHandler<Env, ParseMessage>;
