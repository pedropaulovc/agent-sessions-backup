#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["cryptography>=45,<47"]
# ///
"""Install, enroll, verify, and schedule the collector on this machine.

The short-lived CLOUDFLARE_API_TOKEN must have these two permissions:
  - Zone / SSL and Certificates / Edit on vza.net
  - Account / D1 / Edit on Pedro's Cloudflare account

No token is passed to a child process or written to disk.

After an administrator has atomically registered an already-minted staged
certificate, use --install-staged. That recovery mode performs no Cloudflare or
D1 management calls and therefore does not require a Cloudflare API token. The
collector's doctor and first upload prove that the hub registration matches.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID


ACCOUNT_ID = "18ef3246e9f36d1560485ef53889c0ab"
ZONE_ID = "6a56cdda4766c1d7b5ad0fbe8331048f"
DATABASE_ID = "5ff65cf3-89c8-4fe6-a3c2-a370293ecea6"
API = "https://api.cloudflare.com/client/v4"
HUB = "https://api.sessions.vza.net"
MACHINE_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class EnrollmentError(RuntimeError):
    pass


class ApiError(EnrollmentError):
    pass


class AmbiguousRegistration(EnrollmentError):
    """The D1 write or its verification could have committed; never revoke."""


class RegistrationRejected(EnrollmentError):
    """A fresh cert is conclusively not the machine's active cert and may be revoked."""


@dataclass(frozen=True)
class MachineRow:
    fingerprint: str
    cert_id: str
    is_admin: int
    key_protection: str


@dataclass(frozen=True)
class Material:
    private_key: ec.EllipticCurvePrivateKey
    certificate: x509.Certificate
    cert_id: str
    fingerprint: str


def _redacted_error(error: BaseException) -> str:
    text = str(error)
    for name in ("CLOUDFLARE_API_TOKEN", "AC_PFX_PW"):
        value = os.environ.get(name)
        if value:
            text = text.replace(value, "<redacted>")
    return text[:800]


