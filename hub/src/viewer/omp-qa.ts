/** GET /omp-qa — consented auto-QA reports received directly from OMP. */
import { esc, page, q } from './layout';

/** Keep the viewer bounded even when the intake table grows without limit. */
export const OMP_QA_MAX_ROWS = 5000;
export const OMP_QA_PAGE_SIZE = 25;

/** The only query used by this page. Read one extra candidate so the page can say when its
 * bounded window is full rather than quietly presenting an incomplete corpus. */
export const OMP_QA_QUERY =
  `SELECT id, install_id, entry_id, agent_name, agent_version, platform, arch, model,
          omp_version, tool, report, received_at
   FROM omp_qa_reports
   ORDER BY received_at DESC, id DESC
   LIMIT ${OMP_QA_MAX_ROWS + 1}`;

interface OmpQaRow {
  id: number;
  install_id: string;
  entry_id: number;
  agent_name: string;
  agent_version: string;
  platform: string;
  arch: string;
  model: string;
  omp_version: string;
  tool: string;
  report: string;
  received_at: string;
}

export async function ompQaPage(url: URL, env: Env): Promise<Response> {
  const result = await env.DB.prepare(OMP_QA_QUERY).all<OmpQaRow>();
  const capped = result.results.length > OMP_QA_MAX_ROWS;
  const reports = result.results.slice(0, OMP_QA_MAX_ROWS);
  const tools = toolCounts(reports);
  const selected = url.searchParams.get('tool');
  // A present query parameter is an exact filter, including the (invalid for intake) empty value.
  const filtered = selected === null ? reports : reports.filter((row) => row.tool === selected);
  const currentPage = clampPage(url.searchParams.get('page'), filtered.length);
  const start = (currentPage - 1) * OMP_QA_PAGE_SIZE;
  const shown = filtered.slice(start, start + OMP_QA_PAGE_SIZE);

  const body =
    `<section class="omp-qa-page"><h2>OMP QA reports</h2>` +
    `<p class="muted small omp-qa-about">These are consented reports received directly from OMP and ` +
    `lack transcript backlinks.</p>` +
    `<p class="muted small">${filtered.length} ${filtered.length === 1 ? 'report' : 'reports'}` +
    `${selected !== null ? ` · filtered to tool <code>${esc(selected)}</code>` : ''}</p>` +
    renderToolFilter(tools, selected) +
    (shown.length
      ? shown.map(renderReport).join('')
      : `<p class="muted">${reports.length === 0
        ? 'No OMP QA reports have been received yet.'
        : 'No report uses that tool.'}</p>`) +
    (capped
      ? `<p class="warn">More than ${OMP_QA_MAX_ROWS} reports are available. This page reads only the ` +
        `${OMP_QA_MAX_ROWS} most recent reports.</p>`
      : '') +
    renderPager(url, currentPage, filtered.length) +
    `</section>`;
  return page({ title: 'OMP QA — sessions', nav: 'omp-qa', body });
}

function toolCounts(rows: OmpQaRow[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.tool, (counts.get(row.tool) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderToolFilter(tools: Array<[string, number]>, selected: string | null): string {
  if (tools.length === 0) return '';
  const chips: Array<[string, string, boolean]> = [
    ['/omp-qa', 'All', selected === null],
    ...tools.map(([tool, count]): [string, string, boolean] =>
      [`/omp-qa?tool=${q(tool)}`, `${tool} ${count}`, tool === selected]),
  ];
  return `<nav class="tabs" aria-label="Filter OMP QA reports by tool">` +
    chips.map(([href, label, on]) =>
      `<a href="${esc(href)}"${on ? ' class="on" aria-current="true"' : ''}>${esc(label)}</a>`)
      .join('') +
    `</nav>`;
}

function renderReport(row: OmpQaRow): string {
  const agentVersion = row.agent_version !== row.omp_version
    ? `<span class="chip">agent ${esc(row.agent_name)} ${esc(row.agent_version)}</span>`
    : '';
  const shortInstall = compactInstallId(row.install_id);
  const meta = [
    `<span class="badge">${esc(row.tool)}</span>`,
    `<span class="chip">model ${esc(row.model)}</span>`,
    `<span class="chip">OMP ${esc(row.omp_version)}</span>`,
    agentVersion,
    `<span class="chip">${esc(row.platform)}/${esc(row.arch)}</span>`,
    `<span class="muted small" title="${esc(row.install_id)}">install ${esc(shortInstall)}</span>`,
    `<time class="muted small" datetime="${esc(row.received_at)}">received at ${esc(row.received_at)}</time>`,
  ].filter(Boolean).join('');
  return `<article class="hit omp-qa-report">` +
    `<div class="snip">${esc(row.report)}</div>` +
    `<div class="meta">${meta}</div>` +
    `</article>`;
}

function compactInstallId(installId: string): string {
  if (installId.length <= 16) return installId;
  return `${installId.slice(0, 10)}…${installId.slice(-4)}`;
}

function clampPage(value: string | null, total: number): number {
  const requested = Number(value);
  const pages = Math.max(1, Math.ceil(total / OMP_QA_PAGE_SIZE));
  if (!Number.isSafeInteger(requested) || requested < 1) return 1;
  return Math.min(requested, pages);
}

function renderPager(url: URL, current: number, total: number): string {
  const pages = Math.max(1, Math.ceil(total / OMP_QA_PAGE_SIZE));
  if (pages === 1) return '';
  const link = (target: number, label: string): string => {
    if (target < 1 || target > pages) return `<span class="muted">${label}</span>`;
    const next = new URL(url);
    next.searchParams.set('page', String(target));
    return `<a href="${esc(next.pathname + next.search)}">${label}</a>`;
  };
  return `<nav class="pager" aria-label="OMP QA report pages">` +
    `${link(current - 1, '← Previous')}` +
    `<span class="small">Page ${current} / ${pages}</span>` +
    `${link(current + 1, 'Next →')}</nav>`;
}
