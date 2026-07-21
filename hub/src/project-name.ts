/** Derive a stable project facet from repository metadata, falling back to the working directory. */
export function deriveProjectName(cwd: string | null | undefined, repoUrl: string | null | undefined): string | null {
  return projectFromRepoUrl(repoUrl) ?? projectFromCwd(cwd);
}

function projectFromRepoUrl(repoUrl: string | null | undefined): string | null {
  const raw = repoUrl?.trim();
  if (!raw) return null;

  let pathname: string;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'ssh:', 'git:', 'file:'].includes(url.protocol)) return null;
    pathname = url.pathname;
  } catch {
    // Git's SCP-like SSH syntax is a valid remote even though it is not a WHATWG URL.
    const scp = raw.match(/^[^@/\s]+@[^:/\s]+:(.+)$/);
    if (!scp) return null;
    pathname = scp[1]!;
  }

  const encodedName = pathname.split('/').filter(Boolean).at(-1);
  if (!encodedName) return null;

  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    return null;
  }
  if (name.toLowerCase().endsWith('.git')) name = name.slice(0, -4);
  return validProjectSegment(name);
}

function projectFromCwd(cwd: string | null | undefined): string | null {
  const raw = cwd?.trim();
  if (!raw) return null;

  const normalized = raw.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  const encoded = encodedWindowsWorktreeProject(normalized);
  if (encoded !== null) return normalizeWorktreeName(encoded);

  const segments = normalizeSegments(normalized);
  if (!segments) return null;
  const src = segments.findIndex((segment) => segment.toLowerCase() === 'src');
  if (src < 0) return null;
  return normalizeWorktreeName(segments[src + 1]);
}

function encodedWindowsWorktreeProject(path: string): string | null {
  const matches = [...path.matchAll(/(?:^|\/)c--src-(.+?)--claude-worktrees-[^/]+(?=\/|$)/gi)];
  if (matches.length !== 1) return null;
  return matches[0]![1] ?? null;
}

function normalizeSegments(path: string): string[] | null {
  const normalized: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment !== '..') {
      normalized.push(segment);
      continue;
    }
    if (normalized.length === 0) return null;
    normalized.pop();
  }
  return normalized;
}

function normalizeWorktreeName(segment: string | undefined): string | null {
  const name = validProjectSegment(segment);
  if (!name) return null;

  const marker = name.toLowerCase().indexOf('-wt-');
  if (marker < 0) return name;
  if (name.toLowerCase().indexOf('-wt-', marker + 4) >= 0) return null;
  if (marker === 0 || marker + 4 === name.length) return null;
  return validProjectSegment(name.slice(0, marker));
}

function validProjectSegment(segment: string | undefined): string | null {
  const name = segment?.trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return null;
  if (['src', '.claude', 'worktrees', 'claude-worktrees'].includes(name.toLowerCase())) return null;
  return name;
}