def api_json(
    token: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    *,
    timeout: float = 30,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        f"{API}{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            detail = json.loads(raw).get("errors")
        except Exception:
            detail = raw.decode(errors="replace")[:300]
        raise ApiError(f"Cloudflare API {method} {path} returned HTTP {error.code}: {detail}") from error
    except (OSError, TimeoutError) as error:
        raise ApiError(f"Cloudflare API {method} {path} failed: {_redacted_error(error)}") from error
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ApiError(f"Cloudflare API {method} {path} returned invalid JSON") from error
    if not isinstance(data, dict) or data.get("success") is not True:
        errors = data.get("errors") if isinstance(data, dict) else None
        raise ApiError(f"Cloudflare API {method} {path} failed: {errors}")
    return data


def d1_query(token: str, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
    data = api_json(
        token,
        "POST",
        f"/accounts/{ACCOUNT_ID}/d1/database/{DATABASE_ID}/query",
        {"sql": sql, "params": params or []},
    )
    result = data.get("result")
    if not isinstance(result, list) or not result:
        raise ApiError("D1 query returned no statement result")
    rows: list[dict[str, Any]] = []
    for statement in result:
        if not isinstance(statement, dict) or statement.get("success") is not True:
            raise ApiError(f"D1 statement failed: {statement}")
        statement_rows = statement.get("results") or []
        if not isinstance(statement_rows, list):
            raise ApiError("D1 statement returned malformed rows")
        rows.extend(row for row in statement_rows if isinstance(row, dict))
    return rows


def preflight(token: str) -> None:
    api_json(token, "GET", f"/zones/{ZONE_ID}/client_certificates?per_page=5")
    rows = d1_query(token, "SELECT 1 AS ok;")
    if not rows or rows[0].get("ok") != 1:
        raise EnrollmentError("D1 preflight returned an unexpected result")
    d1_query(token, "UPDATE machines SET machine_id = machine_id WHERE 0;")
    print("[ok] Cloudflare token can reach client certificates and write D1")


def child_env(*, pfx_password: str | None = None) -> dict[str, str]:
    env = dict(os.environ)
    for name in ("CF_API_TOKEN", "CLOUDFLARE_API_TOKEN", "AC_PFX_PW"):
        env.pop(name, None)
    if pfx_password is not None:
        env["AC_PFX_PW"] = pfx_password
    return env


def ensure_collector() -> str:
    executable = shutil.which("agent-collector")
    if executable and collector_supports_enrollment(executable):
        return executable
    uv = shutil.which("uv")
    if not uv:
        raise EnrollmentError("uv is required; install uv and re-run this script")
    collector = Path(__file__).resolve().parents[2] / "collector"
    if not (collector / "pyproject.toml").is_file():
        raise EnrollmentError(f"collector source not found at {collector}")
    action = "upgrading" if executable else "installing"
    print(f"==> {action} agent-collector from {collector}")
    command = [uv, "tool", "install"]
    if executable:
        command.append("--force")
    subprocess.run([*command, str(collector)], check=True, env=child_env())
    candidates = [shutil.which("agent-collector")]
    uv_candidate = Path.home() / ".local" / "bin" / (
        "agent-collector.exe" if os.name == "nt" else "agent-collector"
    )
    if uv_candidate.is_file():
        candidates.append(str(uv_candidate))
    for candidate in candidates:
        if candidate and collector_supports_enrollment(candidate):
            return candidate
    raise EnrollmentError("uv installed agent-collector, but no compatible executable could be resolved")


def collector_supports_enrollment(executable: str) -> bool:
    proc = subprocess.run(
        [executable, "enroll", "--help"],
        capture_output=True,
        text=True,
        check=False,
        env=child_env(),
    )
    return proc.returncode == 0 and "--import-pfx" in proc.stdout and "--client-cert" in proc.stdout


def machine_id_for(collector: str, explicit: str | None) -> str:
    machine_id = explicit
    if not machine_id:
        proc = subprocess.run(
            [collector, "machine-id"],
            capture_output=True,
            text=True,
            check=True,
            env=child_env(),
        )
        machine_id = proc.stdout.strip()
    if machine_id in ("", ".", "..") or not MACHINE_ID_RE.fullmatch(machine_id):
        raise EnrollmentError(f"invalid machine_id {machine_id!r}; use letters, digits, dot, underscore, or hyphen")
    return machine_id


def enrollment_artifact_names(machine_id: str) -> tuple[str, ...]:
    return tuple(
        f"{machine_id}{suffix}"
        for suffix in (
            ".client.pem.new",
            ".client.pem.new.id",
            ".client.pem",
            ".client.key",
            ".client.csr",
            ".client.pfx",
        )
    )


def output_dir_candidates() -> tuple[Path, ...]:
    repo_root = Path(__file__).resolve().parents[2]
    candidates = (
        Path.cwd() / ".config" / "agent-collector",
        repo_root / ".config" / "agent-collector",
        Path.home() / "src" / Path.cwd().name / ".config" / "agent-collector",
        Path.home() / "src" / repo_root.name / ".config" / "agent-collector",
        Path.home() / ".config" / "agent-collector",
    )
    unique: list[Path] = []
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved not in unique:
            unique.append(resolved)
    return tuple(unique)


def output_dir_for(machine_id: str, explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    candidates = output_dir_candidates()
    artifact_names = enrollment_artifact_names(machine_id)
    matches = [
        candidate
        for candidate in candidates
        if any((candidate / name).is_file() for name in artifact_names)
    ]
    if len(matches) > 1:
        rendered = "\n  - ".join(str(match) for match in matches)
        raise EnrollmentError(
            f"enrollment artifacts for {machine_id!r} exist in multiple candidate directories:\n"
            f"  - {rendered}\n"
            "inspect them, then rerun with --out <directory> to select the verified recovery set"
        )
    if matches:
        print(f"==> resuming enrollment artifacts under {matches[0]}")
        return matches[0]
    return (Path.home() / ".config" / "agent-collector").resolve()


def get_machine(token: str, machine_id: str) -> MachineRow | None:
    rows = d1_query(
        token,
        "SELECT cert_fp_sha256, cert_id, is_admin, key_protection FROM machines WHERE machine_id = ?1;",
        [machine_id],
    )
    if not rows:
        return None
    row = rows[0]
    return MachineRow(
        fingerprint=str(row.get("cert_fp_sha256") or ""),
        cert_id=str(row.get("cert_id") or ""),
        is_admin=int(row.get("is_admin") or 0),
        key_protection=str(row.get("key_protection") or ""),
    )


def row_matches(row: MachineRow | None, material: Material, is_admin: int) -> bool:
    return row == MachineRow(material.fingerprint, material.cert_id, is_admin, "software")


def cert_fingerprint(cert: x509.Certificate) -> str:
    return cert.fingerprint(hashes.SHA256()).hex()


def load_private_key(path: Path) -> ec.EllipticCurvePrivateKey:
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        raise EnrollmentError(f"{path} does not contain an EC private key")
    return key


def parse_sidecar(path: Path) -> tuple[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key] = value
    cert_id = values.get("cert_id", "")
    fingerprint = values.get("fp", "")
    if not cert_id:
        raise EnrollmentError(f"recovery sidecar {path} has no cert_id")
    return cert_id, fingerprint


def validate_certificate(
    pem: bytes,
    private_key: ec.EllipticCurvePrivateKey,
    machine_id: str,
) -> x509.Certificate:
    cert = parse_certificate_identity(pem, machine_id)
    cert_public = cert.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    key_public = private_key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    if cert_public != key_public:
        raise EnrollmentError("signed certificate does not match the generated private key")
    return cert


def parse_certificate_identity(pem: bytes, machine_id: str) -> x509.Certificate:
    try:
        cert = x509.load_pem_x509_certificate(pem)
    except ValueError as error:
        raise EnrollmentError("Cloudflare returned an invalid certificate PEM") from error
    names = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
    if len(names) != 1 or names[0].value != machine_id:
        raise EnrollmentError(f"signed certificate CN does not match machine_id {machine_id!r}")
    return cert


def verify_ca_binding(token: str, cert_id: str, expected_fingerprint: str) -> None:
    data = api_json(token, "GET", f"/zones/{ZONE_ID}/client_certificates/{cert_id}")
    result = data.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("certificate"), str):
        raise EnrollmentError(f"Cloudflare could not resolve recovery cert_id {cert_id!r}")
    status = result.get("status")
    if status != "active":
        raise EnrollmentError(f"recovery certificate {cert_id} is not active (status={status!r})")
    try:
        ca_cert = x509.load_pem_x509_certificate(result["certificate"].encode())
    except ValueError as error:
        raise EnrollmentError(f"Cloudflare returned invalid PEM for recovery cert_id {cert_id}") from error
    if cert_fingerprint(ca_cert) != expected_fingerprint:
        raise EnrollmentError("recovery sidecar cert_id resolves to a different certificate at Cloudflare")


def load_recovery(token: str, machine_id: str, out: Path) -> Material | None:
    temp = out / f"{machine_id}.client.pem.new"
    sidecar = out / f"{machine_id}.client.pem.new.id"
    key_path = out / f"{machine_id}.client.key"
    if not temp.exists() and not sidecar.exists():
        return None
    if not (temp.is_file() and sidecar.is_file() and key_path.is_file()):
        raise EnrollmentError("incomplete enrollment recovery artifacts; preserve them and inspect the output directory")
    private_key = load_private_key(key_path)
    cert = validate_certificate(temp.read_bytes(), private_key, machine_id)
    cert_id, saved_fp = parse_sidecar(sidecar)
    fingerprint = cert_fingerprint(cert)
    if saved_fp and saved_fp.lower() != fingerprint:
        raise EnrollmentError("recovery sidecar fingerprint does not match the temporary certificate")
    verify_ca_binding(token, cert_id, fingerprint)
    return Material(private_key, cert, cert_id, fingerprint)


def load_staged_recovery(machine_id: str, out: Path) -> Material | None:
    """Validate staged key/cert/sidecar material without management-plane access."""
    temp = out / f"{machine_id}.client.pem.new"
    sidecar = out / f"{machine_id}.client.pem.new.id"
    key_path = out / f"{machine_id}.client.key"
    if not temp.exists() and not sidecar.exists():
        return None
    if not (temp.is_file() and sidecar.is_file() and key_path.is_file()):
        raise EnrollmentError("incomplete staged enrollment artifacts; preserve them and inspect the output directory")
    private_key = load_private_key(key_path)
    cert = validate_certificate(temp.read_bytes(), private_key, machine_id)
    cert_id, saved_fp = parse_sidecar(sidecar)
    fingerprint = cert_fingerprint(cert)
    if not saved_fp:
        raise EnrollmentError("staged recovery sidecar has no certificate fingerprint")
    if saved_fp.lower() != fingerprint:
        raise EnrollmentError("staged recovery sidecar fingerprint does not match the certificate")
    return Material(private_key, cert, cert_id, fingerprint)


def load_local_promoted(machine_id: str, out: Path) -> Material | None:
    cert_path = out / f"{machine_id}.client.pem"
    key_path = out / f"{machine_id}.client.key"
    if not cert_path.exists() and not key_path.exists():
        return None
    if not (cert_path.is_file() and key_path.is_file()):
        return None
    private_key = load_private_key(key_path)
    cert = validate_certificate(cert_path.read_bytes(), private_key, machine_id)
    return Material(private_key, cert, "", cert_fingerprint(cert))


def load_promoted(machine_id: str, out: Path, row: MachineRow) -> Material | None:
    cert_path = out / f"{machine_id}.client.pem"
    key_path = out / f"{machine_id}.client.key"
    if not cert_path.exists() and not key_path.exists():
        return None
    if not (cert_path.is_file() and key_path.is_file()):
        raise EnrollmentError("promoted enrollment has only one of its PEM cert/private-key files")
    private_key = load_private_key(key_path)
    cert = validate_certificate(cert_path.read_bytes(), private_key, machine_id)
    material = Material(private_key, cert, row.cert_id, cert_fingerprint(cert))
    if not row_matches(row, material, row.is_admin):
        raise EnrollmentError("promoted certificate files do not match the registered D1 row")
    return material


def key_and_csr(machine_id: str, out: Path) -> tuple[ec.EllipticCurvePrivateKey, bytes]:
    key_path = out / f"{machine_id}.client.key"
    csr_path = out / f"{machine_id}.client.csr"
    if key_path.exists() or csr_path.exists():
        if not (key_path.is_file() and csr_path.is_file()):
            raise EnrollmentError("incomplete unsigned key/CSR artifacts; preserve them and inspect the output directory")
        private_key = load_private_key(key_path)
        csr_pem = csr_path.read_bytes()
        try:
            csr = x509.load_pem_x509_csr(csr_pem)
        except ValueError as error:
            raise EnrollmentError(f"{csr_path} is not a valid PEM CSR") from error
        names = csr.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
        if len(names) != 1 or names[0].value != machine_id or not csr.is_signature_valid:
            raise EnrollmentError(f"{csr_path} is not a valid CSR for {machine_id!r}")
        csr_public = csr.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        key_public = private_key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        if csr_public != key_public:
            raise EnrollmentError("unsigned recovery CSR does not match its private key")
        print(f"==> reusing unsigned key and CSR after an earlier signing failure ({csr_path})")
        return private_key, csr_pem

    private_key = ec.generate_private_key(ec.SECP256R1())
    key_bytes = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )
    try:
        descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        raise EnrollmentError(f"refusing to overwrite existing private key {key_path}") from error
    with os.fdopen(descriptor, "wb") as key_file:
        key_file.write(key_bytes)
    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, machine_id),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "agent-sessions-backup"),
        ]))
        .sign(private_key, hashes.SHA256())
    )
    csr_pem = csr.public_bytes(serialization.Encoding.PEM)
    csr_path.write_bytes(csr_pem)
    return private_key, csr_pem


