## Collector releases

- Any collector behavior change MUST bump `collector/src/agent_collector/__init__.py` and update `hub/src/collector-version.ts` in the same change. The package version is derived from `__version__`, the heartbeat reports it, and installed collectors use it to distinguish feature builds.

## Developer workflow

- Prerequisites: Node.js >=22.13, npm, and Chromium. In `hub/`, run `npm ci`; install Chromium with `npx playwright install chromium` on Windows or `npx playwright install --with-deps chromium` on Linux.
- Start the isolated loopback hub with `npm --prefix hub run dev:up`. Stop it with Ctrl+C; use `npm --prefix hub run dev:reset` only after it has stopped. Local development requires zero Wrangler scopes and no Cloudflare login.
- Before review, run `npm --prefix hub test`, `npm --prefix hub run typecheck`, and `npm --prefix hub run test:e2e`. The same commands and browser suite must pass on Windows and Linux.
- Open PR `<number>` with `npm --prefix hub run preview:open -- --pr <number>`. It opens `https://pr-<number>-preview.sessions.vza.net`; Cloudflare Access performs browser authentication. Do not use SQL, copy a bearer, or put credentials in a URL. Use `--print-only` only when a non-interactive job needs the URL without launching a browser.
- Production-session debugging uses only the signed `sessions-dev-bridge` installed natively in WSL and outside the checkout. The agent runs `sessions-dev-bridge pull --session <id> --target pr-<number>` and remains attached; the user only completes browser approvals and the fresh passkey touch. Bootstrap only from trusted `main` using `docs/dev-preview-redesign.md` under “Install and invoke the bridge from WSL”; never run a PR-checkout installer or use Windows-interoperability executables. The installer is not an authorization client.

## Cloudflare least privilege

- Two identity/account pairs exist, and every Cloudflare operation belongs to exactly one
  (full table + rules: `infra/cf/deploy.md`, "Identities and accounts"):
  `pedro@vza.net` → production `18ef3246…` (owner-at-keyboard and protected `main`-only CI
  ONLY — agents never authenticate there), and `pedro@vezza.com.br` → non-production
  `cbb04a26…` (per-PR previews; the only account an agent may ever log into, and only under
  the conditions below).
- Preview browser access and the production-session bridge do not use Wrangler. Remote control-plane login is not part of the development or test flow.
- Only when exceptional preview administration is explicitly authorized, use the non-production-only identity and the exact OAuth scopes `account:read user:read workers:write workers_kv:write workers_scripts:write d1:write queues:write`. Run `npx wrangler login --use-keyring --scopes account:read user:read workers:write workers_kv:write workers_scripts:write d1:write queues:write`; never run an unscoped login. OS keyring storage (Windows Credential Manager or Linux libsecret) is required, and the selected identity/account must have no production membership or resources.
- PR code and untrusted PR CI never receive Cloudflare credentials. The protected trusted smoke job receives a preview-host-only Access service token in addition to one-use route grants; candidate code receives neither. Preview administration belongs to protected default-branch control workflows; production deployment remains protected and `main`-only.
