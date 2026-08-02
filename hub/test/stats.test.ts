import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { collectStats, MAX_EXCLUDED_BINDS, windows, type StatsQuery } from '../src/stats';
import { priceUsage } from '../src/pricing-pass';

/** The statistics page. Its arithmetic is tested through `collectStats` against real D1 rather
 * than by parsing HTML; the page itself is covered by one smoke test that it renders and one
 * that its filters actually reach the SQL.
 *
 * `now` is injected everywhere so no assertion depends on the wall clock — a range test that
 * passes only because the fixture happens to land inside today's window is worthless. */

const testEnv = env as unknown as Env;
const NOW = new Date('2026-08-01T12:00:00.000Z');

const BASE: StatsQuery = { range: '30d', by: 'project', tzOffsetHours: 0 };

/** The page reads dollars off `usage.usd`, which the pricing pass fills — in production from the
 * ingest hook and the nightly cron. These fixtures INSERT into `usage` directly, so they have to
 * run the pass themselves or every dollar assertion here would be asserting on an unpriced table.
 *
 * Deliberately the real pass rather than a hand-written UPDATE: a fixture that priced rows its own
 * way could agree with itself while disagreeing with production. */
async function stats(db: D1Database, q: StatsQuery, now: Date) {
  await priceUsage(db, { maxRows: 100_000, now });
  return collectStats(db, q, now);
}

/** One model, one rate, arithmetic that is easy to check by hand: 1/M input, 10/M output,
 * 0.1/M cache read, 2/M and 4/M cache writes. Disjoint accounting, so cache reads add on top. */
async function seedPrice(): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO model_prices
       (model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
        cache_write_5m_cost, cache_write_1h_cost, input_cost_batch, output_cost_batch,
        cache_accounting, source, fetched_at)
     VALUES ('m1', '2026-01-01', 'm1', 'anthropic', 1, 10, 0.1, 2, 4, NULL, NULL,
             'disjoint', 'test', '2026-07-31T00:00:00Z')`,
  ).run();
}

async function seedSession(
  sessionId: string,
  over: Partial<{ harness: string; machine_id: string; project_name: string; git_branch: string; title: string }> = {},
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO sessions (session_id, harness, machine_id, project_name, git_branch, title,
                           started_at, index_state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2026-07-20T00:00:00Z', 'ready')`,
  )
    .bind(
      sessionId,
      over.harness ?? 'claude-code',
      over.machine_id ?? 'box',
      over.project_name ?? 'proj',
      over.git_branch ?? 'main',
      over.title ?? `title-${sessionId}`,
    )
    .run();
}

let turn = 0;
async function seedTurn(
  sessionId: string,
  ts: string | null,
  tokens: Partial<{ input: number; output: number; cacheRead: number; w5: number; w1h: number; depth: number }> = {},
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO usage (session_id, turn_index, ts, model, input_tokens, output_tokens,
                        cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens)
     VALUES (?1, ?2, ?3, 'm1', ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      sessionId,
      tokens.depth ?? turn++,
      ts,
      tokens.input ?? 0,
      tokens.output ?? 0,
      tokens.cacheRead ?? 0,
      tokens.w5 ?? 0,
      tokens.w1h ?? 0,
    )
    .run();
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM usage'),
    testEnv.DB.prepare('DELETE FROM starred_turns'),
    testEnv.DB.prepare('DELETE FROM sessions'),
    testEnv.DB.prepare('DELETE FROM model_prices'),
  ]);
  turn = 0;
  await seedPrice();
});

describe('mixed pricing versions', () => {
  it('refuses to show a class breakdown it cannot yet compute', async () => {
    // Mid-backfill after a pricing-version bump: SOME rows have been re-priced and carry their
    // five-way split, others still carry only a total. That mixture is the dangerous state, and it
    // is why this fixture prices two turns and rolls back exactly one — with the split missing
    // everywhere, every class sums to 0 and the share is 0 whether or not anything suppresses it,
    // so the suppression would be untested. Here the surviving row's cache dollars are real, the
    // rolled-back row's are absent, and the ratio between them is a confident understatement.
    await seedSession('s1');
    await seedTurn('s1', '2026-07-20T10:00:00.000Z', { input: 1_000_000, cacheRead: 10_000_000 });
    await seedTurn('s1', '2026-07-20T11:00:00.000Z', { input: 1_000_000, cacheRead: 10_000_000 });
    await priceUsage(testEnv.DB, { now: NOW });
    // Exactly the state a version bump leaves behind, on one row: total intact, split gone.
    await testEnv.DB.prepare(
      `UPDATE usage SET priced_version = 1, usd_input = NULL, usd_output = NULL, usd_cache_read = NULL,
                        usd_cache_write_5m = NULL, usd_cache_write_1h = NULL
        WHERE ts = ?1`,
    )
      .bind('2026-07-20T11:00:00.000Z')
      .run();

    const s = await collectStats(testEnv.DB, BASE, NOW);

    expect(s.ledger.staleBreakdownCalls, 'the page did not notice the missing breakdown').toBe(1);
    expect(s.ledger.usd, 'the TOTAL should be unaffected — it comes from usd, which is intact').toBeGreaterThan(0);
    // Half the corpus still carries its cache dollars, so an unsuppressed share here is a real,
    // non-zero, confidently WRONG number rather than an obvious zero.
    expect(s.ledger.cacheShare, 'a cache share was computed from a partial breakdown').toBe(0);
  });
});

