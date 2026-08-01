import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { priceEpochExpr } from '../src/api/ops';
import type { ModelPrice } from '../src/pricing';

/** Integration tests for /api/v1/usage's pricing aggregate — the part that has to survive
 * grouping. costOfUsage()'s own arithmetic is unit-tested in pricing.test.ts; what is tested
 * here is that the right rate reaches it once rows have been folded into buckets. */

const testEnv = env as unknown as Env;

/** The canonical-UTC shape the epoch expression requires; kept here so the SQL-string assertions
 * below read as one thing rather than a wall of bracket classes. */
const GLOB = "u.ts GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'";
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

interface UsageBody {
  rows: Array<Record<string, number | string | null>>;
  cost_basis: string;
  unpriced_models: string[];
}

async function fetchUsageRaw(query: string): Promise<UsageBody> {
  const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/usage?${query}`, {
    headers: { 'x-dev-machine': MACHINE },
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function fetchUsage(query: string): Promise<UsageBody> {
  return fetchUsageRaw(query);
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

describe('rows the aggregate must not silently drop', () => {
  beforeAll(async () => {
    // A session with NO repo_url: its bucket is NULL under group_by=repo.
    await testEnv.DB.prepare(
      `INSERT INTO sessions (session_id, harness, machine_id, repo_url, started_at, index_state)
       VALUES ('sess-norepo', 'claude-code', 'nullbox', NULL, '2026-03-01T00:00:00Z', 'ready')`,
    ).run();
    await seedUsage('sess-norepo', '2026-03-01T10:00:00Z', 'claude-opus-5', { input: 7_000 });
    // A real usage row with no model at all — a Codex `token_count` seen before any
    // `turn_context`, where the parser has no currentModel yet.
    await seedUsage('sess-norepo', '2026-03-01T11:00:00Z', null as unknown as string, { input: 3_000 });
    // A row with no timestamp: not evidence that it predates every rate, just missing metadata.
    await seedUsage('sess-norepo', null as unknown as string, 'claude-opus-5', { input: 5_000 });
  });

  // `bucket IN (subquery)` is never true for NULL, so these calls vanished from the response
  // entirely — not zeroed, absent — even though the subquery contained the NULL bucket.
  it('keeps the NULL bucket when group_by=repo', async () => {
    const body = await fetchUsage('group_by=repo&machine=nullbox');
    const nullBucket = body.rows.find((r) => r.bucket === null);
    expect(nullBucket, 'the no-repo session disappeared from the response').toBeTruthy();
    expect(nullBucket!.calls).toBe(3);
  });

  it('counts a NULL-model call as unpriced rather than silently free', async () => {
    const body = await fetchUsage('group_by=machine&machine=nullbox');
    const row = body.rows.find((r) => r.bucket === 'nullbox');
    expect(row!.unpriced_calls as number).toBeGreaterThan(0);
    const models = (await fetchUsageRaw('group_by=machine&machine=nullbox')).unpriced_models;
    expect(models).toContain('(unknown)');
  });

  it('refuses to price a row with no timestamp when the model has several rates', async () => {
    // priceAt would otherwise take its older-than-any-snapshot branch and charge the EARLIEST
    // rate, reporting it as a real figure. claude-opus-5 has two snapshots seeded above.
    const body = await fetchUsage('group_by=machine&machine=nullbox');
    const row = body.rows.find((r) => r.bucket === 'nullbox');
    // 5,000 input tokens at the earliest rate would be $0.50; it must not be counted at all.
    expect(row!.unpriced_calls as number).toBeGreaterThanOrEqual(2);
  });
});

describe('a NULL bucket is not the string "null"', () => {
  beforeAll(async () => {
    // Two sessions on one machine: one with no repo_url at all, one whose repo_url is the
    // literal text "null". Both stringify to "null" — merging them would combine two unrelated
    // populations and drop one bucket from the response entirely.
    await testEnv.DB.prepare(
      `INSERT INTO sessions (session_id, harness, machine_id, repo_url, started_at, index_state)
       VALUES ('sess-litnull', 'codex', 'collidebox', 'null', '2026-04-01T00:00:00Z', 'ready')`,
    ).run();
    await testEnv.DB.prepare(
      `INSERT INTO sessions (session_id, harness, machine_id, repo_url, started_at, index_state)
       VALUES ('sess-sqlnull', 'codex', 'collidebox', NULL, '2026-04-01T00:00:00Z', 'ready')`,
    ).run();
    await seedUsage('sess-litnull', '2026-04-01T10:00:00Z', 'claude-opus-5', { input: 1_111 });
    await seedUsage('sess-sqlnull', '2026-04-01T10:00:00Z', 'claude-opus-5', { input: 2_222 });
  });

  it('keeps them as two separate buckets', async () => {
    const body = await fetchUsage('group_by=repo&machine=collidebox');
    const literal = body.rows.find((r) => r.bucket === 'null');
    const sqlNull = body.rows.find((r) => r.bucket === null);
    expect(literal, 'the literal "null" repo bucket is missing').toBeTruthy();
    expect(sqlNull, 'the SQL NULL repo bucket is missing').toBeTruthy();
    expect(literal!.input_tokens).toBe(1_111);
    expect(sqlNull!.input_tokens).toBe(2_222);
  });
});

describe('token-class shapes are priced independently', () => {
  beforeAll(async () => {
    // A model whose upstream entry publishes an input rate but NO output rate.
    await testEnv.DB.prepare(
      `INSERT INTO model_prices
         (model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
          cache_write_5m_cost, cache_write_1h_cost, input_cost_batch, output_cost_batch,
          cache_accounting, source, fetched_at)
       VALUES ('partial-model', '2026-01-01', 'partial-model', 'openai', 10, NULL, 0, 0, 0,
               NULL, NULL, 'disjoint', 'test', '2026-01-01T00:00:00Z')`,
    ).run();
    await testEnv.DB.prepare(
      `INSERT INTO sessions (session_id, harness, machine_id, repo_url, started_at, index_state)
       VALUES ('sess-partial', 'codex', 'partialbox', 'https://github.com/a/b', '2026-05-01T00:00:00Z', 'ready')`,
    ).run();
    // One input-only call (priceable at the known input rate) and one with output (not).
    await seedUsage('sess-partial', '2026-05-01T10:00:00Z', 'partial-model', { input: 1_000_000 });
    await seedUsage('sess-partial', '2026-05-01T11:00:00Z', 'partial-model', { input: 500, output: 90 });
  });

  it('still prices the input-only call when the output rate is unpublished', async () => {
    // Grouping the two shapes together put output tokens in the aggregate, so costOfUsage saw a
    // missing output rate and threw away the input-only call's perfectly valid $10 too.
    const body = await fetchUsage('group_by=model&machine=partialbox');
    const row = body.rows.find((r) => r.bucket === 'partial-model');
    expect(row!.cost_usd).toBeCloseTo(10, 6);
    // The output-bearing call remains unpriced — it genuinely can't be costed.
    expect(row!.unpriced_calls).toBe(1);
  });
});

describe('subset models split on fresh input, not raw input', () => {
  beforeAll(async () => {
    // A subset-accounting model with a cache-read rate but NO input rate. A fully-cached call
    // (input == cache_read, so zero fresh input) needs no input rate and is priceable from the
    // cache-read rate alone; a partly-fresh call is not.
    await testEnv.DB.prepare(
      `INSERT INTO model_prices
         (model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
          cache_write_5m_cost, cache_write_1h_cost, input_cost_batch, output_cost_batch,
          cache_accounting, source, fetched_at)
       VALUES ('cached-only-model', '2026-01-01', 'cached-only-model', 'openai', NULL, 1, 2, 0, 0,
               NULL, NULL, 'subset', 'test', '2026-01-01T00:00:00Z')`,
    ).run();
    await testEnv.DB.prepare(
      `INSERT INTO sessions (session_id, harness, machine_id, repo_url, started_at, index_state)
       VALUES ('sess-cached', 'codex', 'cachedbox', 'https://github.com/c/d', '2026-06-01T00:00:00Z', 'ready')`,
    ).run();
    // Fully cached: 1M input, all of it cached -> 0 fresh -> priceable at 1M * 2 / 1M = $2.
    await seedUsage('sess-cached', '2026-06-01T10:00:00Z', 'cached-only-model', {
      input: 1_000_000,
      cacheRead: 1_000_000,
    });
    // Partly fresh: needs the absent input rate, so it stays unpriced.
    await seedUsage('sess-cached', '2026-06-01T11:00:00Z', 'cached-only-model', { input: 400, cacheRead: 100 });
  });

  it('prices the fully-cached call even though the input rate is missing', async () => {
    const body = await fetchUsage('group_by=model&machine=cachedbox');
    const row = body.rows.find((r) => r.bucket === 'cached-only-model');
    expect(row!.cost_usd).toBeCloseTo(2, 6);
    expect(row!.unpriced_calls).toBe(1);
  });
});

describe('negative counters cannot inflate billable input', () => {
  beforeAll(async () => {
    // A FULLY priced subset model — the earlier cached-only-model has no input rate, so a row
    // using it goes unpriced and reports 0 billable input no matter what the SQL computed,
    // which would make this test pass without exercising anything.
    await testEnv.DB.prepare(
      `INSERT INTO model_prices
         (model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
          cache_write_5m_cost, cache_write_1h_cost, input_cost_batch, output_cost_batch,
          cache_accounting, source, fetched_at)
       VALUES ('subset-priced-model', '2026-01-01', 'subset-priced-model', 'openai', 1, 1, 1, 0, 0,
               NULL, NULL, 'subset', 'test', '2026-01-01T00:00:00Z')`,
    ).run();
    await testEnv.DB.prepare(
      `INSERT INTO sessions (session_id, harness, machine_id, repo_url, started_at, index_state)
       VALUES ('sess-negcache', 'codex', 'negbox', 'https://github.com/e/f', '2026-06-15T00:00:00Z', 'ready')`,
    ).run();
    // input=5 with cache_read=-100. Clamping only the SUBTRACTION result gives
    // MAX(0, 5 - (-100)) = 105 fresh tokens billed, on a row whose own reported columns say
    // input=5 and cache_read=0 — a negative counter inventing 100 tokens of spend.
    await seedUsage('sess-negcache', '2026-06-15T10:00:00Z', 'subset-priced-model', { input: 5, cacheRead: -100 });
  });

  it('never derives more fresh input than the row reports as input', async () => {
    const body = await fetchUsage('group_by=model&machine=negbox');
    const row = body.rows.find((r) => r.bucket === 'subset-priced-model');
    expect(row!.input_tokens).toBe(5);
    expect(row!.billable_input_tokens, 'a negative cache_read inflated billable input').toBe(5);
    expect(row!.cost_usd).toBeCloseTo(5 / 1e6, 10);
  });
});

describe('cost_basis honesty', () => {
  it('does not claim batch pricing for a model with no batch tier', async () => {
    // The seeded claude-opus-5 rows have NULL batch rates, so batch=1 falls back to standard.
    const body = await fetchUsageRaw('group_by=model&batch=1&machine=' + MACHINE);
    expect(body.cost_basis).not.toBe('litellm_list_price_batch');
    expect(body.cost_basis).toBe('litellm_list_price');
  });

  it('labels a non-batch request plainly', async () => {
    const body = await fetchUsageRaw('group_by=model&machine=' + MACHINE);
    expect(body.cost_basis).toBe('litellm_list_price');
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
    // Newest-first arms, so the first match wins. The unknown arm has to come first and be
    // explicit — `NULL >= '2026-01-01'` is NULL, not false, so a timestamp-less row would
    // otherwise fall through to the ELSE and be indistinguishable from a genuinely ancient one.
    // It also catches non-canonical timestamps: these comparisons are lexicographic, so an
    // offset-bearing `2026-06-30T23:30:00-05:00` (04:30 July 1 UTC) would sort into the wrong
    // epoch and be priced confidently wrong.
    expect(expr).toBe(
      `CASE WHEN u.ts IS NULL OR NOT (${GLOB}) THEN 'unknown'` +
        " WHEN u.ts >= '2026-07-01' THEN '2026-07-01'" +
        " WHEN u.ts >= '2026-04-01' THEN '2026-04-01'" +
        " WHEN u.ts >= '2026-01-01' THEN '2026-01-01'" +
        " ELSE '0000-00-00' END",
    );
  });

  it('keeps unknown-time and older-than-any-price distinct when no prices are loaded', () => {
    // The ELSE must NOT be an empty/falsy string: priceAt() reads a falsy ts as "no opinion"
    // and returns the NEWEST rate, which is the very bug this expression exists to prevent.
    expect(priceEpochExpr(new Map())).toBe(
      `CASE WHEN u.ts IS NULL OR NOT (${GLOB}) THEN 'unknown' ELSE '0000-00-00' END`,
    );
  });

  it('drops boundaries that are not shaped like dates rather than interpolating them', () => {
    const expr = priceEpochExpr(new Map([['a', [price('a', "2026-01-01'; DROP TABLE usage --")]]]));
    expect(expr).not.toContain('DROP TABLE');
  });


  it('treats a non-UTC-offset timestamp as an unknown epoch, not a pre-boundary one', async () => {
    // `2026-06-30T23:30:00-05:00` is 04:30 on July 1 UTC, so it belongs to NEW_RATE. But these
    // comparisons are LEXICOGRAPHIC and it sorts before '2026-07-01', so it silently took the old
    // 10x-more-expensive rate while looking confidently priced. With two snapshots for this model
    // the unknown epoch cannot pick between them, so it reports unpriced rather than wrong.
    await seedSession('tz-sess', 'tzbox', 'claude-code');
    await seedUsage('tz-sess', '2026-06-30T23:30:00-05:00', 'claude-opus-5', { input: 1_000_000 });
    const row = (await fetchUsage('group_by=machine&machine=tzbox')).rows[0]!;
    // The old rate would have charged 100/M for a call that belongs at 10/M.
    expect(Number(row.cost_usd), 'an offset timestamp was priced at the wrong epoch').not.toBeCloseTo(100, 6);
    expect(Number(row.unpriced_calls)).toBeGreaterThan(0);
  });

  it('treats a malformed timestamp as an unknown epoch', async () => {
    await seedSession('bad-ts-sess', 'badtsbox', 'claude-code');
    await seedUsage('bad-ts-sess', 'not-a-timestamp', 'claude-opus-5', { input: 1_000_000 });
    const row = (await fetchUsage('group_by=machine&machine=badtsbox')).rows[0]!;
    expect(Number(row.unpriced_calls)).toBeGreaterThan(0);
  });

  it('still prices a canonical UTC timestamp at its own epoch', async () => {
    // Guards the fix from over-reaching: the GLOB must not reject the ordinary shape.
    await seedSession('ok-ts-sess', 'oktsbox', 'claude-code');
    await seedUsage('ok-ts-sess', '2026-07-05T04:30:00.000Z', 'claude-opus-5', { input: 1_000_000 });
    const row = (await fetchUsage('group_by=machine&machine=oktsbox')).rows[0]!;
    expect(Number(row.unpriced_calls)).toBe(0);
    expect(Number(row.cost_usd)).toBeCloseTo(10, 6);
  });
});
