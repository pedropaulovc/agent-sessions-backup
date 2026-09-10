import { esc } from './layout';
import type { TraceData, TraceEvent } from './trace-data';

const KINDS = ['user', 'model', 'tool', 'compaction'] as const;
const KIND_LABELS: Record<TraceEvent['kind'], string> = { user: 'User', model: 'Model', tool: 'Tool', compaction: 'Compact' };

function duration(event: TraceEvent): number | undefined {
  if (event.timing !== 'recorded' || !Number.isFinite(event.startMs) || !Number.isFinite(event.endMs)) return undefined;
  const value = event.endMs! - event.startMs!;
  return value >= 0 && Number.isFinite(value) ? value : undefined;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Page-local activity overview. The transcript remains the primary, independently rendered view. */
export function renderTrace(data: TraceData): string {
  const { events } = data;
  let first = Infinity;
  let last = -Infinity;
  let timed = 0;
  let errors = 0;
  let toolCount = 0;
  const tools = new Map<string, { count: number; errors: number; duration: number; timed: number }>();
  for (const event of events) {
    if (Number.isFinite(event.startMs)) {
      first = Math.min(first, event.startMs!);
      last = Math.max(last, event.startMs! + (duration(event) ?? 0));
      timed++;
    }
    if (event.isError) errors++;
    if (event.kind === 'tool') {
      toolCount++;
      const tool = tools.get(event.label) ?? { count: 0, errors: 0, duration: 0, timed: 0 };
      tool.count++;
      if (event.isError) tool.errors++;
      const ms = duration(event);
      if (ms !== undefined) { tool.duration += ms; tool.timed++; }
      tools.set(event.label, tool);
    }
  }
  const range = timed ? last - first : 0;
  const initialMode = timed ? 'duration' : 'sequence';
  const marks: Record<TraceEvent['kind'], string[]> = { user: [], model: [], tool: [], compaction: [] };
  const rows: string[] = [];
  events.forEach((event, index) => {
    const ms = duration(event);
    const hasTime = Number.isFinite(event.startMs);
    const name = event.label.length > 120 ? `${event.label.slice(0, 117)}…` : event.label;
    const time = ms !== undefined ? `${formatDuration(ms)} recorded` : hasTime ? 'timestamp only' : 'timing unknown';
    const offset = hasTime ? `+${formatDuration(event.startMs! - first)}` : '—';
    const href = Number.isSafeInteger(event.turnIndex) && event.turnIndex! >= 0 ? `#t${event.turnIndex}` : undefined;
    const attributes = `data-trace-index="${index}" data-trace-kind="${event.kind}" data-trace-error="${event.isError ? 'true' : 'false'}"`;
    const error = event.isError ? '<span class="session-trace-error">error</span>' : '';
    const title = `${KIND_LABELS[event.kind]}: ${name} · ${time}${event.isError ? ' · error' : ''}`;
    const left = hasTime && range > 0 ? (event.startMs! - first) / range * 100 : 0;
    const width = ms !== undefined && range > 0 ? ms / range * 100 : 0;
    const style = `--trace-time-left:${left.toFixed(4)}%;--trace-time-width:${width.toFixed(4)}%;--trace-seq-left:${(index / Math.max(events.length, 1) * 100).toFixed(4)}%;--trace-seq-width:${(100 / Math.max(events.length, 1)).toFixed(4)}%`;
    const markClass = `session-trace-mark${ms !== undefined && ms > 0 ? ' session-trace-span' : ''}${event.isError ? ' session-trace-failed' : ''}`;
    const markAttributes = `class="${markClass}" ${attributes} data-trace-timed="${hasTime}" style="${style}" title="${esc(title)}" aria-label="${esc(title)}"`;
    marks[event.kind].push(href
      ? `<a href="${href}" ${markAttributes}></a>`
      : `<span ${markAttributes} role="img"></span>`);
    const link = href ? `<a href="${href}">${esc(name)}</a>` : `<span>${esc(name)}</span>`;
    const tokens = event.kind === 'model' && (event.inputTokens !== undefined || event.outputTokens !== undefined)
      ? `<span>${esc(event.inputTokens ?? '—')} in / ${esc(event.outputTokens ?? '—')} out tokens</span>` : '';
    rows.push(`<li ${attributes}><span class="session-trace-order">${index + 1}</span>` +
      `<div class="session-trace-event"><div class="session-trace-event-title"><span class="session-trace-kind">${KIND_LABELS[event.kind]}</span>${link}${error}</div>` +
      `<div class="session-trace-event-meta"><span>${offset}</span><span>${time}</span>${tokens}</div></div></li>`);
  });
  const lanes = KINDS.map(kind => `<div class="session-trace-lane"><span>${KIND_LABELS[kind]}</span><div class="session-trace-track">${marks[kind].join('')}</div></div>`).join('');
  const breakdown = [...tools].sort((a, b) => b[1].count - a[1].count).map(([name, tool]) =>
    `<li><span class="session-trace-tool-name">${esc(name.length > 120 ? `${name.slice(0, 117)}…` : name)}</span><span>${tool.count} calls · <span${tool.errors ? ' class="session-trace-error"' : ''}>${tool.errors} errors</span></span>` +
    `<span class="session-trace-tool-time">${tool.timed ? `${formatDuration(tool.duration)} recorded (${tool.timed}/${tool.count})` : 'duration unknown'}</span></li>`).join('');
  return `<details class="session-trace" data-trace-mode="${initialMode}"><summary><strong>Activity trace</strong> ` +
    `<span class="session-trace-summary">${events.length} events · ${toolCount} tools${errors ? ` · <span class="session-trace-error">${errors} errors</span>` : ''}</span></summary>` +
    `<div class="session-trace-body"><p class="session-trace-note">Current transcript page only. Bars show recorded durations; markers show timestamps. Unknown timing stays in the event list and Sequence view.</p>` +
    `<div class="session-trace-controls" hidden><label>View<select data-trace-control="mode"><option value="duration"${timed ? ' selected' : ''}>Duration</option><option value="sequence"${timed ? '' : ' selected'}>Sequence</option></select></label>` +
    `<label>Kind<select data-trace-control="kind"><option value="all">All kinds</option>${KINDS.map(kind => `<option value="${kind}">${KIND_LABELS[kind]}</option>`).join('')}</select></label>` +
    `<label class="session-trace-search">Search<input type="search" data-trace-control="search" placeholder="Event or tool name" autocomplete="off"></label>` +
    `<label class="session-trace-error-filter"><input type="checkbox" data-trace-control="errors">Errors only</label></div>` +
    `<div class="session-trace-timeline" role="group" aria-label="Activity lanes">${lanes}<div class="session-trace-axis"><span data-trace-axis="start">${timed ? '0s' : 'First event'}</span><span data-trace-axis="end" data-trace-duration="${timed ? formatDuration(range) : 'No timestamps'}">${timed ? formatDuration(range) : 'Last event'}</span></div></div>` +
    `<p class="session-trace-status" role="status">${events.length} events${timed < events.length ? ` · ${events.length - timed} without timestamps` : ''}</p>` +
    `<ol class="session-trace-events" aria-label="Events in transcript order">${rows.join('')}</ol>` +
    `<p class="session-trace-empty"${events.length ? ' hidden' : ''}>No matching events on this page.</p>` +
    (tools.size ? `<details class="session-trace-tools"><summary>Per-tool breakdown · ${tools.size} names</summary><p class="session-trace-note">All tools on this page, independent of filters. Recorded totals may overlap.</p><ul>${breakdown}</ul></details>` : '') +
    `</div><script>${TRACE_SCRIPT}</script></details>`;
}

// Static script only: session content lives in escaped HTML, never executable JSON.
const TRACE_SCRIPT = `(() => {
  const root = document.currentScript.closest('.session-trace');
  const control = name => root.querySelector('[data-trace-control="' + name + '"]');
  const mode = control('mode');
  const kind = control('kind');
  const search = control('search');
  const errors = control('errors');
  const rows = Array.from(root.querySelectorAll('.session-trace-events > li'));
  const marks = Array.from(root.querySelectorAll('.session-trace-mark'));
  const status = root.querySelector('.session-trace-status');
  const empty = root.querySelector('.session-trace-empty');
  const axisStart = root.querySelector('[data-trace-axis="start"]');
  const axisEnd = root.querySelector('[data-trace-axis="end"]');
  const update = () => {
    const query = search.value.trim().toLowerCase();
    const visible = new Set();
    for (const row of rows) {
      const match = (kind.value === 'all' || row.dataset.traceKind === kind.value) &&
        (!errors.checked || row.dataset.traceError === 'true') &&
        (!query || row.textContent.toLowerCase().includes(query));
      row.hidden = !match;
      if (match) visible.add(row.dataset.traceIndex);
    }
    let untimed = 0;
    for (const mark of marks) {
      mark.hidden = !visible.has(mark.dataset.traceIndex);
      if (!mark.hidden && mark.dataset.traceTimed !== 'true') untimed++;
    }
    root.dataset.traceMode = mode.value;
    axisStart.textContent = mode.value === 'duration' ? '0s' : 'First event';
    axisEnd.textContent = mode.value === 'duration' ? axisEnd.dataset.traceDuration : 'Last event';
    status.textContent = visible.size + ' of ' + rows.length + ' events' + (untimed ? ' · ' + untimed + ' without timestamps' : '');
    empty.hidden = visible.size > 0;
  };
  root.querySelector('.session-trace-controls').hidden = false;
  for (const input of [mode, kind, search, errors]) input.addEventListener('input', update);
  root.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#t"]');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = document.getElementById(link.getAttribute('href').slice(1));
    if (!target) return;
    const row = link.closest('[data-trace-kind]');
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
    const turn = target.closest('.turn') || target;
    const content = turn.querySelector('details.turn-content');
    if (content) content.open = true;
    if (row && row.dataset.traceKind === 'tool') {
      for (const detail of turn.querySelectorAll('details.block')) detail.open = true;
    }
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.style.scrollMarginTop = ((document.querySelector('header.nav')?.getBoundingClientRect().height || 0) + 12) + 'px';
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
  });
})();`;
