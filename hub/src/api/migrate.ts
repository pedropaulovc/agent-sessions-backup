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
 * `assertPreviewDatabase` below narrows that: the endpoint asks the database it is actually bound
 * to whether it is the preview one, and refuses before any write if the answer isn't yes.
 *
 * Be precise about what that does and does not buy. This check is itself PR-controlled code, so a
 * hostile PR can simply delete it — it is NOT a defence against a malicious author, and nothing
 * inside this Worker can be, because Workers Builds builds the Worker from the PR. What it does
 * defend against is ACCIDENT: a mistyped or copy-pasted database id, a bad merge, a stale config
 * repointing the preview at production. That is the realistic failure here and it is worth
 * closing, but it is a different claim.
 *
 * The malicious-author case is bounded by the repository, not by this code: the job only runs for
 * same-repo PRs, so it requires push access, and this repo's `main` is unprotected — that access
 * already permits a direct push to `main`, which runs CI's `deploy` job with the full-account
 * CLOUDFLARE_API_TOKEN. This endpoint therefore grants strictly less than the attacker already
 * has. Closing it properly (rather than relying on that) means hosting preview D1 in a separate
 * Cloudflare account, where no credential or binding reachable from a build can name production.
 *
 * CI authenticates with a short-lived GitHub OIDC assertion.
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

/** SQLite's quoting forms. A semicolon or a `--` inside ANY of these is data, not syntax:
 * `CREATE TABLE "audit;log" (id INT);` is valid SQL that wrangler applies fine, and a scanner that
 * tracks only `'…'` splits it into two invalid fragments. `''` and `""` are escaped quotes rather
 * than a close followed by an open; `[…]` has no escape form in SQLite. */
const QUOTE_CLOSERS: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };

/** Walk `sql`, calling `emit` for each character that is real syntax, with `quoted` telling it
 * whether the character sits inside a quoted literal or identifier. Comments are dropped.
 *
 * One scanner so the splitter and the guard can never disagree about where a statement ends —
 * they previously shared a naive `--` strip, which meant the guard could not detect the very
 * corruption the splitter was producing. */
function scanSql(sql: string, emit: (ch: string, quoted: boolean) => void): { unterminated: boolean } {
  let open: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (open) {
      emit(c, true);
      const closer = QUOTE_CLOSERS[open]!;
      // A doubled closer is an escaped one -- but only for the quote forms that HAVE an escape.
      if (c === closer && closer !== ']' && sql[i + 1] === closer) {
        emit(closer, true);
        i++;
        continue;
      }
      if (c === closer) open = null;
      continue;
    }
    if (QUOTE_CLOSERS[c]) {
      open = c;
      emit(c, true);
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      emit('\n', false);
      continue;
    }
    // `/* rationale; details */` is valid SQLite that wrangler applies; leaving it intact would
    // make its semicolon a statement boundary. Unterminated is left as text so assertSplittable
    // sees the original rather than a silently truncated version.
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) {
        emit(c, false);
        continue;
      }
      i = close + 1;
      emit(' ', false);
      continue;
    }
    emit(c, false);
  }
  // A quote still open at EOF means the scanner's idea of where statements end is not the
  // database's, so nothing derived from this scan can be trusted.
  return { unterminated: open !== null };
}

/** Split a migration file into statements on `;`, ignoring semicolons inside quoted literals,
 * quoted identifiers and comments. `assertSplittable` still refuses trigger bodies, whose inner
 * semicolons are real statement terminators that must NOT split — being torn in half is the worst
 * outcome a migration has, so that case fails loudly rather than cleverly.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  scanSql(sql, (ch, quoted) => {
    if (ch === ';' && !quoted) {
      out.push(cur);
      cur = '';
      return;
    }
    cur += ch;
  });
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

export function assertSplittable(name: string, sql: string): string | null {
  // Built from UNQUOTED characters only. `INSERT INTO messages VALUES ('BEGIN')` is valid SQL that
  // wrangler applies fine, and matching this guard against text that still contained quoted
  // content rejected it permanently -- a 422 that never resolves, blocking every other pending
  // migration in the same request. Quoted runs collapse to a space so neighbouring tokens cannot
  // fuse into a false match (`a'x'BEGIN` must not read as one word).
  let unquoted = '';
  const { unterminated } = scanSql(sql, (ch, quoted) => {
    unquoted += quoted ? ' ' : ch;
  });
  if (unterminated) return `${name}: unterminated quote or identifier — refusing to guess where statements end`;
  if (/\bBEGIN\b/i.test(unquoted) || /\bCREATE\s+TRIGGER\b/i.test(unquoted)) {
    return `${name}: contains a trigger or BEGIN block, which this endpoint's statement splitter cannot handle safely`;
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
    // A transient JWKS failure says nothing about the token. Surfacing it as a flat 401 made CI --
    // which now treats every handler error as fatal -- fail a perfectly valid run red instead of
    // using its retry window. 503 + retryable is the signal it keys off.
    if (verified.retryable) {
      return Response.json({ error: 'oidc_unavailable', reason: verified.reason, retryable: true }, { status: 503 });
    }
    return Response.json({ error: 'oidc_rejected', reason: verified.reason }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { migrations?: MigrationInput[] } | null;
  const migrations = body?.migrations;
  if (!Array.isArray(migrations) || migrations.some((m) => typeof m?.name !== 'string' || typeof m?.sql !== 'string')) {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  // Only now touch D1. This route has no mTLS and its workers.dev preview alias is publicly
  // reachable, so doing the marker query first let any unauthenticated POST force a query against
  // the shared preview database -- a trivial flood could burn its quota and degrade every branch
  // preview. Authentication first, marker check immediately before any write: the check still runs
  // on every path that writes, which is all it was ever protecting.
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
    //
    // The insert goes FIRST, and `name` is UNIQUE, which makes it an atomic claim. Every branch
    // shares one preview database and the workflow has no concurrency group, so two overlapping
    // runs can both read the `already` snapshot above before either writes; without the claim the
    // loser replays the DDL and returns migration_failed, turning a successful migration into a
    // red check. Claiming inside the transaction means the loser's whole batch rolls back having
    // applied nothing.
    // A D1 rejection here (an ALTER against a missing table, say) is DETERMINISTIC — it will fail
    // identically on every retry. Letting it escape produces Cloudflare's platform-generated 500,
    // which carries no JSON body, and CI classifies bodiless responses as "the preview is not up
    // yet" and retries then passes. Returning the error envelope is what makes CI fail loudly.
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO d1_migrations (name) VALUES (?1)').bind(m.name),
        ...statements.map((s) => env.DB.prepare(s)),
      ]);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Distinguish "a concurrent run won the claim" from a genuine SQL error by re-reading the
      // bookkeeping table. If the migration is recorded now, someone else applied it while we were
      // working and the correct answer is `skipped`, not a red check.
      const claimed = await env.DB.prepare('SELECT name FROM d1_migrations WHERE name = ?1')
        .bind(m.name)
        .first()
        .catch(() => null);
      if (claimed) {
        console.log(JSON.stringify({ event: 'hub.migrate.raced', migration: m.name }));
        skipped.push(m.name);
        continue;
      }
      console.log(JSON.stringify({ event: 'hub.migrate.failed', migration: m.name, detail, applied }));
      return Response.json({ error: 'migration_failed', migration: m.name, detail, applied }, { status: 500 });
    }
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
