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
| Zone · **SSL and Certificates** · Edit | Zone: `vza.net` — mints client certs + edge certs |
| Zone · **API Gateway** · Edit | Zone: `vza.net` — mTLS hostname associations (a.k.a. API Shield) |
| Zone · Zone Settings · Read | Zone: `vza.net` |

Set TTL to ~1 hour. This single token covers all three steps below; the
`enroll-cert.sh` helper only needs the SSL/Certificates half.

## Step 1 — enable the mTLS hostname association (one-time)

Associate the managed CA with `api.sessions.vza.net` so the edge requests a client
cert during the TLS handshake (without this, `cf.tlsClientAuth` is never populated).

Dashboard path: **SSL/TLS → Client Certificates → Hosts** → add `api.sessions.vza.net`
(and toggle "mTLS" for that hostname). API equivalent:

```
PUT /zones/{zone}/certificate_authorities/hostname_associations
  { "hostnames": ["api.sessions.vza.net"] }
```

Do **not** associate `sessions.vza.net` — the viewer uses passkeys, never client certs.

## Step 2 — add the WAF rule blocking unverified certs (one-time)

Dashboard: **Security → WAF → Custom rules → Create rule**, scoped to the api host:

```
Field:  (http.host eq "api.sessions.vza.net" and not cf.tls_client_auth.cert_verified)
Action: Block
```

This is belt-and-suspenders — the Worker already returns 401 for an unmapped/absent
cert — but it drops uncertified traffic at the edge before it reaches the Worker.

## Step 3 — enroll each machine (repeatable)

Run the helper with the enrollment token. For this box (WSL2, software key):

```
CF_API_TOKEN=<token from above> \
  infra/cf/enroll-cert.sh $(hostname)-linux --admin --out ~/.config/agent-collector
```

It generates an EC P-256 software key + CSR, has the managed CA sign it, computes the
SHA-256 fingerprint the way `cf.tlsClientAuth.certFingerprintSHA256` reports it, and
upserts the `machines` row via `wrangler d1 execute --remote`. `--admin` sets
`is_admin=1` (needed for `POST /api/v1/admin/reindex`); drop it for ordinary machines.
The private key never leaves the box; the signed cert is not secret.

Verify end-to-end:

```
curl --cert ~/.config/agent-collector/$(hostname)-linux.client.pem \
     --key  ~/.config/agent-collector/$(hostname)-linux.client.key \
     https://api.sessions.vza.net/api/v1/machines
```

Once this returns JSON (not 401), the upload → parse → search round-trip is unblocked
and the collector can be pointed at `https://api.sessions.vza.net`.

## Notes

- Real-TPM machines (Windows host, amet) replace the software `openssl` keygen with the
  TPM flows (S2/S3); the CSR → managed-CA → fingerprint → `machines` row steps are
  identical, only `key_protection` becomes `tpm`.
- Cert renewal (`POST /api/v1/certs/renew`) is M4: the hub holds a `CF_API_TOKEN`
  wrangler secret so a still-valid cert can request its own successor. That secret is
  intentionally **not** set in M3 (it would require the same zone token; setting it is a
  one-liner `wrangler secret put CF_API_TOKEN` when M4 lands).
- Per-zone client-certificate limit and ECDSA acceptance were the S4 unknowns: ECDSA
  P-256 CSRs are accepted by the managed CA (the `enroll-cert.sh` default); the fleet is
  5 machines, far under any per-zone cap.
