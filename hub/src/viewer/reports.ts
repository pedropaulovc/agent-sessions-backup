/** GET /reports — every `xd://report_issue` call the agents made, aggregated across the corpus.
 *
 * The harness asks agents to write a one-line report to the `report_issue` tool device whenever a
 * tool behaves inconsistently with its documented contract. Those reports are the only first-hand
 * bug log the harness has, and until this page they were buried one transcript at a time: a report
 * is an ordinary `tool_use` block, indistinguishable in the session list from the thousand other
 * tool calls around it. This surfaces them as a single list, newest first, each one linked back to
 * the turn that filed it so the surrounding context is one click away.
 */
import { subagentSessionSql } from '../session-filters';
import { sessionDisplayTitle } from '../session-title';
import { esc, page, q } from './layout';
import { TURNS_PER_PAGE } from './session';

/** The device URI a report is written to. Also the discriminator: a `write` whose `path` is this
 * executed the device, whereas a `read` of the same URI only fetched its documentation. */
const REPORT_DEVICE = 'xd://report_issue';

/**
 * The WHERE terms of migration 0032's partial index, repeated verbatim.
 *
 * SQLite decides a partial index is usable by comparing a query's WHERE terms against the index's,
 * so a query that paraphrases this — reordered terms, `tool_name = 'write'` added, `instr()`
 * instead of `LIKE` — silently falls back to a full scan of the largest table in the database.
 * Every query on this page therefore composes this constant rather than spelling the predicate
 * out, and the alias is fixed because the terms embed it.
 */
const INDEXED_REPORT_CALLS = `b.btype = 'tool_use' AND b.text LIKE '%${REPORT_DEVICE}%'`;

/** Hard ceiling on rows pulled for aggregation.
 *
 * The facet counts are derived from the recorded call ARGUMENTS, which only JS can parse, so the
 * page reads the whole indexed set rather than grouping in SQL. That is affordable precisely
 * because the set is tiny — reports are rare by construction — but "tiny" must not be an
 * assumption the page would break on, so it reads a bounded window and says so when it fills. */
const MAX_REPORTS = 5000;

const REPORTS_PER_PAGE = 25;

/** Longest session title rendered inside a report's inline metadata row. */
const LINK_TITLE_LIMIT = 80;

/** The leading `<tool>:` of the convention agents are asked to follow, as written.
 *
 * Case-sensitively lowercase because every tool in the harness is, and prose is not: without that
 * a report opening `The write tool: …` would mint a `The` bucket. The optional `://` tail is for
 * the tool devices, which name themselves by URI (`xd://tui: …`) and would otherwise be filed
 * under `xd`. One token only — `hub start: …` and `multi_tool_use.parallel / bash: …` are real
 * report openings that this deliberately leaves unlabelled, because no syntax separates their
 * second word from a sentence, and a bucket that gathers the wrong reports is worse than a
 * visible one that gathers none: the filter's whole purpose is finding every report about a tool.
 */
const REPORT_LABEL = /^([a-z][\w.-]{0,63}(?::\/\/[\w.*-]{1,64})?):(?:\s|$)/;

/** Unlabelled reports get their own bucket rather than being dropped from the filter: 5 of the 37
 * reports in the corpus this was built against open with something this does not parse as a
 * label, and a filter that silently hid a seventh of the list would be worse than no filter. */
const UNLABELLED = '(unlabelled)';

interface ReportRow {
  id: number;
  session_id: string;
  turn_index: number;
  ts: string | null;
  text: string;
  truncated: number;
  on_main_path: number;
  harness: string;
  machine_id: string | null;
  stored_title: string | null;
  first_interaction_title: string | null;
  cwd: string | null;
  subagent: 'yes' | 'no';
}

interface IssueReport {
  row: ReportRow;
  /** The self-assigned `<tool>:` label, or null when the report did not follow the convention. */
  tool: string | null;
  /** The report body as written. */
  report: string;
  /** The call's `i` intent, when it carried one. */
  intent: string | null;
}

/** The page's only query, exported so the test that proves it still uses migration 0032's index
 * can EXPLAIN this exact text rather than a copy that would keep passing after the page drifted. */
