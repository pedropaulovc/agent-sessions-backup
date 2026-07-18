import { esc, page } from './layout';

interface MachineRow {
  machine_id: string;
  os: string | null;
  key_protection: string;
  collector_version: string | null;
  last_seen_at: string | null;
  last_upload_at: string | null;
  files_pending: number;
  files_error: number;
  files_total: number;
}

const STALE_MS = 72 * 60 * 60 * 1000;

/** GET /machines — fleet health table plus corpus totals. */
export async function machinesPage(env: Env): Promise<Response> {
  const machines = await env.DB.prepare(
    `SELECT m.machine_id, m.os, m.key_protection, m.collector_version, m.last_seen_at, m.last_upload_at,
            SUM(CASE WHEN f.parse_state IN ('pending', 'reserved') THEN 1 ELSE 0 END) AS files_pending,
            SUM(CASE WHEN f.parse_state = 'error' THEN 1 ELSE 0 END) AS files_error,
            COUNT(f.id) AS files_total
     FROM machines m LEFT JOIN files f ON f.machine_id = m.machine_id
     GROUP BY m.machine_id ORDER BY m.machine_id`,
  ).all<MachineRow>();

  const totals = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sessions) AS sessions,
       (SELECT COUNT(*) FROM blocks) AS blocks,
       (SELECT COALESCE(SUM(size), 0) FROM files) AS raw_bytes`,
  ).first<{ sessions: number; blocks: number; raw_bytes: number }>();

  const now = Date.now();
  const rows = machines.results
    .map((m) => {
      const stale = isStale(m.last_seen_at, now);
      const cells = [
        `<td>${esc(m.machine_id)}</td>`,
        `<td>${esc(m.os ?? '—')}</td>`,
        `<td>${esc(m.key_protection)}</td>`,
        `<td>${esc(m.collector_version ?? '—')}</td>`,
        `<td>${esc(m.last_seen_at ?? 'never')}${stale ? ' <span class="badge" style="color:var(--err)">stale</span>' : ''}</td>`,
        `<td>${esc(m.last_upload_at ?? 'never')}</td>`,
        `<td>${m.files_pending || 0}</td>`,
        `<td>${m.files_error ? `<span style="color:var(--err)">${m.files_error}</span>` : 0}</td>`,
        `<td>${m.files_total || 0}</td>`,
      ].join('');
      return `<tr class="${stale ? 'stale' : ''}">${cells}</tr>`;
    })
    .join('');

  const body =
    `<h2>Machines</h2>` +
    `<p class="muted small">${esc(totals?.sessions ?? 0)} sessions · ${esc(totals?.blocks ?? 0)} blocks · ${fmtBytes(totals?.raw_bytes ?? 0)} raw</p>` +
    `<table><thead><tr>` +
    ['Machine', 'OS', 'Key', 'Collector', 'Last seen', 'Last upload', 'Pending', 'Error', 'Files']
      .map((h) => `<th>${h}</th>`)
      .join('') +
    `</tr></thead><tbody>${rows || '<tr><td colspan="9" class="muted">No machines enrolled.</td></tr>'}</tbody></table>`;

  return page({ title: 'Machines — sessions', nav: 'machines', body });
}

function isStale(lastSeen: string | null, now: number): boolean {
  if (!lastSeen) return true;
  const t = Date.parse(lastSeen);
  return Number.isFinite(t) && now - t > STALE_MS;
}

function fmtBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}
