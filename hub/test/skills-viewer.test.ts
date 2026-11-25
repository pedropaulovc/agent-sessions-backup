import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API, VIEWER } from './hosts';

const testEnv = env as unknown as Env;
const MACHINE = 'skills-viewer-box';
const STORE = 'omp-skills';
const MEMORY_STORE = 'omp-memories';
const r2Keys: string[] = [];

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seedFile(
  relpath: string,
  content: string,
  store = STORE,
  mtime: string | null = '2026-09-14T12:00:00.000Z',
): Promise<number> {
  const bytes = new TextEncoder().encode(content);
  const hash = await sha256Hex(bytes);
  const r2Key = `raw/${MACHINE}/${store}/${relpath}`;
  await testEnv.RAW.put(r2Key, bytes);
  r2Keys.push(r2Key);
  const row = await testEnv.DB.prepare(
    `INSERT INTO files (machine_id, store, relpath, r2_key, size, mtime, content_hash, harness, parse_state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'unknown', 'skipped')
     RETURNING id`,
  ).bind(MACHINE, store, relpath, r2Key, bytes.byteLength, mtime, hash).first<{ id: number }>();
  if (!row) throw new Error(`failed to seed ${relpath}`);
  return row.id;
}

async function uploadFile(relpath: string, content: string, store = STORE): Promise<{ response: Response; fileId: number }> {
  const bytes = new TextEncoder().encode(content);
  const r2Key = `raw/${MACHINE}/${store}/${relpath}`;
  r2Keys.push(r2Key);
  const response = await SELF.fetch(`${API}/api/v1/files/${MACHINE}/${store}/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': MACHINE,
      'x-content-hash': `sha256:${await sha256Hex(bytes)}`,
      'x-file-mtime': '2026-09-14T12:00:00.000Z',
      'content-length': String(bytes.byteLength),
    },
    body: bytes,
  });
  const payload = await response.clone().json() as { file_id?: unknown };
  if (typeof payload.file_id !== 'number') throw new Error(`upload did not return a file id: ${response.status}`);
  return { response, fileId: payload.file_id };
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

describe('skills viewer', () => {
  it('accepts managed-skill and omp-memories uploads as raw files without creating a session', async () => {
    const { response, fileId } = await uploadFile('uploaded/SKILL.md', '---\nname: uploaded\n---\n');
    const memory = await uploadFile(
      '--home-user-src-demo--/skills/mem-uploaded/SKILL.md',
      '---\nname: mem-uploaded\n---\n',
      MEMORY_STORE,
    );

    expect(response.status).toBe(201);
    expect(memory.response.status).toBe(201);
    for (const id of [fileId, memory.fileId]) {
      expect(
        await testEnv.DB.prepare('SELECT parse_state, harness, session_id FROM files WHERE id = ?1')
          .bind(id)
          .first(),
      ).toEqual({ parse_state: 'skipped', harness: 'unknown', session_id: null });
      expect(
        await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM sessions WHERE canonical_file_id = ?1')
          .bind(id)
          .first(),
      ).toEqual({ count: 0 });
    }
    expect(await (await SELF.fetch(`${VIEWER}/skills/${fileId}`)).text()).toContain('<h2>uploaded</h2>');
    const memoryHtml = await (await SELF.fetch(`${VIEWER}/skills/${memory.fileId}`)).text();
    expect(memoryHtml).toContain('<h2>mem-uploaded</h2>');
    expect(memoryHtml).toContain('<span class="muted">source</span> memory');
    expect(memoryHtml).toContain('<span class="muted">scope</span> <code>--home-user-src-demo--</code>');
  });

  it('lists managed and memory skill manifests alongside each other and keeps companion/non-skill files out', async () => {
    const managedId = await seedFile('zeta-skill/SKILL.md', '---\nname: zeta-skill\n---\n');
    await seedFile('zeta-skill/references/guide.md', 'guide');
    await seedFile('nested/example/SKILL.md', 'not a direct managed skill');
    await seedFile('other/SKILL.md', 'wrong store', 'claude');

    const memoryId = await seedFile(
      '--home-user-src-demo--/skills/alpha-skill/SKILL.md',
      '---\nname: alpha-skill\n---\n',
      MEMORY_STORE,
    );
    await seedFile('--home-user-src-demo--/skills/alpha-skill/examples/demo.md', 'demo', MEMORY_STORE);
    await seedFile('--home-user-src-demo--/MEMORY.md', '# Memory', MEMORY_STORE);
    await seedFile('--home-user-src-demo--/skills/alpha-skill/nested/SKILL.md', 'too deep', MEMORY_STORE);
    await seedFile('--home-user-src-demo--/other/alpha-skill/SKILL.md', 'not under skills dir', MEMORY_STORE);

    const response = await SELF.fetch(`${VIEWER}/skills`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`<a href="/skills/${managedId}">zeta-skill</a>`);
    expect(html).toContain(`<a href="/skills/${memoryId}">alpha-skill</a>`);
    expect(html.indexOf('alpha-skill')).toBeLessThan(html.indexOf('zeta-skill'));
    expect(html).toContain('<td>managed</td>');
    expect(html).toContain('<td>memory · <code>--home-user-src-demo--</code></td>');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(html).toContain('2 skills · 2 backed-up copies (1 managed, 1 memory)');
    expect(html).not.toContain('nested/example');
    expect(html).not.toContain('wrong store');
    expect(html).not.toContain('MEMORY.md');
    expect(html).not.toContain('too deep');
    expect(html).not.toContain('not under skills dir');
    expect(html).toContain('<a href="/skills" style="font-weight:700">Skills</a>');
    expect(html).toContain('<div class="skills-table-scroll" role="region" aria-label="Backed-up skills" tabindex="0">');
    expect(html).toContain('2026-09-14T12:00:00.000Z');
    expect(html).not.toContain('(uploaded)');
  });

  it('renders escaped SKILL.md source and inventories its complete backed-up package', async () => {
    const source = '---\nname: example-rocket\n---\n# <script>alert("skill-xss")</script>\n';
    const skillId = await seedFile('example🚀/SKILL.md', source);
    await seedFile('example🚀/references/guide.md', 'guide');
    await seedFile('example🚀/scripts/check.py', 'print("ok")');
    await seedFile('example🚀/🚀notes.md', 'notes');

    const response = await SELF.fetch(`${VIEWER}/skills/${skillId}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<h2>example🚀</h2>');
    expect(html).toContain('<span class="muted">source</span> managed');
    expect(html).toContain('# &lt;script&gt;alert(&quot;skill-xss&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert("skill-xss")</script>');
    expect(html).toContain('<code>SKILL.md</code>');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(html).toContain('<code>references/guide.md</code>');
    expect(html).toContain('<code>scripts/check.py</code>');
    expect(html).toContain('<code>🚀notes.md</code>');
    expect(html).toContain('4 backed-up package files');
  });

  it('renders memory skill detail with escaped scope and isolates its package inventory', async () => {
    const scope = '--home-<script>-demo--';
    const skillId = await seedFile(
      `${scope}/skills/pds-triage/SKILL.md`,
      '---\nname: pds-triage\n---\n# Memory skill\n',
      MEMORY_STORE,
    );
    await seedFile(`${scope}/skills/pds-triage/examples/triage.md`, 'example', MEMORY_STORE);
    await seedFile(`${scope}/skills/pds-triage/templates/report.md`, 'template', MEMORY_STORE);
    await seedFile(`${scope}/skills/sibling-skill/SKILL.md`, 'sibling', MEMORY_STORE);
    await seedFile(`${scope}/MEMORY.md`, 'top-level memory doc', MEMORY_STORE);

    const response = await SELF.fetch(`${VIEWER}/skills/${skillId}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<h2>pds-triage</h2>');
    expect(html).toContain('<span class="muted">source</span> memory');
    expect(html).toContain('<span class="muted">scope</span> <code>--home-&lt;script&gt;-demo--</code>');
    expect(html).not.toContain('<script>-demo--');
    expect(html).toContain('<code>SKILL.md</code>');
    expect(html).toContain('<code>examples/triage.md</code>');
    expect(html).toContain('<code>templates/report.md</code>');
    expect(html).toContain('3 backed-up package files');
    expect(html).not.toContain('sibling-skill');
    expect(html).not.toContain('MEMORY.md');
  });

  it('labels upload time when filesystem modification time is unavailable', async () => {
    const skillId = await seedFile('undated/SKILL.md', '---\nname: undated\n---\n', STORE, null);

    const list = await (await SELF.fetch(`${VIEWER}/skills`)).text();
    const detail = await (await SELF.fetch(`${VIEWER}/skills/${skillId}`)).text();

    expect(list).toContain('<span class="muted small">(uploaded)</span>');
    expect(detail).toContain('<span class="muted small">(uploaded)</span>');
  });

  it('does not expose arbitrary backed-up files through the skill-detail route', async () => {
    const companionId = await seedFile('example/scripts/check.py', 'private companion');
    const wrongStoreId = await seedFile('other/SKILL.md', 'wrong store', 'claude');
    const memoryDocId = await seedFile('--home-user-src-demo--/MEMORY.md', 'memory doc', MEMORY_STORE);
    const memoryCompanionId = await seedFile(
      '--home-user-src-demo--/skills/pds-triage/examples/triage.md',
      'memory companion',
      MEMORY_STORE,
    );

    expect((await SELF.fetch(`${VIEWER}/skills/${companionId}`)).status).toBe(404);
    expect((await SELF.fetch(`${VIEWER}/skills/${wrongStoreId}`)).status).toBe(404);
    expect((await SELF.fetch(`${VIEWER}/skills/${memoryDocId}`)).status).toBe(404);
    expect((await SELF.fetch(`${VIEWER}/skills/${memoryCompanionId}`)).status).toBe(404);
    expect((await SELF.fetch(`${VIEWER}/skills/not-a-number`)).status).toBe(404);
  });
});
