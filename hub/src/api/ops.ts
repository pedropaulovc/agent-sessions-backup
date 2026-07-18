import type { Identity } from '../auth/identity';
import { detect } from '../ingest/detect';
import { getClientCertFingerprint, queueRetiredIfDisplaced, rotationCas, settleRetired, type RotationState } from './certs';
import { normalizeToBound } from './sessions';

/** POST /api/v1/heartbeat */
export async function heartbeat(request: Request, env: Env, identity: Identity): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await request.json()) as {
    collector_version?: string;
    stores?: Record<string, unknown>;
    events?: Array<{ level: string; code: string; message: string; count?: number; store?: string }>;
  };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO heartbeats (machine_id, collector_version, stats) VALUES (?1, ?2, ?3)').bind(
      identity.machineId,
      body.collector_version ?? null,
      JSON.stringify({ stores: body.stores ?? {}, events: body.events ?? [] }),
    ),
    env.DB.prepare(
      `UPDATE machines SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), collector_version = ?2 WHERE machine_id = ?1`,
    ).bind(identity.machineId, body.collector_version ?? null),
  ]);
  console.log(JSON.stringify({ event: 'hub.heartbeat', machine: identity.machineId }));
  for (const e of body.events ?? []) {
    // Nest the machine-supplied event under `payload` — NEVER spread it at top level. Spreading let a
    // collector set `event`/`machine` itself and forge a hub log line (e.g. hub.certs.cf_auth_failed) to
    // page us with a fake dead-token alert or bury a real one. `event` and `machine` (from the cert
    // identity) stay hub-controlled; nothing in `payload` can collide with them. collector-errors.kql
    // reads body.payload.{level,code,message} to match.
    console.log(JSON.stringify({ event: 'collector.event', machine: identity.machineId, payload: e }));
  }
  return Response.json({ ok: true });
}

