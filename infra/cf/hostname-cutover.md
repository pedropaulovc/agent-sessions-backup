# mTLS re-enrollment onto `api.sessions.pedrovc.com.br`

Target zone: `pedrovc.com.br` = `ff45a32e60c41cefd2fe5ff1c8eb61fb`
Account: `sessions-prod` = `18ef3246e9f36d1560485ef53889c0ab`
Old zone: `vza.net` = `6a56cdda4766c1d7b5ad0fbe8331048f` (`hub/wrangler.jsonc:34`)

All shell snippets below assume:

```bash
export CF_API="https://api.cloudflare.com/client/v4"
export NEW_ZONE="ff45a32e60c41cefd2fe5ff1c8eb61fb"
export OLD_ZONE="6a56cdda4766c1d7b5ad0fbe8331048f"
export NEW_HOST="api.sessions.pedrovc.com.br"
export CLOUDFLARE_API_TOKEN='<short-lived token, see §0>'
export MTLS=/tmp/mtls-reenroll
```

---

## 0. Read this first: the CA is ACCOUNT-scoped, not zone-scoped

The batch premise ("the collectors' certs cannot be repointed cross-account") is right about
*cross-account* but does not apply here, because `pedrovc.com.br` is in the **same** account as
`vza.net` is today.

Evidence, local:

```
$ openssl x509 -in ~/.config/agent-collector/amet-wsl.client.pem -noout -issuer
issuer=C = US, ST = California, L = San Francisco, O = "Cloudflare, Inc.",
       OU = www.cloudflare.com, CN = Managed CA 18ef3246e9f36d1560485ef53889c0ab
```

The issuer CN is literally the **account id**, not a zone id.

