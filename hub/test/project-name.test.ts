import { env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveProjectName } from '../src/project-name';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

interface ProjectCase {
  name: string;
  cwd?: string | null;
  repoUrl?: string | null;
  expected: string | null;
}

const PROJECT_CASES: ProjectCase[] = [
  { name: 'POSIX source checkout', cwd: '/home/pedro/src/agent-sessions-backup', expected: 'agent-sessions-backup' },
  { name: 'Windows source checkout', cwd: 'C:\\src\\harmonic-analyzer\\cad', expected: 'harmonic-analyzer' },
  { name: 'nested Claude worktree', cwd: '/home/pedro/src/meshprobe/.claude/worktrees/fix-render', expected: 'meshprobe' },
  { name: 'nested dot-worktrees checkout', cwd: '/home/pedro/src/meshprobe/.worktrees/fix-render', expected: 'meshprobe' },
  { name: 'sibling worktree', cwd: '/home/pedro/src/meshprobe-wt-fix-render/src', expected: 'meshprobe' },
  {
    name: 'encoded Windows Claude worktree',
    cwd: 'C--src-harmonic-analyzer--claude-worktrees-fix-render',
    expected: 'harmonic-analyzer',
  },
  {
    name: 'encoded POSIX Claude worktree',
    cwd: '-home-pedro-src-agent-sessions-backup--claude-worktrees-facet-ui',
    expected: 'agent-sessions-backup',
  },
  {
    name: 'encoded worktree inside a projects directory',
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
    name: 'SCP-like nested repository URL',
    cwd: '/home/pedro/src/wrong-project',
    repoUrl: 'git@github.com:pedropaulovc/right-project.git',
    expected: 'right-project',
  },
  {
    name: 'SCP-like single-component repository URL',
    cwd: '/home/pedro/src/wrong-project',
    repoUrl: 'git@host:right-project.git',
    expected: 'right-project',
  },
  {
    name: 'SCP-like repository URL may contain at-signs in its path',
    cwd: '/home/pedro/src/wrong-project',
    repoUrl: 'git@host:owner/right@project.git',
    expected: 'right@project',
  },
  { name: 'SCP-like repository rejects whitespace in its authority', cwd: '/home/pedro/src/fallback', repoUrl: 'bad @host:repo.git', expected: 'fallback' },
  { name: 'SCP-like repository rejects repeated at-signs in its authority', cwd: '/home/pedro/src/fallback', repoUrl: 'git@@host:repo.git', expected: 'fallback' },
  { name: 'case-insensitive bare dot-git falls back to cwd', cwd: '/home/pedro/src/fallback', repoUrl: 'git@host:.GIT', expected: 'fallback' },
  { name: 'percent-encoded repository basename stays stable', repoUrl: 'https://example.test/org/right%20project.git', expected: 'right%20project' },
  { name: 'repository may legitimately be named src', cwd: '/tmp', repoUrl: 'https://example.test/org/src.git', expected: 'src' },
  { name: 'repository may legitimately be named dot-claude', cwd: '/tmp', repoUrl: 'https://example.test/org/.claude.git', expected: '.claude' },
  { name: 'repository may legitimately be named dot-worktrees', cwd: '/tmp', repoUrl: 'https://example.test/org/.worktrees.git', expected: '.worktrees' },
  { name: 'repository may legitimately be named worktrees', cwd: '/tmp', repoUrl: 'https://example.test/org/worktrees.git', expected: 'worktrees' },
  { name: 'generic a suffix is retained', cwd: '/home/pedro/src/project-a', expected: 'project-a' },
  { name: 'generic b suffix is retained', cwd: '/home/pedro/src/project-b', expected: 'project-b' },
  { name: 'dot segments are ambiguous', cwd: '/home/pedro/src/first/../final-project', expected: null },
  { name: 'duplicate separators are ambiguous', cwd: '/home/pedro//src/project', expected: null },
  {
    name: 'duplicate separators make an encoded worktree ambiguous',
    cwd: '/prefix//C--src-project--claude-worktrees-fix',
    expected: null,
  },
  { name: 'no src segment', cwd: '/home/pedro/projects/unknown', expected: null },
  { name: 'src has no project child', cwd: '/home/pedro/src', expected: null },
  { name: 'dot-claude is not a cwd project', cwd: '/home/pedro/src/.claude/worktrees/name', expected: null },
  { name: 'dot-worktrees is not a cwd project', cwd: '/home/pedro/src/.worktrees/name', expected: null },
  { name: 'malformed sibling worktree', cwd: '/home/pedro/src/base-wt-', expected: null },
  { name: 'multiple sibling worktree markers are ambiguous', cwd: '/home/pedro/src/base-wt-one-wt-two', expected: null },
  { name: 'empty encoded worktree suffix is ambiguous', cwd: 'C--src-base--claude-worktrees-', expected: null },
  {
    name: 'multiple encoded worktree paths are ambiguous',
    cwd: 'C--src-one--claude-worktrees-a/C--src-two--claude-worktrees-b',
    expected: null,
  },
  { name: 'invalid repository falls back to cwd', cwd: '/home/pedro/src/fallback', repoUrl: 'not a URL', expected: 'fallback' },
  { name: 'URL with no authority falls back to cwd', cwd: '/home/pedro/src/fallback', repoUrl: 'https:///not-valid', expected: 'fallback' },
  { name: 'invalid repository and no cwd project', cwd: '/tmp', repoUrl: 'mailto:owner@example.com', expected: null },
  { name: 'missing metadata', cwd: null, repoUrl: null, expected: null },
];

describe('deriveProjectName', () => {
  for (const testCase of PROJECT_CASES) {
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

  it('backfills every representative row exactly like deriveProjectName', async () => {
    await testEnv.DB.batch(PROJECT_CASES.map((testCase, index) => testEnv.DB.prepare(
      `INSERT INTO sessions (session_id, harness, cwd, repo_url, index_state)
       VALUES (?1, 'codex', ?2, ?3, 'ready')`,
    ).bind(`project-parity-${String(index).padStart(2, '0')}`, testCase.cwd ?? null, testCase.repoUrl ?? null)));

    for (const name of ['0011_sessions_project_name.sql', '0012_sessions_project_name_parity.sql']) {
      const migration = testEnv.TEST_MIGRATIONS.find((candidate) => candidate.name === name);
      const backfill = migration?.queries.find((query) => query.includes('UPDATE sessions') && query.includes('cwd_candidate'));
      expect(backfill, name).toBeTruthy();
      await testEnv.DB.prepare(backfill!).run();
    }

    const rows = await testEnv.DB.prepare(
      "SELECT session_id, project_name FROM sessions WHERE session_id LIKE 'project-parity-%' ORDER BY session_id",
    ).all<{ session_id: string; project_name: string | null }>();
    expect(rows.results).toHaveLength(PROJECT_CASES.length);
    for (let index = 0; index < PROJECT_CASES.length; index++) {
      const testCase = PROJECT_CASES[index]!;
      const expected = deriveProjectName(testCase.cwd, testCase.repoUrl);
      expect(expected, testCase.name).toBe(testCase.expected);
      expect(rows.results[index]?.project_name, `migration parity: ${testCase.name}`).toBe(expected);
    }
  });

  it('uses sessions_project for project equality lookups', async () => {
    const plan = await testEnv.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT session_id FROM sessions WHERE project_name = 'right-project'",
    ).all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes('USING INDEX sessions_project'))).toBe(true);
  });
});