/** GET /api/v1/machines */
export async function listMachines(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT machine_id, os, hostname, key_protection, priority, collector_version, last_seen_at, last_upload_at, created_at
     FROM machines ORDER BY machine_id`,
  ).all();
  return Response.json({ machines: rows.results });
}

/** POST /api/v1/admin/machines — admin-flagged cert only (mirrors reindex's gate). Upserts one
 * machine row (register a fingerprint, set priority/is_admin/…) and returns the full roster.
 * There is deliberately NO delete path — decommissioning revokes the cert, it doesn't drop the row
 * (which files/sessions FK-reference). */
/** Validate the cert fields BEFORE any cert logic, so a malformed value can't slip past the truthy
 * guards below (which skip on "") into a store or a swap. cert_id, if present, must be a non-empty
 * string (a "" would be skipped by `if (body.cert_id)` yet stored by `?? existing`, and settle/prune
 * treat "" as missing → the real cert never gets revoked). cert_fp_sha256, if present, must be 64 hex
 * chars — a blank/garbage value would flip fpChanged, retire+revoke the REAL certs, and store a value no
 * CF fingerprint can ever match (permanent lockout by typo). Accept uppercase and normalize to lowercase
 * IN PLACE (cf.tlsClientAuth's fp is lowercase hex). Returns a 422 Response on any violation, else null. */
function validateCertFields(body: { cert_id?: string; cert_fp_sha256?: string }): Response | null {
  if (body.cert_id !== undefined && (typeof body.cert_id !== 'string' || body.cert_id.trim() === '')) {
    return Response.json({ error: 'invalid_cert_id' }, { status: 422 });
  }
  if (body.cert_fp_sha256 !== undefined) {
    if (typeof body.cert_fp_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.cert_fp_sha256.toLowerCase())) {
      return Response.json({ error: 'invalid_cert_fp' }, { status: 422 });
    }
    body.cert_fp_sha256 = body.cert_fp_sha256.toLowerCase();
  }
  return null;
}

export async function adminMachines(request: Request, env: Env, identity: Identity): Promise<Response> {
  if (identity.kind !== 'machine' || !identity.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    machine_id?: string;
    os?: string;
    hostname?: string;
    cert_fp_sha256?: string;
    cert_id?: string;
    key_protection?: string;
    is_admin?: boolean;
    priority?: number;
  };

  const invalidCert = validateCertFields(body);
  if (invalidCert) return invalidCert;

  // is_admin is a PRIVILEGE flag. A form serializing it as the string "false" is truthy, so the
  // `body.is_admin ? 1 : 0` below would grant admin — a privilege escalation by serialization bug.
  // Require an actual boolean; reject anything else before it can reach the integer conversion.
  if (body.is_admin !== undefined && typeof body.is_admin !== 'boolean') {
    return Response.json({ error: 'invalid_is_admin' }, { status: 422 });
  }

  if (body.machine_id) {
    // Two write paths. A request carrying NO cert fields (cert_fp_sha256/cert_id) is a metadata edit
    // (priority, is_admin, hostname, …) and MUST NOT touch the cert/rotation columns: otherwise a
    // partial edit that snapshotted the row before a concurrent renew landed would write the stale
    // fingerprint back and lock the machine out of its freshly-installed cert. A request that DOES
    // carry cert fields owns the cert columns and CASes on the fingerprint it observed.
    const touchesCert = body.cert_fp_sha256 !== undefined || body.cert_id !== undefined;

    if (!touchesCert) {
      // Metadata-only upsert: read-merge-write the NOT NULL non-cert columns, leaving every cert/
      // rotation column exactly as it stands in the row (untouched on conflict, defaulted on insert).
      const existing = await env.DB.prepare(
        `SELECT os, hostname, key_protection, is_admin, priority FROM machines WHERE machine_id = ?1`,
      )
        .bind(body.machine_id)
        .first<{ os: string; hostname: string | null; key_protection: string; is_admin: number; priority: number }>();
      const os = body.os ?? existing?.os ?? 'unknown';
      const hostname = body.hostname ?? existing?.hostname ?? null;
      const keyProtection = body.key_protection ?? existing?.key_protection ?? 'software';
      const isAdmin = body.is_admin !== undefined ? (body.is_admin ? 1 : 0) : existing?.is_admin ?? 0;
      const priority = body.priority ?? existing?.priority ?? 100;
      await env.DB.prepare(
        `INSERT INTO machines (machine_id, os, hostname, key_protection, is_admin, priority)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (machine_id) DO UPDATE SET
           os = ?2, hostname = ?3, key_protection = ?4, is_admin = ?5, priority = ?6`,
      )
        .bind(body.machine_id, os, hostname, keyProtection, isAdmin, priority)
        .run();
      console.log(JSON.stringify({ event: 'hub.admin.machine_upsert', machine: body.machine_id, is_admin: isAdmin }));
      const rows = await env.DB.prepare(
        `SELECT machine_id, os, hostname, key_protection, is_admin, priority, collector_version, last_seen_at, last_upload_at, created_at
         FROM machines ORDER BY machine_id`,
      ).all();
      return Response.json({ machines: rows.results });
    }

    // Reject a fingerprint still in use anywhere: another machine's current cert, another machine's
    // in-grace prev cert, OR a still-reserved entry in the retired_certs queue (a displaced cert
    // whose CA revoke hasn't been confirmed — it may still be valid at the CA, so reusing the fp
    // would let whoever holds the old cert authenticate as the new row). The queue is the single
    // source of truth for "reserved but not on a machines row"; prev columns now mean ONLY the grace
    // window. A managed cert fingerprint is unique per machine; letting two rows share one would make
    // machineIdentity's unordered .first() authenticate as whichever row it returned. This subsumes
    // the plain current-fp UNIQUE collision into an explicit 409 (clearer than a constraint catch).
    if (body.cert_fp_sha256) {
      const clash = await env.DB.prepare(
        `SELECT machine_id FROM machines WHERE (cert_fp_sha256 = ?1 OR prev_cert_fp_sha256 = ?1) AND machine_id != ?2
         UNION
         SELECT machine_id FROM retired_certs WHERE fingerprint = ?1 AND revoked_at IS NULL
         LIMIT 1`,
      )
        .bind(body.cert_fp_sha256, body.machine_id)
        .first<{ machine_id: string }>();
      if (clash) return Response.json({ error: 'fingerprint_in_use', machine_id: clash.machine_id }, { status: 409 });
    }

    // A body-supplied cert_id is a CA handle used to REVOKE — attaching machine A's id to machine B would
    // make B's next rotation revoke A's live cert (an A-side lockout). Reject if this id is already owned:
    // any OTHER machine's current/prev cert_id, OR a retired_certs row AT ALL. The retired_certs check is
    // NOT filtered on revoked_at: a still-reserved id is mid-revocation, and a CONFIRMED-revoked id is a
    // DEAD handle — attaching either to a fresh fingerprint lets a later prune poll that id, stamp the
    // fresh reservation revoked, and free a still-live fingerprint. Only body-supplied ids are checked;
    // ids carried from THIS row's own existing/prev columns below are already ours. Cheap SELECTs, before
    // any write.
    if (body.cert_id) {
      const idClash = await env.DB.prepare(
        `SELECT machine_id FROM machines WHERE (cert_id = ?1 OR prev_cert_id = ?1) AND machine_id != ?2
         UNION
         SELECT machine_id FROM retired_certs WHERE cert_id = ?1
         LIMIT 1`,
      )
        .bind(body.cert_id, body.machine_id)
        .first<{ machine_id: string }>();
      if (idClash) return Response.json({ error: 'cert_id_in_use', machine_id: idClash.machine_id }, { status: 409 });
    }

    // Read-merge-write so a partial upsert preserves unspecified columns instead of resetting the
    // NOT NULL ones (os/key_protection/is_admin/priority) to their table defaults.
    const existing = await env.DB.prepare(
      `SELECT os, hostname, cert_fp_sha256, cert_id, key_protection, is_admin, priority,
              prev_cert_fp_sha256, prev_cert_id, cert_revoke_at
         FROM machines WHERE machine_id = ?1`,
    )
      .bind(body.machine_id)
      .first<{ os: string; hostname: string | null; cert_fp_sha256: string | null; cert_id: string | null; key_protection: string; is_admin: number; priority: number; prev_cert_fp_sha256: string | null; prev_cert_id: string | null; cert_revoke_at: string | null }>();
    const os = body.os ?? existing?.os ?? 'unknown';
    const hostname = body.hostname ?? existing?.hostname ?? null;
    const certFp = body.cert_fp_sha256 ?? existing?.cert_fp_sha256 ?? null;
    const keyProtection = body.key_protection ?? existing?.key_protection ?? 'software';
    const isAdmin = body.is_admin !== undefined ? (body.is_admin ? 1 : 0) : existing?.is_admin ?? 0;
    const priority = body.priority ?? existing?.priority ?? 100;

    // When the admin swaps in a DIFFERENT current fingerprint, the row's rotation metadata (cert_id +
    // the prev/grace triple) belongs to the OLD cert and is now stale — a later renew would CAS
    // against a dead cert_id. Reset it and clear the grace window; the displaced old current/prev
    // certs are moved into the retired_certs queue after the write (below) so they stay reserved and
    // get revoked. Unchanged fp → keep the active rotation window untouched.
    //
    // Rollback special case: if the new current fp IS the row's in-grace previous fp, its CA id is
    // sitting right there in prev_cert_id — carry it into cert_id (unless the body supplies one) so
    // the reinstated cert keeps a live id.
    //
    // cert_id when fp is UNCHANGED: honor a body-supplied cert_id (an admin attaching/correcting a
    // missing CA id on a helper-enrolled row) instead of always keeping the stale existing value.
    const fpChanged = certFp !== (existing?.cert_fp_sha256 ?? null);
    const rollingBack = fpChanged && certFp !== null && certFp === (existing?.prev_cert_fp_sha256 ?? null);

    // A body cert_id equal to one of THIS row's OWN displaced handles must not ride onto the current
    // fingerprint (self-owned ids are excluded from the clash check above, so this is the only guard):
    //  - the in-grace PREV id, on ANY edit (fp changing or not): storing it on current while it still sits
    //    on the prev slot means the next rotation/prune revokes/stamps it out from under the live current.
    //  - on an fp CHANGE, the old CURRENT id too: it's being displaced and can't also be the new current's.
    // The one legit reuse is a rollback: the new fp IS the in-grace prev fp and the id IS that prev's own
    // id (reinstating the prev with its live handle). Re-supplying THIS row's unchanged current id is fine
    // (idempotent), so it is deliberately NOT rejected.
    if (body.cert_id) {
      const reusesOwnPrevId = body.cert_id === (existing?.prev_cert_id ?? null);
      const isRollbackId = rollingBack && reusesOwnPrevId;
      const reusesDisplacedCurrentId = fpChanged && body.cert_id === (existing?.cert_id ?? null);
      if ((reusesOwnPrevId && !isRollbackId) || reusesDisplacedCurrentId) {
        return Response.json({ error: 'cert_id_belongs_to_displaced_cert', machine_id: body.machine_id }, { status: 409 });
      }
    }

    // A cert_id is a CA revoke handle; it's meaningless without a fingerprint to bind it to. If the body
    // supplies an id but there's no effective certFp (row has no cert and the body omits cert_fp_sha256),
    // storing it would leave an unbound handle that a later fp-set silently drops (fpChanged resets
    // cert_id) — the minted cert then stays live but untracked. Require a fingerprint.
    if (body.cert_id && !certFp) {
      return Response.json({ error: 'cert_id_requires_fingerprint', machine_id: body.machine_id }, { status: 422 });
    }

    // Verify a body-supplied cert_id that is GENUINELY NEW to this row — i.e. not equal to its own current
    // or prev handle (those are trusted D1 state for this machine: an idempotent resubmit of the current
    // id, or a rollback reattaching the prev's own id, needs no CA reach). A genuinely new id could be a
    // wrong/foreign/dead handle; stored as current it's copied to prev on the next rotation, and the prune
    // then revokes/404s it and stamps the REAL fingerprint's reservation revoked while the actual cert
    // stays CA-valid and reusable.
    const attachingNewCertId =
      body.cert_id !== undefined && body.cert_id !== (existing?.cert_id ?? null) && body.cert_id !== (existing?.prev_cert_id ?? null);
    if (attachingNewCertId && certFp && body.cert_id !== undefined) {
      // FAIL CLOSED when we can't reach the CA to verify: the pre-secret deployment window is exactly when
      // an arbitrary/dead handle can slip in unverified and later be carried to prev + mis-revoked. 503
      // (not 422): the request may be perfectly valid — the deploy state just can't verify it yet. In this
      // same window renew can't mint either, so no legitimate cert_id attach arises from the fleet; only a
      // raw admin poke can, and that's precisely what must fail closed.
      if (!env.CF_ZONE_ID || !env.CF_CLIENT_CERT_TOKEN) {
        console.log(JSON.stringify({ event: 'hub.admin.machines.cert_id_unverifiable', machine: body.machine_id, cert_id: body.cert_id }));
        return Response.json({ error: 'cert_id_verification_unavailable', cert_id: body.cert_id }, { status: 503 });
      }
      // Fetch the cert by id: a mismatch / 404 / unresolvable id → 422 cert_id_fingerprint_mismatch; a
      // fp-match whose CA status is already pending_revocation/revoked → 422 cert_id_not_active (installing
      // a machine on a dying cert).
      const ca = await getClientCertFingerprint(env, body.cert_id);
      if (ca === 'not_found' || ca === 'unknown' || ca.fp !== certFp) {
        console.log(JSON.stringify({ event: 'hub.admin.machines.cert_id_unverified', machine: body.machine_id, cert_id: body.cert_id, ca_result: typeof ca === 'string' ? ca : ca.fp }));
        return Response.json({ error: 'cert_id_fingerprint_mismatch', cert_id: body.cert_id, ca: typeof ca === 'string' ? ca : ca.fp }, { status: 422 });
      }
      if (ca.status !== 'active') {
        console.log(JSON.stringify({ event: 'hub.admin.machines.cert_id_not_active', machine: body.machine_id, cert_id: body.cert_id, status: ca.status }));
        return Response.json({ error: 'cert_id_not_active', cert_id: body.cert_id, status: ca.status }, { status: 422 });
      }
    }

    const certId = fpChanged
      ? body.cert_id ?? (rollingBack ? existing?.prev_cert_id ?? null : null)
      : body.cert_id ?? existing?.cert_id ?? null;
    const prevFp = fpChanged ? null : existing?.prev_cert_fp_sha256 ?? null;
    const prevId = fpChanged ? null : existing?.prev_cert_id ?? null;
    const revokeAt = fpChanged ? null : existing?.cert_revoke_at ?? null;

    // On a fingerprint change, the swap displaces the old current out of its slot — and, unless we're
    // reinstating it as current (rollback), the old prev too. Each displaced cert must be reserved in
    // retired_certs so a still-CA-valid fingerprint can't be reclaimed by another machine. Reserve
    // the OLD CURRENT whenever it exists, UNCONDITIONALLY on its cert_id: a NULL id is a pre-M4 cert
    // whose CA cert may still be valid, NOT a revoked one — dropping it untracked is the exact bug.
    const displaced: Array<{ fp: string; id: string | null }> = [];
    if (fpChanged && existing?.cert_fp_sha256) displaced.push({ fp: existing.cert_fp_sha256, id: existing.cert_id });
    if (fpChanged && existing?.prev_cert_fp_sha256 && existing.prev_cert_fp_sha256 !== certFp) {
      displaced.push({ fp: existing.prev_cert_fp_sha256, id: existing.prev_cert_id });
    }

    // CAS on the FULL observed rotation state via rotationCas — cert_fp, cert_id, prev_fp, prev_id, AND
    // the revoke window (IS, so NULL matches NULL). A concurrent change to ANY of them (a prune draining
    // this row's in-grace prev, another admin attaching a cert_id, a renew rotating current) makes the
    // swap miss → 409, and the admin re-reads reality — instead of clobbering with the stale row we read
    // or queuing a displaced cert under a stale/NULL id the other writer just corrected. The retirement
    // INSERTs run in the SAME db.batch, each guarded on the row being in exactly OUR post-swap state, so
    // a lost/interrupted retire can't strand a displaced cert and a CAS miss queues nothing.
    //
    // The CAS also 409s if the reinstated fp sits CLAIMED in retired_certs (revoked_at NULL, claimed_at
    // NOT NULL): every revoke path stamps claimed_at before its async CA DELETE (see certs.ts
    // claimRetired), so a claimed reservation means a revoke is mid-flight — reinstating it as current
    // would race the DELETE and lock the machine out. 409 instead; the admin re-reads after it settles.
    const observed: RotationState = {
      cert_fp: existing?.cert_fp_sha256 ?? null,
      cert_id: existing?.cert_id ?? null,
      prev_fp: existing?.prev_cert_fp_sha256 ?? null,
      prev_id: existing?.prev_cert_id ?? null,
      revoke_at: existing?.cert_revoke_at ?? null,
    };
    const cas = rotationCas(observed, 12);
    const swap = env.DB.prepare(
      `INSERT INTO machines (machine_id, os, hostname, cert_fp_sha256, key_protection, is_admin, priority, cert_id, prev_cert_fp_sha256, prev_cert_id, cert_revoke_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (machine_id) DO UPDATE SET
         os = ?2, hostname = ?3, cert_fp_sha256 = ?4, key_protection = ?5, is_admin = ?6, priority = ?7,
         cert_id = ?8, prev_cert_fp_sha256 = ?9, prev_cert_id = ?10, cert_revoke_at = ?11
       WHERE ${cas.clause}
         AND NOT EXISTS (SELECT 1 FROM retired_certs WHERE fingerprint = ?4 AND machine_id = ?1 AND revoked_at IS NULL AND claimed_at IS NOT NULL)`,
    ).bind(body.machine_id, os, hostname, certFp, keyProtection, isAdmin, priority, certId, prevFp, prevId, revokeAt, ...cas.binds);

    // The state OUR swap produces — each retire INSERT co-commits only if the row is EXACTLY this after
    // the swap, so a request that lost the CAS (row now in the winner's state) queues nothing.
    const postSwap: RotationState = { cert_fp: certFp, cert_id: certId, prev_fp: prevFp, prev_id: prevId, revoke_at: revokeAt };

    // Belt-and-braces for a reservation that predates our read: if the clash pre-check passed but a prune
    // then queued certFp (this row's expiring prev) into retired_certs before we read `existing`, the swap
    // above can still land certFp as current while it sits reserved — the next drain would revoke it.
    // Reinstating a cert must atomically un-queue it: DELETE this machine's UNCLAIMED un-revoked
    // reservation of certFp, guarded on the swap having landed (current is now certFp) so a CAS miss
    // deletes nothing. claimed_at IS NULL so we never yank a reservation out from under a mid-revoke
    // prune (that case already 409'd at the CAS above). A no-op when there is no such reservation.
    const stmts = [
      swap,
      ...displaced.map((d) => queueRetiredIfDisplaced(env, d.fp, d.id, body.machine_id!, postSwap)),
      ...(fpChanged && certFp
        ? [
            // Carry the reservation's cert_id onto the reinstated cert BEFORE deleting it. If a prune
            // queued certFp with its CA id but our read missed it (the prev slot was already cleared, so
            // our incoming certId is NULL), un-queuing would otherwise discard the only copy of that id
            // and leave the machine current on an unrevocable cert. Only when OUR cert_id IS NULL, only
            // over the UNCLAIMED reservation (a claimed one already 409'd the CAS above), and only once
            // the swap has landed (current is now certFp).
            env.DB.prepare(
              `UPDATE machines
                  SET cert_id = (SELECT cert_id FROM retired_certs
                                   WHERE fingerprint = ?1 AND machine_id = ?2 AND revoked_at IS NULL AND claimed_at IS NULL AND cert_id IS NOT NULL
                                   LIMIT 1)
                WHERE machine_id = ?2 AND cert_fp_sha256 = ?1 AND cert_id IS NULL
                  AND EXISTS (SELECT 1 FROM retired_certs
                                WHERE fingerprint = ?1 AND machine_id = ?2 AND revoked_at IS NULL AND claimed_at IS NULL AND cert_id IS NOT NULL)`,
            ).bind(certFp, body.machine_id),
            env.DB.prepare(
              `DELETE FROM retired_certs
                 WHERE fingerprint = ?1 AND machine_id = ?2 AND revoked_at IS NULL AND claimed_at IS NULL
                   AND EXISTS (SELECT 1 FROM machines WHERE machine_id = ?2 AND cert_fp_sha256 = ?1)`,
            ).bind(certFp, body.machine_id),
          ]
        : []),
    ];

    let results;
    try {
      results = await env.DB.batch(stmts);
    } catch (e) {
      // cert_fp_sha256 is UNIQUE — a concurrent write could still race the pre-check above. Surface
      // a 409 rather than a bare 500 so the admin caller sees it's a duplicate, not a hub fault.
      return Response.json({ error: 'machine_upsert_conflict', detail: String(e) }, { status: 409 });
    }
    // A genuinely fresh insert reports changes === 1; changes === 0 means the ON CONFLICT DO UPDATE
    // ran but its CAS WHERE didn't match, so nothing was written (a cert rotated under an existing
    // row, or the first-insert race loser hit ON CONFLICT after the winner inserted). Either way the
    // requested cert was NOT installed — 409, and the guarded retire INSERTs queued nothing.
    if ((results[0]!.meta.changes ?? 0) === 0) {
      return Response.json({ error: 'concurrent_rotation', machine_id: body.machine_id }, { status: 409 });
    }
    if (displaced.length > 0) {
      console.log(JSON.stringify({ event: 'hub.admin.machines.rotation_reset', machine: body.machine_id, displaced: displaced.map((d) => d.id) }));
      // The reservations are committed; now best-effort INITIATE revocation (async — the prune polls
      // each to 'revoked'). A failure here just leaves it reserved for the prune to retry.
      for (const d of displaced) await settleRetired(env, d.id);
    }
    console.log(JSON.stringify({ event: 'hub.admin.machine_upsert', machine: body.machine_id, is_admin: isAdmin }));
  }

  const rows = await env.DB.prepare(
    `SELECT machine_id, os, hostname, key_protection, is_admin, priority, collector_version, last_seen_at, last_upload_at, created_at
     FROM machines ORDER BY machine_id`,
  ).all();
  return Response.json({ machines: rows.results });
}

/** GET /api/v1/status — index-completeness introspection for agents. */
export async function status(env: Env): Promise<Response> {
  const machines = await env.DB.prepare(
    `SELECT m.machine_id, m.os, m.last_seen_at, m.last_upload_at,
            SUM(CASE WHEN f.parse_state = 'pending' THEN 1 ELSE 0 END) AS files_pending,
            SUM(CASE WHEN f.parse_state = 'error' THEN 1 ELSE 0 END) AS files_error,
            COUNT(f.id) AS files_total
     FROM machines m LEFT JOIN files f ON f.machine_id = m.machine_id
     GROUP BY m.machine_id ORDER BY m.machine_id`,
  ).all();
  const sessions = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN index_state = 'ready' THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN index_state = 'error' THEN 1 ELSE 0 END) AS error
     FROM sessions`,
  ).first();
  return Response.json({
    machines: machines.results.map((m) => ({ ...m, indexed_through: m.last_seen_at })),
    sessions,
  });
}

