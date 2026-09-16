import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { REPORTS_QUERY } from '../src/viewer/reports';
import { TURNS_PER_PAGE } from '../src/viewer/session';
import { VIEWER } from './hosts';

const testEnv = env as unknown as Env;
const RUN_ID = crypto.randomUUID();
const STORE = 'reports-viewer-fixtures';
const REPORT_DEVICE = 'xd://report_issue';

const seededSessionIds = new Set<string>();
const seededFileIds = new Set<number>();
const seededMachineIds = new Set<string>();

interface SeedBlock {
  text: string;
  ts: string;
  turnIndex?: number;
  role?: string;
  btype?: string;
  toolName?: string | null;
  onMainPath?: number;
  truncated?: number;
}

interface SeedSession {
  sessionId: string;
  machineId: string;
  title: string;
  startedAt: string;
  parentSessionId?: string | null;
  isSidechain?: number;
  blocks: SeedBlock[];
}

function toolCall(tool: string, args: unknown): string {
  return `${tool} ${JSON.stringify(args)}`;
}

async function seedSession(fixture: SeedSession): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO machines (machine_id, os, hostname) VALUES (?1, 'linux', ?2)`,
  ).bind(fixture.machineId, fixture.machineId).run();
  seededMachineIds.add(fixture.machineId);

  const file = await testEnv.DB.prepare(
    `INSERT INTO files
       (machine_id, store, relpath, r2_key, size, mtime, content_hash, harness, session_id, parse_state)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, 'omp', ?7, 'parsed')
     RETURNING id`,
  ).bind(
    fixture.machineId,
    STORE,
    `${fixture.sessionId}.jsonl`,
    `reports-fixture/${RUN_ID}/${fixture.sessionId}`,
    fixture.startedAt,
    `reports-fixture-${RUN_ID}-${fixture.machineId}`,
    fixture.sessionId,
  ).first<{ id: number }>();
  if (!file) throw new Error(`failed to seed file for ${fixture.sessionId}`);
  seededFileIds.add(file.id);

  await testEnv.DB.prepare(
    `INSERT INTO sessions
       (session_id, harness, machine_id, canonical_file_id, title, started_at, updated_at, parent_session_id, is_sidechain, index_state)
     VALUES (?1, 'omp', ?2, ?3, ?4, ?5, ?5, ?6, ?7, 'ready')`,
  ).bind(
    fixture.sessionId,
    fixture.machineId,
    file.id,
    fixture.title,
    fixture.startedAt,
    fixture.parentSessionId ?? null,
    fixture.isSidechain ?? 0,
  ).run();
  seededSessionIds.add(fixture.sessionId);

  for (const [blockIndex, block] of fixture.blocks.entries()) {
    await testEnv.DB.prepare(
      `INSERT INTO blocks
         (session_id, file_id, turn_index, block_index, role, btype, tool_name, ts, truncated, text, on_main_path)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(
      fixture.sessionId,
      file.id,
      block.turnIndex ?? 0,
      blockIndex,
      block.role ?? 'assistant',
      block.btype ?? 'tool_use',
      block.toolName ?? null,
      block.ts,
      block.truncated ?? 0,
      block.text,
      block.onMainPath ?? 1,
    ).run();
  }
}

afterEach(async () => {
  const statements = [
    ...[...seededSessionIds].map((sessionId) =>
      testEnv.DB.prepare('DELETE FROM blocks WHERE session_id = ?1').bind(sessionId),
    ),
    ...[...seededSessionIds].map((sessionId) =>
      testEnv.DB.prepare('DELETE FROM sessions WHERE session_id = ?1').bind(sessionId),
    ),
    ...[...seededFileIds].map((fileId) =>
      testEnv.DB.prepare('DELETE FROM files WHERE id = ?1').bind(fileId),
    ),
    ...[...seededMachineIds].map((machineId) =>
      testEnv.DB.prepare('DELETE FROM machines WHERE machine_id = ?1').bind(machineId),
    ),
  ];
  if (statements.length > 0) await testEnv.DB.batch(statements);
  seededSessionIds.clear();
  seededFileIds.clear();
  seededMachineIds.clear();
});

