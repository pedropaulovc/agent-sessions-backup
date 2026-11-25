import { esc, fmtBytes, page } from './layout';

const MANAGED_SKILL_STORE = 'omp-skills';
const MEMORY_SKILL_STORE = 'omp-memories';
const MAX_RENDERED_SKILL_BYTES = 1024 * 1024;

interface SkillFileRow {
  id: number;
  machine_id: string;
  store: string;
  relpath: string;
  r2_key: string;
  size: number;
  mtime: string | null;
  content_hash: string;
  uploaded_at: string;
}

interface PackageFileRow {
  relpath: string;
  size: number;
}

interface ParsedSkill {
  name: string;
  source: 'managed' | 'memory';
  scope: string | null;
}

/** GET /skills — current backed-up SKILL.md copies from every enrolled machine. */
export async function skillsPage(env: Env): Promise<Response> {
  const files = await env.DB.prepare(
    `SELECT id, machine_id, store, relpath, r2_key, size, mtime, content_hash, uploaded_at
     FROM files
     WHERE store IN (?1, ?2) AND relpath LIKE '%/SKILL.md'
     ORDER BY relpath COLLATE NOCASE, machine_id COLLATE NOCASE`,
  ).bind(MANAGED_SKILL_STORE, MEMORY_SKILL_STORE).all<SkillFileRow>();

  const skills = files.results.flatMap((file) => {
    const parsed = parseSkillPath(file.store, file.relpath);
    return parsed === null ? [] : [{ file, skill: parsed }];
  });
  skills.sort((a, b) =>
    compareAsciiInsensitive(a.skill.name, b.skill.name) ||
    (a.skill.source === b.skill.source ? 0 : a.skill.source === 'managed' ? -1 : 1) ||
    compareAsciiInsensitive(a.skill.scope ?? '', b.skill.scope ?? '') ||
    compareAsciiInsensitive(a.file.machine_id, b.file.machine_id) ||
    (a.file.id - b.file.id),
  );

  const distinct = new Set(skills.map(({ skill }) => skill.name)).size;
  const managedCount = skills.filter(({ skill }) => skill.source === 'managed').length;
  const memoryCount = skills.length - managedCount;
  const rows = skills.map(({ file, skill }) =>
    `<tr><td><a href="/skills/${file.id}">${esc(skill.name)}</a></td>` +
    `<td>${renderSourceCell(skill)}</td>` +
    `<td>${esc(file.machine_id)}</td>` +
    `<td class="num">${fmtBytes(file.size)}</td>` +
    `<td>${renderModifiedTime(file)}</td>` +
    `<td><code>${esc(file.content_hash.slice(0, 12))}</code></td></tr>`,
  ).join('');

  const body =
    `<section class="skills-page"><h2>Skills</h2>` +
    `<p class="muted small">${distinct} ${distinct === 1 ? 'skill' : 'skills'} · ${skills.length} backed-up ${skills.length === 1 ? 'copy' : 'copies'} (${managedCount} managed, ${memoryCount} memory)</p>` +
    `<div class="skills-table-scroll" role="region" aria-label="Backed-up skills" tabindex="0"><table><thead><tr>` +
    `<th>Skill</th><th>Source</th><th>Machine</th><th class="num">Manifest</th><th>Modified</th><th>SHA-256</th>` +
    `</tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">No skills backed up yet.</td></tr>'}</tbody></table></div></section>`;
  return skillDocument({ title: 'Skills — sessions', body });
}

