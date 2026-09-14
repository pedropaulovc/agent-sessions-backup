import { esc, page } from './layout';

const SKILL_STORE = 'omp-skills';
const MAX_RENDERED_SKILL_BYTES = 1024 * 1024;

interface SkillFileRow {
  id: number;
  machine_id: string;
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

/** GET /skills — current backed-up SKILL.md copies from every enrolled machine. */
export async function skillsPage(env: Env): Promise<Response> {
  const files = await env.DB.prepare(
    `SELECT id, machine_id, relpath, r2_key, size, mtime, content_hash, uploaded_at
     FROM files
     WHERE store = ?1 AND relpath LIKE '%/SKILL.md'
     ORDER BY relpath COLLATE NOCASE, machine_id COLLATE NOCASE`,
  ).bind(SKILL_STORE).all<SkillFileRow>();

  const skills = files.results.flatMap((file) => {
    const name = skillName(file.relpath);
    return name === null ? [] : [{ file, name }];
  });
  const distinct = new Set(skills.map(({ name }) => name)).size;
  const rows = skills.map(({ file, name }) =>
    `<tr><td><a href="/skills/${file.id}">${esc(name)}</a></td>` +
    `<td>${esc(file.machine_id)}</td>` +
    `<td class="num">${formatBytes(file.size)}</td>` +
    `<td>${esc(file.mtime ?? file.uploaded_at)}</td>` +
    `<td><code>${esc(file.content_hash.slice(0, 12))}</code></td></tr>`,
  ).join('');

  const body =
    `<section class="skills-page"><h2>Skills</h2>` +
    `<p class="muted small">${distinct} managed ${distinct === 1 ? 'skill' : 'skills'} · ${skills.length} backed-up ${skills.length === 1 ? 'copy' : 'copies'}</p>` +
    `<div class="skills-table-scroll"><table><thead><tr>` +
    `<th>Skill</th><th>Machine</th><th class="num">Manifest</th><th>Modified</th><th>SHA-256</th>` +
    `</tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No managed skills backed up yet.</td></tr>'}</tbody></table></div></section>`;
  return skillDocument({ title: 'Skills — sessions', body });
}

/** GET /skills/:fileId — escaped source plus the complete backed-up package inventory. */
export async function skillPage(fileId: number, env: Env): Promise<Response> {
  const file = await env.DB.prepare(
    `SELECT id, machine_id, relpath, r2_key, size, mtime, content_hash, uploaded_at
     FROM files WHERE id = ?1 AND store = ?2`,
  ).bind(fileId, SKILL_STORE).first<SkillFileRow>();
  const name = file ? skillName(file.relpath) : null;
  if (!file || name === null) return new Response('skill not found', { status: 404 });

  const prefix = file.relpath.slice(0, -'SKILL.md'.length);
  const packageFiles = await env.DB.prepare(
    `SELECT relpath, size FROM files
     WHERE machine_id = ?1 AND store = ?2 AND substr(relpath, 1, ?3) = ?4
     ORDER BY relpath COLLATE NOCASE`,
  ).bind(file.machine_id, SKILL_STORE, prefix.length, prefix).all<PackageFileRow>();
  const inventory = packageFiles.results.map((item) =>
    `<li><code>${esc(item.relpath.slice(prefix.length))}</code><span class="muted small">${formatBytes(item.size)}</span></li>`,
  ).join('');

  let source: string;
  let sourceNote = '';
  if (file.size > MAX_RENDERED_SKILL_BYTES) {
    source = '';
    sourceNote = `<div class="warn">SKILL.md is ${formatBytes(file.size)}; source display is limited to ${formatBytes(MAX_RENDERED_SKILL_BYTES)}.</div>`;
  } else {
    const object = await env.RAW.get(file.r2_key);
    if (!object) return new Response('skill backup missing', { status: 404 });
    if (object.size > MAX_RENDERED_SKILL_BYTES) {
      source = '';
      sourceNote = `<div class="warn">Stored SKILL.md exceeds the ${formatBytes(MAX_RENDERED_SKILL_BYTES)} source-display limit.</div>`;
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

  const body =
    `<section class="skill-page"><p class="small"><a href="/skills">← All skills</a></p>` +
    `<div class="sesshead"><h2>${esc(name)}</h2><div class="kv">` +
    `<span><span class="muted">machine</span> ${esc(file.machine_id)}</span>` +
    `<span><span class="muted">modified</span> ${esc(file.mtime ?? file.uploaded_at)}</span>` +
    `<span><span class="muted">sha256</span> <code>${esc(file.content_hash)}</code></span>` +
    `</div></div>${sourceNote}` +
    (sourceNote ? '' : `<pre class="skill-source">${esc(source)}</pre>`) +
    `<details class="skill-files"><summary>${packageFiles.results.length} backed-up package ${packageFiles.results.length === 1 ? 'file' : 'files'}</summary>` +
    `<ul>${inventory}</ul></details></section>`;
  return skillDocument({ title: `${name} — skills`, body });
}

function skillName(relpath: string): string | null {
  const parts = relpath.split('/');
  if (parts.length !== 2 || parts[1] !== 'SKILL.md' || parts[0] === '') return null;
  return parts[0]!;
}

function skillDocument(opts: { title: string; body: string }): Response {
  const response = page({ ...opts, nav: 'skills' });
  response.headers.set('cache-control', 'private, no-store');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
