/** Shared HTML shell + escaping helpers for the server-rendered viewer. Inline CSS only (CSP-friendly, no external assets). */

/** HTML-escape text for safe interpolation into element bodies and double-quoted attributes. */
export function esc(v: unknown): string {
  const s = v == null ? '' : String(v);
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Escape a value for use inside a URL query component. */
export function q(v: unknown): string {
  return encodeURIComponent(v == null ? '' : String(v));
}

const STYLE = `
:root {
  --bg: #fbfbfa; --fg: #1d1d1f; --muted: #6b6b70; --line: #e2e2df; --card: #ffffff;
  --accent: #3454d1; --accent-bg: #eaeefb; --mark: #ffe58a; --err: #b42318; --err-bg: #fef3f2;
  --user: #eef3ff; --assistant: #ffffff; --system: #f4f2ee; --tool: #f6f7f9; --chip: #eceef2;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171a; --fg: #e6e6e8; --muted: #9a9aa2; --line: #2c2e33; --card: #1d1f23;
    --accent: #7f9cff; --accent-bg: #23293d; --mark: #6b5d1e; --err: #ff8b7a; --err-bg: #3a1f1c;
    --user: #1c2333; --assistant: #1d1f23; --system: #24231f; --tool: #202227; --chip: #2a2d33;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.55 ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.button-link {
  display: inline-block; padding: 2px 8px; border: 1px solid var(--accent); border-radius: 5px;
  background: var(--accent); color: #fff; font-size: 12px; font-weight: 600;
}
.button-link:hover { text-decoration: none; }
mark { background: var(--mark); color: inherit; padding: 0 1px; border-radius: 2px; }
header.nav {
  display: flex; gap: 18px; align-items: baseline; padding: 12px 20px;
  border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 5;
}
header.nav .brand { font-weight: 700; letter-spacing: -0.02em; }
main { max-width: 1180px; margin: 0 auto; padding: 20px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.chip {
  display: inline-block; background: var(--chip); color: var(--fg); border-radius: 10px;
  padding: 1px 8px; font-size: 11px; white-space: nowrap;
}
.badge {
  display: inline-block; background: var(--accent-bg); color: var(--accent); border-radius: 4px;
  padding: 0 6px; font-size: 11px; font-weight: 600;
}
.row { display: flex; gap: 16px; }
.search-layout { gap: 24px; align-items: flex-start; }
.sidebar { flex: 0 0 240px; width: 240px; min-width: 0; max-width: 240px; }
.content { flex: 1 1 auto; min-width: 0; }
form.search { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
form.search input[type=search] {
  flex: 1 1 320px; min-width: 220px; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 6px; background: var(--card); color: var(--fg); font: inherit;
}
form.search button {
  padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card);
  color: var(--fg); font: inherit;
}
form.search button { background: var(--accent); color: #fff; border-color: var(--accent); cursor: pointer; }
.facets { border-right: 1px solid var(--line); padding-right: 20px; }
.facet-controls { margin-bottom: 16px; }
.facet-controls label { display: grid; gap: 3px; color: var(--muted); font-size: 12px; font-weight: 600; }
.facet-controls select, .facet-controls button {
  width: 100%; min-width: 0; padding: 7px 8px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg); font: inherit;
}
.facet-controls button { margin-top: 8px; background: var(--accent); color: #fff; border-color: var(--accent); cursor: pointer; }
.clear-facets { margin: 9px 0 16px; }
.clear-facets button {
  width: 100%; padding: 7px 8px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg); font: inherit; cursor: pointer;
}
.hit { border-bottom: 1px solid var(--line); padding: 12px 0; }
.hit .title { font-weight: 600; }
.hit .snip { margin: 4px 0; color: var(--fg); white-space: pre-wrap; word-break: break-word; }
.hit .meta { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.facets h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 14px 0 6px; }
.facets ul { list-style: none; margin: 0 0 4px; padding: 0; }
.facets li { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; min-width: 0; padding: 1px 0; }
.facets li a { min-width: 0; overflow-wrap: anywhere; }
.facets li .n { flex: 0 0 auto; color: var(--muted); }
.facets li.active { font-weight: 700; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 12px; }
tr.stale td { background: var(--err-bg); }
.warn { background: var(--err-bg); color: var(--err); border: 1px solid var(--err); border-radius: 6px; padding: 8px 12px; margin: 8px 0; }
.banner { background: var(--accent-bg); border: 1px solid var(--accent); border-radius: 6px; padding: 8px 12px; margin: 8px 0; }
.sesshead { border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 8px; }
.sesshead .kv { display: flex; gap: 6px 18px; flex-wrap: wrap; margin-top: 6px; }
.turn { border: 1px solid var(--line); border-radius: 8px; margin: 10px 0; overflow: hidden; }
.turn > .turnhead {
  display: flex; gap: 10px; align-items: baseline; padding: 6px 12px; border-bottom: 1px solid var(--line);
}
.turn .role { font-weight: 700; text-transform: capitalize; }
.turn .body { padding: 10px 12px; }
.turn.user { background: var(--user); }
.turn.assistant { background: var(--assistant); }
.turn.system { background: var(--system); }
.turn.developer { background: var(--system); }
.turn.tool { background: var(--tool); }
.turn.rewound { opacity: 0.5; }
.turn.rewound .role::after { content: " (rewound)"; color: var(--muted); font-weight: 400; font-size: 11px; }
.blocktext { white-space: pre-wrap; word-break: break-word; margin: 6px 0; }
details.block { margin: 6px 0; border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
details.block > summary { cursor: pointer; padding: 5px 10px; user-select: none; }
details.block[open] > summary { border-bottom: 1px solid var(--line); }
details.block pre { margin: 0; padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
details.error { border-color: var(--err); }
details.error > summary { color: var(--err); }
.divider {
  text-align: center; color: var(--muted); margin: 16px 0; letter-spacing: 0.08em;
  border-top: 1px dashed var(--line); padding-top: 10px; font-size: 12px;
}
.pager { display: flex; gap: 14px; align-items: center; margin: 18px 0; justify-content: center; }
img.media { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
.truncnote { color: var(--muted); font-size: 11px; }
@media (max-width: 760px) {
  main { padding: 14px; }
  .search-layout { flex-direction: column; gap: 10px; }
  .sidebar { flex-basis: auto; width: 100%; max-width: none; }
  .facets { border-right: 0; border-bottom: 1px solid var(--line); padding: 0 0 14px; }
  .content { width: 100%; }
}
`;

/** Full-document shell used by non-streamed pages. */
export function page(opts: { title: string; nav?: string; body: string }): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(opts.title)}</title><style>${STYLE}</style></head><body>` +
    navBar(opts.nav) +
    `<main>${opts.body}</main></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** Opening chunk (doctype → <main>) for streamed pages; pair with pageFoot(). */
export function pageHead(title: string, nav?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>` +
    navBar(nav) +
    `<main>`;
}

export function pageFoot(): string {
  return `</main></body></html>`;
}

function navBar(active?: string): string {
  const link = (href: string, label: string, key: string) =>
    `<a href="${href}"${active === key ? ' style="font-weight:700"' : ''}>${label}</a>`;
  return `<header class="nav"><span class="brand"><a href="/">sessions</a></span>` +
    link('/', 'Search', 'search') +
    link('/machines', 'Machines', 'machines') +
    `</header>`;
}
