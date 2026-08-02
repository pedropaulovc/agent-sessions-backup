import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { priceUsage, PRICING_VERSION } from '../src/pricing-pass';
import { priceUsageSlice, PRICE_ROWS_PER_INVOCATION, setPriceRowsPerInvocation } from '../src/api/ops';
import type { Identity } from '../src/auth/identity';

/** The pass that fills `usage.usd`.
 *
 * Asserted against real D1 rather than a mocked binding: the pass exists to join a SQL expression
 * (`priceEpochExpr`) to a TypeScript function (`costOfUsage`), and a mock would test neither half
 * of that join. `now` is injected so nothing depends on the wall clock. */

const testEnv = env as unknown as Env;
const NOW = new Date('2026-08-01T12:00:00.000Z');
/** Captured at import, before any test mutates it. */
const PRICE_ROWS_PER_INVOCATION_DEFAULT = PRICE_ROWS_PER_INVOCATION;

/** 1/M input, 10/M output, disjoint accounting. Chosen so a million input tokens costs exactly
 * $1 and every expectation below can be checked by hand. */
async function seedPrice(
  over: Partial<{ model: string; from: string; input: number | null; output: number | null }> = {},
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO model_prices
       (model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
        cache_write_5m_cost, cache_write_1h_cost, input_cost_batch, output_cost_batch,
        cache_accounting, source, fetched_at)
     VALUES (?1, ?2, ?1, 'anthropic', ?3, ?4, 0.1, 2, 4, NULL, NULL, 'disjoint', 'test',
             '2026-07-31T00:00:00Z')`,
  )
    .bind(over.model ?? 'm1', over.from ?? '2026-01-01', over.input === undefined ? 1 : over.input, over.output === undefined ? 10 : over.output)
    .run();
}

let turn = 0;
async function seedTurn(
  sessionId: string,
  over: Partial<{ ts: string | null; model: string | null; input: number; output: number }> = {},
): Promise<number> {
  turn++;
  const res = await testEnv.DB.prepare(
    `INSERT INTO usage (session_id, turn_index, ts, model, input_tokens, output_tokens)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`,
  )
    .bind(
      sessionId,
      turn,
      over.ts === undefined ? '2026-07-20T10:00:00.000Z' : over.ts,
      over.model === undefined ? 'm1' : over.model,
      over.input ?? 1_000_000,
      over.output ?? 0,
    )
    .first<{ id: number }>();
  return res!.id;
}

async function priced(id: number): Promise<{
  usd: number | null;
  price_epoch: string | null;
  priced_at: string | null;
  priced_version: number | null;
  usd_input: number | null;
  usd_output: number | null;
  usd_cache_read: number | null;
  usd_cache_write_5m: number | null;
  usd_cache_write_1h: number | null;
}> {
  return (await testEnv.DB.prepare(
    `SELECT usd, price_epoch, priced_at, priced_version, usd_input, usd_output, usd_cache_read,
            usd_cache_write_5m, usd_cache_write_1h FROM usage WHERE id = ?1`,
  )
    .bind(id)
    .first())! as never;
}

describe('priceUsage', () => {
  beforeEach(async () => {
    // Storage is shared across tests in this pool, so every fixture here starts from an empty
    // `usage` and an empty catalog — several of these assertions are about which snapshot was
    // chosen, and a price row surviving from a previous test would decide that silently.
    await testEnv.DB.batch([
      testEnv.DB.prepare('DELETE FROM usage'),
      testEnv.DB.prepare('DELETE FROM model_prices'),
    ]);
    turn = 0;
  });

  it('stores the cost costOfUsage would have computed', async () => {
    await seedPrice();
    const id = await seedTurn('s1', { input: 2_000_000, output: 500_000 });

    const res = await priceUsage(testEnv.DB, { now: NOW });

    // 2M input at $1/M + 0.5M output at $10/M.
    expect((await priced(id)).usd).toBeCloseTo(2 + 5, 9);
    expect(res).toMatchObject({ examined: 1, priced: 1, unpriceable: 0, more: false });
  });

  it('stores a per-class breakdown that sums to usd exactly', async () => {
    // The breakdown is not a second opinion about the cost — costOfUsage computes `usd` AS the sum
    // of these terms, so storing both is one number and its decomposition. If they can disagree,
    // the ledger's cache share (derived from the classes) stops reconciling with the total shown
    // beside it, and neither figure is obviously the wrong one.
    await seedPrice();
    const id = await seedTurn('s1', { input: 2_000_000, output: 500_000 });

    await priceUsage(testEnv.DB, { now: NOW });
    const r = await priced(id);

    expect(r.usd_input).toBeCloseTo(2, 9);
    expect(r.usd_output).toBeCloseTo(5, 9);
    const parts =
      (r.usd_input ?? 0) + (r.usd_output ?? 0) + (r.usd_cache_read ?? 0) +
      (r.usd_cache_write_5m ?? 0) + (r.usd_cache_write_1h ?? 0);
    expect(parts, 'the class breakdown does not reconcile with the stored total').toBeCloseTo(r.usd ?? 0, 9);
  });

  it('re-prices rows left behind by an older pricing version', async () => {
    // The whole point of the version: changing what is stored, or how it is computed, must not
    // require NULLing a column corpus-wide to force a re-run. Every row is simply due again, and
    // its existing cost stays readable until the pass reaches it — no window where the page is $0.
    await seedPrice();
    const id = await seedTurn('s1');
    await priceUsage(testEnv.DB, { now: NOW });
    expect((await priced(id)).priced_version).toBe(PRICING_VERSION);

    // Simulate a row written by an older version, with its cost intact — which is exactly the
    // state a real bump leaves the whole table in.
    await testEnv.DB.prepare('UPDATE usage SET priced_version = ?1, usd_input = NULL WHERE id = ?2')
      .bind(PRICING_VERSION - 1, id)
      .run();

    const res = await priceUsage(testEnv.DB, { now: new Date('2026-08-02T12:00:00.000Z') });

    expect(res.examined, 'a row below the current version was not due').toBe(1);
    const r = await priced(id);
    expect(r.priced_version).toBe(PRICING_VERSION);
    expect(r.usd_input, 'the re-price did not refill the newer columns').toBeCloseTo(1, 9);
  });

  it('leaves an unpriceable row below the current version so later runs retry it', async () => {
    // How the retry works now that the predicate is a single range: a failed attempt does NOT
    // advance priced_version, so the row stays due forever. Advancing it would both declare
    // "priced by version N" about a row carrying no price AND make it invisible to every later
    // run, exactly when a catalog gaining its model is what would fix it.
    const id = await seedTurn('s1', { model: 'never-published' });

    await priceUsage(testEnv.DB, { now: NOW });

    const r = await priced(id);
    expect(r.usd).toBeNull();
    expect(r.priced_version, 'a failed attempt advanced the version and hid the row').toBe(0);
    expect(r.priced_at, 'the attempt was not recorded at all').toBe(NOW.toISOString());
  });

  it('re-prices a turn whose tokens changed under a re-parse', async () => {
    // The upsert path. A re-parse that CHANGES a turn updates its tokens but the row is already at
    // the current pricing version, so the pass -- which selects on being below it -- would skip the
    // row forever and it would keep serving the cost of the token counts it used to have. Wrong
    // money, permanently, with no symptom: nothing on the page distinguishes a stale cost from a
    // current one. The conflict branch of the ingest INSERT clears the pricing state; this asserts
    // the pass then picks the row up and lands on the NEW number.
    await seedPrice();
    const id = await seedTurn('s1', { input: 1_000_000 });
    await priceUsage(testEnv.DB, { now: NOW });
    expect((await priced(id)).usd).toBeCloseTo(1, 9);

    // Exactly what the ON CONFLICT branch does: new tokens, pricing state cleared.
    await testEnv.DB.prepare(
      `UPDATE usage SET input_tokens = 5000000, priced_version = 0, priced_at = NULL, usd = NULL,
                        usd_input = NULL, usd_output = NULL, usd_cache_read = NULL,
                        usd_cache_write_5m = NULL, usd_cache_write_1h = NULL
        WHERE id = ?1`,
    )
      .bind(id)
      .run();

    await priceUsage(testEnv.DB, { now: new Date('2026-08-02T12:00:00.000Z') });

    expect((await priced(id)).usd, 'the re-parsed turn kept the cost of its old token counts').toBeCloseTo(5, 9);
  });

  it('does not overwrite a re-parse that landed mid-pass', async () => {
    // The race. The pass reads a row, prices it in JS, then writes the answer back — and a re-parse
    // of the same turn can land in between, replacing the token counts and resetting the pricing
    // state. A blind `WHERE id` would stamp the OLD cost and the CURRENT version over the new data,
    // putting the row above the version threshold so no later pass reconsiders it: permanently
    // wrong money on a row nothing marks as suspect.
    //
    // `db.batch` is the real seam — it runs after the read and after pricing, immediately before
    // the write — so mutating the row there reproduces the interleaving exactly rather than
    // approximating it.
    await seedPrice();
    const id = await seedTurn('s1', { input: 1_000_000 });

    const realBatch = testEnv.DB.batch.bind(testEnv.DB);
    let intercepted = false;
    (testEnv.DB as unknown as { batch: typeof realBatch }).batch = (async (stmts: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true;
        // The concurrent re-parse: new tokens, pricing state reset — the ON CONFLICT branch.
        await testEnv.DB.prepare(
          `UPDATE usage SET input_tokens = 9000000, priced_version = 0, priced_at = NULL, usd = NULL
            WHERE id = ?1`,
        )
          .bind(id)
          .run();
      }
      return realBatch(stmts);
    }) as typeof realBatch;

    let res;
    try {
      res = await priceUsage(testEnv.DB, { now: NOW });
    } finally {
      (testEnv.DB as unknown as { batch: typeof realBatch }).batch = realBatch;
    }

    expect(intercepted, 'the interception never fired, so no race was simulated').toBe(true);
    expect(res.superseded, 'the stale write was not detected as superseded').toBe(1);
    expect(res.priced, 'a write that changed nothing was counted as priced').toBe(0);

    const r = await priced(id);
    expect(r.usd, 'the stale cost was written over the re-parsed row').toBeNull();
    expect(r.priced_version, 'the row was marked current and will never be re-priced').toBe(0);

    // Still due, so the next pass prices what the row now actually holds: 9M tokens at $1/M.
    await priceUsage(testEnv.DB, { now: new Date('2026-08-02T12:00:00.000Z') });
    expect((await priced(id)).usd, 'the superseded row was never picked up again').toBeCloseTo(9, 9);
  });

  it('records which rate snapshot it used, and prices a turn at the rate in force THEN', async () => {
    // The whole reason `model_prices` is versioned rather than overwritten: an August price cut
    // must not silently rewrite what July cost. Storing the cost makes that permanent, so the
    // epoch has to be stored with it or the number is unauditable after the fact.
    await seedPrice({ from: '2026-01-01', input: 1 });
    await seedPrice({ from: '2026-07-15', input: 3 });
    const june = await seedTurn('s1', { ts: '2026-06-30T10:00:00.000Z' });
    const july = await seedTurn('s1', { ts: '2026-07-20T10:00:00.000Z' });

    await priceUsage(testEnv.DB, { now: NOW });

    expect((await priced(june)).usd, 'the June turn was repriced at July rates').toBeCloseTo(1, 9);
    expect((await priced(july)).usd).toBeCloseTo(3, 9);
    expect((await priced(june)).price_epoch).toBe('2026-01-01');
    expect((await priced(july)).price_epoch).toBe('2026-07-15');
  });

  it('leaves usd NULL when no rate can be determined — NULL is not $0', async () => {
    // A $0 turn is a real answer and an unpriceable turn is not, so they must not share a
    // representation. Storing 0 here would make an unpriced corpus read as a free one, with
    // nothing downstream able to tell the difference.
    const unknownModel = await seedTurn('s1', { model: 'never-published' });
    await seedPrice({ model: 'm2', output: null });
    const missingRate = await seedTurn('s1', { model: 'm2', input: 0, output: 1_000 });

    const res = await priceUsage(testEnv.DB, { now: NOW });

    expect((await priced(unknownModel)).usd).toBeNull();
    expect((await priced(missingRate)).usd, 'a missing output rate was charged as zero').toBeNull();
    expect(res).toMatchObject({ examined: 2, priced: 0, unpriceable: 2 });
  });

  it('stamps priced_at even on the rows it could not price', async () => {
    // This is what makes an attempt distinguishable from a row nobody has looked at yet, and it
    // is the mechanism the whole forward-progress story rests on.
    const id = await seedTurn('s1', { model: 'never-published' });

    await priceUsage(testEnv.DB, { now: NOW });

    expect((await priced(id)).priced_at).toBe(NOW.toISOString());
    expect((await priced(id)).usd).toBeNull();
  });

  it('stores a real 0 for sentinel models rather than leaving them unpriced', async () => {
    // `<synthetic>` rows never hit an API, so zero IS their cost. Leaving them NULL would park
    // them in the unpriced index forever AND report them as pricing coverage we failed to reach.
    const id = await seedTurn('s1', { model: '<synthetic>' });

    const res = await priceUsage(testEnv.DB, { now: NOW });

    expect((await priced(id)).usd).toBe(0);
    expect(res).toMatchObject({ priced: 1, unpriceable: 0 });
  });

  it('advances past unpriceable rows instead of re-reading them for the rest of the run', async () => {
    // The spin case, and the only reason `priced_at` is in the WHERE clause. An unpriceable row
    // still has `usd IS NULL` after being examined, so a predicate of `usd IS NULL` alone returns
    // the identical batch on the next iteration of the loop — and a backfill with a large budget
    // burns the whole budget re-pricing the same rows instead of reaching the ones behind them.
    //
    // `readBatch` is what makes this observable: the loop only takes a second iteration when a
    // read comes back FULL, so with the production batch size this needs 500 seeded rows.
    // examined is the assertion because it counts reads, not distinct rows — spinning inflates it
    // while every visible side effect on the two rows stays identical.
    await seedTurn('s1', { model: 'never-published' });
    await seedTurn('s1', { model: 'also-never-published' });

    const res = await priceUsage(testEnv.DB, { maxRows: 20, readBatch: 2, now: NOW });

    expect(res.examined, 'the pass re-read rows it had already attempted').toBe(2);
    expect(res).toMatchObject({ unpriceable: 2, more: false });
  });

  it('serves never-attempted rows before retrying known failures', async () => {
    // Priority rather than correctness — progress is guaranteed by the WHERE clause above, not by
    // this. It matters for a backfill's shape: a corpus with a large unpriceable tail should
    // spend each run's budget on rows nobody has looked at yet, so coverage climbs steadily
    // instead of the run being consumed by retries of models upstream still does not publish.
    await seedPrice();
    await seedTurn('s1', { model: 'never-published' });
    await priceUsage(testEnv.DB, { now: NOW });

    const fresh = await seedTurn('s1');
    const later = new Date('2026-08-02T12:00:00.000Z');
    await priceUsage(testEnv.DB, { maxRows: 1, readBatch: 1, now: later });

    expect((await priced(fresh)).usd, 'the budget went to the retry instead of the new row').toBeCloseTo(1, 9);
  });

  it('retries yesterday’s unpriceable rows once a rate lands', async () => {
    // "Unpriceable" is a claim about today's catalog, not a permanent verdict — models get added
    // upstream. A later run must reconsider them, which is why the predicate is `priced_at <
    // this run's start` rather than `priced_at IS NULL`.
    const id = await seedTurn('s1', { model: 'published-later' });
    await priceUsage(testEnv.DB, { now: NOW });
    expect((await priced(id)).usd).toBeNull();

    await seedPrice({ model: 'published-later' });
    await priceUsage(testEnv.DB, { now: new Date('2026-08-02T12:00:00.000Z') });

    expect((await priced(id)).usd).toBeCloseTo(1, 9);
  });

  it('does not re-price rows that already have a cost', async () => {
    await seedPrice();
    const id = await seedTurn('s1');
    await priceUsage(testEnv.DB, { now: NOW });

    const second = await priceUsage(testEnv.DB, { now: new Date('2026-08-02T12:00:00.000Z') });

    expect(second, 'a priced row was examined again').toMatchObject({ examined: 0, priced: 0 });
    expect((await priced(id)).priced_at, 'a settled row was restamped').toBe(NOW.toISOString());
  });

  it('scopes to one session when asked, so ingest can price just what it wrote', async () => {
    await seedPrice();
    const mine = await seedTurn('mine');
    const other = await seedTurn('other');

    const res = await priceUsage(testEnv.DB, { sessionId: 'mine', now: NOW });

    expect((await priced(mine)).usd).toBeCloseTo(1, 9);
    expect((await priced(other)).usd, 'the scope leaked into another session').toBeNull();
    expect(res.examined).toBe(1);
  });

  it('reports `more` only when it stopped on the budget, not when it ran out of work', async () => {
    // A caller loops while `more` is true. Getting this backwards against a fully-priced corpus
    // is an infinite loop in a Worker, so the two cases are asserted separately rather than
    // inferred from the row count.
    await seedPrice();
    await seedTurn('s1');
    await seedTurn('s1');

    expect((await priceUsage(testEnv.DB, { maxRows: 1, now: NOW })).more).toBe(true);
    expect((await priceUsage(testEnv.DB, { maxRows: 50, now: NOW })).more).toBe(false);
    expect((await priceUsage(testEnv.DB, { maxRows: 50, now: NOW })), 'a run with nothing to do').toMatchObject({
      examined: 0,
      more: false,
    });
  });

  it('applies the per-row clamps rather than trusting the stored counters', async () => {
    // `usage` has no nonnegative constraint and both parsers store whatever the transcript
    // reported. Without the shared clamps a negative counter produces a NEGATIVE cost reported as
    // fully priced — which is worse than unpriced, because it silently cancels real spend.
    await seedPrice();
    const id = await seedTurn('s1', { input: -5_000_000, output: 1_000_000 });

    await priceUsage(testEnv.DB, { now: NOW });

    expect((await priced(id)).usd, 'a negative token count produced negative dollars').toBeCloseTo(10, 9);
  });
});

