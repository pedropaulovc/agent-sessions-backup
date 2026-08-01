import { verifyGitHubOidc } from '../auth/github-oidc';

/** POST /api/v1/admin/migrate — apply pending D1 migrations to the PREVIEW database.
 *
 * This exists so CI never holds a Cloudflare credential. Cloudflare's D1 API-token permissions
 * are account-scoped (no per-database resource, unlike R2's per-bucket one) and Cloudflare has no
 * workload-identity federation, so any token given to a PR-triggered job can reach production D1.
 * A Worker binding is the one thing in D1's model that genuinely cannot: this Worker's `DB` is
 * `sessions-index-preview` and it has no production binding, so even a fully hostile caller
 * reaches exactly one database. CI authenticates with a short-lived GitHub OIDC assertion.
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

/** Split a migration file into statements.
 *
 * Deliberately simple, and guarded rather than clever: every migration in this repo is plain DDL
 * with no trigger bodies and no semicolons inside string literals, so splitting on `;` is exact.
 * `assertSplittable` refuses anything that breaks that assumption, so a future migration with a
 * `CREATE TRIGGER ... BEGIN ... END;` fails loudly here instead of being silently torn in half and
 * half-applied — which on a migration is the worst possible outcome.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function assertSplittable(name: string, sql: string): string | null {
  const stripped = sql.replace(/--.*$/gm, '');
  if (/\bBEGIN\b/i.test(stripped) || /\bCREATE\s+TRIGGER\b/i.test(stripped)) {
    return `${name}: contains a trigger or BEGIN block, which this endpoint's statement splitter cannot handle safely`;
  }
  // A semicolon inside a quoted literal would split mid-statement.
  for (const literal of stripped.match(/'(?:[^']|'')*'/g) ?? []) {
    if (literal.includes(';')) return `${name}: a quoted literal contains ';', which the splitter would break on`;
  }
  return null;
}

export async function migratePreview(request: Request, env: Env): Promise<Response> {
  // Preview only, and 404 rather than 403: on production this route does not exist. The check is
  // first so an unauthenticated prod request cannot even learn the endpoint is there.
  if (env.ENVIRONMENT !== 'preview') return Response.json({ error: 'not_found' }, { status: 404 });

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