def create_material(token: str, machine_id: str, out: Path) -> Material:
    out.mkdir(parents=True, exist_ok=True)
    key_path = out / f"{machine_id}.client.key"
    csr_path = out / f"{machine_id}.client.csr"
    temp_path = out / f"{machine_id}.client.pem.new"
    sidecar = out / f"{machine_id}.client.pem.new.id"
    private_key, csr_pem = key_and_csr(machine_id, out)
    print("==> requesting a signed certificate from Cloudflare's managed CA")
    data = api_json(
        token,
        "POST",
        f"/zones/{ZONE_ID}/client_certificates",
        {"csr": csr_pem.decode(), "validity_days": 365},
    )
    result = data.get("result")
    if not isinstance(result, dict):
        raise EnrollmentError("Cloudflare sign response has no result object")
    cert_id = result.get("id")
    if not isinstance(cert_id, str) or not cert_id:
        raise EnrollmentError("Cloudflare sign response has no certificate id")
    sidecar.write_text(f"cert_id={cert_id}\nfp=\n")
    try:
        pem_text = result.get("certificate")
        if not isinstance(pem_text, str) or not pem_text:
            raise EnrollmentError(f"Cloudflare minted cert {cert_id} but returned no certificate PEM")
        pem = pem_text.encode()
        # Persist the CA response before deeper validation. If validation or revocation is ambiguous,
        # the cert id, PEM, and private key remain together for a later safe recovery decision.
        temp_path.write_bytes(pem)
        if not result.get("expires_on"):
            raise EnrollmentError(f"Cloudflare minted cert {cert_id} but returned no expiry")
        cert = validate_certificate(pem, private_key, machine_id)
    except EnrollmentError as invalid:
        try:
            api_json(token, "DELETE", f"/zones/{ZONE_ID}/client_certificates/{cert_id}")
        except ApiError as revoke_error:
            raise EnrollmentError(
                f"{invalid}; revocation was not confirmed, so the recovery handle was preserved at {sidecar}: "
                f"{_redacted_error(revoke_error)}"
            ) from revoke_error
        for path in (key_path, csr_path, temp_path, sidecar):
            if path.exists():
                path.unlink()
        raise EnrollmentError(f"{invalid}; the unusable certificate was revoked") from invalid
    fingerprint = cert_fingerprint(cert)
    sidecar.write_text(f"cert_id={cert_id}\nfp={fingerprint}\n")
    print(f"    cert id: {cert_id} fingerprint: {fingerprint}")
    return Material(private_key, cert, cert_id, fingerprint)