describe('range windows', () => {
  it('makes the prior window the same length and immediately before the current one', () => {
    const w = windows('30d', NOW);
    expect(w.current.to).toBe('2026-08-01T12:00:00.000Z');
    expect(w.current.from).toBe('2026-07-02T12:00:00.000Z');
    // Adjacent, not overlapping: `prior.to` IS `current.from`, and the filter is half-open, so a
    // turn exactly on the boundary is counted once rather than in both windows.
    expect(w.prior.to).toBe(w.current.from);
    expect(w.prior.from).toBe('2026-06-02T12:00:00.000Z');
  });

  it('leaves both windows unbounded for `all`', () => {
    expect(windows('all', NOW)).toEqual({
      current: { from: null, to: null },
      prior: { from: null, to: null },
    });
  });
});

describe('ledger', () => {
  it('prices the window and compares it against the prior one', async () => {
    await seedSession('s1');
    // In-window: 1M input + 1M output = $1 + $10.
    await seedTurn('s1', '2026-07-20T10:00:00.000Z', { input: 1_000_000, output: 1_000_000 });
    // Prior window (35 days back): 1M input = $1.
    await seedTurn('s1', '2026-06-27T10:00:00.000Z', { input: 1_000_000 });

    const s = await stats(testEnv.DB, BASE, NOW);
    expect(s.ledger.usd).toBeCloseTo(11, 6);
    expect(s.ledger.priorUsd).toBeCloseTo(1, 6);
    expect(s.ledger.calls).toBe(1);
  });

  it('excludes the synthetic prompt-log harness from every number', async () => {
    // One row of it spans months and outweighs real work in any ranking it is allowed into.
    await seedSession('real');
    await seedSession('plog', { harness: 'prompt-log' });
    await seedTurn('real', '2026-07-20T10:00:00.000Z', { input: 1_000_000 });
    await seedTurn('plog', '2026-07-20T10:00:00.000Z', { input: 500_000_000 });

    const s = await stats(testEnv.DB, BASE, NOW);
    expect(s.ledger.usd, 'prompt-log usage reached the ledger').toBeCloseTo(1, 6);
    expect(s.ledger.calls).toBe(1);
  });

  it('excludes prompt-log from the narrow panels, not just the ledger', async () => {
    // There are two exclusion paths. With no session filter set — this page — NOTHING joins
    // `sessions` (the join costs a lookup per usage row for the sake of 7 sessions out of 31k), so
    // every panel excludes by bound session id; the harness-filter test below is what covers the
    // join path. The ledger reaches its numbers through the main scan, so it cannot tell you
    // whether rhythm and the gap histogram — separate queries, same predicate — also got it right.
    // A regression there would leave a synthetic row spanning months sitting in the middle of the
    // heatmap while every dollar figure looked right.
    await seedSession('real');
    await seedSession('plog', { harness: 'prompt-log' });
    await seedTurn('real', '2026-07-20T10:00:00.000Z', { input: 1 });
    await seedTurn('plog', '2026-07-21T03:00:00.000Z', { input: 1 });

    const s = await stats(testEnv.DB, BASE, NOW);
    expect(s.rhythm.reduce((a, c) => a + c.calls, 0), 'prompt-log turns reached the heatmap').toBe(1);
    expect(s.rhythm[0]!.hour, 'the surviving turn is not the real one').toBe(10);
  });

  it('still excludes prompt-log once the id list outgrows the bind budget', async () => {
    // D1 caps a statement at 100 bound parameters, and the excluded-id list is data-derived — it
    // grows with the corpus, not with anything we control. Past the budget `filters` swaps the
    // bound `NOT IN` for a parameter-free `NOT EXISTS`; without that arm every panel on the page
    // would start failing outright the day one prompt-log session too many landed. The count is
    // derived from the threshold, not written out: a literal would keep passing while quietly
    // testing the other arm the moment the constant moved.
    const excluded = MAX_EXCLUDED_BINDS + 1;
    await seedSession('real');
    await seedTurn('real', '2026-07-20T10:00:00.000Z', { input: 1_000_000 });
    for (let i = 0; i < excluded; i++) {
      await seedSession(`plog-${i}`, { harness: 'prompt-log' });
      await seedTurn(`plog-${i}`, '2026-07-21T03:00:00.000Z', { input: 500_000_000 });
    }

    const s = await stats(testEnv.DB, BASE, NOW);
    expect(s.ledger.usd, 'prompt-log usage reached the ledger').toBeCloseTo(1, 6);
    expect(s.ledger.calls, 'the main scan let prompt-log through').toBe(1);
    // The narrow panels are separate queries running the same predicate, and they are the ones
    // that would have thrown on the bind cap rather than merely miscounting.
    expect(s.rhythm.reduce((a, c) => a + c.calls, 0), 'prompt-log turns reached the heatmap').toBe(1);
  });

  it('reports the cache share of spend, not of tokens', async () => {
    // 1M cache reads at 0.1 = $0.10; 1M output at 10 = $10. Cache is 90% of TOKENS but under 1%
    // of the bill, and it is the bill that this number is about.
    await seedSession('s1');
    await seedTurn('s1', '2026-07-20T10:00:00.000Z', { cacheRead: 9_000_000, output: 1_000_000 });
    const s = await stats(testEnv.DB, BASE, NOW);
    expect(s.ledger.cacheShare).toBeCloseTo(0.9 / 10.9, 6);
  });

  it('counts turns it could not price so the total is not silently a floor', async () => {
    await seedSession('s1');
    await testEnv.DB.prepare(
      `INSERT INTO usage (session_id, turn_index, ts, model, input_tokens)
       VALUES ('s1', 900, '2026-07-20T10:00:00.000Z', 'no-such-model', 1000000)`,
    ).run();
    const s = await stats(testEnv.DB, BASE, NOW);
    expect(s.ledger.unpricedCalls).toBe(1);
    expect(s.ledger.usd).toBe(0);
  });
});