export const REPORTS_QUERY =
  `SELECT b.id, b.session_id, b.turn_index, b.ts, b.text, b.truncated, b.on_main_path,
          s.harness, s.machine_id, s.title AS stored_title, s.first_interaction_title, s.cwd,
          ${subagentSessionSql('s')} AS subagent
   FROM blocks b
   JOIN sessions s ON s.session_id = b.session_id AND b.file_id = s.canonical_file_id
   WHERE ${INDEXED_REPORT_CALLS}
   ORDER BY b.ts DESC, b.id DESC
   LIMIT ${MAX_REPORTS + 1}`;

export async function reportsPage(url: URL, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(REPORTS_QUERY).all<ReportRow>();

  const capped = rows.results.length > MAX_REPORTS;
  // Rows that merely MENTION the device — a `read` of its documentation — are indexed on purpose
  // (see 0032) and are dropped here, where the arguments can actually be parsed.
  const reports = rows.results.slice(0, MAX_REPORTS).flatMap((row) => parseReport(row) ?? []);
  const tools = toolCounts(reports);

  const selected = url.searchParams.get('tool');
  const filtered = selected ? reports.filter((r) => (r.tool ?? UNLABELLED) === selected) : reports;
  const pageNumber = clampPage(url.searchParams.get('page'), filtered.length);
  const shown = filtered.slice((pageNumber - 1) * REPORTS_PER_PAGE, pageNumber * REPORTS_PER_PAGE);

  const body =
    `<section class="reports-page"><h2>Issue reports</h2>` +
    renderIntro(reports, capped) +
    renderToolFilter(tools, selected) +
    (shown.length
      ? shown.map(renderReport).join('')
      : `<p class="muted">${reports.length === 0
        ? 'No agent has filed an issue report in this corpus yet.'
        : 'No report carries that label.'}</p>`) +
    renderPager(url, pageNumber, filtered.length) +
    `</section>`;
  return page({ title: 'Issue reports — sessions', nav: 'reports', body });
}

/** A stored `tool_use` block's text is `<tool name> <JSON arguments>`; a report is a write whose
 * `path` is the device and which carries the `content` it wrote.
 *
 * Returns null for anything else in the index — notably a `read` of the device's documentation,
 * which has the path but no content, and a block whose arguments were cut off by the 2 KB
 * `tool_use` cap before the path was recorded. Nothing is guessed from a partial argument object:
 * a report whose body cannot be read is not a report this page can show, and `blocks.truncated`
 * marks the ones it renders with a body that the cap cut short.
 */
function parseReport(row: ReportRow): IssueReport | null {
  const split = row.text.indexOf(' ');
  if (split < 0) return null;
  const args = parseArgs(row.text.slice(split + 1));
  if (!args || args.path !== REPORT_DEVICE || typeof args.content !== 'string') return null;
  const report = args.content.trim();
  if (!report) return null;
  return {
    row,
    tool: REPORT_LABEL.exec(report)?.[1] ?? null,
    report,
    intent: typeof args.i === 'string' && args.i.trim() ? args.i.trim() : null,
  };
}

function parseArgs(json: string): { path?: unknown; content?: unknown; i?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Either the recorded arguments were not an object, or the block hit the `tool_use` cap
    // mid-value. Both are outside what this page can read; see `parseReport`.
    return null;
  }
}