Evidence, Cloudflare docs (<https://developers.cloudflare.com/ssl/client-certificates/>, "How it
works"):

> Cloudflare validates client certificates against CAs set at the account level. Because
> validation is account-level, the same certificates work across multiple domains under your
> account, as long as mTLS is enabled for each hostname (for example, `host.example.com`,
> `name.example.net`, `secure.anotherdomain.test`).

So **only the hostname association is zone-scoped** for *validation* purposes. Independently
confirmed against the live account: the account has exactly one CA
(`GET /accounts/18ef3246…/mtls_certificates` → `ef55c994-1026-43bd-8ad8-8f4ac10a2c22`, `ca: true`,
issuer `CN=Gateway CA - Cloudflare Managed G1 18ef3246e9f36d1560485ef53889c0ab`, expires
2030-12-10), and a different zone in the same account (`killapikeys.fyi`) answers the same
`certificate_authorities/hostname_associations` endpoint with `hostnames: null` — one CA, per-zone
association sets.

### 0.1 But the certificate INVENTORY is per-zone, and that decides the plan

`GET /zones/{id}/client_certificates` is zone-scoped: 3 certs on `vza.net`, 0 on
`killapikeys.fyi`. So the CA is account-level while the certificate list — and the revoke verb —
are zone-level. That raises the question of whether a `vza.net`-minted cert presented to a
`pedrovc.com.br` hostname can ever be revoked.

**What the docs answer, and what they do not:**

* **There is NO account-level revocation surface.** The Client Certificates API resource exposes
  exactly five methods, all zone-scoped: List, Details, Create, Reactivate (`PATCH`), Revoke
  (`DELETE`) — all on `/zones/{zone_id}/client_certificates[/{id}]`
  (<https://developers.cloudflare.com/api/resources/client_certificates/>). No
  `/accounts/{id}/client_certificates` exists. **`DELETE /zones/{zone_id}/client_certificates/{id}`
  on the MINTING zone is the only revoke verb.** That part is settled.
* **Whether the edge's revocation check is CA-scoped or zone-scoped is NOT documented** (but it is
  now MEASURED — see §0.3: CA-scoped. The reasoning below was the pre-measurement inference, kept
  because it predicted the result correctly and shows which doc statements were load-bearing.) The
  evidence leans CA-scoped (i.e. revocation *would* follow the cert across zones in the same
  account):
  * Revocation checking is described as a property of the CA, not the zone:
    "This check only applies to client certificates issued by the Cloudflare-managed CA.
    Cloudflare currently does not check certificate revocation lists (CRL) for CAs that have been
    uploaded" (<https://developers.cloudflare.com/api-shield/security/mtls/configure/#check-for-revoked-certificates>).
  * `cert_revoked` is computed in the same validation pass as `cert_verified` — the field
    reference states "When `true`, the `cf.tls_client_auth.cert_verified` field is also `true`"
    (<https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/cf.tls_client_auth.cert_revoked/>).
    That pass is the account-level CA validation, which demonstrably works cross-zone.

  **Stated plainly: the docs still do not answer this.** The inference above is no longer what the
  plan rests on — §0.3 replaces it with a measurement, which is what a claim this load-bearing
  needed in the first place.

**CORRECTION (measured 2026-09-02, after the move).** This section originally argued that once
`vza.net` left the account, `sessions-prod` would have no zone through which to address those three
cert ids, making the only revoke verb unreachable and the certs *permanently unrevokeable*. That
premise is **false**, and it was never tested before being written.

A registrar move does not move the zone object between accounts. It leaves a husk with
`status: "moved"` in the source account, and the client certificates stay with that husk:

```
GET    /zones/6a56cdda4766c1d7b5ad0fbe8331048f          -> account.name "sessions-prod", status "moved"
GET    /zones/6a56cdda…/client_certificates             -> 200, the three certs, all "active"
```

Reachability of the *list* is not the claim that matters, so the write path was proven end to end
with a throwaway credential rather than inferred (positive control, 2026-09-02):

```
POST   /zones/6a56cdda…/client_certificates             -> 201, CN "husk-revoke-probe", active
DELETE /zones/6a56cdda…/client_certificates/7eedeb26-…  -> 200, success true
GET    /zones/6a56cdda…/client_certificates/7eedeb26-…  -> 200, status "revoked"
```

The three live certs were untouched throughout, and the probe's key material never left `/tmp`. A
`moved` zone accepts both mints and revocations. So the revoke verb stays reachable from the source
account and §8's Stage 2 remains performable at leisure — it is NOT a before-the-move-or-never step.

The open question this section hedged on — CA-scoped vs zone-scoped edge validation — has since been
measured too, in §0.3: the edge check is **CA-scoped**, and a revocation performed on the husk *is*
honoured on `api.sessions.pedrovc.com.br`. The zone-scoped branch is refuted, so the two-branch
table that used to sit here is gone; there is one outcome. Revoking the three old certs on the husk
blocks them at the edge, account-wide.

Note `hub/src/auth/identity.ts:89` still adds no *independent* revocation capability — it reads
`certRevoked` from the edge. It does not need to: the edge honours the real revocation, and D1's
fingerprint check is what identifies machines (§0.3, consequence 2).

### 0.2 Decision: Path A is a BRIDGE, Path B is MANDATORY

* **Path A — temporary bridge, do it first.** Add the hostname association (§1), prove the certs
  verify (§3), flip only `hub_url` in the three collector configs (§4). No new certs, no D1 write,
  no downtime, rollback = revert one config line. This restores service on the new hostname
  immediately and decouples it from the cert work.
* **Path B — MANDATORY, but NOT gated on the zone move.** Re-mint all three certs from
  `/zones/ff45a32e…/client_certificates` (§5), write the new fingerprints into D1 (§6), install
  them (§7), and **revoke the three old `vza.net`-minted certs** (§8, last block). The original
  text ordered the revocation before the zone move; §0.1's CORRECTION measures that premise false —
  the `moved` zone husk stays in `sessions-prod` and keeps serving the revoke verb. Revoke once the
  last box is running on a new cert, not before, or you strand it.

This supersedes the earlier framing of Path B as an optional fallback. What remains genuinely
deferred is only the *`cert_id` bookkeeping* (§7.5) — that is cosmetic. The re-mint itself is not.

### 0.3 Revocation in this system: D1 is PRIMARY, the CA is SECONDARY

**Read this before you conclude anything above is urgent.** The intuition a reader brings cold —
"if we cannot revoke at the CA, we cannot revoke" — is inverted for this system. CA revocation has
never been the mechanism that de-authorizes a collector here. It is the second layer.

**PRIMARY: the D1 fingerprint allowlist.** A collector authenticates only because its fingerprint
is present in a `machines` row. Clear that row's `cert_fp_sha256` (and `prev_cert_fp_sha256`) and
`machineIdentity`'s lookup returns no row → `{ kind: 'anonymous' }`
(`hub/src/auth/identity.ts:100`) → 401 at `hub/src/router.ts:114`. Immediate, CA-independent, and
effective against a cert that is still perfectly valid at the CA. The schema says so outright —
`hub/migrations/0005_cert_rotation.sql:47-48`:

> retired certs NEVER authenticate — machineIdentity still matches only the current or in-grace prev
> fingerprint. This table is reservation + revoke bookkeeping only.

That last clause is the point: `retired_certs` and every CA revoke call in this codebase are
**bookkeeping around** the allowlist, not the enforcement boundary. `cert_id` exists solely as a
handle for that bookkeeping (`hub/migrations/0005_cert_rotation.sql:10-11`) and is never consulted
on the request path.

**SECONDARY, and also CA-independent: a fingerprint-specific WAF rule** at the edge, using
`cf.tls_client_auth.cert_fingerprint_sha256` — a documented field with a worked example at
<https://developers.cloudflare.com/learning-paths/mtls/mtls-app-security/related-features/>:

```
(http.host eq "api.sessions.pedrovc.com.br" and cf.tls_client_auth.cert_fingerprint_sha256 eq "8118…")
Action: Block
```

**TERTIARY: CA revocation** (`cf.tls_client_auth.cert_revoked` + `DELETE /zones/{zone}/client_certificates/{id}`).
Defense in depth, and CONFIRMED WORKING for these certs (§0.1 CORRECTION: the `moved` husk still
exposes the revoke verb; §0.3 ANSWERED below: the edge honours that revocation cross-zone).

**Consequence for sequencing:** a compromised collector cert is containable today by all three
mechanisms — the two D1-side ones that involve no CA at all, plus a real CA revocation on the husk.
So §0.2's mandatory Path B is *sequenced work*, not an active security incident, and it has no
externally imposed deadline. What still justifies doing it is defense in depth plus not wanting a
live, valid credential for this account's CA sitting on three boxes indefinitely. It is NOT
justified by *unrevokeability* — those certs remain revokeable, and the revocation demonstrably
takes effect.

**ANSWERED (measured 2026-09-02) — the edge's check is CA-scoped, and revocation IS honoured
cross-zone.** This was previously logged here as "deliberately not chased", on the grounds that the
only already-revoked cert's key material sat on an offline box. That was a false constraint: a
throwaway cert can be minted on demand, and the §0.1 CORRECTION established the `moved` husk is
still writable. Method — mint a cert on the husk (`vza.net`) zone, present it to
`api.sessions.pedrovc.com.br` (a *different* zone, same account), revoke it, present it again. The
WAF rule in §5 makes the verdict directly observable:

| Presented credential | HTTP | Means |
|---|---|---|
| none | 403 | WAF blocked — `cert_verified` false |
| `amet-wsl`'s live cert | 200 | verified and known to D1 |
| husk-minted, **active**, unknown to D1 | **401** | passed the WAF, rejected by the hub — so the edge verified a cert minted on the departed zone |
| the same cert, **revoked** on the husk | **403** | WAF blocked — `cert_revoked` propagated across zones |

Two consequences, both load-bearing:

1. **CA revocation is a real defense layer for these certs, not a lost one.** Revoking the three
   old certs genuinely blocks them at the edge, account-wide, on every mTLS hostname. Combined with
   §0.1, the whole "unrevokeable" thesis inverted: the capability was never lost *and* it works.
2. **mTLS here authenticates "a cert from our CA", not "this machine".** Any cert this account's CA
   ever minted — from any zone in the account, including the still-writable husk — clears the edge.
   The 401 above is the hub's D1 fingerprint check doing the actual machine identification. That is
   why §0.3 ranks D1 PRIMARY, and it is not merely a design preference: it is the only layer that
   distinguishes machines.

**Operational caveat:** propagation is eventually-consistent across colos. Immediately after the
DELETE the probe returned 403, 403, then 401 — one PoP had not yet received the revocation — before
converging to 403 on 30/30 samples within about a minute. After revoking, verify with a burst of
requests, not one; a single accepted request shortly after revoking is propagation lag, not failure.

### 0.4 What happens to the three `vza.net` client certs when that zone moves accounts

Cloudflare's own guidance for a cross-account move
(<https://developers.cloudflare.com/fundamentals/manage-domains/move-domain/>) is that the move is
re-add-and-re-delegate, not a migration, and explicitly: "SSL/TLS certificates associated with
your previous Cloudflare account **will not be transferred** to your new account… You must reissue
SSL/TLS certificates and recreate and validate DNS records when transferring domains between
Cloudflare accounts." The page enumerates edge/custom/ACM certificates and does not name client
certificates either way — so their fate is undocumented.

The structural argument that used to close this section was **wrong**, and its error is instructive:
it reasoned about what the *destination* account would hold, and concluded that either way
"`sessions-prod` loses the endpoint that can revoke them". That inference skipped the actual
question — what happens in the *source* account. Measured (§0.1 CORRECTION): the zone object never
leaves. A `status: "moved"` husk remains in `sessions-prod`, still holding the three certs and still
accepting mints and revocations. Cloudflare's "certificates will not be transferred" wording is
consistent with this: nothing transferred, because nothing moved.

**Therefore: mint the replacements in `pedrovc.com.br` now, and revoke the old three on the husk
once each box is running on its new cert — in that order, with no handover deadline.** That is the
clean end state: the account's CA has exactly three live client certs, all under a zone this account
controls, and the superseded three are revoked and blocked at the edge (§0.3).

### 0.5 Auth for every curl in this runbook — two mechanisms, both scriptable

Every step below is expressed as an API call. **Nothing in this runbook requires clicking through
the dashboard UI**, and it should not be done that way: a scripted call is auditable, repeatable,
and cannot half-apply because someone mis-typed one of N form fields under time pressure.

**Mechanism A — scoped API token** (dashboard → My Profile → API Tokens → Custom token, TTL ~1h):

| Permission | Scope | Needed for |
|---|---|---|
| Zone · SSL and Certificates · Edit | Zone: `pedrovc.com.br` | hostname associations (§1) — the API reference lists `SSL and Certificates Write` as the accepted permission for `PUT …/certificate_authorities/hostname_associations`; also client-cert minting (§5.4) |
| Zone · WAF · Edit | Zone: `pedrovc.com.br` | custom rule (§2) |
| Zone · SSL and Certificates · Edit | Zone: `vza.net` | revoking the old certs (§8.1) — must be minted while that zone is still in this account |
| Account · D1 · Edit | Account: `sessions-prod` | Path B D1 writes (§6) |

`infra/cf/mtls.md:39-40` suggests **API Gateway · Edit** for the hostname association. That is
stale/wrong for this endpoint: the API reference for *Replace Hostname Associations* names
`SSL and Certificates Write` as the only accepted permission. Granting SSL-and-Certificates Edit
covers §1 and §5.4 with one permission.

**Mechanism B — the logged-in dashboard session's own `/api/v4`, with cookies.** Verified working
in practice: zone-level **writes** are accepted this way (a 28-delete + 23-create DNS rebuild ran
clean, all `success: true`). Use this when a token is inconvenient or when the token path 403s.

Two things to know about the auth landscape here, because they are easy to misdiagnose:

* **The wrangler OAuth token cannot do zone endpoints.** `npx wrangler auth token --profile
  sessions-prod` yields a bearer with no zone-level permissions; zone endpoints 403. This is a
  property of that grant, not of the zone or of your permissions — do not spend time debugging it.
  It is also why the hub uses its own private Cloudflare OAuth client for cert minting rather than
  the CLI grant (`infra/cf/mtls.md`, and `hub/src/auth/cloudflare-oauth.ts`).
* **Only `POST /zones` itself is edge-blocked.** Zone *creation* must happen in the UI. Everything
  else in this runbook — associations, rulesets, client certs, DNS — is scriptable.

Substitute whichever mechanism you use into `$CLOUDFLARE_API_TOKEN` / the `Authorization` header in
the commands below; the request bodies and URLs are identical either way.

---

## 1. Associate the new hostname with the managed CA

### 1.1 Confirmed semantics (from the API reference, not inference)

Endpoint: `PUT /zones/{zone_id}/certificate_authorities/hostname_associations`
API reference: <https://developers.cloudflare.com/api/resources/certificate_authorities/subresources/hostname_associations/methods/update/>

1. **It is a REPLACE, not an append.** The operation's official title is literally
   **"Replace Hostname Associations"**. `infra/cf/mtls.md:51-53` says the same from experience.
2. **An omitted or empty `hostnames` WIPES the set.** The reference marks `hostnames` as
   *optional array of string*, and the doc page's own worked example sends `-d '{}'` — i.e. the
   empty body is a valid call whose only possible meaning is "replace the set with nothing".
   There is no separate add/remove verb and no merge semantics. **Never PUT without first GETting
   the current set.**
3. **Omitting `mtls_certificate_id` selects the account managed CA — that is the documented
   default, not a fallback.** Verbatim from the reference:
   > `mtls_certificate_id`: optional string — The UUID for a certificate that was uploaded to the
   > mTLS Certificate Management endpoint. **If no `mtls_certificate_id` is given, the hostnames
   > will be associated to your active Cloudflare Managed CA.**

   So for our case the field must be **absent**. Supplying it would point the association at a
   BYOCA (Enterprise-only) instead.
4. **A PUT on the new zone cannot disturb `api.sessions.vza.net`.** `zone_id` is a *path*
   parameter and the association set is per-zone — the request has no way to name another zone,
   and the response echoes only `result.hostnames` for the zone you addressed. `mtls.md:52` frames
   the collateral-damage risk as "any sibling host already associated **on the zone**", same
   scoping. The old zone's associations are untouched by anything in §1, which is exactly what
   makes the §8 rollback (point collectors back at the old hostname) work.

### 1.2 The exact request

```bash
# 1a. MANDATORY read first. A brand-new zone should return hostnames: [] or null.
curl -sS -X GET "$CF_API/zones/$NEW_ZONE/certificate_authorities/hostname_associations" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.success, .result.hostnames'

# 1b. PUT the UNION of whatever 1a returned PLUS the new host.
#     If 1a returned [] or null, this exact body is correct as written.
curl -sS -X PUT "$CF_API/zones/$NEW_ZONE/certificate_authorities/hostname_associations" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"hostnames":["api.sessions.pedrovc.com.br"]}' \
  | jq '.success, .result.hostnames'
```

If 1a returned a non-empty list, build the union mechanically instead of by hand:

```bash
curl -sS -X GET "$CF_API/zones/$NEW_ZONE/certificate_authorities/hostname_associations" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | jq '{hostnames: ((.result.hostnames // []) + ["api.sessions.pedrovc.com.br"] | unique)}' \
  > /tmp/mtls-reenroll/assoc.json
cat /tmp/mtls-reenroll/assoc.json     # REVIEW: this list becomes the complete set
curl -sS -X PUT "$CF_API/zones/$NEW_ZONE/certificate_authorities/hostname_associations" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data @/tmp/mtls-reenroll/assoc.json | jq '.success, .result.hostnames'
```

Expected 200 body: `{"success": true, "result": {"hostnames": ["api.sessions.pedrovc.com.br"]}}`.
The echoed `hostnames` IS the resulting complete set — verify it contains everything you intended
to keep before moving on.

Do **not** associate the viewer hostname. `mtls.md:64`: the viewer uses passkeys, never client
certs, and an association there would make browsers prompt for a certificate.

There is a dashboard equivalent — **SSL/TLS → Client Certificates → Hosts → Edit** — whose only
advantage is that it appends rather than replaces, so it cannot wipe the set (type only
`api.sessions`; it appends the apex for you). **Prefer the API call above anyway.** The 1a-then-1b
read-then-union sequence gets the same safety property, and either auth mechanism in §0.5 can
drive it, so there is no reason to hand-click a cutover step.

## 2. WAF custom rule enforcing a verified, unrevoked cert

**Verdict up front: this rule is belt-and-braces, NOT load-bearing. You can go live without it and
add it afterwards.** Full reasoning and the one caveat in §2.1.

Reconstructed verbatim from the existing `vza.net` rule documented at `infra/cf/mtls.md:65-79`:

```
Field:  (http.host eq "api.sessions.vza.net" and (not cf.tls_client_auth.cert_verified or cf.tls_client_auth.cert_revoked))
Action: Block
```

The `cert_revoked` disjunct is load-bearing — `mtls.md:74-77`: Cloudflare keeps `cert_verified`
**true** for a revoked-but-otherwise-valid cert and reports revocation only through the separate
`cert_revoked` field, so a rule testing `cert_verified` alone still admits a revoked machine cert.

New-zone expression (only the host literal changes):

```
(http.host eq "api.sessions.pedrovc.com.br" and (not cf.tls_client_auth.cert_verified or cf.tls_client_auth.cert_revoked))
```

API — read the custom-rules entrypoint ruleset, then PUT the union of its existing rules plus this
one (same replace-semantics trap as §1):

```bash
# 2a. read existing custom rules. This endpoint's PUT REPLACES the entire `rules`
# array - anything absent from the payload is DELETED. Same trap as §1.
curl -sS -X GET "$CF_API/zones/$NEW_ZONE/rulesets/phases/http_request_firewall_custom/entrypoint" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result.rules' > rules.json
cat rules.json          # REVIEW: every rule here must survive step 2c

# 2b. build the union. Existing rules are carried verbatim except for the three
# server-managed fields, which the API rejects on write; `action_parameters` and
# `logging` MUST be preserved or a skip/challenge rule silently loses its config.
# Filtering on our own description makes a re-run replace rather than duplicate, so DESC MUST equal
# the description actually deployed - verified live 2026-09-02. Change it and the filter misses,
# leaving two block rules with the same effect.
DESC="mTLS required api.sessions.pedrovc.com.br"
NEWRULE=$(jq -n --arg h "api.sessions.pedrovc.com.br" --arg d "$DESC" '{
  action: "block", description: $d, enabled: true,
  expression: "(http.host eq \"\($h)\" and (not cf.tls_client_auth.cert_verified or cf.tls_client_auth.cert_revoked))"
}')
# Cloudflare normalizes the stored expression - it strips these outer parentheses, so the live rule
# reads `http.host eq "..." and (not ...)`. That is the same rule, not drift.
jq --arg d "$DESC" --argjson new "$NEWRULE" '
  { rules: ((. // []) | map(select(.description != $d) | del(.id, .version, .last_updated)) + [$new]) }
' rules.json > put.json
jq -r '.rules[] | "\(.action)\t\(.description)"' put.json   # REVIEW before sending

# 2c. PUT the union
curl -sS -X PUT "$CF_API/zones/$NEW_ZONE/rulesets/phases/http_request_firewall_custom/entrypoint" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" --data @put.json \
  | jq '.success, [.result.rules[].description]'
```

### 2.1 Is the WAF rule load-bearing? No — verdict and proof

**You can go live on the new zone without this rule. Its absence changes where the denial comes
from (a 401 JSON from the Worker instead of a 403 block page from the edge), not whether
unauthenticated traffic is denied.** The complete decision path, in order:

1. `hub/src/router.ts:60-62` — in production every request on `API_HOST` goes to `apiRoute`,
   including non-`/api/` paths, so the viewer is never served on the API host:
   ```ts
   if (url.pathname.startsWith('/api/')
       || apiOAuthCallback
       || (env.ENVIRONMENT !== 'development' && env.ENVIRONMENT !== 'preview' && url.hostname === env.API_HOST)) {
     return apiRoute(request, url, env);
   }
   ```
2. `hub/src/router.ts:78` — `apiRoute` resolves identity before any route dispatch:
   `const identity = await machineIdentity(request, env);`
3. `hub/src/auth/identity.ts:89-90` — the mTLS gate. Absent `cf.tlsClientAuth`, a
   `certVerified` that is anything other than `'SUCCESS'`, a missing fingerprint, or a
   `certRevoked` of `'1'`/`'true'` all fail this condition:
   ```ts
   const revoked = tls?.certRevoked === '1' || tls?.certRevoked === 'true';
   if (tls?.certVerified === 'SUCCESS' && !revoked && tls.certFingerprintSHA256) {
   ```
4. `hub/src/auth/identity.ts:105-113` — with `ENVIRONMENT === 'production'` neither the
   development `x-dev-machine` branch nor the preview bearer branch is reachable, so the function
   returns `{ kind: 'anonymous' }`. A forged header cannot manufacture a machine identity.
5. `hub/src/router.ts:111-115` — anonymous identity terminates the request:
   ```ts
   if (identity.kind !== 'machine') {
     const grant = await grantIdentity(request, env);
     const granted = grant ? await grantReadRoute(request, url, env, grant) : null;
     return granted ?? Response.json({ error: 'unauthorized' }, { status: 401 });
   }
   ```
   Everything below that gate is machine-only by construction (`router.ts:108-110`). The routes
   *above* it — `checkFiles`, the file/multipart handlers, `heartbeat`, `renewCert` — each take
   `identity` and gate themselves; e.g. `hub/src/api/ops.ts:21`
   `if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });`
6. Revocation is covered independently of the WAF's `cert_revoked` disjunct by step 3's `revoked`
   check, so dropping the rule opens no revoked-cert window at the Worker.
7. This is not just code reading — it was verified in production. `infra/cf/mtls.md:12-15`: "With
   no client cert, `GET /api/v1/search`, `PUT /api/v1/files/...`, and even a forged
   `x-dev-machine` header all return `401` in production (verified)."

**The one real difference — `/healthz`.** `hub/src/router.ts:32-35` answers `/healthz` *before*
the API dispatch and before any identity resolution, so without the WAF rule
`https://api.sessions.pedrovc.com.br/healthz` is publicly readable. In production it returns only
`{"ok":true,"environment":"production"}` (`router.ts:34`); the verbose build/migration-digest body
at `router.ts:36-47` is gated on `ENVIRONMENT === 'development'`. So the exposure is an
unauthenticated liveness ping, not a data or metadata leak. It is also the reason the collector's
doctor sends its client cert on the `/healthz` probe
(`collector/tests/test_transport.py:200-203`) — that behaviour is unaffected either way.

**Recommended ordering:** §1 → §3 (prove the CA) → §4 (flip collectors, service restored) → §2
(add the rule) → re-run the §3 control probe to confirm the rule blocks certless traffic. Doing §2
first is also fine; it just means a mistake in the expression shows up as a mysterious 403 while
you are still trying to establish whether the certs verify at all, which is harder to debug.

## 3. THE DECIDING TEST — one command that proves the account-level-CA hypothesis

Run this the moment the new zone reports `active` and §1 has landed. It uses the **existing,
unchanged** `amet-wsl` cert and key — nothing from `/tmp/mtls-reenroll` is involved.

`GET /api/v1/status` is the right probe because it echoes the identity the hub resolved back to
you (`hub/src/api/ops.ts:544-553`): `identity.machine_id`, `identity.cert_fingerprint` (the value
the EDGE reported, `hub/src/auth/identity.ts:102`), and `identity.cert_slot`. A 200 with the right
fingerprint is direct proof that a `vza.net`-minted cert was verified by the edge on a
`pedrovc.com.br` hostname.

### The command

```bash
curl -sS --cert ~/.config/agent-collector/amet-wsl.client.pem \
         --key  ~/.config/agent-collector/amet-wsl.client.key \
         -w '\n--- http_status=%{http_code} tls=%{ssl_verify_result} ---\n' \
         "https://api.sessions.pedrovc.com.br/api/v1/status" \
  | head -c 600
```

### SUCCESS signature — hypothesis CONFIRMED, take the §4 bridge (then still do §5–§8.1)

`http_status=200`, and a JSON body starting with:

```json
{"identity":{"machine_id":"amet-wsl",
             "cert_fingerprint":"811800780425b3fe6455fbb2d0c45c5337fd28e741a01d621621fcc38a7b379f",
             "cert_slot":"current"}, …
```

`cert_fingerprint` must equal `811800780425b3fe…` — that is `amet-wsl`'s CURRENT
`machines.cert_fp_sha256` in production D1 and the SHA-256 of the DER of the cert you just
presented. `cert_slot":"current"` confirms it matched the current slot, not a grace slot.

### FAILURE signatures — how to tell the three causes apart

| What you see | Cause | Next step |
|---|---|---|
| `curl: (6) Could not resolve host` | DNS not delegated yet — nameservers `ned.ns.cloudflare.com` / `pearl.ns.cloudflare.com` not set at registro.br, or DNSSEC still on there. Zone will read `initializing`, not `active`. | Finish the registrar work. Nothing here is testable yet. |
| `curl: (35)` / `curl: (60)` TLS handshake or SSL-cert error, or an SSL error naming a hostname mismatch | **Hostname not routed / no edge certificate yet.** Universal SSL does not cover a 3-label host, so `api.sessions.pedrovc.com.br` needs its own edge cert exactly like `api.sessions.vza.net` did (`infra/cf/mtls.md:24-26` — it "provisioned automatically within a few minutes"). | Wait for the Workers custom-domain edge cert. Not a CA problem. |
| HTTP `530` (Cloudflare error 1016) or `404` with a Cloudflare (not JSON) body | Zone is active and TLS works, but the Worker custom domain for `$NEW_HOST` does not exist. | `hub/wrangler.jsonc:19` route + `API_HOST` must be flipped and deployed (see the end of §7). |
| `http_status=401` **and** body `{"error":"unauthorized"}` | **CA NOT ASSOCIATED.** TLS completed, the request reached the Worker, but the edge never asked for (or never verified) a client certificate, so `cf.tlsClientAuth` was absent and `machineIdentity` returned anonymous (`hub/src/auth/identity.ts:90,113` → `hub/src/router.ts:114`). | Re-check §1: GET the associations and confirm `api.sessions.pedrovc.com.br` is in `result.hostnames`. If it is present and this persists, the hypothesis is disproved → Path B (§5–§7). |
| `http_status=403` with an **HTML** Cloudflare block page | The §2 WAF rule fired, i.e. `cf.tls_client_auth.cert_verified` was false at the edge. Same root cause as the row above, just caught one layer earlier. | Same as above. Temporarily disable the §2 rule to get the cleaner 401-vs-200 discrimination. |
| `http_status=403` and body `{"error":"passkey_grant_required"}` | Not a failure of this test at all — you probed a session/search path instead of `/api/v1/status` (`hub/src/router.ts:129-131`). The cert verified fine. | Use `/api/v1/status`. |
| `http_status=401` with JSON, but a `-v` trace showing the server DID send a certificate request | Edge verified the cert; the Worker found no `machines` row for the fingerprint (`hub/src/auth/identity.ts:100`). Fingerprint mismatch, not a CA problem. | Compare `openssl x509 -in <pem> -outform DER \| sha256sum` against `machines.cert_fp_sha256`. |

**The single unambiguous discriminator between "CA not associated" and "not routed yet":** whether
you got an HTTP status at all. No HTTP status (curl exit 6/35/60) = DNS or edge TLS, i.e. routing.
An HTTP 401/403 = the request reached Cloudflare's L7 and the client-cert step is what failed.

To see the TLS-level truth directly — whether the edge sent a CertificateRequest — add `-v`:

```bash
curl -sS -v -o /dev/null "https://api.sessions.pedrovc.com.br/api/v1/status" \
  --cert ~/.config/agent-collector/amet-wsl.client.pem \
  --key  ~/.config/agent-collector/amet-wsl.client.key 2>&1 \
  | grep -Ei 'subject|issuer|Request CERT|CERT verify|SSL connection|HTTP/'
```

A line matching `Request CERT` (curl reporting the server's CertificateRequest) means the hostname
association is live. Its absence means §1 has not taken effect.

### Control probe — certless traffic must be denied

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "https://api.sessions.pedrovc.com.br/api/v1/status"
```

* `403` → the §2 WAF rule is in place and blocking at the edge.
* `401` → §2 not applied yet; the Worker denied it instead. **Also a pass** — see the §2.1 verdict.
* `200` → stop everything. That would mean an unauthenticated caller reached a machine route, which
  no code path in §2.1 permits.

## 4. Path A (bridge) — flip `hub_url` only

Per machine, change exactly one line. Nothing else, no cert touch, no D1 write.

| Machine | Config file | Change |
|---|---|---|
| `amet-wsl` | `/home/pedro/.config/agent-collector/config.toml` | `hub_url = "https://api.sessions.pedrovc.com.br"` |
| `amet-windows` | `C:\Users\pedro\.config\agent-collector\config.toml` | same |
| `vm-solidworks-windows` | `C:\Users\<user>\.config\agent-collector\config.toml` on that VM | same |

Then, on each box:

```bash
uv run agent-collector doctor     # authenticated /api/v1/status probe
uv run agent-collector run --once
```

Rollback: put `https://api.sessions.vza.net` back. Valid only while the old zone is still in this
account — see §8.

---

## 5. Path B (MANDATORY, no zone-move deadline) — re-issue all three certs from the new zone

Per §0.2 this is not optional. The old certs are issued by this account's CA and are revokeable only
through the `vza.net` zone endpoint — which stayed in this account as a `moved` husk, so the
handover imposed no deadline (§0.1 CORRECTION; the heading previously said otherwise). Complete
§5–§7, then §8.1.

### 5.1 The three identities (read from production D1, `sessions-index`, 2026-09-01)

```
machine_id             os       hostname       cert_fp_sha256                                                    cert_id                               is_admin
amet-windows           windows  amet           1152bdfb152001dee6be77521a8c6bc5b6e79c59e7baffc0bbbcca4e0c05da31  65913f0a-4b65-4047-9bb4-1e8e4f9f1590  1
amet-wsl               wsl      amet           811800780425b3fe6455fbb2d0c45c5337fd28e741a01d621621fcc38a7b379f  NULL                                  1
vm-solidworks-windows  windows  vm-solidworks  53ba4e2bf19dd0dd8f27759de344329ab3f67aedfdaa67e3afb523962f519f8f  2544a51d-fc9e-47f0-966e-2a789155ade0  0
```

**The third identity — the cert whose display name is `Cloudflare` — is `amet-wsl`. Determined,
not guessed:**

```
$ openssl x509 -in ~/.config/agent-collector/amet-wsl.client.pem -noout -subject
subject=C = US, CN = Cloudflare
$ openssl x509 -in ~/.config/agent-collector/amet-wsl.client.pem -outform DER | sha256sum
811800780425b3fe6455fbb2d0c45c5337fd28e741a01d621621fcc38a7b379f
```

That fingerprint is byte-identical to `machines.cert_fp_sha256` for `amet-wsl` above. The subject
CN is the string `Cloudflare` because that cert was minted through the dashboard's
"Cloudflare generates the private key and CSR" flow (it is also on disk as the `public.cer` /
`private.pfx` pair, same serial `2307C4CF…`), not through `infra/cf/enroll-cert.py`, which sets
`CN=<machine_id>` (`infra/cf/enroll-cert.py:501-504`). Its `cert_id` is NULL, matching the
legacy-row note at `hub/src/api/ops.ts:357` ("the real M3-era rows with no recorded id (amet-wsl,
amet-windows)"). The re-issued CSR below fixes this: `CN=amet-wsl`.

Also note `vm-solidworks-windows` last checked in `2026-08-15T21:45:14.866Z` — over two weeks
stale. Treat that box as offline: its cutover cannot be validated by a live upload and will need a
hands-on visit.

### 5.2 Key type: EC P-256 (not RSA)

Nothing in the hub *requires* a key type — `certFingerprint` only SHA-256s the leaf DER
(`hub/src/api/certs.ts:14-21`) and `machineIdentity` only compares that hex string. The choice is
fleet convention plus the one empirically verified path:

* `infra/cf/enroll-cert.py:487` — `private_key = ec.generate_private_key(ec.SECP256R1())`
* `infra/cf/mtls.md:149-151` — "ECDSA P-256 CSRs are accepted by the managed CA (the
  `enroll-cert.py` default)"

So: **EC P-256, `ecdsa-with-SHA256`.** RSA-2048 was not used, to avoid re-testing CA acceptance
and Schannel import on a live cutover.

CSR subject follows `enroll-cert.py:501-504` exactly — `CN=<machine_id>, O=agent-sessions-backup`.
`enroll-cert.py:370-372` hard-fails if the signed cert's CN ≠ machine_id, so the CN is not
cosmetic for any future re-run of that script.

### 5.3 Generated material (already on disk)

```
$ ls -l /tmp/mtls-reenroll
-rw-r--r-- amet-windows.client.csr
-rw------- amet-windows.client.key
-rw-r--r-- amet-wsl.client.csr
-rw------- amet-wsl.client.key
-rw-r--r-- vm-solidworks-windows.client.csr
-rw------- vm-solidworks-windows.client.key

$ openssl req -in amet-windows.client.csr          -noout -subject
subject=CN = amet-windows, O = agent-sessions-backup
$ openssl req -in amet-wsl.client.csr              -noout -subject
subject=CN = amet-wsl, O = agent-sessions-backup
$ openssl req -in vm-solidworks-windows.client.csr -noout -subject
subject=CN = vm-solidworks-windows, O = agent-sessions-backup
```

All three verify (`openssl req -noout -verify` → "self-signature verify OK"), all
`prime256v1` / `ecdsa-with-SHA256`. Keys are `0600`.

Regeneration command, if ever needed:

```bash
mkdir -p /tmp/mtls-reenroll && cd /tmp/mtls-reenroll
for m in amet-windows amet-wsl vm-solidworks-windows; do
  openssl ecparam -name prime256v1 -genkey -noout -out "$m.client.key"
  chmod 0600 "$m.client.key"
  openssl req -new -key "$m.client.key" -sha256 -out "$m.client.csr" \
    -subj "/CN=$m/O=agent-sessions-backup"
done
```

### 5.4 POST each CSR to the new zone's managed CA

Endpoint and body shape from `infra/cf/enroll-cert.py:520-525` and
`hub/src/auth/cloudflare-oauth.ts:293`:

```
POST https://api.cloudflare.com/client/v4/zones/ff45a32e60c41cefd2fe5ff1c8eb61fb/client_certificates
Content-Type: application/json
Authorization: Bearer <token>

{ "csr": "-----BEGIN CERTIFICATE REQUEST-----\n…\n-----END CERTIFICATE REQUEST-----\n",
  "validity_days": 365 }
```

Copy-pasteable, all three, writing the signed PEM and the new `cert_id` next to each key:

```bash
cd "$MTLS"
for m in amet-windows amet-wsl vm-solidworks-windows; do
  jq -n --rawfile csr "$m.client.csr" '{csr:$csr, validity_days:365}' > "$m.req.json"
  curl -sS -X POST "$CF_API/zones/$NEW_ZONE/client_certificates" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data @"$m.req.json" > "$m.resp.json"
  jq -e '.success == true' "$m.resp.json" >/dev/null || { echo "FAILED $m"; jq '.errors' "$m.resp.json"; continue; }
  jq -r '.result.certificate' "$m.resp.json" > "$m.client.pem"
  jq -r '.result.id'          "$m.resp.json" > "$m.cert_id"
  # the value the edge will report and the hub will compare: SHA-256 of the leaf DER,
  # lowercase hex, no colons (hub/src/api/certs.ts:14-21, ops.ts:924-926)
  openssl x509 -in "$m.client.pem" -outform DER | sha256sum | cut -d' ' -f1 > "$m.fp"
  echo "$m  cert_id=$(cat "$m.cert_id")  fp=$(cat "$m.fp")"
  # sanity: CN must equal machine_id (enroll-cert.py:370-372)
  openssl x509 -in "$m.client.pem" -noout -subject
done
chmod 0600 "$MTLS"/*.client.pem "$MTLS"/*.client.key
```

Fingerprint form matters. `machineIdentity` binds `tls.certFingerprintSHA256` verbatim with **no
case folding and no colon stripping** (`hub/src/auth/identity.ts:98`), and the stored value is
produced by `hex()` — `b.toString(16).padStart(2,'0')`, lowercase, no separators
(`hub/src/api/ops.ts:924-926`). So never store `openssl`'s `-fingerprint` output as-is (uppercase,
colon-separated) — always the `sha256sum` of the DER as above.

## 6. Path B, D1 writes

### 6.1 Verdict: a simultaneous current + grace fingerprint IS possible

**Zero-downtime dual-cert rollover is POSSIBLE.** Backing schema:

* `machines.cert_fp_sha256` — `hub/migrations/0001_init.sql:7`, `TEXT UNIQUE`
* `machines.prev_cert_fp_sha256`, `prev_cert_id`, `cert_revoke_at`, `cert_id` —
  `hub/migrations/0005_cert_rotation.sql:21-24` (no UNIQUE on `prev_cert_fp_sha256`)
* `0005_cert_rotation.sql:4-5`: "During that window a machine has TWO valid fingerprints;
  `machineIdentity()` matches `cert_fp_sha256` OR (`prev_cert_fp_sha256` with `cert_revoke_at`
  still in the future)."

The auth query proves it, `hub/src/auth/identity.ts:91-99`:

```sql
SELECT machine_id, is_admin,
       CASE WHEN cert_fp_sha256 = ?1 THEN 'current' ELSE 'grace' END AS cert_slot
  FROM machines
 WHERE cert_fp_sha256 = ?1
    OR (prev_cert_fp_sha256 = ?1 AND cert_revoke_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
```

So there is **no hard cutover moment at the hub layer** — one row authenticates two certs at once.

Two caveats that shape the direction of the swap:

1. **A grace-slot cert is never admin.** `hub/src/auth/identity.ts:101`:
   `const isAdmin = row.is_admin === 1 && row.cert_slot === 'current';`
   `amet-windows` and `amet-wsl` are both `is_admin = 1`. Putting the NEW fingerprint in the grace
   slot would authenticate them but silently strip admin. **Therefore the new fingerprint goes into
   the CURRENT slot and the old one is demoted into grace** — exactly what `renewCert` does
   (`hub/src/api/certs.ts:484-489`).
2. **The edge is the real serialization point, not D1.** A `vza.net`-minted cert only verifies on a
   hostname associated on a zone whose account owns that CA, and vice versa. D1 dual-validity buys
   you a window in which *either hostname* works, which is what makes the collector-side flip
   reversible — it does not make a single request accept either cert.

Note that `POST /api/v1/admin/machines` **cannot** produce this dual state: on a fingerprint change
it forces `prev_cert_fp_sha256 = NULL, prev_cert_id = NULL, cert_revoke_at = NULL`
(`hub/src/api/ops.ts:372-374`) and queues the old current into `retired_certs`
(`ops.ts:386-389`). Use direct SQL below.

Also: `retired_certs` currently holds exactly one row
(`4bc2b0c5…`, `vm-solidworks-windows`, `revoked_at = 2026-07-20T04:30:51.160Z`), so there is no
unrevoked reservation to clash with a new fingerprint.

### 6.2 Recommended: new fingerprint as CURRENT, old demoted to grace

One statement per machine, guarded on the *observed* pre-rotation state so a re-run cannot fire
twice. `AND cert_fp_sha256 <> '$NEWFP'` is NOT such a guard — it only stops an immediate repeat of
the same rotation. Run it after any *other* rotation and it demotes that newer current cert into
the grace slot and restores this staged one as current. Bind the old values instead.

This is weaker than `hub/src/api/certs.ts:478-489`, which CASes on the full observed row
(`cert_fp`, `cert_id`, `prev_fp`, `prev_id`, `revoke_at`) via `rotationCas` and 409s on any drift.
Pinning fp AND id is the floor: a NULL `cert_id` beside a matching fingerprint is a different
state, and moving it into the prev slot is the exact stale-value bug that comment describes.

```bash
# Pin the observed pre-rotation state. Empty string means SQL NULL: `IS nullif(...)` is NULL-safe
# equality, so a NULL cert_id is matched deliberately rather than by accident.
cd /home/pedro/src/agent-sessions-backup/hub
npx wrangler d1 execute sessions-index --remote --profile sessions-prod --json --command \
  "SELECT machine_id, cert_fp_sha256, cert_id FROM machines ORDER BY machine_id" \
  | jq -r '.[0].results[] | [.machine_id, (.cert_fp_sha256 // ""), (.cert_id // "")] | @tsv' \
  > "$MTLS/observed.tsv"
cd "$MTLS"
cat observed.tsv    # REVIEW: the guard will REQUIRE exactly these values

while IFS=$'\t' read -r m OLDFP OLDID; do
  case " amet-windows amet-wsl vm-solidworks-windows " in *" $m "*) ;; *) continue;; esac
  NEWFP=$(cat "$m.fp"); NEWID=$(cat "$m.cert_id")
  echo "UPDATE machines
           SET prev_cert_fp_sha256 = cert_fp_sha256,
               prev_cert_id        = cert_id,
               cert_revoke_at      = strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days'),
               cert_fp_sha256      = '$NEWFP',
               cert_id             = '$NEWID'
         WHERE machine_id = '$m'
           AND cert_fp_sha256 IS nullif('$OLDFP','')
           AND cert_id        IS nullif('$OLDID','');"
done < observed.tsv > swap.sql
cat swap.sql        # REVIEW before running
cd /home/pedro/src/agent-sessions-backup/hub
npx wrangler d1 execute sessions-index --remote --profile sessions-prod --file "$MTLS/swap.sql"
```

`+7 days` matches `CERT_GRACE_DAYS = 7` (`hub/src/api/certs.ts:8`). The timestamp format
`%Y-%m-%dT%H:%M:%fZ` is required — `identity.ts:96` compares it lexicographically against the same
`strftime` format.

Check the reported `changes` per statement. A machine reporting **0** means the row drifted between
the read and the write — someone else rotated, or `observed.tsv` is stale. Re-read and regenerate;
do NOT relax the guard to force it through, which is what re-running with `<>` used to do.

Verify:

```bash
npx wrangler d1 execute sessions-index --remote --profile sessions-prod --json --command \
  "SELECT machine_id, cert_fp_sha256, cert_id, prev_cert_fp_sha256, prev_cert_id, cert_revoke_at FROM machines ORDER BY machine_id"
```

### 6.3 Literal grace-slot staging + promotion (only if you must stage ahead of the flip)

Stage the new fingerprint in the GRACE slot while the old one stays current. Use this only for
`vm-solidworks-windows` (`is_admin = 0`) — on the two admin rows it costs admin capability until
promotion, per §6.1 caveat 1.

```sql
-- stage: new fp into the grace slot
UPDATE machines
   SET prev_cert_fp_sha256 = '<new fp>',
       prev_cert_id        = '<new cert id>',
       cert_revoke_at      = strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days')
 WHERE machine_id = 'vm-solidworks-windows'
   AND cert_fp_sha256 = '53ba4e2bf19dd0dd8f27759de344329ab3f67aedfdaa67e3afb523962f519f8f'
   AND prev_cert_fp_sha256 IS NULL;
```

```sql
-- promotion: swap the slots. SQLite evaluates every RHS against the pre-update row,
-- so this exchanges current and grace in a single statement.
UPDATE machines
   SET cert_fp_sha256      = prev_cert_fp_sha256,
       cert_id             = prev_cert_id,
       prev_cert_fp_sha256 = cert_fp_sha256,
       prev_cert_id        = cert_id,
       cert_revoke_at      = strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days')
 WHERE machine_id = 'vm-solidworks-windows'
   AND prev_cert_fp_sha256 = '<new fp>';
```

Promote before `cert_revoke_at` elapses. If it elapses first, the daily prune (`30 4`) moves the
staged fingerprint into `retired_certs` and clears the grace slot
(`hub/src/cron/prune.ts:52-78`), and you would have to re-stage.

On a fingerprint miss the hub is fail-closed and gives you no diagnostic:
`hub/src/auth/identity.ts:100` — `if (!row) return { kind: 'anonymous' };` — which every machine
route turns into a 401. A verified-but-unmapped cert and no cert at all are indistinguishable from
the response.

## 7. Install the new material on each collector (Path B)

### 7.1 `amet-wsl` — POSIX / OpenSSL curl, file-based PEM

`collector/src/agent_collector/transport.py:130-131` — a PEM cert + key presented via
`--cert`/`--key`. Paths must be absolute; `collector/src/agent_collector/config.py:510-512` notes a
relative path breaks scheduled runs that start from another cwd.

```bash
install -m 0600 "$MTLS/amet-wsl.client.key" ~/.config/agent-collector/amet-wsl.client.key
install -m 0644 "$MTLS/amet-wsl.client.pem" ~/.config/agent-collector/amet-wsl.client.pem
```

`~/.config/agent-collector/config.toml`:

```toml
machine_id = "amet-wsl"
hub_url = "https://api.sessions.pedrovc.com.br"
auth = "mtls"
client_cert_path = "/home/pedro/.config/agent-collector/amet-wsl.client.pem"
client_key_path = "/home/pedro/.config/agent-collector/amet-wsl.client.key"
```

Keep the existing `[stores]` block and `include_windows_mounts` verbatim — re-enrolling must not
revert customized roots (`config.py:459-462`).

### 7.2 `amet-windows` and `vm-solidworks-windows` — Windows / Schannel, cert store by thumbprint

Windows `curl.exe` is Schannel-backed and **refuses file-based client certs**. Verified table at
`infra/cf/mtls.md:123-127`: `--cert cert.pem --key key.pem` fails, `--cert client.p12 --type P12`
gives `SEC_E_INTERNAL_ERROR`, and only `--cert "CurrentUser\MY\<thumbprint>"` returns 200. The
collector emits exactly that form with no `--key`
(`collector/src/agent_collector/transport.py:132-136`).

Build the PFX and read the thumbprint (Linux side):

```bash
cd "$MTLS"
for m in amet-windows vm-solidworks-windows; do
  PW=$(openssl rand -base64 24)
  openssl pkcs12 -export -inkey "$m.client.key" -in "$m.client.pem" \
    -name "$m" -out "$m.client.pfx" -passout "pass:$PW"
  chmod 0600 "$m.client.pfx"
  echo "$m PFX password: $PW"          # hand-carry, do not commit
  printf '%s thumbprint: ' "$m"
  openssl x509 -in "$m.client.pem" -noout -fingerprint -sha1 \
    | sed 's/.*=//; s/://g' | tr 'a-f' 'A-F'
done
```

On the target box, native PowerShell:

```powershell
$pw = Read-Host -AsSecureString "PFX password"
Import-PfxCertificate -FilePath .\amet-windows.client.pfx `
  -CertStoreLocation Cert:\CurrentUser\My -Password $pw
# verify it landed WITH a private key — a cert without one fails the handshake (run.py:892-897)
Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -like '*amet-windows*' } |
  Select-Object Thumbprint, HasPrivateKey, NotAfter