/** GET /api/v1/usage?group_by=day|model|machine|repo&from&to&machine&harness */
export async function usage(url: URL, env: Env): Promise<Response> {
  const groupBy = url.searchParams.get('group_by') ?? 'day';
  const groupExpr: Record<string, string> = {
    day: "substr(u.ts, 1, 10)",
    model: 'u.model',
    machine: 's.machine_id',
    repo: 's.repo_url',
  };
  const expr = groupExpr[groupBy];
  if (!expr) return Response.json({ error: 'bad_group_by' }, { status: 400 });
  const binds: unknown[] = [];
  const filters: string[] = [];
  if (url.searchParams.get('from')) {
    binds.push(url.searchParams.get('from'));
    filters.push(`u.ts >= ?${binds.length}`);
  }
  if (url.searchParams.get('to')) {
    binds.push(normalizeToBound(url.searchParams.get('to')!));
    filters.push(`u.ts <= ?${binds.length}`);
  }
  // The join to `sessions` already exists (for the machine/repo group_by exprs above), so a
  // machine/harness filter is just two more WHERE terms on the already-joined table — no
  // schema change, no extra join.
  if (url.searchParams.get('machine')) {
    binds.push(url.searchParams.get('machine'));
    filters.push(`s.machine_id = ?${binds.length}`);
  }
  if (url.searchParams.get('harness')) {
    binds.push(url.searchParams.get('harness'));
    filters.push(`s.harness = ?${binds.length}`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await env.DB.prepare(
    `SELECT ${expr} AS bucket,
            COUNT(*) AS calls,
            SUM(COALESCE(u.input_tokens,0)) AS input_tokens,
            SUM(COALESCE(u.output_tokens,0)) AS output_tokens,
            SUM(COALESCE(u.reasoning_tokens,0)) AS reasoning_tokens,
            SUM(COALESCE(u.cache_read_tokens,0)) AS cache_read_tokens,
            SUM(COALESCE(u.cache_creation_5m_tokens,0)) AS cache_creation_5m_tokens,
            SUM(COALESCE(u.cache_creation_1h_tokens,0)) AS cache_creation_1h_tokens
     FROM usage u JOIN sessions s ON s.session_id = u.session_id
     ${where} GROUP BY bucket ORDER BY bucket DESC LIMIT 400`,
  )
    .bind(...binds)
    .all();
  return Response.json({ group_by: groupBy, rows: rows.results });
}

// A Worker invocation gets ~1000 subrequests, and EVERY D1 query counts — including each statement in a
// batch. One page's worst case is ~3 statements per object: a machine upsert (when every object is on a
// distinct machine), the files upsert, and the parsing-flip — so a 200-object page is ~600 statements +
// list + sendBatch + cursor persist ≈ 605, safely under 1000. Two such pages would breach it, so we take
// exactly ONE page per invocation and make the resumable cursor the primary mechanism: each call
// persists the cursor and returns {done:false} until the corpus is exhausted; the caller (the drill
// script) loops until {done:true}. Bumping MAX_PAGES_PER_INVOCATION would reintroduce the budget breach.
export const PAGE_SIZE = 200;
export const MAX_PAGES_PER_INVOCATION = 1;

/** POST /api/v1/admin/reindex — walk a BOUNDED slice of R2, upsert files rows, re-enqueue them, and
 * report progress. Response is `{ enqueued, done, cursor }` with status **202 Accepted** while more
 * slices remain (done:false) and **200 OK** only when the corpus (for this prefix) is fully
 * re-enqueued (done:true). The 202 keeps a status-only caller from mistaking a partial slice for
 * success. The caller re-invokes until it sees 200/done:true; the server resumes from the persisted
 * cursor on entry, so a crash or a bounded stop both continue rather than restarting from zero. */
export async function reindex(request: Request, env: Env, identity: Identity): Promise<Response> {
  if (identity.kind !== 'machine' || !identity.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { prefix?: string };
  const prefix = body.prefix ?? 'raw/';

  // Resume: a crashed/paused/bounded run leaves reindex_cursor at the last R2 page it finished, tagged
  // with the prefix it was walking. Re-entering with a live cursor for the SAME prefix picks up there;
  // a fresh run, a completed run (cursor null), or a run for a DIFFERENT prefix starts from the
  // beginning. The prefix tag matters because the cursor is R2's own opaque token, scoped to the
  // prefix that produced it — replaying a full-corpus cursor against a targeted `raw/machineX/`
  // reindex would skip the start of the requested prefix or fail outright.
  const saved = await env.DB.prepare("SELECT value FROM meta WHERE key = 'reindex_cursor'").first<{ value: string }>();
  let cursor = resumeCursor(saved?.value, prefix);

  let enqueued = 0;
  let done = false;
  for (let pagesThisCall = 0; pagesThisCall < MAX_PAGES_PER_INVOCATION; pagesThisCall++) {
    const page: R2Objects = await env.RAW.list({ prefix, cursor, limit: PAGE_SIZE, include: ['customMetadata'] });

    type Item = { key: string; machineId: string; store: string; relpath: string; det: ReturnType<typeof detect>; contentHash: string; mtime: string | null; size: number };
    const items: Item[] = [];
    for (const obj of page.objects) {
      const parts = obj.key.split('/'); // raw/{machine}/{store}/{relpath...}
      if (parts.length < 4 || parts[0] !== 'raw') continue;
      const machineId = parts[1]!;
      const store = parts[2]!;
      const relpath = parts.slice(3).join('/');
      // R2 doesn't carry files.mtime natively — it's the SOURCE file's mtime, recorded as
      // customMetadata on the object by upload.ts's PUT calls (see r2MtimeMetadata there). A
      // legacy object written before that existed simply has no customMetadata; fall back to
      // NULL rather than clobbering a row's already-known mtime with a wrong value on reindex.
      items.push({
        key: obj.key,
        machineId,
        store,
        relpath,
        det: detect(store, relpath, machineId),
        // Every canonical object is written by a single put({sha256}) (simple PUT, or the multipart
        // staging->canonical copy), so R2 carries a native checksum; 'unknown' only for a legacy
        // pre-{sha256} object.
        contentHash: objectSha256(obj) ?? 'unknown',
        mtime: obj.customMetadata?.mtime ?? null,
        size: obj.size,
      });
    }

    if (items.length > 0) {
      // One batch, executed sequentially in a transaction: distinct machine parents first (files.machine_id
      // is a FK), then every files upsert RETURNING id. We read the ids straight back out of the batch
      // results to drive the flips and the queue sends — no per-row round trip.
      const machineIds = [...new Set(items.map((i) => i.machineId))];
      const machineStmts = machineIds.map((m) =>
        env.DB.prepare(`INSERT INTO machines (machine_id, os) VALUES (?1, 'unknown') ON CONFLICT (machine_id) DO NOTHING`).bind(m),
      );
      const fileStmts = items.map((i) =>
        env.DB.prepare(
          `INSERT INTO files (machine_id, store, relpath, r2_key, size, mtime, content_hash, harness, session_id, parse_state)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending')
           ON CONFLICT (machine_id, store, relpath) DO UPDATE SET
             parse_state = 'pending', size = excluded.size, mtime = COALESCE(excluded.mtime, files.mtime),
             harness = excluded.harness, session_id = excluded.session_id, content_hash = excluded.content_hash
           RETURNING id`,
        ).bind(i.machineId, i.store, i.relpath, i.key, i.size, i.mtime, i.contentHash, i.det.harness, i.det.sessionId ?? null),
      );
      const results = await env.DB.batch<{ id: number }>([...machineStmts, ...fileStmts]);
      const ids = results.slice(machineStmts.length).map((r) => r.results[0]!.id);

      // Mirror upload.ts's canonical-reupload fix in a second batch, now that we hold each row id: the
      // upserts above flipped every file back to 'pending', so any session those files are CURRENTLY
      // canonical for must leave 'ready' (it otherwise keeps advertising blocks/FTS from the pre-reindex
      // parse until the consumer catches up). A session id matches its own canonical; an export ZIP has
      // no det.sessionId (it fans out to many sessions) so it flips every session it owns. Brand-new
      // sessions and non-canonical duplicates simply match nothing.
      const flipStmts = [];
      for (let k = 0; k < items.length; k++) {
        const { det } = items[k]!;
        if (det.sessionId) {
          flipStmts.push(
            env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1 AND canonical_file_id = ?2").bind(det.sessionId, ids[k]!),
          );
        } else if (det.kind === 'export-archive') {
          flipStmts.push(env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE canonical_file_id = ?1").bind(ids[k]!));
        }
      }
      if (flipStmts.length > 0) await env.DB.batch(flipStmts);

      // Re-enqueue via sendBatch instead of one send per file. Chunks are bounded by BOTH the 100-message
      // count cap AND a serialized-size budget: Cloudflare Queues rejects a sendBatch whose total payload
      // exceeds 256KB, and 100 messages with long R2 keys can blow past that — which would throw here and
      // wedge this page forever. queueChunks keeps each chunk under ~200KB, leaving envelope margin.
      const messages = items.map((i, k) => ({
        body: { file_id: ids[k]!, r2_key: i.key, reason: 'reindex' as const, content_hash: i.contentHash },
      }));
      for (const chunk of queueChunks(messages)) {
        await env.PARSE_QUEUE.sendBatch(chunk);
      }
      enqueued += items.length;
    }

    cursor = page.truncated ? page.cursor : undefined;
    // Persist AFTER this page's sends so a crash re-processes at most one page — and reindexing a page
    // is idempotent (upserts + re-enqueue), so the overlap is harmless. Tag it with the prefix so a
    // later reindex of a different prefix doesn't resume from this token (see resumeCursor).
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('reindex_cursor', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
      .bind(JSON.stringify({ prefix, cursor: cursor ?? null }))
      .run();
    if (!cursor) {
      done = true;
      break;
    }
  }

  console.log(JSON.stringify({ event: 'hub.reindex', enqueued, done }));
  // 202 (not 200) while slices remain, so a status-only caller can't mistake a partial run for success.
  return Response.json({ enqueued, done, cursor: cursor ?? null }, { status: done ? 200 : 202 });
}

/** The persisted reindex cursor is a live R2 list token only when it belongs to the prefix being walked
 * now; anything else (fresh run, completed run with cursor null, a different prefix, or a legacy/plain
 * value) means start from the beginning. */
export function resumeCursor(saved: string | undefined, prefix: string): string | undefined {
  if (!saved) return undefined;
  try {
    const parsed = JSON.parse(saved) as { prefix?: string; cursor?: string | null };
    if (parsed.prefix === prefix && parsed.cursor) return parsed.cursor;
  } catch {
    // Legacy plain-string value from before cursors were prefix-tagged — treat as no resume.
  }
  return undefined;
}

const QUEUE_SIZE_ENCODER = new TextEncoder();

/** Split queue messages into sendBatch chunks bounded by BOTH the 100-message count cap and a
 * serialized-size budget (Cloudflare Queues rejects a sendBatch whose total payload exceeds 256KB).
 * Size is measured in UTF-8 BYTES (not .length UTF-16 code units) so a multibyte relpath can't slip
 * under the budget yet blow the byte cap; sizeCap is conservative and each message adds envelope
 * overhead so the real serialized array stays comfortably under the hard limit. */
export function queueChunks<T>(messages: { body: T }[], sizeCap = 200_000): { body: T }[][] {
  const chunks: { body: T }[][] = [];
  let chunk: { body: T }[] = [];
  let bytes = 0;
  for (const m of messages) {
    const size = QUEUE_SIZE_ENCODER.encode(JSON.stringify(m.body)).length + 32; // +32 for per-message array/envelope overhead
    if (chunk.length > 0 && (chunk.length >= 100 || bytes + size > sizeCap)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(m);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The sha256 (hex) an R2 canonical object hashes to, or undefined if it has no native checksum. EVERY
 * object under raw/ is written by a single put({sha256}) — the simple PUT directly, the multipart path
 * via its verified staging->canonical copy — so R2 records checksums.sha256 natively and this is a real
 * verification of the stored bytes (not a trusted metadata string). A legacy object written before the
 * PUT path set {sha256} simply returns undefined, which the callers treat as "can't verify → missing".
 */
export function objectSha256(obj: R2Object | null | undefined): string | undefined {
  return obj?.checksums?.sha256 ? hex(obj.checksums.sha256) : undefined;
}
