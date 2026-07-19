# API Shield mTLS for `api.sessions.vza.net` (spike S4)

The machine API is authenticated by TPM/software-bound mTLS client certificates
signed by Cloudflare's per-zone **managed CA**. The edge verifies the client cert,
a zone WAF rule blocks anything unverified, and the Worker maps
`request.cf.tlsClientAuth.certFingerprintSHA256` to a `machines` row (defense in
depth). This file is the runbook for standing that up on the `vza.net` zone.

## S4 findings (what M3 verified)

- **The worker and all data-plane resources are deployed and fail-closed.** With no
  client cert, `GET /api/v1/search`, `PUT /api/v1/files/...`, and even a forged
  `x-dev-machine` header all return `401` in production (verified). `ENVIRONMENT=production`
  disables the dev-header and `DEV_AUTH` bypasses entirely (`src/auth/identity.ts`).
- **The wrangler OAuth login cannot configure mTLS.** Its token is accepted for
  Workers/D1/R2/KV/Queues and read-only zone metadata, but the zone SSL surface
  (`/client_certificates`, `/ssl/certificate_packs`, `/dns_records`) rejects it with
  auth error `10000`. So the three steps below need a **zone-scoped API token** (or the
  dashboard). This matches the plan's design: enrollment pastes a just-in-time token.
- **DNS/routing did not need a zone token.** Both hostnames are Workers **Custom
  Domains** (`custom_domain: true` in `wrangler.jsonc`), which Cloudflare provisions
  (proxied record + edge cert) through the Workers API. `api.sessions.vza.net` needed a
  dedicated edge cert because Universal SSL's `*.vza.net` does not cover a 3-label host;
  it provisioned automatically within a few minutes.

## Mint the enrollment token (dashboard, ~1 min)

Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token:

| Permission | Scope |
|---|---|
| Zone · **SSL and Certificates** · Edit | Zone: `vza.net` — mint and revoke client certificates |
| Account · **D1** · Edit | Account: `Pedro@vezza.com.br` — register and verify the machine row |

Set TTL to about one hour. `enroll-cert.py` uses this token directly with the
Cloudflare REST API; it does not need Wrangler login or a second credential. If you
configure the one-time hostname association through the API instead of the dashboard,
use a separate deployment token with **API Gateway · Edit** for that operation.

## Step 1 — enable the mTLS hostname association (one-time)

Associate the managed CA with `api.sessions.vza.net` so the edge requests a client
cert during the TLS handshake (without this, `cf.tlsClientAuth` is never populated).

Dashboard path: **SSL/TLS → Client Certificates → Hosts** → add `api.sessions.vza.net`
(and toggle "mTLS" for that hostname). The dashboard only adds the host, so it is the
safe option.

The API endpoint is **Replace** Hostname Associations, not append — a bare PUT with just
this host silently drops mTLS from any sibling host already associated on the zone. So
read the current list first and PUT the **union**:

```
# 1. read existing associations
GET /zones/{zone}/certificate_authorities/hostname_associations
# 2. PUT the existing hostnames PLUS api.sessions.vza.net (union of the two)
PUT /zones/{zone}/certificate_authorities/hostname_associations
  { "hostnames": ["<each existing host>", "api.sessions.vza.net"] }
```

Do **not** associate `sessions.vza.net` — the viewer uses passkeys, never client certs.

## Step 2 — add the WAF rule blocking unverified certs (one-time)

Dashboard: **Security → WAF → Custom rules → Create rule**, scoped to the api host:

```
Field:  (http.host eq "api.sessions.vza.net" and (not cf.tls_client_auth.cert_verified or cf.tls_client_auth.cert_revoked))
Action: Block
```

The `cert_revoked` predicate matters: Cloudflare keeps `cert_verified` **true** for a
revoked-but-otherwise-valid cert and reports revocation only via the separate
`cert_revoked` field, so a rule checking `cert_verified` alone would still admit a
revoked machine cert. This is belt-and-suspenders — the Worker also rejects unmapped,
absent, and revoked certs (`src/auth/identity.ts`) — but it drops that traffic at the
edge before it reaches the Worker.

## Step 3 — enroll each machine (repeatable)

From native PowerShell, set the short-lived token and run one command:

```powershell
$env:CF_API_TOKEN = '<token from above>'
uv run infra/cf/enroll-cert.py
Remove-Item Env:CF_API_TOKEN
```

The Python script handles the complete local flow: it preflights both token permissions,
installs the sibling collector with `uv tool install` only when it is missing, derives the
collector's exact machine id, generates the P-256 key and CSR, mints and validates the
certificate, performs a guarded fresh-only D1 registration, and independently verifies
the complete stored tuple. It then configures the collector, runs `doctor` with an
authenticated `/api/v1/status` probe, performs one live collector pass, and installs the
15-minute schedule.

Use `--admin` when this machine needs hub admin endpoints, `--machine-id <id>` only to
override the collector-derived id, `--out <directory>` to move the working material, or
`--no-schedule` to stop after the verified one-shot upload. On POSIX, use the same command
with an environment assignment:

```bash
CF_API_TOKEN='<token from above>' uv run infra/cf/enroll-cert.py
```

The token is sent only in Cloudflare HTTPS headers. It is never placed in argv, written to
disk, logged, or inherited by `uv` or collector subprocesses.

## Windows / Schannel mTLS

The Windows collector runs against the host's `curl.exe`, which is **Schannel-backed, not
OpenSSL**. Schannel refuses file-based client certs — the `--cert file.pem --key file.key`
and `--cert file.p12` forms both fail. Verified against the real hub on amet:

| curl client-cert form | result |
| --- | --- |
| `--cert cert.pem --key key.pem` | fails — Schannel won't load a file-based key |
| `--cert client.p12 --type P12` | `SEC_E_INTERNAL_ERROR` (0x80090304, "Local Security Authority cannot be contacted") |
| `--cert "CurrentUser\MY\<thumbprint>"` (no `--key`) | **200** — the only form that works |

So on Windows the cert must live in the `Cert:\CurrentUser\My` store and be referenced by
**thumbprint**; the collector emits `--cert "CurrentUser\MY\<thumbprint>"` with no `--key`.
This is also the future TPM/PCP path (S2): a PCP-backed key surfaces as the same
`CurrentUser\My` entry with a non-exportable private key, so only enrollment differs.

`enroll-cert.py` detects native Windows and does the extra work automatically. It creates
a randomly password-protected PFX in memory/on the local working directory, passes the
password to the collector only through a scrubbed child environment, imports the key as
non-exportable into `Cert:\CurrentUser\My`, and confirms that the collector deleted the
PFX. The exportable PEM key is kept through `doctor`'s authenticated hub check and the live
collector pass, then deleted only after both succeed. If import, the authenticated check, or
the pass fails, the key is retained and scheduling does not occur.

## Notes

- Real-TPM machines (Windows host, amet) replace the software keygen with the
  TPM flows (S2/S3); the CSR → managed-CA → fingerprint → `machines` row steps are
  identical, only `key_protection` becomes `tpm`.
- Cert renewal (`POST /api/v1/certs/renew`) is implemented — see "Cert renewal endpoint" below.
- Per-zone client-certificate limit and ECDSA acceptance were the S4 unknowns: ECDSA
  P-256 CSRs are accepted by the managed CA (the `enroll-cert.py` default); the fleet is
  5 machines, far under any per-zone cap.

## M4 fleet-management endpoints

Three mTLS-authenticated endpoints back centrally-managed fleet ops (`hub/src/api/bootstrap.ts`,
`certs.ts`, `ops.ts`):

- **`GET /api/v1/bootstrap`** (any enrolled machine) — returns the centrally-managed collector
  config (scan cadence, upload caps, per-store toggles), versioned by `schema_version` so an older
  collector ignores keys it doesn't understand. Defaults live in code; override any subset by writing
  a JSON object to the D1 `meta` row keyed `collector_config`. The collector merges this over local config.
- **`POST /api/v1/certs/renew`** (authenticated by the still-valid current OR in-grace previous cert)
  — body `{ "csr": "<PEM CSR>" }`. The hub has the managed CA sign it, swaps the new fingerprint in as
  current, and keeps the previous fingerprint valid for 7 days (`machines.prev_cert_fp_sha256` +
  `cert_revoke_at`; `machineIdentity` matches current OR prev-in-window). The daily prune cron (`30 4`)
  revokes the previous cert at the CA once the window elapses. A second renew inside the window replaces
  the previous cert and resets the clock — at most one generation is ever in grace. Renewal is therefore
  authenticated by the current client certificate and does not reuse the fresh-enrollment D1 token.
- **`POST /api/v1/admin/machines`** (admin-flagged cert only, mirrors `admin/reindex`) — upsert a machine
  row (register fingerprint, set `priority`/`is_admin`) and get the roster back. No delete path by design
  (files/sessions FK-reference the row; decommission by revoking the cert).

### USER ACTION — provision the renewal token (one-time)

`POST /api/v1/certs/renew` needs a Cloudflare API token with **SSL and Certificates · Edit** on the
`vza.net` zone (the wrangler OAuth login can't reach `/client_certificates` — error 10000, verified in
M3). Mint one (dashboard → My Profile → API Tokens; the same SSL/Certificates permission the enrollment
token uses), then set it as a hub secret:

```
cd hub && npx wrangler secret put CF_CLIENT_CERT_TOKEN
```

Until it's set the endpoint returns `503 cert_renewal_unavailable` (collectors keep their current cert
and retry — no lockout). The zone id is a non-secret var (`CF_ZONE_ID` in `hub/wrangler.jsonc`).

Mint it narrowly and track its expiry:

- **Scope:** zone `vza.net` only (never account-wide).
- **Permission:** the single **SSL and Certificates · Edit** — nothing broader.
- **Expiry:** set `expires_on` ~1 year out and rotate it **before** it lapses. The CF API has no
  inbound OIDC/workload-identity federation for API tokens (open feature request since 2023,
  community thread 492897), so this bearer token — not a federated credential — is what mints and
  revokes every mTLS client cert; an expired or revoked token silently breaks renewals and the daily
  revoke prune.

That failure mode is now alertable: the hub emits a distinct `hub.certs.cf_auth_failed` event on any
401/403 from the CF API (sign / revoke / status paths), and `infra/azure/alerts/cf-auth-failed.kql`
pages on it — so a dead token becomes an email, not a slow-burning outage. Rotating the secret
(`wrangler secret put CF_CLIENT_CERT_TOKEN`) clears it.

### Deploy note — apply the D1 migration

`hub/migrations/0005_cert_rotation.sql` adds the rotation columns (`cert_id`, `prev_cert_fp_sha256`,
`prev_cert_id`, `cert_revoke_at`), and `0009_retired_certs_reservation_source.sql` records whether a
retired row came from a prior machine slot or is cleanup for a never-delivered minted orphan. Apply
all pending migrations to each remote D1 before deploying the Worker that reads the new column:

```
cd hub && npx wrangler d1 migrations apply sessions-index --remote          # production
cd hub && npx wrangler d1 migrations apply sessions-index-preview --remote  # preview
```