def register_machine(token: str, machine_id: str, material: Material, is_admin: int) -> MachineRow:
    sql = """
    INSERT INTO machines
      (machine_id, os, hostname, cert_fp_sha256, cert_id, key_protection, is_admin)
    VALUES (?1, ?2, ?3, ?4, ?5, 'software', ?6)
    ON CONFLICT (machine_id) DO UPDATE SET
      cert_fp_sha256 = excluded.cert_fp_sha256,
      cert_id = excluded.cert_id,
      os = excluded.os,
      hostname = excluded.hostname,
      key_protection = excluded.key_protection,
      is_admin = excluded.is_admin
    WHERE machines.cert_fp_sha256 IS NULL;
    """
    os_tag = machine_id.rsplit("-", 1)[-1]
    write_error: ApiError | None = None
    try:
        d1_query(
            token,
            sql,
            [machine_id, os_tag, socket.gethostname(), material.fingerprint, material.cert_id, str(is_admin)],
        )
    except ApiError as error:
        write_error = error
    try:
        row = get_machine(token, machine_id)
    except ApiError as verify_error:
        raise AmbiguousRegistration(
            "D1 registration is ambiguous and the verification read also failed. "
            "The temporary certificate and sidecar were preserved; do not rerun or revoke. "
            f"Write error: {_redacted_error(write_error) if write_error else 'none'}; "
            f"verify error: {_redacted_error(verify_error)}"
        ) from verify_error
    if row_matches(row, material, is_admin):
        return row  # type: ignore[return-value]
    if write_error:
        raise RegistrationRejected(
            f"D1 registration failed and a verification read proved the row does not contain this cert: "
            f"{_redacted_error(write_error)}"
        )
    raise RegistrationRejected(f"machine {machine_id!r} is enrolled with different certificate metadata")


