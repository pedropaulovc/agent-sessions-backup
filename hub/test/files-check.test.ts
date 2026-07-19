import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

const testEnv = env as unknown as Env;
const MACHINE = 'files-check-cap';

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('POST /api/v1/files/check D1 variable cap', () => {
  it('checks all 500 items with no statement exceeding production D1\'s ?100 bind limit', async () => {
    await testEnv.DB.prepare(
      `INSERT INTO machines (machine_id, os) VALUES (?1, 'linux') ON CONFLICT (machine_id) DO NOTHING`,
    )
      .bind(MACHINE)
      .run();

    // Forty distinct, fully matching rows are enough to cross the 33-item boundary while keeping the
    // fixture cheap. Cycling them to 500 entries exercises the endpoint's public request maximum; every
    // requested triple still has a matching D1 row and checksum-verified R2 object.
    const fixtures = await Promise.all(
      Array.from({ length: 40 }, async (_, index) => {
        const store = 'cap-store';
        const relpath = `cap-${index}.jsonl`;
        const r2Key = `raw/${MACHINE}/${store}/${relpath}`;
        const bytes = new TextEncoder().encode(`files-check-cap-${index}`);
        const sha256 = await sha256Hex(bytes);
        await testEnv.RAW.put(r2Key, bytes, { sha256 });
        return { store, relpath, r2Key, sha256, size: bytes.length };
      }),
    );
    await testEnv.DB.batch(
      fixtures.map((fixture) =>
        testEnv.DB.prepare(
          `INSERT INTO files (machine_id, store, relpath, r2_key, size, content_hash, harness, parse_state)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'unknown', 'parsed')`,
        ).bind(MACHINE, fixture.store, fixture.relpath, fixture.r2Key, fixture.size, fixture.sha256),
      ),
    );

    const items = Array.from({ length: 500 }, (_, index) => {
      const fixture = fixtures[index % fixtures.length]!;
      return { store: fixture.store, relpath: fixture.relpath, sha256: `sha256:${fixture.sha256}` };
    });
    const queryBindCounts: number[] = [];
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const prepareSpy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((sql: string) => {
      const statement = realPrepare(sql);
      if (!sql.includes('FROM files WHERE machine_id = ?1 AND (')) return statement;
      const realBind = statement.bind.bind(statement);
      (statement as unknown as { bind: (...values: unknown[]) => D1PreparedStatement }).bind = (
        ...values: unknown[]
      ) => {
        queryBindCounts.push(values.length);
        return realBind(...(values as []));
      };
      return statement;
    });

    try {
      const response = await SELF.fetch('https://api.sessions.vza.net/api/v1/files/check', {
        method: 'POST',
        headers: { 'x-dev-machine': MACHINE, 'content-type': 'application/json' },
        body: JSON.stringify({ files: items }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()) as { missing: unknown[] }).toEqual({ missing: [] });
    } finally {
      prepareSpy.mockRestore();
    }

    // 500 = 15 full chunks of 33 plus 5 items. Each full query binds 1 + 33*3 = 100;
    // the final query binds 1 + 5*3 = 16. The old 50-item chunks produced 151 binds here.
    expect(queryBindCounts).toEqual([...Array<number>(15).fill(100), 16]);
    expect(Math.max(...queryBindCounts)).toBe(100);
  });
});