Remove-Item .\amet-windows.client.pfx -Force
```

Then edit `C:\Users\pedro\.config\agent-collector\config.toml` (and the equivalent on the
SolidWorks VM):

```toml
machine_id = "amet-windows"
hub_url = "https://api.sessions.pedrovc.com.br"
auth = "mtls"
client_cert_thumbprint = "<uppercase SHA-1, no separators>"
```

`client_cert_thumbprint` and `client_cert_path`/`client_key_path` are mutually exclusive —
setting both is rejected as ambiguous (`collector/src/agent_collector/config.py:220-235`). The
current `amet-windows` thumbprint is `BA5556284E8636F3BAD1D8573C35D6A9C345EEBA`; record it before
overwriting, it is the rollback value.

### 7.3 Validate, every box

```
uv run agent-collector doctor        # includes the cert-store check, run.py:866-911
uv run agent-collector run --once
```

`doctor` performs an authenticated `/api/v1/status` probe with the client cert, so a 200 proves the
edge verified the cert AND the hub matched a `machines` row.

### 7.4 Not this agent's scope, but BOTH paths are blocked without it

`hub/wrangler.jsonc` must be flipped and deployed first, or `$NEW_HOST` never reaches the Worker
and renewals keep targeting the wrong CA:

* `:19` — route `api.sessions.vza.net` → `api.sessions.pedrovc.com.br` (`custom_domain: true`)
* `:29` — `API_HOST` → `api.sessions.pedrovc.com.br`. `hub/src/router.ts:62` sends every
  production request on `API_HOST` to `apiRoute`, so this is what makes the new host an API host.
* `:34` — `CF_ZONE_ID` → `ff45a32e60c41cefd2fe5ff1c8eb61fb`. This is the single zone
  `POST /api/v1/certs/renew` and the prune's revoke path use
  (`hub/src/auth/cloudflare-oauth.ts:164-165,293`). Until it is flipped, a renewal mints its
  successor from the OLD zone's endpoint.
* `:36` — `CF_OAUTH_REDIRECT_URI` is on the viewer host; the Cloudflare OAuth client's registered
  redirect URL must keep matching a hostname this Worker actually serves, or cert automation
  cannot be re-authorized.

### 7.5 Deferred: the stale `cert_id` BOOKKEEPING (this, and only this, is optional)

Scope note: §0.2 makes the **re-mint** mandatory. What this subsection calls deferred is narrower
— the `cert_id` column values themselves, i.e. the CA handles, not the certificates. If you are
running the Path A bridge, the three `machines` rows temporarily keep the fingerprints and
`cert_id`s of certs minted through `/zones/6a56cdda…/client_certificates`. Consequences while the
bridge is up, all tolerable:

* **Ingest, heartbeats, uploads, `/status`, `/machines`, `/usage`: entirely unaffected.** The hub
  authenticates by FINGERPRINT only (`hub/src/auth/identity.ts:91-99`); `cert_id` is never
  consulted on the request path. It is purely a CA handle used to revoke
  (`hub/migrations/0005_cert_rotation.sql:10-11`).
* **`POST /api/v1/certs/renew` still works**, and self-heals: it signs a fresh CSR against the
  configured (new) zone and writes the new id into `cert_id`
  (`hub/src/api/certs.ts:484-489`). The only casualty is the *displaced* old cert — its id goes to
  `prev_cert_id` and then to `retired_certs`, where the daily prune's revoke targets the new zone
  and 404s. `revokeClientCert` maps 404 → `'revoked'` (`hub/src/api/certs.ts:90`), so the row gets
  stamped revoked without a real revocation. The reason originally given here — "the cert has no
  hostname left to authenticate against once its zone leaves the account" — is WRONG, on the same
  measurement as §0.1's CORRECTION and for the same reason as §7.5: the account CA still validates
  that cert on `api.sessions.pedrovc.com.br`, so it authenticates fine. What actually bounds it is
  D1 (`cert_revoke_at`), plus a real revoke on the `moved` husk, which remains reachable.
* **No same-day urgency for the bookkeeping.** All three certs are valid until `2027-07-17`
  (`notAfter` on the local `amet-wsl.client.pem`; the fleet was enrolled with
  `validity_days: 365` on the same day). `amet-wsl` has already run for over a month with
  `cert_id = NULL` — the schema explicitly tolerates unknown ids
  (`hub/migrations/0005_cert_rotation.sql:13-14`, `hub/src/api/ops.ts:356-359`).

**Deadline that IS real:** the re-mint (§5–§7) plus the old-cert revoke (§8, last block) must both
complete BEFORE `vza.net` is handed to `vza-net-prod`, per §0.1–§0.2. After that handover the old
certs can never be revoked by anyone in this account.

Lowest-effort way to do the re-mint, if you would rather not hand-carry CSRs: once the flipped
`CF_ZONE_ID` is deployed, have each collector call `POST /api/v1/certs/renew` once. That mints
from the new zone, swaps the fingerprint into the current slot, puts the old one in a 7-day grace
window, and records the new `cert_id` — the same end state as §5–§6 with no manual steps
(`hub/src/api/certs.ts:471-497`). The CSRs in `$MTLS` remain the fallback for a box that cannot
reach the renew endpoint, and for `vm-solidworks-windows`, which has been offline since
2026-08-15 and may need a hands-on visit anyway.

## 8. Rollback

**If a collector fails to present the new cert** (doctor red, uploads 401/403):

1. **Collector-side, no hub change.** Restore the previous config: `hub_url` back to
   `https://api.sessions.vza.net`, plus `client_cert_thumbprint` back to
   `BA5556284E8636F3BAD1D8573C35D6A9C345EEBA` (amet-windows) or the PEM paths back to
   `amet-wsl.client.{pem,key}`. Nothing was deleted, so this is a pure config revert.
   Under §6.2 the old fingerprint is live in the grace slot for 7 days, so the hub still maps it —
   just without admin (`hub/src/auth/identity.ts:101`), which affects only
   `/api/v1/admin/*`; heartbeats, uploads and `/status` are unaffected.
   **This works only while the `vza.net` zone is still in account `18ef3246…`.** Once that zone
   moves, `api.sessions.vza.net` stops terminating this mTLS and rollback target 1 is gone. Do the
   whole collector cutover *before* handing `vza.net` over, and keep the old hostname associated
   and routed until every box is green.

