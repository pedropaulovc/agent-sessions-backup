## Collector releases

- Any collector behavior change MUST bump `collector/src/agent_collector/__init__.py` and update `hub/src/collector-version.ts` in the same change. The package version is derived from `__version__`, the heartbeat reports it, and installed collectors use it to distinguish feature builds.

## Developer workflow

- Prerequisites: Node.js >=22.13, npm, and Chromium. In `hub/`, run `npm ci`; install Chromium with `npx playwright install chromium` on Windows or `npx playwright install --with-deps chromium` on Linux.
- Start the isolated loopback hub with `npm --prefix hub run dev:up`. Stop it with Ctrl+C; use `npm --prefix hub run dev:reset` only after it has stopped. Local development requires zero Wrangler scopes and no Cloudflare login.
- Before review, run `npm --prefix hub test`, `npm --prefix hub run typecheck`, and `npm --prefix hub run test:e2e`. The same commands and browser suite must pass on Windows and Linux.
- Open PR `<number>` with `npm --prefix hub run preview:open -- --pr <number>`. It opens `https://pr-<number>-preview.sessions.vza.net`; Cloudflare Access performs browser authentication. Do not use SQL, copy a bearer, or put credentials in a URL. Use `--print-only` only when a non-interactive job needs the URL without launching a browser.
- Production-session debugging uses only the signed `sessions-dev-bridge` installed outside the checkout. From WSL, the agent runs `powershell.exe -NoLogo -NoProfile -Command 'Set-Location $env:USERPROFILE; & cmd.exe /d /s /c "sessions-dev-bridge.cmd pull --session <id> --target pr-<number> 2>&1"; exit $LASTEXITCODE'`; the native working directory and stderr merge prevent harmless UNC and `NativeCommandError` noise. The user only completes the browser approvals and fresh passkey touch. Installation is a one-time trusted Windows bootstrap, not a PR-checkout command. See `docs/dev-preview-redesign.md` under “Install and invoke the bridge from WSL” for setup, the five-page approval sequence, and the fields to verify. A repository script is never the authorization client.

## Cloudflare least privilege

- Preview browser access and the production-session bridge do not use Wrangler. Remote control-plane login is not part of the development or test flow.
- Only when exceptional preview administration is explicitly authorized, use the non-production-only identity and the exact OAuth scopes `account:read user:read workers:write workers_kv:write workers_scripts:write d1:write queues:write`. Run `npx wrangler login --use-keyring --scopes account:read user:read workers:write workers_kv:write workers_scripts:write d1:write queues:write`; never run an unscoped login. OS keyring storage (Windows Credential Manager or Linux libsecret) is required, and the selected identity/account must have no production membership or resources.
- PR code and untrusted PR CI never receive Cloudflare credentials. The protected trusted smoke job receives a preview-host-only Access service token in addition to one-use route grants; candidate code receives neither. Preview administration belongs to protected default-branch control workflows; production deployment remains protected and `main`-only.
