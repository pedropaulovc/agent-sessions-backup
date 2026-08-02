/** Nightly `usage.usd` fill, run right after the LiteLLM price sync.
 *
 * Two populations reach this, and it handles both with the same pass:
 *   - rows the ingest path could not price when it wrote them, because the model had no published
 *     rate yet. The sync that just ran may have added one.
 *   - the backfill tail. `POST /api/v1/admin/price-usage` does the bulk of an existing corpus in
 *     minutes by looping until it stops answering 202; this is what keeps up afterwards, and what
 *     would eventually finish the job on its own if nobody ever called that endpoint.
 */
import { priceUsage, type PricingPassResult } from '../pricing-pass';

/** Rows per nightly run.
 *
 * Bounded by the invocation's subrequest budget (~1000, shared with the prune jobs running
 * alongside), not by the clock: at PRICING_READ_BATCH=500 and PRICING_WRITE_BATCH=100 this is 40
 * reads plus 200 write batches, so ~240 of that budget. It is deliberately NOT sized to finish a
 * cold 776k-row corpus — 39 days of nightly runs is not a backfill strategy, which is why the
 * script exists. This is the steady-state trickle plus retries.
 */
const MAX_ROWS_PER_RUN = 20_000;

export async function runDailyPricing(env: Env): Promise<void> {
  const started = Date.now();
  try {
    const res = await priceUsage(env.DB, { maxRows: MAX_ROWS_PER_RUN });
    emit('hub.pricing.daily', { ...res, ms: Date.now() - started, ok: true });
  } catch (e) {
    // Swallowed, not rethrown: this runs under waitUntil alongside the prunes, and an unhandled
    // rejection there is a silent scheduled-invocation failure. The log line IS the signal.
    emit('hub.pricing.daily', {
      examined: 0,
      priced: 0,
      unpriceable: 0,
      superseded: 0,
      more: false,
      ms: Date.now() - started,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function emit(event: string, fields: PricingPassResult & Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