def certificate_is_referenced(token: str, material: Material) -> bool:
    rows = d1_query(
        token,
        """
        SELECT machine_id AS owner FROM machines
          WHERE cert_fp_sha256 = ?1 OR prev_cert_fp_sha256 = ?1
             OR cert_id = ?2 OR prev_cert_id = ?2
        UNION ALL
        SELECT machine_id AS owner FROM retired_certs
          WHERE fingerprint = ?1 OR cert_id = ?2;
        """,
        [material.fingerprint, material.cert_id],
    )
    return bool(rows)


def revoke_unused(token: str, machine_id: str, out: Path, material: Material) -> None:
    """Revoke only after a fresh read proves no current/previous/retired row references the cert."""
    try:
        referenced = certificate_is_referenced(token, material)
    except ApiError as error:
        raise AmbiguousRegistration(
            "the new certificate was rejected, but D1 reference verification failed; "
            "temporary artifacts were preserved and the certificate was not revoked: "
            f"{_redacted_error(error)}"
        ) from error
    if referenced:
        raise AmbiguousRegistration(
            "the rejected certificate is still referenced by D1; temporary artifacts were preserved and it was not revoked"
        )
    try:
        api_json(token, "DELETE", f"/zones/{ZONE_ID}/client_certificates/{material.cert_id}")
    except ApiError as error:
        raise AmbiguousRegistration(
            "Cloudflare did not confirm revocation of the unused certificate; recovery artifacts were preserved: "
            f"{_redacted_error(error)}"
        ) from error
    for path in (
        out / f"{machine_id}.client.pem.new",
        out / f"{machine_id}.client.pem.new.id",
        out / f"{machine_id}.client.key",
        out / f"{machine_id}.client.csr",
    ):
        if path.exists():
            path.unlink()
    print(f"[ok] revoked unused certificate {material.cert_id}")