describe('/reports viewer', () => {
  it('aggregates reports from different sessions newest first by block timestamp', async () => {
    const olderSession = `${RUN_ID}-aggregation-older`;
    const newerSession = `${RUN_ID}-aggregation-newer`;
    await seedSession({
      sessionId: olderSession,
      machineId: `${RUN_ID}-machine-older`,
      title: 'Older aggregation session',
      startedAt: '2026-09-15T10:00:00.000Z',
      blocks: [{
        text: toolCall('write', { path: REPORT_DEVICE, content: 'hub.start: older report sentinel' }),
        toolName: 'write',
        ts: '2026-09-15T10:01:00.000Z',
      }],
    });
    await seedSession({
      sessionId: newerSession,
      machineId: `${RUN_ID}-machine-newer`,
      title: 'Newer aggregation session',
      startedAt: '2026-09-16T10:00:00.000Z',
      blocks: [{
        text: toolCall('write', { path: REPORT_DEVICE, content: 'bash: newer report sentinel' }),
        toolName: 'write',
        ts: '2026-09-16T10:01:00.000Z',
      }],
    });

    const response = await SELF.fetch(`${VIEWER}/reports`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const newerAt = html.indexOf('bash: newer report sentinel');
    const olderAt = html.indexOf('hub.start: older report sentinel');
    expect(newerAt).toBeGreaterThanOrEqual(0);
    expect(olderAt).toBeGreaterThanOrEqual(0);
    expect(newerAt).toBeLessThan(olderAt);
  });
  it('paginates 26 reports and preserves filters while clamping an oversized page', async () => {
    const sessionId = `${RUN_ID}-pager`;
    const reportBody = (number: number) => `bash: pager report #${String(number).padStart(2, '0')}`;
    await seedSession({
      sessionId,
      machineId: `${RUN_ID}-machine-pager`,
      title: 'Pager session',
      startedAt: '2026-09-16T11:30:00.000Z',
      blocks: Array.from({ length: 26 }, (_, index) => {
        const number = index + 1;
        return {
          text: toolCall('write', { path: REPORT_DEVICE, content: reportBody(number) }),
          toolName: 'write',
          ts: `2026-09-16T11:${String(59 - index).padStart(2, '0')}:00.000Z`,
        };
      }),
    });

    const pageOne = await SELF.fetch(`${VIEWER}/reports?tool=bash`);
    expect(pageOne.status).toBe(200);
    const pageOneHtml = await pageOne.text();
    expect(pageOneHtml).toContain(reportBody(1));
    expect(pageOneHtml).toContain(reportBody(25));
    expect(pageOneHtml).not.toContain(reportBody(26));
    expect(pageOneHtml).toContain('<nav class="pager" aria-label="Issue report pages">');
    expect(pageOneHtml).toContain('<a href="/reports?tool=bash&amp;page=2">Next →</a>');

    const pageTwo = await SELF.fetch(`${VIEWER}/reports?tool=bash&page=2`);
    expect(pageTwo.status).toBe(200);
    const pageTwoHtml = await pageTwo.text();
    expect(pageTwoHtml).toContain(reportBody(26));
    expect(pageTwoHtml).not.toContain(reportBody(1));
    expect(pageTwoHtml).toContain('<a href="/reports?tool=bash&amp;page=1">← Previous</a>');

    const clamped = await SELF.fetch(`${VIEWER}/reports?tool=bash&page=99`);
    expect(clamped.status).toBe(200);
    const clampedHtml = await clamped.text();
    expect(clampedHtml).toContain(reportBody(26));
    expect(clampedHtml).toContain('<span class="small">Page 2 / 2</span>');
  });

  it('links each report to its encoded session and turn page', async () => {
    const sessionId = `omp:${RUN_ID}:back-link-agent.jsonl`;
    const turnIndex = TURNS_PER_PAGE + 37;
    const fullTitle = `Subagent prompt first line\n\nSecond line ${'x'.repeat(100)}`;
    const collapsedTitle = fullTitle.replace(/\s+/g, ' ').trim();
    const clippedTitle = `${collapsedTitle.slice(0, 79)}…`;
    await seedSession({
      sessionId,
      machineId: `${RUN_ID}-machine-back-link`,
      title: fullTitle,
      parentSessionId: `${RUN_ID}-parent-session`,
      isSidechain: 1,
      startedAt: '2026-09-16T11:00:00.000Z',
      blocks: [{
        turnIndex,
        text: toolCall('write', { path: REPORT_DEVICE, content: 'bash: back-link report sentinel' }),
        toolName: 'write',
        ts: '2026-09-16T11:01:00.000Z',
      }],
    });

    const response = await SELF.fetch(`${VIEWER}/reports`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const expectedHref =
      `/s/${encodeURIComponent(sessionId)}?page=${Math.floor(turnIndex / TURNS_PER_PAGE) + 1}` +
      `&view=chronological#t${turnIndex}`;
    expect(html).toContain(`href="${expectedHref.replaceAll('&', '&amp;')}"`);
    expect(html).toContain(`title="${collapsedTitle}"`);
    expect(html).toContain(`>${clippedTitle}</a>`);
  });

  it('excludes documentation reads, malformed arguments, and ordinary mentions', async () => {
    const sessionId = `${RUN_ID}-discrimination`;
    await seedSession({
      sessionId,
      machineId: `${RUN_ID}-machine-discrimination`,
      title: 'Discrimination session',
      startedAt: '2026-09-16T12:00:00.000Z',
      blocks: [
        {
          text: toolCall('read', { path: REPORT_DEVICE, i: 'read-call-sentinel' }),
          toolName: 'read',
          ts: '2026-09-16T12:04:00.000Z',
        },
        {
          text: toolCall('write', [REPORT_DEVICE]),
          toolName: 'write',
          ts: '2026-09-16T12:03:00.000Z',
        },
        {
          text: 'The prompt merely mentions xd://report_issue: prompt-mention-sentinel',
          role: 'user',
          btype: 'prompt',
          ts: '2026-09-16T12:02:00.000Z',
        },
        {
          text: 'Ordinary text merely mentions xd://report_issue: text-mention-sentinel',
          role: 'user',
          btype: 'text',
          ts: '2026-09-16T12:01:00.000Z',
        },
        {
          text: toolCall('write', {
            path: REPORT_DEVICE,
            content: 'bash: real report sentinel',
          }),
          toolName: 'write',
          ts: '2026-09-16T12:00:00.000Z',
        },
      ],
    });

    const response = await SELF.fetch(`${VIEWER}/reports`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('bash: real report sentinel');
    expect(html).not.toContain('read-call-sentinel');
    expect(html).not.toContain('prompt-mention-sentinel');
    expect(html).not.toContain('text-mention-sentinel');
    expect(html).not.toContain('write ["xd://report_issue"]');
  });

  it('labels reports and filters by reported tool including unlabelled and unknown labels', async () => {
    const sessionId = `${RUN_ID}-labels`;
    await seedSession({
      sessionId,
      machineId: `${RUN_ID}-machine-labels`,
      title: 'Labels session',
      startedAt: '2026-09-16T13:00:00.000Z',
      blocks: [
        {
          text: toolCall('write', { path: REPORT_DEVICE, content: 'bash: bash-labelled sentinel' }),
          toolName: 'write',
          ts: '2026-09-16T13:07:00.000Z',
        },
        {
          text: toolCall('write', { path: REPORT_DEVICE, content: 'hub.start: dotted-label sentinel' }),
          toolName: 'write',
          ts: '2026-09-16T13:06:00.000Z',
        },
        {
          text: toolCall('write', { path: REPORT_DEVICE, content: 'xd://tui: URI-labelled sentinel' }),
          toolName: 'write',
          ts: '2026-09-16T13:05:00.000Z',
        },
        {
          text: toolCall('write', { path: REPORT_DEVICE, content: 'not a label: unlabelled sentinel' }),
          toolName: 'write',
          ts: '2026-09-16T13:04:00.000Z',
        },
        {
          text: toolCall('write', { path: REPORT_DEVICE, content: 'The write tool: prose-unlabelled sentinel' }),
          toolName: 'write',
          ts: '2026-09-16T13:03:00.000Z',
        },
        {
          text: toolCall('write', { path: REPORT_DEVICE, content: 'Bash: uppercase-unlabelled sentinel' }),
          toolName: 'write',
          ts: '2026-09-16T13:02:00.000Z',
        },
        {
          text: toolCall('write', { path: REPORT_DEVICE, content: 'hub start: spaced-unlabelled sentinel' }),
          toolName: 'write',
          ts: '2026-09-16T13:01:00.000Z',
        },
      ],
    });

    const all = await SELF.fetch(`${VIEWER}/reports`);
    expect(all.status).toBe(200);
    const allHtml = await all.text();
    expect(allHtml).toContain('bash: bash-labelled sentinel');
    expect(allHtml).toContain('hub.start: dotted-label sentinel');
    expect(allHtml).toContain('xd://tui: URI-labelled sentinel');
    expect(allHtml).toContain('not a label: unlabelled sentinel');
    expect(allHtml).toContain('The write tool: prose-unlabelled sentinel');
    expect(allHtml).toContain('Bash: uppercase-unlabelled sentinel');
    expect(allHtml).toContain('hub start: spaced-unlabelled sentinel');
    expect(allHtml).toContain('<a href="/reports?tool=bash">bash 1</a>');
    expect(allHtml).toContain('<a href="/reports?tool=hub.start">hub.start 1</a>');
    expect(allHtml).toContain('<a href="/reports?tool=xd%3A%2F%2Ftui">xd://tui 1</a>');
    expect(allHtml).toContain('<a href="/reports?tool=(unlabelled)">(unlabelled) 4</a>');

    const bash = await SELF.fetch(`${VIEWER}/reports?tool=bash`);
    expect(bash.status).toBe(200);
    const bashHtml = await bash.text();
    expect(bashHtml).toContain('<a href="/reports?tool=bash" class="on" aria-current="true">bash 1</a>');
    expect(bashHtml).toContain('bash: bash-labelled sentinel');
    expect(bashHtml).not.toContain('hub.start: dotted-label sentinel');
    expect(bashHtml).not.toContain('xd://tui: URI-labelled sentinel');
    expect(bashHtml).not.toContain('not a label: unlabelled sentinel');

    const uri = await SELF.fetch(`${VIEWER}/reports?tool=${encodeURIComponent('xd://tui')}`);
    expect(uri.status).toBe(200);
    const uriHtml = await uri.text();
    expect(uriHtml).toContain(
      '<a href="/reports?tool=xd%3A%2F%2Ftui" class="on" aria-current="true">xd://tui 1</a>',
    );
    expect(uriHtml).toContain('xd://tui: URI-labelled sentinel');
    expect(uriHtml).not.toContain('bash: bash-labelled sentinel');

    const unlabelled = await SELF.fetch(`${VIEWER}/reports?tool=${encodeURIComponent('(unlabelled)')}`);
    expect(unlabelled.status).toBe(200);
    const unlabelledHtml = await unlabelled.text();
    expect(unlabelledHtml).toContain(
      '<a href="/reports?tool=(unlabelled)" class="on" aria-current="true">(unlabelled) 4</a>',
    );
    expect(unlabelledHtml).toContain('not a label: unlabelled sentinel');
    expect(unlabelledHtml).toContain('The write tool: prose-unlabelled sentinel');
    expect(unlabelledHtml).toContain('Bash: uppercase-unlabelled sentinel');
    expect(unlabelledHtml).toContain('hub start: spaced-unlabelled sentinel');
    expect(unlabelledHtml).not.toContain('bash: bash-labelled sentinel');
    expect(unlabelledHtml).not.toContain('hub.start: dotted-label sentinel');
    expect(unlabelledHtml).not.toContain('xd://tui: URI-labelled sentinel');

    const unknown = await SELF.fetch(`${VIEWER}/reports?tool=never-used`);
    expect(unknown.status).toBe(200);
    const unknownHtml = await unknown.text();
    expect(unknownHtml).toContain('No report carries that label.');
    expect(unknownHtml).not.toContain('bash: bash-labelled sentinel');
  });

  it('escapes report bodies as text rather than markup', async () => {
    const sessionId = `${RUN_ID}-escaping`;
    const report = 'bash: payload <script>alert("x")</script> and "quoted"';
    await seedSession({
      sessionId,
      machineId: `${RUN_ID}-machine-escaping`,
      title: 'Escaping session',
      startedAt: '2026-09-16T14:00:00.000Z',
      blocks: [{
        text: toolCall('write', { path: REPORT_DEVICE, content: report }),
        toolName: 'write',
        ts: '2026-09-16T14:01:00.000Z',
      }],
    });

    const response = await SELF.fetch(`${VIEWER}/reports`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      '<div class="snip">bash: payload &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; and &quot;quoted&quot;</div>',
    );
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  it('renders the empty state when no report is seeded', async () => {
    const response = await SELF.fetch(`${VIEWER}/reports`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('No agent has filed an issue report in this corpus yet.');
  });

  it('uses blocks_issue_reports for the reports page query', async () => {
    const plan = await testEnv.DB.prepare(`EXPLAIN QUERY PLAN ${REPORTS_QUERY}`).all<{ detail?: string }>();
    expect(plan.results.some((row) => row.detail?.includes('blocks_issue_reports'))).toBe(true);
  });
});
