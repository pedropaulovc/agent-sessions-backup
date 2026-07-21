/** Derive a stable project facet from repository metadata, falling back to the working directory. */
export function deriveProjectName(cwd: string | null | undefined, repoUrl: string | null | undefined): string | null {
  return projectFromRepoUrl(repoUrl) ?? projectFromCwd(cwd);
}

function projectFromRepoUrl(repoUrl: string | null | undefined): string | null {
  const raw = repoUrl?.trim();
  if (!raw) return null;

  let path: string | null = null;
  const url = raw.match(/^(https?|ssh|git|file):\/\/(.*)$/i);
  if (url) {
    const protocol = url[1]!.toLowerCase();
    const afterScheme = url[2]!;
    const slash = afterScheme.indexOf('/');
    if (slash < 0) return null;
    if (protocol !== 'file' && slash === 0) return null;
    path = afterScheme.slice(slash + 1);
  }

  if (path === null) {
    // Git's SCP-like SSH syntax is valid with either a nested or single-component path.
    const scp = raw.match(/^[^@/:\s]+@[^@/:\s]+:(.+)$/);
    if (!scp) return null;
    path = scp[1]!;
  }

  const query = path.indexOf('?');
  const fragment = path.indexOf('#');
  const end = query >= 0 && (fragment < 0 || query < fragment) ? query : fragment;
  const clean = (end >= 0 ? path.slice(0, end) : path).replace(/^\/+|\/+$/g, '');
  let name = clean.split('/').at(-1) ?? '';
  if (name.toLowerCase().endsWith('.git')) name = name.slice(0, -4);
  return validRepoProject(name);
}

function projectFromCwd(cwd: string | null | undefined): string | null {
  const raw = cwd?.trim();
  if (!raw) return null;

  const normalized = raw.replaceAll('\\', '/');
  if (normalized.includes('//')) return null;

  const encoded = encodedWorktreeProject(normalized);
  if (encoded.kind === 'invalid') return null;
  if (encoded.kind === 'project') return normalizeWorktreeName(encoded.name);

  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  const src = segments.findIndex((segment) => segment.toLowerCase() === 'src');
  if (src < 0) return null;
  return normalizeWorktreeName(segments[src + 1]);
}

type EncodedWorktreeProject =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'project'; name: string };

function encodedWorktreeProject(path: string): EncodedWorktreeProject {
  const prefixCount = path.toLowerCase().split('-src-').length - 1;
  const worktreeCount = path.toLowerCase().split('--claude-worktrees-').length - 1;
  if (prefixCount === 0 || worktreeCount === 0) return { kind: 'absent' };
  if (prefixCount !== 1 || worktreeCount !== 1) return { kind: 'invalid' };

  const match = path.match(/-src-(.+?)--claude-worktrees-([^/]+)(?=\/|$)/i);
  if (!match) return { kind: 'invalid' };
  return { kind: 'project', name: match[1]! };
}

function normalizeWorktreeName(segment: string | undefined): string | null {
  const name = validCwdProject(segment);
  if (!name) return null;

  const marker = name.toLowerCase().indexOf('-wt-');
  if (marker < 0) return name;
  if (name.toLowerCase().indexOf('-wt-', marker + 4) >= 0) return null;
  if (marker === 0 || marker + 4 === name.length) return null;
  return validCwdProject(name.slice(0, marker));
}

function validRepoProject(segment: string | undefined): string | null {
  const name = segment?.trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return null;
  return name;
}

function validCwdProject(segment: string | undefined): string | null {
  const name = validRepoProject(segment);
  if (!name) return null;
  if (['src', '.claude', '.worktrees', 'worktrees', 'claude-worktrees'].includes(name.toLowerCase())) return null;
  return name;
}
