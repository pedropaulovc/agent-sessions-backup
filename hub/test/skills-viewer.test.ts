import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VIEWER } from './hosts';

const testEnv = env as unknown as Env;
const MACHINE = 'skills-viewer-box';
const STORE = 'omp-skills';
const r2Keys: string[] = [];

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seedFile(relpath: string, content: string, store = STORE): Promise<number> {
  const bytes = new TextEncoder().encode(content);
  const hash = await sha256Hex(bytes);
  const r2Key = `raw/${MACHINE}/${store}/${relpath}`;
  await testEnv.RAW.put(r2Key, bytes);
  r2Keys.push(r2Key);
  const row = await testEnv.DB.prepare(
    `INSERT INTO files (machine_id, store, relpath, r2_key, size, mtime, content_hash, harness, parse_state)
     VALUES (?1, ?2, ?3, ?4, ?5, '2026-09-14T12:00:00.000Z', ?6, 'unknown', 'skipped')
     RETURNING id`,
  ).bind(MACHINE, store, relpath, r2Key, bytes.byteLength, hash).first<{ id: number }>();
  if (!row) throw new Error(`failed to seed ${relpath}`);
  return row.id;
}

beforeEach(async () => {
  await testEnv.DB.prepare(
    `INSERT INTO machines (machine_id, os) VALUES (?1, 'linux')
     ON CONFLICT (machine_id) DO NOTHING`,
  ).bind(MACHINE).run();
});

afterEach(async () => {
  await testEnv.DB.prepare('DELETE FROM files WHERE machine_id = ?1').bind(MACHINE).run();
  await testEnv.DB.prepare('DELETE FROM machines WHERE machine_id = ?1').bind(MACHINE).run();
  for (const key of r2Keys.splice(0)) await testEnv.RAW.delete(key);
});

describe('managed skills viewer', () => {
  it('lists each direct managed-skill manifest and keeps companion files out of the skill index', async () => {
    const skillId = await seedFile('example/SKILL.md', '---\nname: example\n---\n');
    await seedFile('example/references/guide.md', 'guide');
    await seedFile('nested/example/SKILL.md', 'not a direct managed skill');
    await seedFile('other/SKILL.md', 'wrong store', 'claude');

    const response = await SELF.fetch(`${VIEWER}/skills`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`<a href="/skills/${skillId}">example</a>`);
    expect(html).toContain('1 managed skill · 1 backed-up copy');
    expect(html).not.toContain('nested/example');
    expect(html).not.toContain('wrong store');
    expect(html).toContain('<a href="/skills" style="font-weight:700">Skills</a>');
  });

  it('renders escaped SKILL.md source and inventories its complete backed-up package', async () => {
    const source = '---\nname: example\n---\n# <script>alert("skill-xss")</script>\n';
    const skillId = await seedFile('example/SKILL.md', source);
    await seedFile('example/references/guide.md', 'guide');
    await seedFile('example/scripts/check.py', 'print("ok")');

    const response = await SELF.fetch(`${VIEWER}/skills/${skillId}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<h2>example</h2>');
    expect(html).toContain('# &lt;script&gt;alert(&quot;skill-xss&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert("skill-xss")</script>');
    expect(html).toContain('<code>SKILL.md</code>');
    expect(html).toContain('<code>references/guide.md</code>');
    expect(html).toContain('<code>scripts/check.py</code>');
    expect(html).toContain('3 backed-up package files');
  });

  it('does not expose arbitrary backed-up files through the skill-detail route', async () => {
    const companionId = await seedFile('example/scripts/check.py', 'private companion');
    const wrongStoreId = await seedFile('other/SKILL.md', 'wrong store', 'claude');

    expect((await SELF.fetch(`${VIEWER}/skills/${companionId}`)).status).toBe(404);
    expect((await SELF.fetch(`${VIEWER}/skills/${wrongStoreId}`)).status).toBe(404);
    expect((await SELF.fetch(`${VIEWER}/skills/not-a-number`)).status).toBe(404);
  });
});
