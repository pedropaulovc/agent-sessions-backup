import { verifyGitHubOidc } from '../auth/github-oidc';

/** POST /api/v1/admin/migrate — apply pending D1 migrations to the PREVIEW database.
 *
 * This exists so CI never holds a Cloudflare credential. Cloudflare's D1 API-token permissions
 * are account-scoped (no per-database resource, unlike R2's per-bucket one) and Cloudflare has no
 * workload-identity federation, so any token given to a PR-triggered job can reach production D1.
 * A Worker binding is the one thing in D1's model that genuinely bounds this — a Worker reaches
 * exactly the databases bound to it. But the binding is declared in hub/wrangler.jsonc, and
 * Workers Builds builds branch previews from the PR's OWN checkout, so a PR can repoint
 * env.preview at the production database id (it is committed in that same file) and this endpoint
 * would then apply PR-authored SQL to production. The binding alone is therefore NOT the control.
 *
 * What closes it is `assertPreviewDatabase` below: the endpoint asks the database it is actually
 * bound to whether it is the preview one, and refuses before any write if the answer isn't yes.
 * Production has no such marker and a PR has no credential to add one, so a repointed binding
 * gets a 409 rather than a migration. CI authenticates with a short-lived GitHub OIDC assertion.
 *
 * The caller supplies the migration SQL because `wrangler d1 migrations apply` is a wrangler-side
 * operation. That is deliberate rather than reluctant: the preview Worker is itself built from PR
 * code, so bundling the migrations would be no less PR-controlled. The binding is what bounds the
 * blast radius, not the provenance of the SQL.
 */

/** Audience CI must mint its OIDC token for. A repository can mint a token with any `aud`, so
 * this is not a secret — it is what stops a token minted for some OTHER service in the same repo
 * from being replayed here. */
export const MIGRATE_OIDC_AUDIENCE = 'sessions-hub-preview-migrate';

/** A row only the real preview database carries. Seeded out of band, once, by whoever holds the
 * production credential (see infra/cf/deploy.md) — deliberately NOT created by this endpoint or by
 * a migration, because anything a PR can cause to run could then mint the marker on the database
 * it just repointed itself at. Its whole value is being unforgeable by the untrusted side. */
export const PREVIEW_MARKER_TABLE = 'preview_environment_marker';
export const PREVIEW_MARKER_VALUE = 'sessions-index-preview';

/** Ask the bound database to prove it is the preview one. Fails CLOSED: a missing table, a missing
 * row, a wrong value, or any error at all means "not proven", which means no writes. An unseeded
 * preview database is a broken preview; a migration applied to production is a restore from
 * backup. */
