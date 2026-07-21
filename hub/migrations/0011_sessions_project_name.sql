ALTER TABLE sessions ADD COLUMN project_name TEXT;

-- Existing sessions need the same repo-first project identity that new writes receive in
-- project-name.ts. Split repository paths recursively because SQLite has no reverse() helper;
-- this remains safe for quotes and other characters that make JSON-string splitting brittle.
WITH RECURSIVE
source AS (
  SELECT
    session_id,
    trim(repo_url) AS repo,
    replace(trim(cwd), char(92), '/') AS cwd
  FROM sessions
),
repo_path AS (
  SELECT
    session_id,
    cwd,
    CASE
      WHEN repo IS NULL OR repo = '' THEN NULL
      WHEN lower(repo) LIKE 'http://%' OR lower(repo) LIKE 'https://%'
        OR lower(repo) LIKE 'ssh://%' OR lower(repo) LIKE 'git://%' OR lower(repo) LIKE 'file://%' THEN
        CASE
          WHEN instr(substr(repo, instr(repo, '://') + 3), '/') > 0
          THEN substr(
            substr(repo, instr(repo, '://') + 3),
            instr(substr(repo, instr(repo, '://') + 3), '/') + 1
          )
          ELSE NULL
        END
      WHEN repo GLOB '*@*:*/*' THEN substr(repo, instr(repo, ':') + 1)
      ELSE NULL
    END AS path
  FROM source
),
repo_clean AS (
  SELECT
    session_id,
    cwd,
    trim(
      CASE
        WHEN path IS NULL THEN NULL
        WHEN instr(path, '?') > 0 AND (instr(path, '#') = 0 OR instr(path, '?') < instr(path, '#'))
          THEN substr(path, 1, instr(path, '?') - 1)
        WHEN instr(path, '#') > 0 THEN substr(path, 1, instr(path, '#') - 1)
        ELSE path
      END,
      '/'
    ) AS path
  FROM repo_path
),
repo_parts(session_id, cwd, rest, part, depth) AS (
  SELECT session_id, cwd, path, NULL, 0 FROM repo_clean
  UNION ALL
  SELECT
    session_id,
    cwd,
    CASE WHEN instr(rest, '/') > 0 THEN substr(rest, instr(rest, '/') + 1) ELSE '' END,
    CASE WHEN instr(rest, '/') > 0 THEN substr(rest, 1, instr(rest, '/') - 1) ELSE rest END,
    depth + 1
  FROM repo_parts
  WHERE rest IS NOT NULL AND rest <> ''
),
repo_name AS (
  SELECT
    session_id,
    CASE
      WHEN part IS NULL OR part IN ('', '.', '..', '.git') THEN NULL
      WHEN lower(part) LIKE '%.git' THEN substr(part, 1, length(part) - 4)
      ELSE part
    END AS name
  FROM repo_parts
  WHERE rest = '' AND depth > 0
),
cwd_candidate AS (
  SELECT
    session_id,
    CASE
      WHEN instr(lower(cwd), 'c--src-') > 0
       AND (instr(lower(cwd), 'c--src-') = 1 OR substr(cwd, instr(lower(cwd), 'c--src-') - 1, 1) = '/')
       AND instr(lower(cwd), '--claude-worktrees-') > instr(lower(cwd), 'c--src-') + 7
       AND instr(substr(lower(cwd), instr(lower(cwd), 'c--src-') + 7), 'c--src-') = 0
       AND instr(substr(lower(cwd), instr(lower(cwd), '--claude-worktrees-') + 19), '--claude-worktrees-') = 0
      THEN substr(
        cwd,
        instr(lower(cwd), 'c--src-') + 7,
        instr(lower(cwd), '--claude-worktrees-') - instr(lower(cwd), 'c--src-') - 7
      )
      WHEN instr(lower('/' || ltrim(cwd, '/')), '/src/') > 0 THEN
        CASE
          WHEN instr(substr('/' || ltrim(cwd, '/'), instr(lower('/' || ltrim(cwd, '/')), '/src/') + 5), '/') > 0
          THEN substr(
            substr('/' || ltrim(cwd, '/'), instr(lower('/' || ltrim(cwd, '/')), '/src/') + 5),
            1,
            instr(substr('/' || ltrim(cwd, '/'), instr(lower('/' || ltrim(cwd, '/')), '/src/') + 5), '/') - 1
          )
          ELSE substr('/' || ltrim(cwd, '/'), instr(lower('/' || ltrim(cwd, '/')), '/src/') + 5)
        END
      ELSE NULL
    END AS name
  FROM repo_clean
),
cwd_name AS (
  SELECT
    session_id,
    CASE
      WHEN name IS NULL OR trim(name) IN ('', '.', '..')
        OR lower(trim(name)) IN ('src', '.claude', 'worktrees', 'claude-worktrees') THEN NULL
      WHEN instr(lower(name), '-wt-') > 1
        AND instr(substr(lower(name), instr(lower(name), '-wt-') + 4), '-wt-') = 0
        AND instr(lower(name), '-wt-') + 4 <= length(name)
      THEN substr(name, 1, instr(lower(name), '-wt-') - 1)
      WHEN instr(lower(name), '-wt-') > 0 THEN NULL
      ELSE trim(name)
    END AS name
  FROM cwd_candidate
)
UPDATE sessions
SET project_name = COALESCE(
  (SELECT name FROM repo_name WHERE repo_name.session_id = sessions.session_id),
  (SELECT name FROM cwd_name WHERE cwd_name.session_id = sessions.session_id)
);

CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_name);
