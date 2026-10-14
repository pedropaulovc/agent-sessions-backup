import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

// Throwaway verification driver. Runs only when the integration owner invokes it.
// This is a test-precondition control, NOT a production-predicate regression.
const root = dirname(fileURLToPath(import.meta.url));
const hub = join(root, 'hub');
const originalRevision = '4f372ffb3d4936be02df8e1f37fe706d9f41f507';
const testPath = 'hub/test/reindex-range.test.ts';
const testName = 'leaves a fresh reservation owned and retryable while unrelated targets progress';
const historical = execFileSync('git', ['show', `${originalRevision}:${testPath}`], { cwd: root, encoding: 'utf8' });
const current = await readFile(join(root, testPath), 'utf8');

function clockControl(futureAnchor) {
  return `
// Appended control: call the real queue consumer, then inspect real committed rows.
// Only the historical control moves the target's temporal lower bound into the future.
beforeEach(() => {
  const realQueue = worker.queue.bind(worker);
  vi.spyOn(worker, 'queue').mockImplementation(async (batch, queueEnv) => {
    await realQueue(batch, queueEnv);
    for (const message of batch.messages) {
      if (!('file_id' in message.body)) continue;
      const observed = await db.prepare(\`SELECT t.job_id, t.session_id, t.dispatched_at,
        f.parsed_at, s.updated_at, f.parse_state, s.index_state,
        f.content_hash IS t.content_hash AS source_matches,
        s.canonical_file_id IS t.file_id AS canonical_matches
        FROM reindex_range_targets t JOIN files f ON f.id = t.file_id
        JOIN sessions s ON s.session_id = t.session_id
        WHERE t.file_id = ?1 AND t.dispatch_state NOT IN ('ready', 'error')\`)
        .bind(message.body.file_id).first<{
          job_id: string; session_id: string; dispatched_at: string;
          parsed_at: string; updated_at: string; parse_state: string; index_state: string;
          source_matches: number; canonical_matches: number;
        }>();
      if (!observed) continue;
      expect(observed).toMatchObject({
        parse_state: 'parsed', index_state: 'ready', source_matches: 1, canonical_matches: 1,
      });
      expect(Number.isFinite(Date.parse(observed.parsed_at))).toBe(true);
      expect(Number.isFinite(Date.parse(observed.updated_at))).toBe(true);
      if (${futureAnchor}) {
        const future = new Date(Math.max(Date.parse(observed.parsed_at), Date.parse(observed.updated_at)) + 1).toISOString();
        await db.prepare('UPDATE reindex_range_targets SET dispatched_at = ?3 WHERE job_id = ?1 AND session_id = ?2')
          .bind(observed.job_id, observed.session_id, future).run();
      }
      const gate = await db.prepare(\`SELECT t.dispatched_at, f.parsed_at, s.updated_at,
        f.parsed_at >= t.dispatched_at AS file_time_fresh,
        s.updated_at >= t.dispatched_at AS session_time_fresh
        FROM reindex_range_targets t JOIN files f ON f.id = t.file_id
        JOIN sessions s ON s.session_id = t.session_id WHERE t.job_id = ?1 AND t.session_id = ?2\`)
        .bind(observed.job_id, observed.session_id).first();
      console.log(JSON.stringify({ event: 'reindex.clock.precondition', variant: '${futureAnchor ? 'historical-future-anchor' : 'ordered-fixture'}', ...gate }));
    }
  });
});
`;
}

const files = [];
try {
  for (const [variant, source, futureAnchor] of [
    ['historical', historical, true],
    ['ordered', current, false],
  ]) {
    const relative = `test/reindex-clock-${variant}-${process.pid}.test.ts`;
    const path = join(hub, relative);
    await writeFile(path, source + clockControl(futureAnchor), { flag: 'wx' });
    files.push(path);
    console.log(`\n=== ${variant}: ${variant === 'historical' ? originalRevision : 'integrated working source'} ===`);
    const result = spawnSync(process.execPath, [join(hub, 'node_modules/vitest/vitest.mjs'), 'run', relative, '-t', testName], {
      cwd: hub, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    assert.ifError(result.error);
    const output = stripVTControlCharacters(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    const records = output.split('\n').flatMap((line) => {
      try {
        const record = JSON.parse(line.trim());
        return record.event === 'reindex.clock.precondition' ? [record] : [];
      } catch { return []; }
    });
    assert.ok(records.length > 0, 'Control must reach the real consumer and report actual SQL gate inputs');
    if (futureAnchor) {
      assert.equal(result.status, 1, 'Historical ready:1 assertion must fail on the deliberate future lower bound');
      assert.ok(records.some((record) => record.file_time_fresh === 0 && record.session_time_fresh === 0));
      assert.match(output, /AssertionError/);
      assert.match(output, /"ready": 0/);
    } else {
      assert.equal(result.status, 0, 'Ordered temporal precondition must preserve ready:1/blocked:1 and eventual complete:2');
      assert.ok(records.every((record) => record.file_time_fresh === 1 && record.session_time_fresh === 1));
    }
  }
  console.log('\nPrecondition control passed: historical future anchor rejects healthy completion; ordered fixture accepts real healthy completion without releasing the reserved owner.');
} finally {
  for (const path of files) await rm(path, { force: true });
}