async function assertPreviewDatabase(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT value FROM ${PREVIEW_MARKER_TABLE} LIMIT 1`)
    .first<{ value: string }>()
    .catch(() => null);
  return row?.value === PREVIEW_MARKER_VALUE;
}

/** Mirrors the table wrangler itself creates, so `wrangler d1 migrations apply` and this endpoint
 * agree on what has already run and neither re-applies the other's work. */
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

interface MigrationInput {
  name: string;
  sql: string;
}

/** Strip `--` line comments, skipping any that are inside a quoted literal.
 *
 * The quote-awareness is not hypothetical tidiness: migrations 0011 and 0012 both contain
 * `instr(lower(cwd), '--claude-worktrees-')`. A naive /--.*$/ strip truncates that line at the
 * literal's own leading dashes, producing `instr(lower(cwd), ` — an unbalanced quote and a torn
 * statement, applied to a real database.
 */
function stripComments(sql: string): string {
  let out = '';
  let inLiteral = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (inLiteral) {
      out += c;
      // '' is SQL's escaped quote, not a close immediately followed by an open.
      if (c === "'" && sql[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      if (c === "'") inLiteral = false;
      continue;
    }
    if (c === "'") {
      inLiteral = true;
      out += c;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

/** Split a migration file into statements on `;`, ignoring semicolons inside quoted literals and
 * comments. `assertSplittable` still refuses trigger bodies, whose inner semicolons are real
 * statement terminators that must NOT split — being torn in half is the worst outcome a migration
 * has, so that case fails loudly rather than cleverly.
 */
export function splitStatements(sql: string): string[] {
  const stripped = stripComments(sql);
  const out: string[] = [];
  let cur = '';
  let inLiteral = false;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i]!;
    if (inLiteral) {
      cur += c;
      if (c === "'" && stripped[i + 1] === "'") {
        cur += "'";
        i++;
        continue;
      }
      if (c === "'") inLiteral = false;
      continue;
    }
    if (c === "'") {
      inLiteral = true;
      cur += c;
      continue;
    }
    if (c === ';') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

export function assertSplittable(name: string, sql: string): string | null {
  const stripped = stripComments(sql);
  if (/\bBEGIN\b/i.test(stripped) || /\bCREATE\s+TRIGGER\b/i.test(stripped)) {
    return `${name}: contains a trigger or BEGIN block, which this endpoint's statement splitter cannot handle safely`;
  }
  // An unterminated literal means the scanner's idea of where statements end is not the database's.
  const quotes = (stripped.match(/'/g) ?? []).length;
  if (quotes % 2 !== 0) return `${name}: unbalanced quote — refusing to guess where statements end`;
  return null;
}

export async function migratePreview(request: Request, env: Env): Promise<Response> {
  // Preview only, and 404 rather than 403: on production this route does not exist. The check is
  // first so an unauthenticated prod request cannot even learn the endpoint is there.
  if (env.ENVIRONMENT !== 'preview') return Response.json({ error: 'not_found' }, { status: 404 });

  // Before authentication even: this says nothing about the caller, only about which database
  // this Worker was built to talk to, and a legitimate caller needs to see it as loudly as a
  // hostile one does.
  if (!(await assertPreviewDatabase(env))) {
    console.log(JSON.stringify({ event: 'hub.migrate.rejected', reason: 'not_preview_database' }));
    return Response.json(
      {
        error: 'not_preview_database',
        detail: `the bound DB has no ${PREVIEW_MARKER_TABLE} row for '${PREVIEW_MARKER_VALUE}' — refusing to migrate a database that cannot prove it is the preview one`,
      },
      { status: 409 },
    );
  }

  const repo = env.MIGRATE_OIDC_REPOSITORY;
  if (!repo) return Response.json({ error: 'migrate_not_configured' }, { status: 503 });

  const auth = request.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return Response.json({ error: 'missing_oidc_token' }, { status: 401 });

  const verified = await verifyGitHubOidc(token, {
    expectedAudience: MIGRATE_OIDC_AUDIENCE,
    expectedRepository: repo,
  });
  if (!verified.ok) {
    console.log(JSON.stringify({ event: 'hub.migrate.rejected', reason: verified.reason }));
    return Response.json({ error: 'oidc_rejected', reason: verified.reason }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { migrations?: MigrationInput[] } | null;
  const migrations = body?.migrations;
  if (!Array.isArray(migrations) || migrations.some((m) => typeof m?.name !== 'string' || typeof m?.sql !== 'string')) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  // Validate the whole set BEFORE applying any of it — a batch that fails halfway leaves the
  // database in a state no migration file describes.
  for (const m of migrations) {
    const problem = assertSplittable(m.name, m.sql);
    if (problem) return Response.json({ error: 'unsupported_migration', detail: problem }, { status: 422 });
  }

  await env.DB.prepare(MIGRATIONS_TABLE).run();
  const appliedRows = await env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
  const already = new Set((appliedRows.results ?? []).map((r) => r.name));

  const applied: string[] = [];
  const skipped: string[] = [];
  // Sort by name: migrations are numbered (0001_, 0002_, …) and applying them out of order is a
  // different database than applying them in order.
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (already.has(m.name)) {
      skipped.push(m.name);
      continue;
    }
    const statements = splitStatements(m.sql);
    if (!statements.length) {
      skipped.push(m.name);
      continue;
    }
    // One batch per migration: D1 runs a batch in an implicit transaction, so a migration either
    // lands whole or not at all. The bookkeeping insert rides in the SAME batch — recording it
    // separately would let a crash between the two leave a migration applied but unrecorded, and
    // the next run would replay it.
    await env.DB.batch([
      ...statements.map((s) => env.DB.prepare(s)),
      env.DB.prepare('INSERT INTO d1_migrations (name) VALUES (?1)').bind(m.name),
    ]);
    applied.push(m.name);
  }

  console.log(
    JSON.stringify({
      event: 'hub.migrate.applied',
      actor: verified.claims.sub,
      repository: verified.claims.repository,
      ref: verified.claims.ref,
      applied,
      skipped,
    }),
  );
  return Response.json({ applied, skipped });
}
