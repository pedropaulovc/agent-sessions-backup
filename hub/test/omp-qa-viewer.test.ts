import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { OMP_QA_FACET_QUERY, OMP_QA_FILTERED_PAGE_QUERY, OMP_QA_PAGE_QUERY } from '../src/viewer/omp-qa';
import { VIEWER } from './hosts';

const testEnv = env as unknown as Env;
const RUN_ID = crypto.randomUUID();
const INSTALL_PREFIX = `omp-qa-viewer-${RUN_ID}-`;
const seededInstallIds = new Set<string>();

interface SeedRow {
  installId: string;
  entryId?: number;
  agentName?: string;
  agentVersion?: string;
  platform?: string;
  arch?: string;
  model?: string;
  ompVersion?: string;
  tool?: string;
  report?: string;
  properties?: string;
  receivedAt?: string;
}

function row(overrides: SeedRow): SeedRow & Required<Omit<SeedRow, 'entryId'>> & { entryId: number } {
  return {
    installId: overrides.installId,
    entryId: overrides.entryId ?? 1,
    agentName: overrides.agentName ?? 'omp',
    agentVersion: overrides.agentVersion ?? '0.9.0',
    platform: overrides.platform ?? 'linux',
    arch: overrides.arch ?? 'x64',
    model: overrides.model ?? 'gpt-5.6',
    ompVersion: overrides.ompVersion ?? '0.9.0',
    tool: overrides.tool ?? 'shell',
    report: overrides.report ?? 'qa report',
    properties: overrides.properties ?? '{}',
    receivedAt: overrides.receivedAt ?? '2026-09-18T00:00:00.000Z',
  };
}