/** POST /api/v1/admin/price-usage — the backfill entrypoint.
 *
 * The status code IS the contract: a caller loops until it stops getting 202, so a pass that
 * returned 200 while rows remained would silently truncate the backfill and report success. */
describe('priceUsageSlice', () => {
  const admin: Identity = { kind: 'machine', machineId: 'opsbox', isAdmin: true, certSlot: 'current' };
  const req = () => new Request('https://api.sessions.vza.net/api/v1/admin/price-usage', { method: 'POST' });

  beforeEach(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare('DELETE FROM usage'),
      testEnv.DB.prepare('DELETE FROM model_prices'),
    ]);
    turn = 0;
  });

  afterEach(() => setPriceRowsPerInvocation(PRICE_ROWS_PER_INVOCATION_DEFAULT));

  it('202s while rows remain and 200s only when the pass ran out of work', async () => {
    // The status code is the whole contract: the backfill caller loops until it stops seeing 202,
    // so a run that answered 200 with rows still unpriced would truncate the backfill silently and
    // report success. Two rows against a one-row budget reaches the 202 arm; the real budget is
    // 10,000, and seeding that many is a minute of fixtures for a branch this covers identically.
    setPriceRowsPerInvocation(1);
    await seedPrice();
    await seedTurn('s1');
    await seedTurn('s1');

    const partial = await priceUsageSlice(req(), testEnv, admin);
    expect(partial.status, 'a partial pass reported the backfill finished').toBe(202);
    expect(await partial.json()).toMatchObject({ examined: 1, priced: 1, more: true });

    // Second row, then nothing left — the only state that may answer 200.
    expect((await priceUsageSlice(req(), testEnv, admin)).status).toBe(202);
    const done = await priceUsageSlice(req(), testEnv, admin);
    expect(done.status, 'a finished pass never reported done, so the caller would loop forever').toBe(200);
    expect(await done.json()).toMatchObject({ examined: 0, more: false });
  });

  it('refuses a non-admin identity', async () => {
    const plain: Identity = { kind: 'machine', machineId: 'anybox', isAdmin: false, certSlot: 'current' };
    await seedPrice();
    const id = await seedTurn('s1');

    expect((await priceUsageSlice(req(), testEnv, plain)).status).toBe(403);
    expect((await priced(id)).usd, 'a non-admin call still did the work').toBeNull();
  });
});
