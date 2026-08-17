## Collector releases

- Any collector behavior change MUST bump `collector/src/agent_collector/__init__.py` and update `hub/src/collector-version.ts` in the same change. The package version is derived from `__version__`, the heartbeat reports it, and installed collectors use it to distinguish feature builds.

## Developer workflow

- Prerequisites: Node.js >=22.13, npm, and Chromium. In `hub/`, run `npm ci`; install Chromium with `npx playwright install chromium` on Windows or `npx playwright install --with-deps chromium` on Linux.
- Start the isolated loopback hub with `npm --prefix hub run dev:up`. Stop it with Ctrl+C; use `npm --prefix hub run dev:reset` only after it has stopped. Local development requires zero Wrangler scopes and no Cloudflare login.
- Before review, run `npm --prefix hub test`, `npm --prefix hub run typecheck`, and `npm --prefix hub run test:e2e`. The same commands and browser suite must pass on Windows and Linux.
- Open a PR preview with `npm --prefix hub run preview:open -- --pr <number>`; it opens `https://sessions.ppe.vza.net/pr?id=<number>`, where the shared PPE Worker requires the owner's passkey before deriving the per-PR bearer and redirecting to `https://pr-<number>.sessions-ppe.workers.dev`. Use `--print-only` for a non-interactive URL. Direct origins remain for CI and `preview-upload-session.mjs`.
- Production-session debugging is a hand-carried zip: the owner clicks "Export zip" on the session page of the production viewer (behind their passkey session) and hands the file over; the agent pushes it into a preview on its own with `node hub/scripts/preview-upload-session.mjs --pr <number> --zip <file>` (standard collector uploads, authenticated by the derived per-PR bearer). No prod→preview credential, encryption, or cross-account flow exists.
- Preview data is persistent across pushes but disposable. A PR that edits one of its own already-applied migrations triggers an automatic preview D1 reset on the next provision (uploaded sessions vanish — re-upload is one command). Manual reset: dispatch the `Preview Close` workflow against the open PR, then re-run CI.
- The preview is built, migrated, deployed, and smoked by the `preview` job in `.github/workflows/ci.yml` on `pull_request`. Its `environment: preview/pr-<number>` is the deployment record GitHub shows on the PR, opened and closed by that job's own conclusion — do not hand-write deployment statuses. Repository credentials come from `node infra/cf/preview-token.mjs --set`.

## Cloudflare least privilege

- Two identity/account pairs exist, and every Cloudflare operation belongs to exactly one
  (full table + rules: `infra/cf/deploy.md`, "Identities and accounts"):
  `pedro@vza.net` → production `18ef3246…` (owner-at-keyboard and protected `main`-only CI
  ONLY — agents never authenticate there; also hosts the shared PPE redirect Worker and its
  dedicated isolated D1), and `pedro@vezza.com.br` → non-production `cbb04a26…` (per-PR
  previews; the only account an agent may ever log into, and only under the conditions below).
- Preview browser access and session uploads do not use Wrangler — PPE passkey redirects and
  direct preview uploads use the derived per-PR bearer. Remote control-plane login is not part
  of the development or test flow.
- Only when exceptional preview administration is explicitly authorized, use the
  non-production-only identity and the exact OAuth scopes `account:read user:read workers:write
  workers_kv:write workers_scripts:write d1:write queues:write`. Run `npx wrangler login
  --use-keyring --scopes account:read user:read workers:write workers_kv:write workers_scripts:write
  d1:write queues:write`; never run an unscoped login. OS keyring storage (Windows Credential
  Manager or Linux libsecret) is required, and the selected identity/account must have no
  production membership or resources.
- A PR's `preview` CI job holds the non-production API token (`CLOUDFLARE_PPE_API_TOKEN`) and
  the bearer seed, and deploys only that PR's resources from that PR's own checkout. The shared
  PPE Worker is deployed separately by protected main-only CI with production-account
  credentials; its D1 and secrets are never available to a PR.