2. **Hub-side, undo the D1 swap.** Reverse §6.2 for one machine:

   ```sql
   UPDATE machines
      SET cert_fp_sha256      = prev_cert_fp_sha256,
          cert_id             = prev_cert_id,
          prev_cert_fp_sha256 = NULL,
          prev_cert_id        = NULL,
          cert_revoke_at      = NULL
    WHERE machine_id = 'amet-windows'
      AND cert_fp_sha256 = '<new fp>'
      AND prev_cert_fp_sha256 = '1152bdfb152001dee6be77521a8c6bc5b6e79c59e7baffc0bbbcca4e0c05da31'
      AND cert_revoke_at > strftime('%Y-%m-%dT%H:%M:%fZ','now');
   ```

   Do this before the grace window elapses. After it elapses, the prune has moved the old
   fingerprint into `retired_certs` (`hub/src/cron/prune.ts:65-75`) and reinstating it needs the
   `POST /api/v1/admin/machines` reinstatement path, which requires an unclaimed reservation
   (`hub/src/api/ops.ts:421-425`).

3. **Worst case — locked out of every admin cert.** Direct D1 writes with the
   `sessions-prod` wrangler profile do not need mTLS at all, so a `machines` row can always be
   repaired out-of-band. That is the true floor; there is no scenario requiring cert re-issue to
   regain access.