function toolCounts(reports: IssueReport[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const report of reports) {
    const key = report.tool ?? UNLABELLED;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderIntro(reports: IssueReport[], capped: boolean): string {
  const sessions = new Set(reports.map((r) => r.row.session_id)).size;
  const stamps = reports.map((r) => r.row.ts).filter((ts): ts is string => !!ts);
  const span = stamps.length
    ? ` · ${esc(stamps[stamps.length - 1]!.slice(0, 10))} → ${esc(stamps[0]!.slice(0, 10))}`
    : '';
  return `<p class="muted small">${reports.length} ${reports.length === 1 ? 'report' : 'reports'}` +
    ` from ${sessions} ${sessions === 1 ? 'session' : 'sessions'}${span}</p>` +
    `<p class="muted small reports-about">Agents are asked to write a report to the ` +
    `<code>${esc(REPORT_DEVICE)}</code> device whenever a tool behaves inconsistently with its ` +
    `documented contract. False positives are expected, so treat each one as a lead rather than a ` +
    `confirmed defect, and follow the link to read what the agent was doing.</p>` +
    (capped
      ? `<p class="warn">More than ${MAX_REPORTS} reports are indexed. This page shows the ` +
        `${MAX_REPORTS} most recent, and the counts below describe only those.</p>`
      : '');
}

function renderToolFilter(tools: Array<[string, number]>, selected: string | null): string {
  if (tools.length === 0) return '';
  const chips: Array<[string, string, boolean]> = [
    ['/reports', 'All', !selected],
    ...tools.map(([tool, count]): [string, string, boolean] =>
      [`/reports?tool=${q(tool)}`, `${tool} ${count}`, tool === selected]),
  ];
  return `<nav class="tabs" aria-label="Filter reports by reported tool">` +
    chips.map(([href, label, on]) =>
      `<a href="${esc(href)}"${on ? ' class="on" aria-current="true"' : ''}>${esc(label)}</a>`)
      .join('') +
    `</nav>`;
}

function renderReport(report: IssueReport): string {
  const row = report.row;
  // Collapsed and clipped, unlike the session list's own heading: a subagent's stored title is the
  // whole assignment it was handed, newlines included, and one of those in a row of inline chips
  // pushes every other field off the card. The full title is on the page the link goes to.
  const title = sessionDisplayTitle(row.first_interaction_title, row.stored_title, row.session_id, row.harness)
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = title.length > LINK_TITLE_LIMIT ? `${title.slice(0, LINK_TITLE_LIMIT - 1)}…` : title;
  const turnPage = Math.floor(row.turn_index / TURNS_PER_PAGE) + 1;
  const href = `/s/${q(row.session_id)}?page=${turnPage}&view=chronological#t${row.turn_index}`;
  const meta = [
    report.tool ? `<span class="badge">${esc(report.tool)}</span>` : '',
    `<a href="${esc(href)}" title="${esc(title)}">${esc(clipped)}</a>`,
    row.subagent === 'yes' ? `<span class="chip">subagent</span>` : '',
    `<span class="chip">${esc(row.harness)}</span>`,
    row.machine_id ? `<span class="chip">${esc(row.machine_id)}</span>` : '',
    row.cwd ? `<span class="muted small">${esc(row.cwd)}</span>` : '',
    row.ts ? `<span class="muted small">${esc(row.ts)}</span>` : '',
    // A rewound turn's report still happened — the call executed before the branch was abandoned —
    // so it is listed, but the transcript it links to shows that turn as off the main path.
    row.on_main_path === 0 ? `<span class="chip">rewound turn</span>` : '',
    row.truncated ? `<span class="badge" style="color:var(--err)">body truncated</span>` : '',
  ].filter(Boolean).join('');
  return `<article class="hit report">` +
    `<div class="snip">${esc(report.report)}</div>` +
    (report.intent ? `<div class="muted small">Intent: ${esc(report.intent)}</div>` : '') +
    `<div class="meta">${meta}</div>` +
    `</article>`;
}

function clampPage(value: string | null, total: number): number {
  const requested = Number(value);
  const pages = Math.max(1, Math.ceil(total / REPORTS_PER_PAGE));
  if (!Number.isSafeInteger(requested) || requested < 1) return 1;
  return Math.min(requested, pages);
}

function renderPager(url: URL, current: number, total: number): string {
  const pages = Math.max(1, Math.ceil(total / REPORTS_PER_PAGE));
  if (pages === 1) return '';
  const steps: Array<[number, string]> = [[current - 1, '← Previous'], [current + 1, 'Next →']];
  const [previous, following] = steps.map(([target, label]) => {
    if (target < 1 || target > pages) return `<span class="muted">${label}</span>`;
    const next = new URL(url);
    next.searchParams.set('page', String(target));
    return `<a href="${esc(next.pathname + next.search)}">${label}</a>`;
  });
  return `<nav class="pager" aria-label="Issue report pages">${previous}` +
    `<span class="small">Page ${current} / ${pages}</span>${following}</nav>`;
}
