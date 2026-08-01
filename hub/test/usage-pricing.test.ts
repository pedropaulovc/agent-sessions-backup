import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { priceEpochExpr } from '../src/api/ops';
import type { ModelPrice } from '../src/pricing';

/** Integration tests for /api/v1/usage's pricing aggregate — the part that has to survive
 * grouping. costOfUsage()'s own arithmetic is unit-tested in pricing.test.ts; what is tested
 * here is that the right rate reaches it once rows have been folded into buckets. */

const testEnv = env as unknown as Env;
const MACHINE = 'pricebox';

/** Two snapshots of one model, at a 10x rate cut. Any test below that mixes usage from both
 * sides of 2026-07-01 can only come out right if each side was priced at its own rate. */
const OLD_RATE = { effective_from: '2026-01-01', input: 100, output: 200 };
const NEW_RATE = { effective_from: '2026-07-01', input: 10, output: 20 };

async function seedPrices(): Promise<void> {
  await testEnv.DB.batch(
    [OLD_RATE, NEW_RATE].map((r) =>
      testEnv.DB.prepare(
        `INSERT INTO model_prices
           (model, effective_from, litellm_key, provider, input_cost, output_cost,
            cache_read_cost, cache_write_5m_cost, cache_write_1h_cost, input_cost_batch,
            output_cost_batch, cache_accounting, source, fetched_at)
         VALUES ('claude-opus-5', ?1, 'claude-opus-5', 'anthropic', ?2, ?3, 0, 0, 0,
                 NULL, NULL, 'disjoint', 'test', '2026-07-31T00:00:00Z')`,
      ).bind(r.effective_from, r.input, r.output),
    ),
  );
}

async function seedSession(sessionId: string, machineId: string, harness: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO sessions (session_id, harness, machine_id, repo_url, started_at, index_state)
     VALUES (?1, ?2, ?3, 'https://github.com/x/y', '2026-01-01T00:00:00Z', 'ready')`,
  )
    .bind(sessionId, harness, machineId)
    .run();
}

let turn = 0;
async function seedUsage(sessionId: string, ts: string, model: string, tokens: Record<string, number>): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO usage (session_id, turn_index, ts, model, input_tokens, output_tokens,
                        cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0)`,
  )
    .bind(
      sessionId,
      turn++,
      ts,
      model,
      tokens.input ?? 0,
      tokens.output ?? 0,
      tokens.cacheRead ?? 0,
    )
    .run();
}