async function seed(rows: Array<SeedRow & Required<Omit<SeedRow, 'entryId'>> & { entryId: number }>): Promise<void> {
  for (const fixture of rows) seededInstallIds.add(fixture.installId);
  await testEnv.DB.batch(rows.map((fixture) => testEnv.DB.prepare(
    `INSERT INTO omp_qa_reports
       (install_id, entry_id, properties, dedup_key, agent_name, agent_version, platform, arch, model, omp_version, tool, report, received_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  ).bind(
    fixture.installId,
    fixture.entryId,
    fixture.properties,
    `${fixture.installId}:${fixture.entryId}:${fixture.tool}:${fixture.report}`,
    fixture.agentName,
    fixture.agentVersion,
    fixture.platform,
    fixture.arch,
    fixture.model,
    fixture.ompVersion,
    fixture.tool,
    fixture.report,
    fixture.receivedAt,
  )));
}

afterEach(async () => {
  if (seededInstallIds.size > 0) {
    await testEnv.DB.batch(
      [...seededInstallIds].map((installId) =>
        testEnv.DB.prepare('DELETE FROM omp_qa_reports WHERE install_id = ?1').bind(installId)),
    );
  }
  seededInstallIds.clear();
});

describe('/omp-qa viewer', () => {
  it('renders the navigation, newest-first metadata, consent note, and escaped reports', async () => {
    const newerInstall = `${INSTALL_PREFIX}new-install-long`;
    const olderInstall = `${INSTALL_PREFIX}old-install-long`;
    await seed([
      row({
        installId: newerInstall,
        agentVersion: '0.9.1',
        ompVersion: '0.9.0',
        model: 'gpt-5.6-luna',
        report: '<script>alert("qa")</script> newest sentinel',
        properties: JSON.stringify({ sessionId: 'session-future', note: '<script>property</script>' }),
        receivedAt: '2026-09-18T00:02:00.000Z',
      }),
      row({
        installId: olderInstall,
        tool: 'shell-extra',
        report: 'older sentinel',
        receivedAt: '2026-09-18T00:01:00.000Z',
      }),
    ]);

    const response = await SELF.fetch(`${VIEWER}/omp-qa`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<a href="/omp-qa" style="font-weight:700">OMP QA</a>');
    expect(html).toContain('These are consented reports received directly from OMP and lack transcript backlinks.');
    expect(html).toContain('&lt;script&gt;alert(&quot;qa&quot;)&lt;/script&gt; newest sentinel');
    expect(html).not.toContain('<script>alert("qa")</script>');
    expect(html).toContain('model gpt-5.6-luna');
    expect(html).toContain('OMP 0.9.0');
    expect(html).toContain('agent omp 0.9.1');
    expect(html).toContain('linux/x64');
    expect(html).toContain(`title="${newerInstall}"`);
    expect(html).toContain('received at 2026-09-18T00:02:00.000Z');
    expect(html).toContain('properties</span> <code>{&quot;sessionId&quot;:&quot;session-future&quot;');
    expect(html).toContain('&lt;script&gt;property&lt;/script&gt;');
    expect(html).not.toContain('<script>property</script>');
    expect(html.indexOf('newest sentinel')).toBeLessThan(html.indexOf('older sentinel'));
  });

  it('filters tools by exact value and paginates 26 matching reports', async () => {
    await seed([
      ...Array.from({ length: 26 }, (_, index) => row({
        installId: `${INSTALL_PREFIX}pager-${index}`,
        tool: 'shell',
        report: `pager-${index} sentinel`,
        receivedAt: `2026-09-18T00:${String(index).padStart(2, '0')}:00.000Z`,
      })),
      row({
        installId: `${INSTALL_PREFIX}different-tool`,
        tool: 'shell-extra',
        report: 'must not match shell filter',
        receivedAt: '2026-09-18T01:00:00.000Z',
      }),
    ]);

    const pageOne = await SELF.fetch(`${VIEWER}/omp-qa?tool=shell`);
    expect(pageOne.status).toBe(200);
    const pageOneHtml = await pageOne.text();
    expect(pageOneHtml).toContain('pager-25 sentinel');
    expect(pageOneHtml).not.toContain('pager-0 sentinel');
    expect(pageOneHtml).not.toContain('must not match shell filter');
    expect(pageOneHtml).toContain('<a href="/omp-qa?tool=shell" class="on" aria-current="true">shell 26</a>');
    expect(pageOneHtml).toContain('<a href="/omp-qa?tool=shell&amp;page=2">Next →</a>');

    const pageTwo = await SELF.fetch(`${VIEWER}/omp-qa?tool=shell&page=2`);
    expect(pageTwo.status).toBe(200);
    const pageTwoHtml = await pageTwo.text();
    expect(pageTwoHtml).toContain('pager-0 sentinel');
    expect(pageTwoHtml).not.toContain('pager-25 sentinel');
    expect(pageTwoHtml).toContain('<span class="small">Page 2 / 2</span>');
  });

  it('renders an empty exact-tool state without confusing it for a populated page', async () => {
    await seed([row({
      installId: `${INSTALL_PREFIX}empty-filter`,
      tool: 'present-tool',
      report: 'present tool sentinel',
    })]);
    const response = await SELF.fetch(`${VIEWER}/omp-qa?tool=${encodeURIComponent(`missing-${RUN_ID}`)}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('No report uses that tool.');
  });

  it('bounds public report previews and tool facets', async () => {
    await seed(Array.from({ length: 51 }, (_, index) => row({
      installId: `${INSTALL_PREFIX}bounds-${index}`,
      tool: `bounds-tool-${String(index).padStart(2, '0')}`,
      report: index === 50 ? `${'x'.repeat(5000)} tail-must-not-render` : `report ${index}`,
      receivedAt: `2026-09-18T02:${String(index).padStart(2, '0')}:00.000Z`,
    })));
    const response = await SELF.fetch(`${VIEWER}/omp-qa`);
    const html = await response.text();
    expect(html).toContain('Showing the 50 most common tool filters.');
    expect(html.match(/href="\/omp-qa\?tool=/g)).toHaveLength(50);
    expect(html).not.toContain('tail-must-not-render');
  });

  it('uses the newest-first index for a bounded page query', async () => {
    const plan = await testEnv.DB.prepare(`EXPLAIN QUERY PLAN ${OMP_QA_PAGE_QUERY}`)
      .bind(25, 0)
      .all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes('omp_qa_reports_received'))).toBe(true);
  });

  it('uses the exact-tool index for filtered page queries', async () => {
    const plan = await testEnv.DB.prepare(`EXPLAIN QUERY PLAN ${OMP_QA_FILTERED_PAGE_QUERY}`)
      .bind('shell', 25, 0)
      .all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes('omp_qa_reports_tool_received'))).toBe(true);
  });

  it('bounds facet aggregation to the indexed recent-report window', async () => {
    const plan = await testEnv.DB.prepare(`EXPLAIN QUERY PLAN ${OMP_QA_FACET_QUERY}`)
      .all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes('omp_qa_reports_received'))).toBe(true);
  });
});