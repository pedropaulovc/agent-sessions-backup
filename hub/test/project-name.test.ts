import { env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveProjectName } from '../src/project-name';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

describe('deriveProjectName', () => {
  const cases: Array<{
    name: string;
    cwd?: string | null;
    repoUrl?: string | null;
    expected: string | null;
  }> = [
    { name: 'POSIX source checkout', cwd: '/home/pedro/src/agent-sessions-backup', expected: 'agent-sessions-backup' },
    { name: 'Windows source checkout', cwd: 'C:\\src\\harmonic-analyzer\\cad', expected: 'harmonic-analyzer' },
    { name: 'nested Claude worktree', cwd: '/home/pedro/src/meshprobe/.claude/worktrees/fix-render', expected: 'meshprobe' },
    { name: 'sibling worktree', cwd: '/home/pedro/src/meshprobe-wt-fix-render/src', expected: 'meshprobe' },
    {
      name: 'encoded Windows Claude worktree',
      cwd: 'C--src-harmonic-analyzer--claude-worktrees-fix-render',
      expected: 'harmonic-analyzer',
    },
    {
      name: 'encoded Windows Claude worktree inside a projects directory',
      cwd: '/users/pedro/.claude/projects/C--src-agent-sessions-backup--claude-worktrees-facet-ui',
      expected: 'agent-sessions-backup',
    },
    {
      name: 'repository URL wins over cwd',
      cwd: '/home/pedro/src/wrong-project',
      repoUrl: 'https://github.com/pedropaulovc/right-project.git',
      expected: 'right-project',
    },
    {
      name: 'SCP-like repository URL',
      cwd: '/home/pedro/src/wrong-project',
      repoUrl: 'git@github.com:pedropaulovc/right-project.git',
      expected: 'right-project',
    },
    { name: 'generic a suffix is retained', cwd: '/home/pedro/src/project-a', expected: 'project-a' },
    { name: 'generic b suffix is retained', cwd: '/home/pedro/src/project-b', expected: 'project-b' },
    { name: 'dot segments are normalized', cwd: '/home/pedro/src/first/../final-project/subdir', expected: 'final-project' },
    { name: 'no src segment', cwd: '/home/pedro/projects/unknown', expected: null },
    { name: 'src has no project child', cwd: '/home/pedro/src', expected: null },
    { name: 'generic worktree directory is not a project', cwd: '/home/pedro/src/.claude/worktrees/name', expected: null },
    { name: 'malformed sibling worktree', cwd: '/home/pedro/src/base-wt-', expected: null },
    { name: 'multiple sibling worktree markers are ambiguous', cwd: '/home/pedro/src/base-wt-one-wt-two', expected: null },
    {
      name: 'multiple encoded worktree paths are ambiguous',
      cwd: 'C--src-one--claude-worktrees-a/C--src-two--claude-worktrees-b',
      expected: null,
    },
    { name: 'invalid repository falls back to cwd', cwd: '/home/pedro/src/fallback', repoUrl: 'not a URL', expected: 'fallback' },
    { name: 'invalid repository and no cwd project', cwd: '/tmp', repoUrl: 'mailto:owner@example.com', expected: null },
    { name: 'missing metadata', cwd: null, repoUrl: null, expected: null },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(deriveProjectName(testCase.cwd, testCase.repoUrl)).toBe(testCase.expected);
    });
  }
});

describe('project_name migration', () => {
  it('adds the nullable column and sessions_project index', async () => {
    const column = await testEnv.DB.prepare("SELECT type, [notnull] FROM pragma_table_info('sessions') WHERE name = 'project_name'")
      .first<{ type: string; notnull: number }>();
    expect(column).toEqual({ type: 'TEXT', notnull: 0 });

    const index = await testEnv.DB.prepare("SELECT name FROM pragma_index_list('sessions') WHERE name = 'sessions_project'")
      .first<{ name: string }>();
    expect(index).toEqual({ name: 'sessions_project' });
  });

  it('backfills existing rows with repo precedence and safe cwd fallbacks', async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO sessions (session_id, harness, cwd, repo_url, index_state) VALUES ('project-backfill-repo', 'codex', '/home/pedro/src/cwd-project', 'https://github.com/org/repo-project.git', 'ready')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO sessions (session_id, harness, cwd, index_state) VALUES ('project-backfill-sibling', 'codex', 'C:\\src\\model-wt-redesign\\cad', 'ready')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO sessions (session_id, harness, cwd, index_state) VALUES ('project-backfill-encoded', 'claude-code', 'C--src-encoded-project--claude-worktrees-fix', 'ready')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO sessions (session_id, harness, cwd, index_state) VALUES ('project-backfill-negative', 'codex', '/tmp/no-project', 'ready')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO sessions (session_id, harness, cwd, index_state) VALUES ('project-backfill-windows', 'codex', 'C:\\src\\windows-project\\nested', 'ready')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO sessions (session_id, harness, cwd, index_state) VALUES ('project-backfill-nested', 'claude-code', '/home/pedro/src/nested-project/.claude/worktrees/feature', 'ready')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO sessions (session_id, harness, cwd, index_state) VALUES ('project-backfill-generic-a', 'codex', '/home/pedro/src/project-a', 'ready')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO sessions (session_id, harness, cwd, index_state) VALUES ('project-backfill-ambiguous', 'codex', '/home/pedro/src/base-wt-one-wt-two', 'ready')",
      ),
    ]);

    const migration = testEnv.TEST_MIGRATIONS.find((candidate) => candidate.name === '0011_sessions_project_name.sql');
    const backfill = migration?.queries.find((query) => query.includes('UPDATE sessions') && query.includes('cwd_candidate'));
    expect(backfill).toBeTruthy();
    await testEnv.DB.prepare(backfill!).run();

    const rows = await testEnv.DB.prepare(
      "SELECT session_id, project_name FROM sessions WHERE session_id LIKE 'project-backfill-%' ORDER BY session_id",
    ).all<{ session_id: string; project_name: string | null }>();
    expect(rows.results).toEqual([
      { session_id: 'project-backfill-ambiguous', project_name: null },
      { session_id: 'project-backfill-encoded', project_name: 'encoded-project' },
      { session_id: 'project-backfill-generic-a', project_name: 'project-a' },
      { session_id: 'project-backfill-negative', project_name: null },
      { session_id: 'project-backfill-nested', project_name: 'nested-project' },
      { session_id: 'project-backfill-repo', project_name: 'repo-project' },
      { session_id: 'project-backfill-sibling', project_name: 'model' },
      { session_id: 'project-backfill-windows', project_name: 'windows-project' },
    ]);
  });

  it('uses sessions_project for project equality lookups', async () => {
    const plan = await testEnv.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT session_id FROM sessions WHERE project_name = 'repo-project'",
    ).all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes('USING INDEX sessions_project'))).toBe(true);
  });
});
