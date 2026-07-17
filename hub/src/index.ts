import { route } from './router';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(request, env, ctx);
  },

  async queue(batch: MessageBatch<ParseMessage>, _env: Env): Promise<void> {
    // M1: parse consumer. Until then, fail loudly so nothing lands in DLQ silently.
    for (const msg of batch.messages) {
      console.log(JSON.stringify({ event: 'parse.skipped', file_id: msg.body.file_id }));
      msg.ack();
    }
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // M4: watchdog + prune + audit-log polling.
  },
} satisfies ExportedHandler<Env, ParseMessage>;