### 8.1 The old `vza.net` certs: keep, then REVOKE once each box is on its new cert

Two-stage, and the ordering is the whole point — but the ordering is set by the grace fallback, not
by the (nonexistent) handover deadline:

**Stage 1 — keep them while the cutover is in flight.** They are the rollback credential in
point 1 above. Do not revoke anything until every collector is green on
`api.sessions.pedrovc.com.br` with a `pedrovc.com.br`-minted cert.

**Stage 2 — revoke them once every collector is green on a `pedrovc.com.br`-minted cert.** The
earlier text called this mandatory *before* handing `vza.net` to `vza-net-prod`, on the theory that
the revoke verb becomes unreachable afterwards. Measured false — see §0.1's CORRECTION: the move
leaves a `status: "moved"` husk of the zone in `sessions-prod`, and
`GET /zones/$OLD_ZONE/client_certificates` still returns all three certs from this account. There is
no ordering constraint against the zone move.

What DOES constrain the order is the grace fallback: the old cert is a machine's only working
credential until its new PFX is imported. Revoking early locks that box out. As of 2026-09-02
`vm-solidworks-windows` has NOT imported its new cert, so revoking now would strand it.

`DELETE /zones/{zone_id}/client_certificates/{id}` is still the only revoke verb, and the token
below needs SSL-and-Certificates Edit on the `vza.net` zone — which, since the husk stayed behind,
means a `sessions-prod` token, not a `vza-net-prod` one.