describe('token economics', () => {
  it('splits cost across the five billing classes and the split sums to the total', async () => {
    await seedSession('s1');
    await seedTurn('s1', '2026-07-20T10:00:00.000Z', {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      w5: 1_000_000,
      w1h: 1_000_000,
    });
    const s = await stats(testEnv.DB, BASE, NOW);
    const byLabel = new Map(s.classes.map((c) => [c.label, c]));
    expect(byLabel.get('Fresh input')!.usd).toBeCloseTo(1, 6);
    expect(byLabel.get('Output')!.usd).toBeCloseTo(10, 6);
    expect(byLabel.get('Cache read')!.usd).toBeCloseTo(0.1, 6);
    expect(byLabel.get('Cache write 5m')!.usd).toBeCloseTo(2, 6);
    expect(byLabel.get('Cache write 1h')!.usd).toBeCloseTo(4, 6);
    const sum = s.classes.reduce((a, c) => a + c.usd, 0);
    expect(sum, 'the class breakdown does not add up to the ledger total').toBeCloseTo(s.ledger.usd, 6);
  });
});

describe('session shape', () => {
  it('bands turns by depth and reports cost per turn within each band', async () => {
    await seedSession('s1');
    // Shallow turn: 1M input = $1. Deep turn: 10M input = $10. Same model, same rate.
    await seedTurn('s1', '2026-07-20T10:00:00.000Z', { depth: 2, input: 1_000_000 });
    await seedTurn('s1', '2026-07-20T11:00:00.000Z', { depth: 120, input: 10_000_000 });

    const s = await stats(testEnv.DB, BASE, NOW);
    const byBand = new Map(s.depth.map((d) => [d.label, d]));
    expect(byBand.get('1–5')!.usdPerCall).toBeCloseTo(1, 6);
    expect(byBand.get('101–200')!.usdPerCall).toBeCloseTo(10, 6);
    expect(byBand.get('101–200')!.sessions).toBe(1);
    // A band with no turns must report 0, not NaN from dividing by a zero call count.
    expect(byBand.get('200+')!.usdPerCall).toBe(0);
  });
});

