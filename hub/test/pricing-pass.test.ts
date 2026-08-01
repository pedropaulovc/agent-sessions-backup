import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { priceUsage } from '../src/pricing-pass';

/** The pass that fills `usage.usd`.
 *
 * Asserted against real D1 rather than a mocked binding: the pass exists to join a SQL expression
 * (`priceEpochExpr`) to a TypeScript function (`costOfUsage`), and a mock would test neither half
 * of that join. `now` is injected so nothing depends on the wall clock. */

const testEnv = env as unknown as Env;
const NOW = new Date('2026-08-01T12:00:00.000Z');

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

async function priced(id: number): Promise<{ usd: number | null; price_epoch: string | null; priced_at: string | null }> {
  return (await testEnv.DB.prepare('SELECT usd, price_epoch, priced_at FROM usage WHERE id = ?1')
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