```bash
# 1. list the zone's certs (the `moved` husk still serves this) and capture the ids
curl -sS "$CF_API/zones/$OLD_ZONE/client_certificates" \
  -H "Authorization: Bearer <token with SSL-and-Certificates Edit on vza.net>" \
  | jq -r '.result[] | "\(.id)  \(.common_name)  \(.serial_number)  \(.status)  \(.fingerprint_sha256)"'

# 2. revoke — ONE MACHINE AT A TIME, and only after THAT box reports cert_slot='current' on its new
#    cert. Each id below is the machine's grace credential; revoking before import strands the box.
#    ids verified against fingerprints on the husk, 2026-09-02:
#      65913f0a-4b65-4047-9bb4-1e8e4f9f1590  amet-windows           fp 1152bdfb152001de…  ELIGIBLE
#      049d21f6-95ee-49a7-8efc-f92929cabaf2  amet-wsl, CN "Cloudflare"  fp 811800780425b3fe…  ELIGIBLE
#      2544a51d-fc9e-47f0-966e-2a789155ade0  vm-solidworks-windows  fp 53ba4e2bf19dd0dd…  DO NOT
#    ELIGIBLE = that box is confirmed running on its new cert (D1 cert_slot='current'). As of
#    2026-09-02 none of the three has actually been revoked yet; vm-solidworks-windows has a new
#    cert staged in D1 but has NOT imported it, so its grace credential is still load-bearing.
CID=""   # paste exactly ONE id from the list above
[ -n "$CID" ] || { echo "set CID to a single cert id first"; exit 1; }
curl -sS -X DELETE "$CF_API/zones/$OLD_ZONE/client_certificates/$CID" \
  -H "Authorization: Bearer <token with SSL-and-Certificates Edit on vza.net>" \
  | jq '.success, .result.status'

# 3. confirm. Revocation is ASYNCHRONOUS: expect pending_revocation, then revoked.
#    Re-run until all three read "revoked" (hub/src/api/certs.ts:69-71 documents the same lifecycle).
#    `?status=all` is REQUIRED: the default list returns ACTIVE ONLY, so without it a successful
#    revoke looks like the cert vanished (measured 2026-09-02: default n=3, status=all n=5).
curl -sS "$CF_API/zones/$OLD_ZONE/client_certificates?status=all" \
  -H "Authorization: Bearer <token with SSL-and-Certificates Edit on vza.net>" \
  | jq -r '.result[] | "\(.common_name)  \(.status)"'
```

`amet-wsl`'s old cert has `cert_id = NULL` in D1, so its id could not be read from D1. It has now
been resolved off the husk and inlined in step 2: `049d21f6-95ee-49a7-8efc-f92929cabaf2`, bound to
serial `2307C4CF6D3B2A420971AF0656CDA7397DB05773` and
`fingerprint_sha256 = 811800780425b3fe6455fbb2d0c45c5337fd28e741a01d621621fcc38a7b379f`. Its
`common_name` is the string `Cloudflare` (see §5.1), not `amet-wsl`, so do not match on name — and
note a *revoked* `vm-solidworks-windows` entry also exists (`d2bfa96d-…`, revoked 2026-07-20), so
match on fingerprint, never on name plus status.