/** GET /skills/:fileId — escaped source plus the complete backed-up package inventory. */
export async function skillPage(fileId: number, env: Env): Promise<Response> {
  const file = await env.DB.prepare(
    `SELECT id, machine_id, store, relpath, r2_key, size, mtime, content_hash, uploaded_at
     FROM files WHERE id = ?1 AND store IN (?2, ?3)`,
  ).bind(fileId, MANAGED_SKILL_STORE, MEMORY_SKILL_STORE).first<SkillFileRow>();
  const parsed = file ? parseSkillPath(file.store, file.relpath) : null;
  if (!file || parsed === null) return new Response('skill not found', { status: 404 });

  const prefix = file.relpath.slice(0, -'SKILL.md'.length);
  const packageFiles = await env.DB.prepare(
    `SELECT relpath, size FROM files
     WHERE machine_id = ?1 AND store = ?2 AND relpath >= ?3 AND relpath < ?4
     ORDER BY relpath COLLATE NOCASE`,
  ).bind(file.machine_id, file.store, prefix, `${prefix}\u{10ffff}`).all<PackageFileRow>();
  const inventory = packageFiles.results.map((item) =>
    `<li><code>${esc(item.relpath.slice(prefix.length))}</code><span class="muted small">${fmtBytes(item.size)}</span></li>`,
  ).join('');

  let source: string;
  let sourceNote = '';
  if (file.size > MAX_RENDERED_SKILL_BYTES) {
    source = '';
    sourceNote = `<div class="warn">SKILL.md is ${fmtBytes(file.size)}; source display is limited to ${fmtBytes(MAX_RENDERED_SKILL_BYTES)}.</div>`;
  } else {
    const object = await env.RAW.get(file.r2_key);
    if (!object) return new Response('skill backup missing', { status: 404 });
    if (object.size > MAX_RENDERED_SKILL_BYTES) {
      source = '';
      sourceNote = `<div class="warn">Stored SKILL.md exceeds the ${fmtBytes(MAX_RENDERED_SKILL_BYTES)} source-display limit.</div>`;
    } else {
      const bytes = await object.arrayBuffer();
      try {
        source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      } catch {
        source = '';
        sourceNote = '<div class="warn">Stored SKILL.md is not valid UTF-8 text.</div>';
      }
    }
  }

  const scopeMeta = parsed.scope === null
    ? ''
    : `<span><span class="muted">scope</span> <code>${esc(parsed.scope)}</code></span>`;
  const body =
    `<section class="skill-page"><p class="small"><a href="/skills">← All skills</a></p>` +
    `<div class="sesshead"><h2>${esc(parsed.name)}</h2><div class="kv">` +
    `<span><span class="muted">source</span> ${parsed.source}</span>` +
    scopeMeta +
    `<span><span class="muted">machine</span> ${esc(file.machine_id)}</span>` +
    `<span><span class="muted">modified</span> ${renderModifiedTime(file)}</span>` +
    `<span><span class="muted">sha256</span> <code>${esc(file.content_hash)}</code></span>` +
    `</div></div>${sourceNote}` +
    (sourceNote ? '' : `<pre class="skill-source">${esc(source)}</pre>`) +
    `<details class="skill-files"><summary>${packageFiles.results.length} backed-up package ${packageFiles.results.length === 1 ? 'file' : 'files'}</summary>` +
    `<ul>${inventory}</ul></details></section>`;
  return skillDocument({ title: `${parsed.name} — skills`, body });
}

function parseSkillPath(store: string, relpath: string): ParsedSkill | null {
  const parts = relpath.split('/');
  if (store === MANAGED_SKILL_STORE) {
    if (parts.length !== 2 || parts[1] !== 'SKILL.md' || parts[0] === '') return null;
    return { name: parts[0]!, source: 'managed', scope: null };
  }
  if (store === MEMORY_SKILL_STORE) {
    if (parts.length !== 4 || parts[0] === '' || parts[1] !== 'skills' || parts[2] === '' || parts[3] !== 'SKILL.md') {
      return null;
    }
    return { name: parts[2]!, source: 'memory', scope: parts[0]! };
  }
  return null;
}

function renderSourceCell(skill: ParsedSkill): string {
  if (skill.source === 'managed') return 'managed';
  return `memory · <code>${esc(skill.scope!)}</code>`;
}

function compareAsciiInsensitive(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function skillDocument(opts: { title: string; body: string }): Response {
  const response = page({ ...opts, nav: 'skills' });
  response.headers.set('cache-control', 'private, no-store');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}

function renderModifiedTime(file: Pick<SkillFileRow, 'mtime' | 'uploaded_at'>): string {
  const value = esc(file.mtime ?? file.uploaded_at);
  return file.mtime === null ? `${value} <span class="muted small">(uploaded)</span>` : value;
}