describe('cache tuning', () => {
  it('bins inter-turn gaps and splits them on the 5-minute line', async () => {
    await seedSession('s1');
    await seedTurn('s1', '2026-07-20T10:00:00.000Z', { depth: 0 });
    await seedTurn('s1', '2026-07-20T10:00:20.000Z', { depth: 1 }); // 20s
    await seedTurn('s1', '2026-07-20T10:20:20.000Z', { depth: 2 }); // 20m

    const s = await stats(testEnv.DB, BASE, NOW);
    const byBand = new Map(s.gaps.map((g) => [g.label, g]));
    expect(byBand.get('15–30s')!.turns).toBe(1);
    expect(byBand.get('15–30s')!.overFiveMin).toBe(false);
    expect(byBand.get('10–30m')!.turns).toBe(1);
    expect(byBand.get('10–30m')!.overFiveMin).toBe(true);
    // The first turn of a session has no predecessor and must not become a zero-second gap,
    // which would land in '<15s' and inflate the "your 1h writes are wasted" reading.
    expect(byBand.get('<15s')!.turns).toBe(0);
  });

  it('treats the band bounds as half-open, so a gap of exactly 30m is not in the 10–30m band', async () => {
    // Pinned because it is the kind of boundary a reader assumes either way, and the 5-minute
    // split below it is the number the panel's whole recommendation rests on.
    await seedSession('s1');
    await seedTurn('s1', '2026-07-20T10:00:00.000Z', { depth: 0 });
    await seedTurn('s1', '2026-07-20T10:30:00.000Z', { depth: 1 });
    const s = await stats(testEnv.DB, BASE, NOW);
    const byBand = new Map(s.gaps.map((g) => [g.label, g]));
    expect(byBand.get('10–30m')!.turns).toBe(0);
    expect(byBand.get('30–60m')!.turns).toBe(1);
  });

  it('puts a gap of exactly 5 minutes on the expired side, where the 1h write earns its premium', async () => {
    // A 5m cache entry written at T is gone at T+300, so a turn landing exactly then is a miss.
    // Getting this backwards flips the panel's recommendation for every tight-loop session.
    await seedSession('s1');
    await seedTurn('s1', '2026-07-20T10:00:00.000Z', { depth: 0 });
    await seedTurn('s1', '2026-07-20T10:05:00.000Z', { depth: 1 });
    const s = await stats(testEnv.DB, BASE, NOW);
    const hit = s.gaps.find((g) => g.turns > 0)!;
    expect(hit.label).toBe('5–10m');
    expect(hit.overFiveMin, 'a 5-minute gap was counted as covered by the 5m TTL').toBe(true);
  });

  it('drops a gap whose timestamps run backwards rather than calling it zero seconds', async () => {
    // turn_index is the transcript's order and ts is nullable and can disagree with it. A
    // negative gap is that disagreement, not a fast turnaround.
    await seedSession('s1');
    await seedTurn('s1', '2026-07-20T10:00:00.000Z', { depth: 0 });
    await seedTurn('s1', '2026-07-20T09:00:00.000Z', { depth: 1 });
    const s = await stats(testEnv.DB, BASE, NOW);
    expect(s.gaps.reduce((a, g) => a + g.turns, 0), 'a backwards gap was counted').toBe(0);
  });
});

describe('attribution', () => {
  it('keys branches by project so two repos with a `main` do not pool', async () => {
    await seedSession('a', { project_name: 'alpha', git_branch: 'main' });
    await seedSession('b', { project_name: 'beta', git_branch: 'main' });
    await seedTurn('a', '2026-07-20T10:00:00.000Z', { input: 1_000_000 });
    await seedTurn('b', '2026-07-20T10:00:00.000Z', { input: 2_000_000 });

    const s = await stats(testEnv.DB, { ...BASE, by: 'branch' }, NOW);
    const keys = s.attribution.map((r) => r.key);
    expect(keys).toContain('alpha@main');
    expect(keys).toContain('beta@main');
    expect(s.attribution.find((r) => r.key === 'beta@main')!.usd).toBeCloseTo(2, 6);
  });

  it('gives a NULL project a visible label rather than dropping the row', async () => {
    await testEnv.DB.prepare(
      `INSERT INTO sessions (session_id, harness, machine_id, started_at, index_state)
       VALUES ('np', 'claude-code', 'box', '2026-07-20T00:00:00Z', 'ready')`,
    ).run();
    await seedTurn('np', '2026-07-20T10:00:00.000Z', { input: 1_000_000 });
    const s = await stats(testEnv.DB, { ...BASE, by: 'project' }, NOW);
    expect(s.attribution.map((r) => r.key)).toContain('(no project)');
  });
});

