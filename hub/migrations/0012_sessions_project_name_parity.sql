-- Migration 0011 was applied to the preview database before the stricter runtime/backfill parity
-- cases landed. Recompute every derived value so preview and production converge: production applies
-- 0011 then this correction, while preview applies only this correction to its already-backfilled rows.
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
           AND (lower(repo) LIKE 'file://%' OR instr(substr(repo, instr(repo, '://') + 3), '/') > 1)
          THEN substr(
            substr(repo, instr(repo, '://') + 3),
            instr(substr(repo, instr(repo, '://') + 3), '/') + 1
          )
          ELSE NULL
        END
      WHEN instr(repo, '@') > 1
       AND instr(repo, ':') > instr(repo, '@') + 1
       AND instr(repo, ':') < length(repo)
       AND instr(substr(repo, instr(repo, '@') + 1, instr(repo, ':') - instr(repo, '@') - 1), '@') = 0
       AND instr(substr(repo, 1, instr(repo, ':') - 1), '/') = 0
       AND instr(substr(repo, 1, instr(repo, ':') - 1), ' ') = 0
       AND instr(substr(repo, 1, instr(repo, ':') - 1), char(9)) = 0
       AND instr(substr(repo, 1, instr(repo, ':') - 1), char(10)) = 0
       AND instr(substr(repo, 1, instr(repo, ':') - 1), char(11)) = 0
       AND instr(substr(repo, 1, instr(repo, ':') - 1), char(12)) = 0
       AND instr(substr(repo, 1, instr(repo, ':') - 1), char(13)) = 0
      THEN substr(repo, instr(repo, ':') + 1)
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
      WHEN part IS NULL OR lower(trim(part)) IN ('', '.', '..', '.git') OR instr(part, char(92)) > 0 THEN NULL
      WHEN lower(trim(part)) LIKE '%.git' THEN substr(trim(part), 1, length(trim(part)) - 4)
      ELSE trim(part)
    END AS name
  FROM repo_parts
  WHERE rest = '' AND depth > 0
),
cwd_shape AS (
  SELECT
    session_id,
    cwd,
    '/' || ltrim(cwd, '/') AS rooted,
    instr(lower(cwd), '-src-') AS encoded_src,
    instr(lower(cwd), '--claude-worktrees-') AS encoded_worktree
  FROM repo_clean
),
cwd_candidate AS (
  SELECT
    session_id,
    CASE
      WHEN instr(cwd, '//') = 0
       AND encoded_src > 0
       AND encoded_worktree > encoded_src + 5
       AND instr(substr(lower(cwd), encoded_src + 5), '-src-') = 0
       AND instr(substr(lower(cwd), encoded_worktree + 19), '--claude-worktrees-') = 0
       AND length(cwd) >= encoded_worktree + 19
       AND substr(cwd, encoded_worktree + 19, 1) <> '/'
      THEN substr(
        cwd,
        encoded_src + 5,
        encoded_worktree - encoded_src - 5
      )
      WHEN encoded_src > 0 AND encoded_worktree > encoded_src THEN NULL
      WHEN instr(cwd, '//') = 0
       AND instr(rooted, '/./') = 0
       AND instr(rooted, '/../') = 0
       AND substr(rooted, -2) <> '/.'
       AND substr(rooted, -3) <> '/..'
       AND instr(lower(rooted), '/src/') > 0 THEN
        CASE
          WHEN instr(substr(rooted, instr(lower(rooted), '/src/') + 5), '/') > 0
          THEN substr(
            substr(rooted, instr(lower(rooted), '/src/') + 5),
            1,
            instr(substr(rooted, instr(lower(rooted), '/src/') + 5), '/') - 1
          )
          ELSE substr(rooted, instr(lower(rooted), '/src/') + 5)
        END
      ELSE NULL
    END AS name
  FROM cwd_shape
),
cwd_name AS (
  SELECT
    session_id,
    CASE
      WHEN name IS NULL OR trim(name) IN ('', '.', '..') OR instr(trim(name), '/') > 0
        OR lower(trim(name)) IN ('src', '.claude', 'worktrees', 'claude-worktrees') THEN NULL
      WHEN lower(trim(name)) = '.worktrees' THEN NULL
      WHEN instr(lower(trim(name)), '-wt-') > 1
        AND instr(substr(lower(trim(name)), instr(lower(trim(name)), '-wt-') + 4), '-wt-') = 0
        AND instr(lower(trim(name)), '-wt-') + 4 <= length(trim(name))
      THEN substr(trim(name), 1, instr(lower(trim(name)), '-wt-') - 1)
      WHEN instr(lower(trim(name)), '-wt-') > 0 THEN NULL
      ELSE trim(name)
    END AS name
  FROM cwd_candidate
)
UPDATE sessions
SET project_name = COALESCE(
  (SELECT name FROM repo_name WHERE repo_name.session_id = sessions.session_id),
  (SELECT name FROM cwd_name WHERE cwd_name.session_id = sessions.session_id)
);