def promote(machine_id: str, out: Path) -> Path:
    temp = out / f"{machine_id}.client.pem.new"
    cert = out / f"{machine_id}.client.pem"
    sidecar = out / f"{machine_id}.client.pem.new.id"
    if temp.is_file():
        os.replace(temp, cert)
    if sidecar.exists():
        sidecar.unlink()
    return cert


def configure_collector(
    collector: str,
    machine_id: str,
    out: Path,
    cert_path: Path,
    material: Material,
    schedule: bool,
) -> None:
    key_path = out / f"{machine_id}.client.key"
    if os.name == "nt":
        pfx_path = out / f"{machine_id}.client.pfx"
        password = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
        pfx_path.write_bytes(
            pkcs12.serialize_key_and_certificates(
                machine_id.encode(),
                material.private_key,
                material.certificate,
                None,
                serialization.BestAvailableEncryption(password.encode()),
            )
        )
        subprocess.run(
            [collector, "enroll", "--hub", HUB, "--machine-id", machine_id, "--import-pfx", str(pfx_path)],
            check=True,
            env=child_env(pfx_password=password),
        )
        if pfx_path.exists():
            raise EnrollmentError(f"collector did not remove imported PFX {pfx_path}")
    else:
        subprocess.run(
            [collector, "enroll", "--hub", HUB, "--machine-id", machine_id,
             "--client-cert", str(cert_path), "--client-key", str(key_path)],
            check=True,
            env=child_env(),
        )
    subprocess.run([collector, "doctor", "--require-current-cert"], check=True, env=child_env())
    subprocess.run([collector, "run", "--once"], check=True, env=child_env())
    if os.name == "nt":
        key_path.unlink()
        print(f"[ok] removed exportable Windows private key {key_path}")
    csr_path = out / f"{machine_id}.client.csr"
    if csr_path.exists():
        csr_path.unlink()
    if schedule:
        subprocess.run([collector, "install", "--interval", "15"], check=True, env=child_env())


def resume_configured_collector(collector: str, schedule: bool) -> None:
    """Resume after Windows already imported the key and removed its exportable copy."""
    subprocess.run([collector, "doctor", "--require-current-cert"], check=True, env=child_env())
    subprocess.run([collector, "run", "--once"], check=True, env=child_env())
    if schedule:
        subprocess.run([collector, "install", "--interval", "15"], check=True, env=child_env())