describe('rhythm', () => {
  it('shifts weekday and hour into the requested timezone', async () => {
    await seedSession('s1');
    // 02:00 UTC on Monday 2026-07-20 is 18:00 the previous day (Sunday) at UTC-8.
    await seedTurn('s1', '2026-07-20T02:00:00.000Z', { input: 1 });

    const utc = await stats(testEnv.DB, BASE, NOW);
    expect(utc.rhythm).toEqual([{ dow: 1, hour: 2, calls: 1 }]);

    const pacific = await stats(testEnv.DB, { ...BASE, tzOffsetHours: -8 }, NOW);
    expect(pacific.rhythm, 'the timezone offset did not move the cell').toEqual([{ dow: 0, hour: 18, calls: 1 }]);
  });

  it('leaves a turn with no timestamp off the clock', async () => {
    await seedSession('s1');
    await seedTurn('s1', null, { input: 1 });
    const s = await stats(testEnv.DB, { ...BASE, range: 'all' }, NOW);
    expect(s.rhythm).toEqual([]);
  });
});

describe('outliers', () => {
  it('ranks sessions by cost and carries a title through for the link', async () => {
    await seedSession('cheap', { title: 'a cheap one' });
    await seedSession('pricey', { title: 'the expensive one' });
    await seedTurn('cheap', '2026-07-20T10:00:00.000Z', { input: 1_000_000 });
    await seedTurn('pricey', '2026-07-20T10:00:00.000Z', { input: 50_000_000 });

    const s = await stats(testEnv.DB, BASE, NOW);
    expect(s.outliers[0]!.sessionId).toBe('pricey');
    expect(s.outliers[0]!.title).toBe('the expensive one');
    expect(s.outliers[0]!.usd).toBeCloseTo(50, 6);
  });

  it('prefers first_interaction_title over the raw title', async () => {
    await seedSession('s1', { title: 'raw' });
    await testEnv.DB.prepare(`UPDATE sessions SET first_interaction_title = 'parsed' WHERE session_id = 's1'`).run();
    await seedTurn('s1', '2026-07-20T10:00:00.000Z', { input: 1_000_000 });
    const s = await stats(testEnv.DB, BASE, NOW);
    expect(s.outliers[0]!.title).toBe('parsed');
  });
});

describe('filters', () => {
  it('applies a harness filter to every panel, not just the ledger', async () => {
    await seedSession('cc', { harness: 'claude-code', project_name: 'alpha' });
    await seedSession('cx', { harness: 'codex', project_name: 'beta' });
    await seedTurn('cc', '2026-07-20T10:00:00.000Z', { input: 1_000_000 });
    await seedTurn('cx', '2026-07-20T10:00:00.000Z', { input: 9_000_000 });

    const s = await stats(testEnv.DB, { ...BASE, harness: 'claude-code' }, NOW);
    expect(s.ledger.usd).toBeCloseTo(1, 6);
    // The filter has to reach the other queries too. A panel built from an unfiltered query
    // would still show beta here, and nothing on the page would say so.
    expect(s.attribution.map((r) => r.key)).toEqual(['alpha']);
    expect(s.outliers.map((o) => o.sessionId)).toEqual(['cc']);
    expect(s.rhythm.reduce((a, c) => a + c.calls, 0)).toBe(1);
  });
});

describe('the page', () => {
  it('renders with data and links its outliers to the transcript', async () => {
    await seedSession('s1', { title: 'a session' });
    await seedTurn('s1', '2026-07-20T10:00:00.000Z', { input: 1_000_000, output: 100_000 });

    const res = await SELF.fetch('https://sessions.vza.net/stats');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Statistics');
    expect(html).toContain('/s/s1');
    // Every panel present, so a rendering error in one shows up as a failure here rather than as
    // a quietly missing section.
    for (const id of ['ledger', 'shape', 'classes', 'cache', 'attribution', 'rhythm', 'models', 'outliers', 'unbuilt']) {
      expect(html, `panel ${id} is missing`).toContain(`id="${id}"`);
    }
  });

  it('renders an empty corpus without dividing by zero', async () => {
    const res = await SELF.fetch('https://sessions.vza.net/stats');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });

  it('falls back to defaults for an unparseable range instead of erroring', async () => {
    const res = await SELF.fetch('https://sessions.vza.net/stats?range=lifetime&by=colour&tz=nope');
    expect(res.status).toBe(200);
  });
});