async function fetchUsage(query: string): Promise<{ rows: Array<Record<string, number | string>> }> {
  const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/usage?${query}`, {
    headers: { 'x-dev-machine': MACHINE },
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe('usage pricing across a rate change', () => {
  beforeAll(async () => {
    await seedPrices();
    await seedSession('sess-price', MACHINE, 'claude-code');
    // One million input tokens on each side of the 2026-07-01 boundary. Priced correctly that
    // is 1M*100/1M + 1M*10/1M = $110. Priced entirely at the newest rate it is $20.
    await seedUsage('sess-price', '2026-03-15T10:00:00Z', 'claude-opus-5', { input: 1_000_000 });
    await seedUsage('sess-price', '2026-08-15T10:00:00Z', 'claude-opus-5', { input: 1_000_000 });
  });

  // The P1 regression: `bucket` is only a timestamp when group_by=day. For every other mode it
  // is an identifier, and priceAt() comparing '2026-01-01' <= 'claude-opus-5' silently picked
  // one arbitrary rate for all of history.
  it('prices each side of a rate change at its own rate when group_by=model', async () => {
    const body = await fetchUsage('group_by=model&from=2026-01-01&to=2026-12-31');
    const row = body.rows.find((r) => r.bucket === 'claude-opus-5');
    expect(row).toBeTruthy();
    expect(row!.input_tokens).toBe(2_000_000);
    expect(row!.cost_usd).toBeCloseTo(110, 6);
  });

  it('prices each side of a rate change at its own rate when group_by=machine', async () => {
    const body = await fetchUsage('group_by=machine&from=2026-01-01&to=2026-12-31');
    const row = body.rows.find((r) => r.bucket === MACHINE);
    expect(row!.cost_usd).toBeCloseTo(110, 6);
  });

  it('prices each side of a rate change at its own rate when group_by=repo', async () => {
    const body = await fetchUsage('group_by=repo&from=2026-01-01&to=2026-12-31');
    const row = body.rows.find((r) => r.bucket === 'https://github.com/x/y');
    expect(row!.cost_usd).toBeCloseTo(110, 6);
  });

  it('still prices day buckets at the rate in effect that day', async () => {
    const body = await fetchUsage('group_by=day&from=2026-01-01&to=2026-12-31');
    expect(body.rows.find((r) => r.bucket === '2026-03-15')!.cost_usd).toBeCloseTo(100, 6);
    expect(body.rows.find((r) => r.bucket === '2026-08-15')!.cost_usd).toBeCloseTo(10, 6);
  });
});

describe('bucket completeness', () => {
  // The row cap used to be LIMIT 4000 over (bucket, model) pairs while the API returns 400
  // buckets, so once a range held more than 4000 pairs the 400th bucket could be cut after
  // only some of its models — undercounting a bucket that looked complete.
  const MODELS = Array.from({ length: 12 }, (_, i) => `model-${String(i).padStart(2, '0')}`);

  beforeAll(async () => {
    await seedSession('sess-wide', 'widebox', 'codex');
    // 420 days x 12 models = 5040 (bucket, model) pairs, comfortably past the old 4000 cap.
    const stmts = [];
    for (let d = 0; d < 420; d++) {
      const day = new Date(Date.UTC(2025, 0, 1 + d)).toISOString().slice(0, 10);
      for (const model of MODELS) {
        stmts.push(
          testEnv.DB.prepare(
            `INSERT INTO usage (session_id, turn_index, ts, model, input_tokens, output_tokens,
                                cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens)
             VALUES ('sess-wide', ?1, ?2, ?3, 1000, 0, 0, 0, 0)`,
          ).bind(turn++, `${day}T12:00:00Z`, model),
        );
      }
    }
    for (let i = 0; i < stmts.length; i += 200) await testEnv.DB.batch(stmts.slice(i, i + 200));
  });

  it('returns whole buckets — every day bucket counts all 12 of its models', async () => {
    const body = await fetchUsage('group_by=day&machine=widebox');
    expect(body.rows.length).toBe(400);
    // Not just the newest bucket: the boundary one is where truncation used to land.
    for (const row of body.rows) {
      expect(row.calls, `bucket ${row.bucket} is missing models`).toBe(MODELS.length);
      expect(row.input_tokens).toBe(MODELS.length * 1000);
    }
  });
});

describe('priceEpochExpr', () => {
  const price = (model: string, effective_from: string): ModelPrice =>
    ({ model, effective_from }) as ModelPrice;

  it('maps a timestamp to the snapshot in effect, pooling boundaries across models', () => {
    const expr = priceEpochExpr(
      new Map([
        ['a', [price('a', '2026-07-01'), price('a', '2026-01-01')]],
        ['b', [price('b', '2026-04-01')]],
      ]),
    );
    // Newest-first arms, so the first match wins.
    expect(expr).toBe(
      "CASE WHEN u.ts >= '2026-07-01' THEN '2026-07-01'" +
        " WHEN u.ts >= '2026-04-01' THEN '2026-04-01'" +
        " WHEN u.ts >= '2026-01-01' THEN '2026-01-01'" +
        " ELSE '0000-00-00' END",
    );
  });

  it('falls back to a constant older than any snapshot when no prices are loaded', () => {
    // Must NOT be an empty/falsy string: priceAt() reads a falsy ts as "no opinion" and
    // returns the NEWEST rate, which is the very bug this expression exists to prevent.
    expect(priceEpochExpr(new Map())).toBe("'0000-00-00'");
  });

  it('drops boundaries that are not shaped like dates rather than interpolating them', () => {
    const expr = priceEpochExpr(new Map([['a', [price('a', "2026-01-01'; DROP TABLE usage --")]]]));
    expect(expr).not.toContain('DROP TABLE');
  });
});