Note: revoked managed-CA client certs cannot be deleted, only revoked — "It is not possible to
permanently delete client certificates generated with the default Cloudflare-managed CA. Once
revoked, these client certificates will still be listed … and can be restored at any time"
(<https://developers.cloudflare.com/ssl/client-certificates/revoke-client-certificate/>). So the
three entries will remain visible under `vza.net` with `status: revoked`, which is the intended end
state — but only under `?status=all`; the default list filters them out (measured, see step 3). The
restore capability does NOT leave with the zone: the husk stays in `sessions-prod`, so restore is
still ours too.

**Do NOT rely on the hub's prune to do this.** After `CF_ZONE_ID` is flipped, the prune would send
`DELETE /zones/ff45a32e…/client_certificates/<old-vza-id>` — wrong zone — get a 404, and
`revokeClientCert` maps 404 → `'revoked'` (`hub/src/api/certs.ts:90`), stamping `retired_certs`
revoked without any real revocation having happened. That audit trail would be a false negative.
Revoke manually via the commands above, against the old zone's `moved` husk.

---

### 8.2 FOLLOW-UP DEFECT (not part of this cutover, do not fix here)

**Captured because it outlives this migration.** The 404 behaviour noted at the end of §8.1 is not
merely a cutover inconvenience; it is a latent correctness bug in the cert-rotation bookkeeping,
independent of any zone move. Recording it here so it is not lost. **It should be fixed in its own
change, not folded into this runbook.**

**Defect.** Both CA-status paths treat an HTTP 404 as positive proof of revocation. The DELETE
path:

```ts
// hub/src/api/certs.ts:88-90
// cert no longer exists — locking the machine onto an unauthenticatable current cert. So 404 → 'revoked',
// never 'failed'. (The poll path matches only the HTTP 404, not a body error code — mirror it exactly.)
if (res.status === 404) return 'revoked';
```

…and the GET path, whose `'not_found'` `pollRetired` maps onto the revoked-and-settled terminal
state:

```ts
// hub/src/api/certs.ts:112
if (res.status === 404) return 'not_found';

// hub/src/api/certs.ts:315-318
if (status === 'revoked' || status === 'not_found') {
  await stampRevoked(env, certId); // terminal on success; on failure the claim is kept, prune re-polls
  return 'revoked';
}
```

The two are deliberately kept in lockstep (`hub/src/api/certs.ts:83-89` explains why: release-vs-settle
feeds the reinstatement guard), so the defect is symmetric across both — fixing one without the
other would reintroduce the hazard those comments describe.

The 404 is read as "the cert is GONE at the CA — SETTLED" (`hub/src/api/certs.ts:83-84`). But the
request URL is built from the Worker's *currently configured* zone:

```ts
// hub/src/auth/cloudflare-oauth.ts:293-294
const base = `https://api.cloudflare.com/client/v4/zones/${zoneId}/client_certificates`;
const url = operation.kind === 'sign' ? base : `${base}/${encodeURIComponent(operation.cert_id)}`;
```

So **404 conflates two very different facts**: "this cert does not exist at the CA" and "this cert
does not exist *in the zone I am currently pointed at*". Any `cert_id` minted under a previous
`CF_ZONE_ID` produces the second while being recorded as the first.

**Why it is worse than a cosmetic audit lie.** `stampRevoked`'s own contract
(`hub/src/api/certs.ts:161-162`) is:

> Stamp a queued cert as revoked (returns its fingerprint to the reusable pool; the row is kept as
> an audit trail).

and the reservation check keys on exactly that column — `retired_certs_reserved` is a partial index
`WHERE revoked_at IS NULL` (`hub/migrations/0005_cert_rotation.sql:58-59`), and the claim guard is
`NOT EXISTS (… WHERE fingerprint = ?4 AND revoked_at IS NULL)` (`hub/src/api/ops.ts:413-417`). So a
falsely-stamped `revoked_at` **returns a still-CA-valid fingerprint to the reusable pool**, after
which another machine may legitimately claim it — and the old, never-revoked cert would then
authenticate as that machine. That is precisely the failure the migration comments were written to
prevent (`hub/migrations/0005_cert_rotation.sql:17-20`: keep an unconfirmed fingerprint as a
TOMBSTONE so "no other machine can claim a fingerprint whose cert might still authenticate";
"Only a confirmed CA revoke (known id) clears `prev_cert_fp_sha256`"). The 404 path bypasses that
intent by manufacturing a confirmation that never happened.

**Trigger conditions** (both real, neither exotic): any `CF_ZONE_ID` change with pre-existing
`cert_id`s in D1 — i.e. exactly this migration — or a mis-set / stale zone binding in any
environment.

**Proposed fix — sketch only, DO NOT IMPLEMENT AS PART OF THIS CUTOVER.** Make 404 ambiguous
rather than terminal. Options, roughly in order of preference:

1. **Record the minting zone.** Add a `zone_id` alongside `cert_id` (on `machines` and
   `retired_certs`) and address revoke/poll at the zone that minted the cert. Then a 404 from the
   correct zone genuinely means "gone", and a cert whose zone is no longer reachable is
   distinguishable rather than silently settled. This also un-breaks §7.5's stale handles properly.
2. **Verify the zone before trusting the 404.** On 404, `GET /zones/{CF_ZONE_ID}` (or list the
   zone's certs) to confirm the zone is the one that should hold this cert; treat
   404-with-zone-mismatch as `'unknown'`, which `pollRetired` already handles correctly by KEEPING
   the claim and retrying next run (`hub/src/api/certs.ts:338-340`) — no new state machine needed.
3. **Minimal, if neither is wanted:** stop mapping 404 → settled. Return `'unknown'` and let the
   existing staleness retry hold the reservation, emitting an alertable event so a permanently-404
   cert surfaces as an operator decision instead of an automatic — possibly false — revocation
   record.

Note that option 3 alone would change the behaviour §8.1 relies on being *harmless*, so whoever
takes this should re-read §8.1 first.

---

# CORRECTION + COMPLETION LOG (verified live 2026-09-01)

## C1. Certificates are MINTED, ACTIVE, and edge-verified

Issued in zone `pedrovc.com.br` (`ff45a32e60c41cefd2fe5ff1c8eb61fb`), 730-day validity,
expiring **2028-08-31T20:30:00Z**:

| machine | cert_id | sha256(DER) fingerprint |
|---|---|---|
| amet-wsl | `7daecd0b-862f-4805-a168-d552d0d041ec` | `910b54819abcae5a5956176976e31b62cf95eaccb41e543861020aa13cec01aa` |
| amet-windows | `788ce453-7d82-41e4-86e5-4f2ba11bcf42` | `f7fe20e8244d8769893e150eaec1ce039a68d97771f41fd92845f4a85c9fb970` |
| vm-solidworks-windows | `b07081df-baab-44fa-8be4-e05a8621f28a` | `7e13bcb9fbf2656c83e6a4b4fbb567e0703ebfeb11ab25208bf81c904efa870d` |

**Cross-zone verification (the key result):** the Managed CA is an *account*-scoped resource,
so a certificate issued in the `pedrovc.com.br` zone is accepted by the edge at
`api.sessions.vza.net` TODAY. Measured:

    no cert  -> 403 (WAF mTLS rule blocks)
    new cert -> 401 {"error":"unauthorized"}  (passed edge mTLS; rejected only by D1 lookup)

Consequence: **cert rotation is fully decoupled from the zone migration.** All three machines
can be rotated now, before any NS flip, and need no second rotation afterwards.

## C2. CORRECTION - `cert_revoke_at` is MANDATORY for the grace slot

§6 recommended a simultaneous current+grace swap but omitted `cert_revoke_at`. The grace
branch is gated on it (`hub/src/auth/identity.ts:96`):

    OR (prev_cert_fp_sha256 = ?1 AND cert_revoke_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))

`NULL > <timestamp>` is NULL, i.e. false. **Setting prev_cert_fp_sha256 while leaving
cert_revoke_at NULL kills the old certificate instantly** — measured: old cert 401 with the
prev slot populated, then 200 `cert_slot='grace'` after setting cert_revoke_at. Any rotation
that omits it is a hard cutover with no fallback.

## C3. amet-wsl - COMPLETE

D1 swapped (new=current, old=grace, `cert_revoke_at=2026-09-08T20:40:14Z`, `is_admin=1`
preserved), PEM+key installed, config rewritten. Collector doctor:

    [ok] authenticated hub identity: GET .../api/v1/status -> 200; machine='amet-wsl'; cert_slot='current'

Old material backed up at `~/.config/agent-collector/backup-premigration-20260901/`.

## C4. Remaining: two Windows collectors (Schannel - must run ON each box)

**Step 1 (D1) is DONE** - applied 2026-09-02T00:32:58Z/00:32:59Z. Verified state:

    amet-windows           cur=f7fe20e8244d8769 prev=1152bdfb152001de revoke=2026-09-09T00:32:58.688Z admin=1
    vm-solidworks-windows  cur=7e13bcb9fbf2656c prev=53ba4e2bf19dd0dd revoke=2026-09-09T00:32:59.819Z admin=0

**CORRECTION (2026-09-02).** An earlier draft of this section claimed the grace window was
"bookkeeping only" because the superseded certs were enrolled in the `vza.net` zone, which
left the account, so they "can no longer authenticate at all". That reasoning is WRONG and
was never tested. Measured instead:

- The client CA is **account**-scoped, not zone-scoped. The certificate itself says so - its
  issuer is `CN = Managed CA 18ef3246e9f36d1560485ef53889c0ab`, the sessions-prod ACCOUNT id.
  A cert minted before the zone move is still signed by the CA that `api.sessions.pedrovc.com.br`
  is associated with, so it still verifies at the edge.
- `hub/src/auth/identity.ts:93-101` then accepts it: `WHERE cert_fp_sha256 = ?1 OR
  (prev_cert_fp_sha256 = ?1 AND cert_revoke_at > now)`. A superseded fp matches the second
  arm, yielding `cert_slot='grace'` with `is_admin` forced false (line 101).

So the grace window is REAL and load-bearing until `2026-09-09T00:32:58Z`, after which hub
rejects those certs on its own regardless of Cloudflare revocation state. The practical
consequence the wrong claim would have hidden: repointing a Windows box's `hub_url` WITHOUT
importing the new PFX still works, read-only, until that date - a usable fallback.

Both boxes are nevertheless offline right now, but for a different reason than the certs:
their `config.toml` still points at `api.sessions.vza.net`, which stopped resolving when the
zone moved at 23:56:43Z. `amet-windows` last checked in 23:44:41Z, `vm-solidworks-windows`
on 2026-08-15 (long before this migration). The fix is the repoint, not the certificate.

`is_admin` was preserved by putting the new fp in the CURRENT slot.

PFX bundles are built and integrity-checked; passwords in the matching `.password` files.

| machine | PFX | SHA-1 thumbprint | new SHA-256 (in D1 now) | cert_id |
|---|---|---|---|---|
| amet-windows | `amet-windows.pedrovc.pfx` | `BA876F90606BDC54BBAB3F11D34C19BDB589956F` | `f7fe20e8…` | `788ce453-7d82-41e4-86e5-4f2ba11bcf42` |
| vm-solidworks-windows | `vm-solidworks-windows.pedrovc.pfx` | `E1C8FAF789C73A0EC091E00D259CF7969EFDF315` | `7e13bcb9…` | `b07081df-baab-44fa-8be4-e05a8621f28a` |

What remains is ONE command per box. `agent-collector enroll` has `--import-pfx`, which
imports into `Cert:\CurrentUser\My`, adopts the thumbprint, and deletes the PFX - so the
separate `Import-PfxCertificate` + `--client-cert-thumbprint` pair in the old draft is
unnecessary. `--hub` is REQUIRED (cli.py:77) and must be the new host; the config on both
boxes still points at the retired `api.sessions.vza.net`, so this repoints it in the same pass.

    # on the Windows box (PowerShell), from the collector checkout:
    $env:AC_PFX_PW = (Get-Content "<M>.pedrovc.pfx.password" -Raw).Trim()
    python -m agent_collector.cli enroll `
      --hub https://api.sessions.pedrovc.com.br `
      --import-pfx <M>.pedrovc.pfx `
      --machine-id <M>
    Remove-Item Env:\AC_PFX_PW

    # verify - must report cert_slot='current' (NOT 'prev')
    python -m agent_collector.cli doctor

`AC_PFX_PW` must be PLAINTEXT - `config.py:407` runs `ConvertTo-SecureString -AsPlainText`
on it. `.Trim()` is REQUIRED: both `.password` files end in `\n` (25 bytes incl. newline),
and `config.py:430` uses the value verbatim, so an untrimmed read fails the import.
Do NOT use `ConvertFrom-SecureString -AsPlainText` - that is PowerShell 7+ only and both
boxes may be on 5.1. Passing `--pfx-password` instead puts the secret in the process table.
Verified 2026-09-02: both PFX bundles open with the password from their `.password` file
(`openssl pkcs12 -passin pass:…` -> `CN = amet-windows` / `CN = vm-solidworks-windows`).

Verify host correction: the old draft's `curl … https://api.sessions.vza.net/api/v1/status`
is dead - that hostname resolves to nothing since the zone move. `doctor` reads the new host
from the config it just wrote, so it needs no hostname argument.

## C5. Deferred cleanup (after all three report cert_slot='current')

Revoke the three superseded `vza.net`-zone client certificates. Do NOT revoke before then —
revocation is what actually breaks the grace fallback.

---

# 9. Hub host cutover — verified prerequisites (added 2026-09-01, post-CSR)

Everything below was verified against live state or source, not inferred.

## 9.1 `wrangler deploy` REPLACES custom domains — config must list all four

`sessions-hub` config previously listed 2 custom domains while the live Worker had 4
(the `pedrovc` pair was attached out-of-band via API). wrangler's trigger step sends
`PUT .../domains/records` with `replace_state=true`; any attached custom domain absent
from `routes` is DETACHED. Verified present in the bundle the hub actually runs
(wrangler 4.111.0): strings `domains/records`, `replace_state=true`,
`PUT will delete previous routes`; no `keep-routes` opt-out exists.

FIXED: `hub/wrangler.jsonc` now lists all four. Verified `config set == live set`,
`would be DETACHED by a deploy: none`, and `wrangler deploy --dry-run` passes.

Drop the `vza.net` pair only after every collector has moved, as its own deploy.

Do NOT use `--routes` to add domains: it REPLACES `config.routes` (silently dropping
the vza.net entries). `--domain`/`--domains` appends.

Non-TTY stdout (any scripted/captured run) skips the interactive changeset preview and
forces `override_existing_origin`/`override_existing_dns_record` true. Harmless here
(all four hostnames already belong to this Worker), but run the real deploy on a TTY
to see the diff.

## 9.2 Four vars carry stale identity — not two

| var | current | must become |
|---|---|---|
| `API_HOST` | `api.sessions.vza.net` | `api.sessions.pedrovc.com.br` |
| `VIEWER_HOST` | `sessions.vza.net` | `sessions.pedrovc.com.br` |
| `CF_OAUTH_REDIRECT_URI` | `https://sessions.vza.net/oauth/cloudflare/callback` | `https://sessions.pedrovc.com.br/oauth/cloudflare/callback` |
| `CF_ZONE_ID` | `6a56cdda…` (vza.net) | `ff45a32e60c41cefd2fe5ff1c8eb61fb` (pedrovc.com.br) |

`R2_DASHBOARD_BASE_URL` does NOT change — its account `18ef3246…` keeps the R2 bucket.

`CF_ZONE_ID` is load-bearing beyond config: `hub/src/auth/cloudflare-oauth.ts:293` builds
`zones/${zoneId}/client_certificates`. Left stale, hub self-service rotation mints certs
in `vza.net` while the hostname association lives in `pedrovc` — certs that verify nowhere.

## 9.3 OAuth client redirect — DONE, no manual step remains

Client `0455069be2aea97dd2812497f3ba0dfe` (`agent-sessions-hub`) is reachable at
`GET/PATCH /api/v4/accounts/{account}/oauth_clients/{client_id}` from an authenticated
dash session. `redirect_uris` is an array, so the new callback was added ADDITIVELY:

    https://sessions.vza.net/oauth/cloudflare/callback          (kept)
    https://sessions.pedrovc.com.br/oauth/cloudflare/callback   (added 2026-09-01)

Verified post-PATCH that `grant_types`, `response_types`, `scopes` and
`token_endpoint_auth_method: none` are unchanged. Both hosts can complete the flow, so
this is safe before, during, and after cutover. Remove the vza.net entry only at teardown.

Pre-existing, NOT caused by this change: `client_uri_verification.status = "failed"`
(`client_uri` is `https://sessions.vza.net`). The flow works regardless.

## 9.4 Passkey reset ordering — `SETUP_TOKEN` FIRST

`SETUP_TOKEN` is `secret_text`: Cloudflare never returns its value, so the current one is
UNREADABLE. `hub/src/auth/webauthn.ts:279-283` makes the token dead once any credential
exists (`count > 0` requires an authenticated session).

**CORRECTION (2026-09-02).** The earlier wording — "deviating locks the viewer out with no
recovery path" — was WRONG, and it was never tested. `wrangler secret put` is an
account-level Cloudflare API call that does not consult hub auth at all, so the token can be
rotated at ANY time, including after `DELETE FROM credentials`. Deleting first is recoverable:
rotate, then bootstrap. Measured proof (`sessions-hub`, 2026-09-02T00:36Z): wrote and deleted
a throwaway `ORDERING_PROBE` secret with one credential present and no session — both
succeeded. There is no lockout state reachable while you hold account access.

The real hazard of the wrong order is the OPPOSITE of a lockout, and worse for being quiet:
between `DELETE FROM credentials` and the rotation, `authorizeRegistration` falls through to
`count === 0`, so the CURRENT token — whose value you cannot read, and whose age and exposure
you cannot audit — becomes a live first-passkey enrollment key for anyone who can reach
`/login?setup=…`. That is an unauthenticated account-takeover window, not an outage.

So the ordering below still stands, but for a security reason, not a recovery one:

1. `wrangler secret put SETUP_TOKEN` (to a value you record) — BEFORE deleting anything.
   This makes the takeover window inert: only your new value opens it.
2. Flip the four vars in 9.2, `wrangler deploy`.
3. `DELETE FROM credentials` (no inbound FKs).
4. Re-bootstrap at `https://sessions.pedrovc.com.br/login?setup=<the token from step 1>`.

Passkeys cannot be carried over: `webauthn.ts:71` pins `rpID` to `VIEWER_HOST`. Confirmed
live 2026-09-02 — `POST /webauthn/auth/options` on the new host returns
`rpId: sessions.pedrovc.com.br`, while the single stored credential
(`r57_oXEFDdrwAMVrGqJDHG…`, last used 2026-07-17) was minted under `sessions.vza.net`. The
authenticator will not match it, so that row is already dead weight rather than a fallback.

Also measured: registration is genuinely closed right now. With one credential present,
`POST /webauthn/register/options` returns 403 `forbidden` both with a wrong token and with
none — and 403 `bad_origin` before that if the `Origin` header is missing, so any probe must
send `Origin: https://sessions.pedrovc.com.br` to reach the real check.

---

# 10. Cutover EXECUTED (2026-09-01/02)

Everything below is measured state, not plan.

## 10.1 vza.net left sessions-prod

Inter-account Registrar move via the dash wizard (`POST
/registrar/accounts/{src}/domains/vza.net/move_request`, HTTP 201), accepted on
the destination, completed `2026-09-01T23:56:43Z`.

    vza.net  [active] acct=vza-net-prod       <- live
    vza.net  [moved]  acct=sessions-prod      <- inert husk, left in place

Record parity after the move: 29 old -> 27 new. The only two missing were the
Worker-generated `AAAA 100::` placeholders for the sessions hostnames, which
cannot follow cross-account. `www.vza.net` returns 522 on BOTH zones - a
pre-existing proxied `A 192.0.2.1` with no matching Worker route, not a
regression.

## 10.2 Bridge folded away

`vza-net-router-bridge` existed only because a Worker in `vza-net-prod` could
not bind a hostname in a zone owned by `sessions-prod` (cross-account Custom
Domain = Error 1014). Once the zone moved, that constraint evaporated.

Removed: `src/bridge.ts`, `wrangler.bridge.jsonc`, the
`x-vza-router-host` / `x-vza-router-token` protocol, its tests, and the
`ROUTER_BRIDGE_TOKEN` secret. All four hostnames now answer
`x-vza-router: vza-net-prod` directly.

TRAP HIT HERE: `vza-net-router/wrangler.jsonc` had **no `routes` array** while
four Custom Domains were live. Deploying as-is would have detached all four,
the same `replace_state=true` destroyer documented in 9.1. Pinned all four into
`routes` first; `--dry-run` then asserted `set(live) - set(config) == {}`.

## 10.3 Hub host cutover

Deployed on a TTY with all four identity vars flipped together:

    API_HOST                api.sessions.pedrovc.com.br
    VIEWER_HOST             sessions.pedrovc.com.br
    CF_OAUTH_REDIRECT_URI   https://sessions.pedrovc.com.br/oauth/cloudflare/callback
    CF_ZONE_ID              ff45a32e60c41cefd2fe5ff1c8eb61fb
    R2_DASHBOARD_BASE_URL   UNCHANGED (R2 bucket stays in sessions-prod)

The two dead `vza.net` Custom Domains were detached via the Workers API BEFORE
deploying, and dropped from `routes`, so wrangler's reconciliation had nothing
to silently remove.

Verified: viewer `/healthz` 200, `/login` 200, `/api/v1/status` 401; API host
bare 403 (WAF cert-verified rule) and 200 with the amet-wsl client cert,
reporting `machine='amet-wsl' cert_slot='current'`; `api.sessions.vza.net` 000.
Live collector `config.toml` repointed; `agent-collector doctor` green
end-to-end. Full hub suite 42 files / 907 tests, unchanged from the
pre-migration baseline.

## 10.4 THE CERT PACK TRAP - read this before any zone move

**A Workers-provisioned advanced certificate pack ordered while its zone is
still `pending` never issues. It sits in `pending_validation` indefinitely.**

Measured twice, same day, two different zones:

| zone | pack created | zone activated | outcome |
|---|---|---|---|
| pedrovc.com.br | 20:07Z (pending) | 23:16Z | stuck 4h+ |
| vza.net | 20:02Z (pending) | 23:56Z | stuck 4h+ |

A pack ordered AFTER activation issues in about **90 seconds** (`8944ea64`,
created 00:16:49Z, active by 00:18Z).

This is NOT a DCV problem, and the instinct to hand-write `_acme-challenge`
TXT records is wrong. `dig TXT _acme-challenge.<host> @<assigned-ns>` returns
values matching the pack exactly - Cloudflare publishes DCV at the edge without
any visible record in the zone's DNS list. Validation simply cannot start while
the zone is `pending`.

### Why it bites asymmetrically

Universal SSL covers the apex plus exactly ONE label (`*.zone`), and it is
created at ACTIVATION, so it is always healthy. Therefore:

- 1-label hosts (`artifacts.vza.net`, `sessions.pedrovc.com.br`) silently ride
  Universal SSL and look fine. Their dedicated packs are stuck but redundant.
- **N-label hosts (`el400.ppe.vza.net`, `api.sessions.pedrovc.com.br`) have no
  cert at all** and fail the handshake with TLS alert 40.

Symptom is `curl` 000 plus
`sslv3 alert handshake failure ... no peer certificate available`.

### Fix

Re-provision the Custom Domain so Cloudflare mints a fresh pack against the
now-active zone: `DELETE /accounts/{a}/workers/domains/{id}` then
`PUT /accounts/{a}/workers/domains` with the same hostname/service/zone_id.

Zero risk on a host that is already failing. On a host that is WORKING via
Universal SSL, this briefly deletes its proxied DNS record - do not do it for
cosmetics.

### Ordering rule

Activate the zone FIRST, then attach N-label Custom Domains. Attaching before
activation buys nothing and costs a stuck pack.

### Verify with a hostname-validating client

`openssl s_client` does NOT check the name by default, so it reports a
handshake against the wrong cert as success. It printed `subject=CN = vza.net`
for `el400.ppe.vza.net` while that host had no valid cert. Confirm with
`curl -w '%{ssl_verify_result}'` (want 0) and read the SANs:

    openssl s_client -connect <ip>:443 -servername <host> </dev/null \
      | openssl x509 -noout -ext subjectAltName

## 10.5 Residual state, deliberately left alone

- Three stuck `pending_validation` packs on `vza.net` for `artifacts`, `go`,
  `el400`. Those hosts validate clean (`ssl_verify=0`) under Universal SSL
  `*.vza.net`. Re-provisioning would blip live traffic to fix bookkeeping. Left.
- `el400.ppe.vza.net` returns 530 AFTER the TLS fix. Pre-existing: its origin
  `el400-ppe.el400-ppe-vza-net-prod.workers.dev` does not exist, and that PPE
  Worker lives under the `vezza.com.br` identity.
- `vza.net [moved]` husk in sessions-prod. Inert.
- Analytics history does not cross accounts. The killapikeys destination got a
  new RUM site; the old stream stays behind.

# 11. Post-cutover observations (measured 2026-09-02)

Everything here is measured on the live system, not inferred.

## 11.1 The `hub_url` repoint re-offers the entire corpus, by design

Repointing `amet-wsl`'s `config.toml` at the new host did not just change a URL. `State._reconcile_identity`
(`collector/src/agent_collector/state.py:155-175`) treats `machine_id` + `hub_url` as the identity of the
local fast-path cache, and on a change runs:

    UPDATE files SET status = 'pending', error = NULL
    DELETE FROM asset_scans

The reason is sound: the hub object key includes `machine_id`, so 'ok' rows would satisfy the size+mtime
fast path and the new namespace would never receive the corpus. The buffered event proves it fired:

    [hub_url_changed] hub_url changed 'https://api.sessions.vza.net'
                      -> 'https://api.sessions.pedrovc.com.br'; re-offering all files

Measured drain on the scheduled `run --once` path: **3.0 files/s** (10261 ok / 53659 pending), i.e. about
**5 hours** for the 63920-file corpus. That is not a hang - it is one serial curl per file
(`run.py:_do_run -> _process_item -> transport.put`).

Worth knowing: the batch path exists but belongs to a different subcommand. `backfill` uses the hub's
`files/check` (BACKFILL_CHUNK=500, limit 1000) plus `upload_batch` (50 URLs per curl invocation) and
defaults to concurrency 6. The state.py docstring's "files/check cheaply resyncs what the hub already
has" describes `backfill`, while the systemd timer runs `run`. After an identity change, `backfill` is
the cheaper way to reconcile - it could not be measured here because `run` held the OverlapLock.

Overlap itself is safe: `OverlapLock` makes a second invocation print "another collector run holds the
lock; exiting cleanly" and return 0, so the 15-minute `OnUnitActiveSec` timer cannot pile up behind a
long pass.

## 11.2 An empty `--cert` in the process table is curl, not a bug

`pgrep`/`/proc/<pid>/cmdline` on the collector's curl child shows `--cert` followed by a run of spaces
exactly as long as the path it replaced (55 chars for `amet-wsl.client.pem`). This looks alarming - a
handshake with no client certificate - and it is a dead end. curl scrubs the argument itself, because
the option syntax is `--cert <certificate[:password]>` and the value may carry a password.

Positive control, with a plain curl of our own:

    curl --cert amet-wsl.client.pem --key ... &   # then read /proc/<pid>/cmdline
    --cert value: len=19 all_spaces=True          # 19 == len("amet-wsl.client.pem")

`--key` is NOT scrubbed, which is why only one of the two looks empty. Do not chase this.

## 11.3 Fleet liveness after the move

    machine                 last_seen                  state
    amet-windows            2026-09-01T23:44:41Z       offline: config still on api.sessions.vza.net
    amet-wsl                2026-09-01T23:50:41Z       repointed; mid re-offer (see 11.1)
    vm-solidworks-windows   2026-08-15T21:45:14Z       offline since well before this migration

`vm-solidworks-windows` being 17 days stale is pre-existing, not a migration regression.
