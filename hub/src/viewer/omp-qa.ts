/** GET /omp-qa — consented auto-QA reports received directly from OMP. */
import { esc, page, q } from './layout';

export const OMP_QA_PAGE_SIZE = 25;
export const OMP_QA_MAX_ROWS = 5000;
const OMP_QA_TOOL_FACET_LIMIT = 50;
const OMP_QA_REPORT_PREVIEW_LIMIT = 4096;
const OMP_QA_PROPERTIES_PREVIEW_LIMIT = 1024;
export const OMP_QA_PAGE_QUERY =
  `SELECT id, install_id, entry_id, properties, agent_name, agent_version, platform, arch, model,
          omp_version, tool, report, received_at
     FROM omp_qa_reports
    ORDER BY received_at DESC, id DESC
    LIMIT ?1 OFFSET ?2`;

export const OMP_QA_FILTERED_PAGE_QUERY =
  `SELECT id, install_id, entry_id, properties, agent_name, agent_version, platform, arch, model,
          omp_version, tool, report, received_at
     FROM omp_qa_reports
    WHERE tool = ?1
    ORDER BY received_at DESC, id DESC
    LIMIT ?2 OFFSET ?3`;

export const OMP_QA_FACET_QUERY =
  `SELECT tool, COUNT(*) AS count
     FROM (
       SELECT tool
         FROM omp_qa_reports
        ORDER BY received_at DESC, id DESC
        LIMIT ${OMP_QA_MAX_ROWS}
     )
    GROUP BY tool
    ORDER BY count DESC, tool
    LIMIT ${OMP_QA_TOOL_FACET_LIMIT + 1}`;

interface OmpQaRow {
  id: number;
  install_id: string;
  entry_id: number;
  properties: string;
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
  const selected = url.searchParams.get('tool');
  const countSql = selected === null
    ? `SELECT COUNT(*) AS count FROM (
         SELECT 1 FROM omp_qa_reports
          ORDER BY received_at DESC, id DESC
          LIMIT ${OMP_QA_MAX_ROWS + 1}
       )`
    : `SELECT COUNT(*) AS count FROM (
         SELECT 1 FROM omp_qa_reports
          WHERE tool = ?1
          ORDER BY received_at DESC, id DESC
          LIMIT ${OMP_QA_MAX_ROWS + 1}
       )`;
  const countStatement = selected === null
    ? env.DB.prepare(countSql)
    : env.DB.prepare(countSql).bind(selected);
  const [count, toolsResult] = await Promise.all([
    countStatement.first<{ count: number }>(),
    env.DB.prepare(OMP_QA_FACET_QUERY).all<{ tool: string; count: number }>(),
  ]);
  const observed = count?.count ?? 0;
  const capped = observed > OMP_QA_MAX_ROWS;
  const total = Math.min(observed, OMP_QA_MAX_ROWS);
  const currentPage = clampPage(url.searchParams.get('page'), total);
  const offset = (currentPage - 1) * OMP_QA_PAGE_SIZE;
  const pageStatement = selected === null
    ? env.DB.prepare(OMP_QA_PAGE_QUERY).bind(OMP_QA_PAGE_SIZE, offset)
    : env.DB.prepare(OMP_QA_FILTERED_PAGE_QUERY).bind(selected, OMP_QA_PAGE_SIZE, offset);
  const reports = (await pageStatement.all<OmpQaRow>()).results;
  const facetsTruncated = toolsResult.results.length > OMP_QA_TOOL_FACET_LIMIT;
  const tools = toolsResult.results.slice(0, OMP_QA_TOOL_FACET_LIMIT)
    .map((row): [string, number] => [row.tool, row.count]);

  const body =
    `<section class="omp-qa-page"><h2>OMP QA reports</h2>` +
    `<p class="muted small omp-qa-about">These are consented reports received directly from OMP and ` +
    `lack transcript backlinks.</p>` +
    (capped
      ? `<p class="warn">More than ${OMP_QA_MAX_ROWS} matching reports are available; counts and ` +
        `pagination cover the newest ${OMP_QA_MAX_ROWS}.</p>`
      : '') +
    `<p class="muted small">${capped ? `${OMP_QA_MAX_ROWS}+` : total} ${total === 1 ? 'report' : 'reports'}` +
    `${selected !== null ? ` · filtered to tool <code>${esc(selected)}</code>` : ''}</p>` +
    renderToolFilter(tools, selected) +
    (facetsTruncated
      ? `<p class="warn">Showing the ${OMP_QA_TOOL_FACET_LIMIT} most common tool filters.</p>`
      : '') +
    (reports.length
      ? reports.map(renderReport).join('')
      : `<p class="muted">${tools.length === 0
        ? 'No OMP QA reports have been received yet.'
        : 'No report uses that tool.'}</p>`) +
    renderPager(url, currentPage, total) +
    `</section>`;
  return page({ title: 'OMP QA — sessions', nav: 'omp-qa', body });
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
  const report = row.report.length > OMP_QA_REPORT_PREVIEW_LIMIT
    ? `${row.report.slice(0, OMP_QA_REPORT_PREVIEW_LIMIT - 1)}…`
    : row.report;
  const properties = row.properties.length > OMP_QA_PROPERTIES_PREVIEW_LIMIT
    ? `${row.properties.slice(0, OMP_QA_PROPERTIES_PREVIEW_LIMIT - 1)}…`
    : row.properties;
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
    `<div class="snip">${esc(report)}</div>` +
    `<div class="small"><span class="muted">properties</span> <code>${esc(properties)}</code></div>` +
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