def install_staged_collector(collector: str, machine_id: str, out: Path, schedule: bool) -> None:
    """Finish a hub-registered staged rotation without a management-plane credential."""
    cert_path = out / f"{machine_id}.client.pem"
    key_path = out / f"{machine_id}.client.key"
    material = load_staged_recovery(machine_id, out)
    if os.name == "nt" and cert_path.is_file() and not key_path.exists():
        parse_certificate_identity(cert_path.read_bytes(), machine_id)
        print("==> resuming an already imported Windows certificate")
        resume_configured_collector(collector, schedule)
        return

    if material:
        print(f"==> found staged certificate ({material.fingerprint})")
        cert_path = promote(machine_id, out)
    else:
        material = load_local_promoted(machine_id, out)
        if not material:
            raise EnrollmentError("no complete staged or promoted certificate material was found")
        print(f"==> resuming promoted certificate ({material.fingerprint})")
    configure_collector(collector, machine_id, out, cert_path, material, schedule)


def is_imported_windows_enrollment(
    machine_id: str,
    out: Path,
    row: MachineRow,
    is_admin: int,
) -> bool:
    if os.name != "nt":
        return False
    cert_path = out / f"{machine_id}.client.pem"
    key_path = out / f"{machine_id}.client.key"
    if not cert_path.is_file() or key_path.exists():
        return False
    cert = parse_certificate_identity(cert_path.read_bytes(), machine_id)
    expected = MachineRow(cert_fingerprint(cert), row.cert_id, is_admin, "software")
    if row != expected:
        raise EnrollmentError("imported Windows certificate does not match the registered D1 row")
    return True


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--machine-id", help="override the collector-computed machine id")
    parser.add_argument("--out", help="certificate working directory (default ~/.config/agent-collector)")
    parser.add_argument("--admin", action="store_true", help="enroll this machine as a hub admin")
    parser.add_argument("--no-schedule", action="store_true", help="do not install the 15-minute scheduler")
    parser.add_argument(
        "--install-staged",
        action="store_true",
        help="install a certificate already registered by a hub admin; requires no Cloudflare API token",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not args.install_staged and not token:
        print(
            "CLOUDFLARE_API_TOKEN must contain a short-lived token with certificate and D1 Edit permissions",
            file=sys.stderr,
        )
        return 2
    try:
        collector = ensure_collector()
        machine_id = machine_id_for(collector, args.machine_id)
        out = output_dir_for(machine_id, args.out)
        print(f"==> enrolling {machine_id} from {out}")
        if args.install_staged:
            install_staged_collector(collector, machine_id, out, not args.no_schedule)
            print(f"[ok] {machine_id} installed, uploaded once, and {'left unscheduled' if args.no_schedule else 'scheduled every 15 minutes'}")
            return 0
        assert token is not None
        preflight(token)
        is_admin = int(args.admin)
        material = load_recovery(token, machine_id, out)
        if material:
            print(f"==> found a recoverable certificate ({material.fingerprint})")
        else:
            existing = get_machine(token, machine_id)
            if existing and existing.fingerprint:
                if is_imported_windows_enrollment(machine_id, out, existing, is_admin):
                    print("==> resuming an already imported Windows certificate")
                    resume_configured_collector(collector, not args.no_schedule)
                    print(f"[ok] {machine_id} uploaded once and {'left unscheduled' if args.no_schedule else 'scheduled every 15 minutes'}")
                    return 0
                material = load_promoted(machine_id, out, existing)
                if material:
                    if not row_matches(existing, material, is_admin):
                        raise EnrollmentError("registered role or certificate metadata differs from this enrollment request")
                    print(f"==> resuming promoted certificate ({material.fingerprint})")
                else:
                    raise EnrollmentError(
                        f"machine {machine_id!r} is already enrolled; rotate it through the hub, not fresh enrollment"
                    )
            else:
                material = create_material(token, machine_id, out)
        try:
            register_machine(token, machine_id, material, is_admin)
        except RegistrationRejected as rejected:
            revoke_unused(token, machine_id, out, material)
            raise EnrollmentError(str(rejected)) from rejected
        cert_path = promote(machine_id, out)
        print(f"[ok] D1 registration verified; certificate promoted to {cert_path}")
        configure_collector(collector, machine_id, out, cert_path, material, not args.no_schedule)
        print(f"[ok] {machine_id} enrolled, uploaded once, and {'left unscheduled' if args.no_schedule else 'scheduled every 15 minutes'}")
        return 0
    except (EnrollmentError, subprocess.CalledProcessError, OSError, ValueError) as error:
        print(f"enrollment failed: {_redacted_error(error)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
