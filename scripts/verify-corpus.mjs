#!/usr/bin/env node
/**
 * Reconciliation checks for a locally seeded hub (wrangler dev). Plain node, no deps.
 *
 * Checks:
 *  (a) on-disk *.jsonl file count under the two stores vs files rows for the machine
 *  (b) 10 random sessions: fetch /api/v1/sessions/{id}, assert turns.length > 0 and meta.harness matches
 *  (c) 5 searches for phrases sampled from real block texts, assert the source session is among hits
 *  (d) prints a JSON summary
 *
 * Usage: node verify-corpus.mjs [--hub http://localhost:8787] [--machine amet-wsl] [--db <path-to-sqlite>]
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const HUB = opt('hub', 'http://localhost:8787');
const MACHINE = opt('machine', 'amet-wsl');
const HUB_DIR = opt('hub-dir', join(process.cwd(), 'hub'));

function findSqlite() {
  const explicit = opt('db', null);
  if (explicit) return explicit;
  const base = join(HUB_DIR, '.wrangler', 'state', 'v3', 'd1');
  const found = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.sqlite')) found.push(p);
    }
  };
  walk(base);
  if (found.length === 0) throw new Error(`no sqlite db found under ${base}`);
  // Prefer the largest (miniflare sometimes leaves stale empty ones around).
  found.sort((a, b) => statSync(b).size - statSync(a).size);
  return found[0];
}

const DB_PATH = findSqlite();

function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'sessions-index', '--local', '--json', '--command', sql],
    { cwd: HUB_DIR, maxBuffer: 1024 * 1024 * 256 },
  ).toString();
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

async function countOnDiskFiles() {
  const stores = [
    { name: 'claude-projects', dir: join(homedir(), '.claude', 'projects') },
    { name: 'codex-sessions', dir: join(homedir(), '.codex', 'sessions') },
  ];
  let total = 0;
  const perStore = {};
  for (const s of stores) {
    let n = 0;
    const walk = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && e.name.endsWith('.jsonl')) n++;
      }
    };
    walk(s.dir);
    perStore[s.name] = n;
    total += n;
  }
  return { total, perStore };
}

async function fetchJson(path) {
  const res = await fetch(`${HUB}${path}`, { headers: { 'x-dev-machine': MACHINE } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const summary = { checks: {} };

  // (a) file count reconciliation
  const onDisk = await countOnDiskFiles();
  const filesRows = d1(
    `SELECT store, COUNT(*) AS n FROM files WHERE machine_id = '${MACHINE}' AND relpath LIKE '%.jsonl' GROUP BY store`,
  );
  const dbPerStore = Object.fromEntries(filesRows.map((r) => [r.store, r.n]));
  const dbTotal = Object.values(dbPerStore).reduce((a, b) => a + b, 0);
  summary.checks.file_count_reconciliation = {
    on_disk: onDisk,
    in_db: { total: dbTotal, perStore: dbPerStore },
    pass: dbTotal === onDisk.total,
  };

  // (b) 10 random sessions
  const sessionRows = d1(
    `SELECT session_id, harness FROM sessions ORDER BY RANDOM() LIMIT 10`,
  );
  const sessionChecks = [];
  for (const row of sessionRows) {
    try {
      const body = await fetchJson(`/api/v1/sessions/${encodeURIComponent(row.session_id)}`);
      const turnsLen = body.session?.turns?.length ?? 0;
      const harnessMatch = body.meta?.harness === row.harness;
      sessionChecks.push({
        session_id: row.session_id,
        expected_harness: row.harness,
        got_harness: body.meta?.harness,
        turns: turnsLen,
        pass: turnsLen > 0 && harnessMatch,
      });
    } catch (e) {
      sessionChecks.push({ session_id: row.session_id, pass: false, error: String(e) });
    }
  }
  summary.checks.random_sessions = {
    sampled: sessionChecks.length,
    passed: sessionChecks.filter((c) => c.pass).length,
    pass: sessionChecks.every((c) => c.pass),
    details: sessionChecks,
  };

  // (c) 5 searches for phrases sampled from real block texts
  const blockRows = d1(
    `SELECT session_id, text FROM blocks WHERE text IS NOT NULL AND LENGTH(text) > 40 ORDER BY RANDOM() LIMIT 80`,
  );
  const searchChecks = [];
  let attempts = 0;
  for (const row of blockRows) {
    if (searchChecks.length >= 5) break;
    attempts++;
    const phrase = distinctivePhrase(row.text);
    if (!phrase) continue;
    try {
      const body = await fetchJson(`/api/v1/search?q=${encodeURIComponent(phrase)}&limit=100`);
      const found = (body.hits ?? []).some((h) => h.session_id === row.session_id);
      searchChecks.push({ session_id: row.session_id, phrase, hits: body.hits?.length ?? 0, pass: found });
    } catch (e) {
      searchChecks.push({ session_id: row.session_id, phrase, pass: false, error: String(e) });
    }
  }
  summary.checks.searches = {
    sampled: searchChecks.length,
    attempts,
    passed: searchChecks.filter((c) => c.pass).length,
    pass: searchChecks.length > 0 && searchChecks.every((c) => c.pass),
    details: searchChecks,
  };

  summary.overall_pass = Object.values(summary.checks).every((c) => c.pass);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.overall_pass) process.exitCode = 1;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'does', 'was', 'were', 'have', 'has',
  'had', 'you', 'your', 'are', 'not', 'but', 'all', 'can', 'will', 'then', 'than', 'when',
  'what', 'where', 'which', 'who', 'how', 'its', 'into', 'out', 'now', 'been', 'being', 'off',
  'read', 'run', 'get', 'set', 'use', 'used', 'using', 'let', 'via', 'per', 'each', 'any',
]);

/**
 * Pick a distinctive 3-word phrase from block text using only pure-alphabetic word runs
 * (bounded by whitespace, taken verbatim). A run of letters bounded by non-letter separators
 * is always a single token under the FTS5 unicode61 tokenizer regardless of how '_-.' tokenchars
 * get folded in around it, so this sidesteps the whole class of tokenization edge cases
 * (CLI flags like --jq, dotted paths/versions, trailing punctuation) that a naive punctuation
 * strip can't safely reproduce. Skip markup/code-heavy lines outright, and require the triple
 * to look distinctive (long/technical words, not three common English function words) — this
 * corpus is large enough that generic trigrams ("then read the") legitimately recur across
 * hundreds of sessions and get outranked out of even a 100-hit window by BM25.
 */
function distinctivePhrase(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 20 && l.length < 300 && !/^[{[<]/.test(l) && !l.startsWith('#') && !l.includes('`'));
  for (const line of lines) {
    const words = line.split(/\s+/);
    for (let i = 0; i + 2 < words.length; i++) {
      const triple = words.slice(i, i + 3);
      if (!triple.every((w) => /^[A-Za-z]{5,}$/.test(w) && !STOPWORDS.has(w.toLowerCase()))) continue;
      return triple.join(' ');
    }
  }
  return null;
}

await main();
