#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["cryptography>=45,<47"]
# ///
"""Hermetic tests for enroll-cert.py (no Cloudflare or child-process access)."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


SCRIPT = Path(__file__).with_name("enroll-cert.py")
SPEC = importlib.util.spec_from_file_location("enroll_cert", SCRIPT)
assert SPEC and SPEC.loader
enroll = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = enroll
SPEC.loader.exec_module(enroll)


def material(machine_id: str = "test-windows", cert_id: str = "cert-123"):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, machine_id)])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(1)
        .not_valid_before(datetime.now(timezone.utc))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    return enroll.Material(key, cert, cert_id, enroll.cert_fingerprint(cert))


class FakeResponse:
    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self):
        return self.body


class ApiTests(unittest.TestCase):
    def test_api_token_is_header_only(self):
        seen = {}

        def open_request(request, timeout):
            seen["request"] = request
            seen["timeout"] = timeout
            return FakeResponse(b'{"success":true,"result":[]}')

        with mock.patch.object(enroll.urllib.request, "urlopen", side_effect=open_request):
            enroll.api_json("secret-token", "GET", "/test")

        request = seen["request"]
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-token")
        self.assertNotIn("secret-token", request.full_url)
        self.assertIsNone(request.data)

    def test_preflight_checks_certificate_list_before_d1(self):
        calls = []
        with (
            mock.patch.object(enroll, "api_json", side_effect=lambda *_args, **_kwargs: calls.append("cert") or {}) as api,
            mock.patch.object(enroll, "d1_query", side_effect=lambda *_args, **_kwargs: calls.append("d1") or [{"ok": 1}]),
        ):
            enroll.preflight("token")
        self.assertEqual(calls, ["cert", "d1", "d1"])
        api.assert_called_once_with(
            "token", "GET", f"/zones/{enroll.ZONE_ID}/client_certificates?per_page=5"
        )

    def test_preflight_rejects_unexpected_d1_response(self):
        with (
            mock.patch.object(enroll, "api_json", return_value={}),
            mock.patch.object(enroll, "d1_query", return_value=[{"ok": 0}]),
        ):
            with self.assertRaisesRegex(enroll.EnrollmentError, "unexpected"):
                enroll.preflight("token")

    def test_d1_rejects_missing_or_failed_statement_results(self):
        invalid = [
            {"success": True, "result": []},
            {"success": True, "result": [{"success": False, "error": "bad"}]},
            {"success": True, "result": [{"success": True, "results": "not rows"}]},
        ]
        for response in invalid:
            with self.subTest(response=response):
                with mock.patch.object(enroll, "api_json", return_value=response):
                    with self.assertRaises(enroll.ApiError):
                        enroll.d1_query("token", "SELECT 1")


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.material = material()
        self.expected = enroll.MachineRow(
            self.material.fingerprint, self.material.cert_id, 1, "software"
        )

    def test_guarded_registration_uses_params_and_separate_verify(self):
        calls = []

        def query(_token, sql, params=None):
            calls.append((sql, params))
            return []

        with (
            mock.patch.object(enroll, "d1_query", side_effect=query),
            mock.patch.object(enroll, "get_machine", return_value=self.expected) as verify,
        ):
            row = enroll.register_machine("token", "test-windows", self.material, 1)

        self.assertEqual(row, self.expected)
        self.assertEqual(len(calls), 1)
        self.assertIn("WHERE machines.cert_fp_sha256 IS NULL", calls[0][0])
        self.assertEqual(calls[0][1][0], "test-windows")
        self.assertEqual(calls[0][1][3:6], [self.material.fingerprint, "cert-123", "1"])
        verify.assert_called_once_with("token", "test-windows")

    def test_machine_lookup_uses_one_parameter_list(self):
        with mock.patch.object(enroll, "d1_query", return_value=[]) as query:
            self.assertIsNone(enroll.get_machine("token", "test-windows"))

        query.assert_called_once()
        self.assertEqual(query.call_args.args[2], ["test-windows"])

    def test_failed_write_can_succeed_when_separate_verify_matches(self):
        with (
            mock.patch.object(enroll, "d1_query", side_effect=enroll.ApiError("write uncertain")),
            mock.patch.object(enroll, "get_machine", return_value=self.expected),
        ):
            self.assertEqual(
                enroll.register_machine("token", "test-windows", self.material, 1),
                self.expected,
            )

    def test_failed_write_and_failed_verify_is_ambiguous(self):
        with (
            mock.patch.object(enroll, "d1_query", side_effect=enroll.ApiError("write uncertain")),
            mock.patch.object(enroll, "get_machine", side_effect=enroll.ApiError("read down")),
        ):
            with self.assertRaisesRegex(enroll.EnrollmentError, "ambiguous"):
                enroll.register_machine("token", "test-windows", self.material, 1)

    def test_different_full_tuple_is_rejected(self):
        mismatches = [
            enroll.MachineRow("other", "cert-123", 1, "software"),
            enroll.MachineRow(self.material.fingerprint, "other-id", 1, "software"),
            enroll.MachineRow(self.material.fingerprint, "cert-123", 0, "software"),
            enroll.MachineRow(self.material.fingerprint, "cert-123", 1, "tpm"),
        ]
        for row in mismatches:
            with self.subTest(row=row):
                with (
                    mock.patch.object(enroll, "d1_query", return_value=[]),
                    mock.patch.object(enroll, "get_machine", return_value=row),
                ):
                    with self.assertRaisesRegex(enroll.EnrollmentError, "different certificate metadata"):
                        enroll.register_machine("token", "test-windows", self.material, 1)

    def test_revoke_unused_checks_all_references_before_delete_and_cleanup(self):
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            paths = [
                out / "test-windows.client.pem.new",
                out / "test-windows.client.pem.new.id",
                out / "test-windows.client.key",
                out / "test-windows.client.csr",
            ]
            for path in paths:
                path.write_text("artifact")
            with (
                mock.patch.object(enroll, "d1_query", return_value=[]) as query,
                mock.patch.object(enroll, "api_json", return_value={"success": True}) as api,
            ):
                enroll.revoke_unused("token", "test-windows", out, self.material)
            sql = query.call_args.args[1]
            self.assertIn("prev_cert_fp_sha256", sql)
            self.assertIn("prev_cert_id", sql)
            self.assertIn("retired_certs", sql)
            self.assertEqual(query.call_args.args[2], [self.material.fingerprint, self.material.cert_id])
            self.assertEqual(api.call_args.args[:3], (
                "token", "DELETE", f"/zones/{enroll.ZONE_ID}/client_certificates/{self.material.cert_id}"
            ))
            self.assertTrue(all(not path.exists() for path in paths))

    def test_reference_or_reference_read_failure_preserves_artifacts(self):
        for result in ([{"owner": "someone"}], enroll.ApiError("D1 unavailable")):
            with self.subTest(result=result), tempfile.TemporaryDirectory() as raw:
                out = Path(raw)
                temp = out / "test-windows.client.pem.new"
                sidecar = out / "test-windows.client.pem.new.id"
                temp.write_text("cert")
                sidecar.write_text("cert_id=cert-123")
                effect = result if isinstance(result, Exception) else None
                with (
                    mock.patch.object(enroll, "d1_query", return_value=result if effect is None else None,
                                      side_effect=effect),
                    mock.patch.object(enroll, "api_json") as api,
                ):
                    with self.assertRaises(enroll.AmbiguousRegistration):
                        enroll.revoke_unused("token", "test-windows", out, self.material)
                api.assert_not_called()
                self.assertTrue(temp.exists())
                self.assertTrue(sidecar.exists())

    def test_unconfirmed_revoke_preserves_artifacts(self):
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            temp = out / "test-windows.client.pem.new"
            sidecar = out / "test-windows.client.pem.new.id"
            temp.write_text("cert")
            sidecar.write_text("cert_id=cert-123")
            with (
                mock.patch.object(enroll, "d1_query", return_value=[]),
                mock.patch.object(enroll, "api_json", side_effect=enroll.ApiError("delete uncertain")),
            ):
                with self.assertRaises(enroll.AmbiguousRegistration):
                    enroll.revoke_unused("token", "test-windows", out, self.material)
            self.assertTrue(temp.exists())
            self.assertTrue(sidecar.exists())


class RecoveryTests(unittest.TestCase):
    def test_loads_staged_material_without_cloudflare_or_d1_access(self):
        item = material()
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            (out / "test-windows.client.key").write_bytes(
                item.private_key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.TraditionalOpenSSL,
                    serialization.NoEncryption(),
                )
            )
            (out / "test-windows.client.pem.new").write_bytes(
                item.certificate.public_bytes(serialization.Encoding.PEM)
            )
            (out / "test-windows.client.pem.new.id").write_text(
                f"cert_id={item.cert_id}\nfp={item.fingerprint}\n"
            )
            with (
                mock.patch.object(enroll, "api_json") as api,
                mock.patch.object(enroll, "d1_query") as d1,
            ):
                recovered = enroll.load_staged_recovery("test-windows", out)

            api.assert_not_called()
            d1.assert_not_called()
            self.assertEqual(recovered.cert_id, item.cert_id)
            self.assertEqual(recovered.fingerprint, item.fingerprint)

    def test_staged_material_requires_sidecar_fingerprint(self):
        item = material()
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            (out / "test-windows.client.key").write_bytes(
                item.private_key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.TraditionalOpenSSL,
                    serialization.NoEncryption(),
                )
            )
            (out / "test-windows.client.pem.new").write_bytes(
                item.certificate.public_bytes(serialization.Encoding.PEM)
            )
            (out / "test-windows.client.pem.new.id").write_text(f"cert_id={item.cert_id}\nfp=\n")
            with self.assertRaisesRegex(enroll.EnrollmentError, "no certificate fingerprint"):
                enroll.load_staged_recovery("test-windows", out)

    def test_loads_promoted_stage_after_interrupted_proof(self):
        item = material()
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            (out / "test-windows.client.key").write_bytes(
                item.private_key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.TraditionalOpenSSL,
                    serialization.NoEncryption(),
                )
            )
            (out / "test-windows.client.pem").write_bytes(
                item.certificate.public_bytes(serialization.Encoding.PEM)
            )
            (out / "test-windows.client.pem.new.id").write_text(
                f"cert_id={item.cert_id}\nfp={item.fingerprint}\n"
            )
            recovered = enroll.load_staged_recovery("test-windows", out)
            self.assertEqual(recovered.fingerprint, item.fingerprint)

    def test_loads_complete_stranded_material(self):
        item = material()
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            (out / "test-windows.client.key").write_bytes(
                item.private_key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.TraditionalOpenSSL,
                    serialization.NoEncryption(),
                )
            )
            (out / "test-windows.client.pem.new").write_bytes(
                item.certificate.public_bytes(serialization.Encoding.PEM)
            )
            (out / "test-windows.client.pem.new.id").write_text(
                f"cert_id={item.cert_id}\nfp={item.fingerprint}\n"
            )
            with mock.patch.object(enroll, "verify_ca_binding") as verify:
                recovered = enroll.load_recovery("token", "test-windows", out)
            verify.assert_called_once_with("token", item.cert_id, item.fingerprint)
        self.assertEqual(recovered.cert_id, item.cert_id)
        self.assertEqual(recovered.fingerprint, item.fingerprint)

    def test_incomplete_or_mismatched_recovery_is_preserved_and_rejected(self):
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            temp = out / "test-windows.client.pem.new"
            temp.write_text("do not delete")
            with self.assertRaisesRegex(enroll.EnrollmentError, "incomplete"):
                enroll.load_recovery("token", "test-windows", out)
            self.assertEqual(temp.read_text(), "do not delete")

    def test_wrong_sidecar_ca_binding_aborts_recovery(self):
        item = material()
        other = material(cert_id="different-id")
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            (out / "test-windows.client.key").write_bytes(
                item.private_key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.TraditionalOpenSSL,
                    serialization.NoEncryption(),
                )
            )
            temp = out / "test-windows.client.pem.new"
            sidecar = out / "test-windows.client.pem.new.id"
            temp.write_bytes(item.certificate.public_bytes(serialization.Encoding.PEM))
            sidecar.write_text(f"cert_id={other.cert_id}\nfp={item.fingerprint}\n")
            response = {
                "success": True,
                "result": {
                    "status": "active",
                    "certificate": other.certificate.public_bytes(serialization.Encoding.PEM).decode(),
                },
            }
            with mock.patch.object(enroll, "api_json", return_value=response):
                with self.assertRaisesRegex(enroll.EnrollmentError, "different certificate"):
                    enroll.load_recovery("token", "test-windows", out)
            self.assertTrue(temp.exists())
            self.assertTrue(sidecar.exists())

    def test_malformed_minted_cert_and_ambiguous_delete_preserve_recovery_set(self):
        response = {
            "success": True,
            "result": {
                "id": "minted-cert",
                "certificate": "not a certificate",
                "expires_on": "2099-01-01T00:00:00Z",
            },
        }

        def api(_token, method, _path, _payload=None):
            if method == "POST":
                return response
            raise enroll.ApiError("DELETE timed out")

        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            with mock.patch.object(enroll, "api_json", side_effect=api):
                with self.assertRaisesRegex(enroll.EnrollmentError, "revocation was not confirmed"):
                    enroll.create_material("token", "test-windows", out)
            temp = out / "test-windows.client.pem.new"
            sidecar = out / "test-windows.client.pem.new.id"
            key = out / "test-windows.client.key"
            self.assertEqual(temp.read_text(), "not a certificate")
            self.assertIn("cert_id=minted-cert", sidecar.read_text())
            self.assertTrue(key.is_file())

    def test_sign_failure_reuses_unsigned_key_and_csr_on_rerun(self):
        ca_key = ec.generate_private_key(ec.SECP256R1())
        calls = 0

        def api(_token, method, _path, payload=None):
            nonlocal calls
            self.assertEqual(method, "POST")
            calls += 1
            if calls == 1:
                raise enroll.ApiError("sign request timed out")
            csr = x509.load_pem_x509_csr(payload["csr"].encode())
            cert = (
                x509.CertificateBuilder()
                .subject_name(csr.subject)
                .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test CA")]))
                .public_key(csr.public_key())
                .serial_number(2)
                .not_valid_before(datetime.now(timezone.utc))
                .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
                .sign(ca_key, hashes.SHA256())
            )
            return {
                "success": True,
                "result": {
                    "id": "recovered-cert",
                    "certificate": cert.public_bytes(serialization.Encoding.PEM).decode(),
                    "expires_on": "2099-01-01T00:00:00Z",
                },
            }

        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            with mock.patch.object(enroll, "api_json", side_effect=api):
                with self.assertRaises(enroll.ApiError):
                    enroll.create_material("token", "test-windows", out)
                key_path = out / "test-windows.client.key"
                csr_path = out / "test-windows.client.csr"
                original_key = key_path.read_bytes()
                original_csr = csr_path.read_bytes()
                self.assertFalse((out / "test-windows.client.pem.new").exists())
                recovered = enroll.create_material("token", "test-windows", out)

            self.assertEqual(key_path.read_bytes(), original_key)
            self.assertEqual(csr_path.read_bytes(), original_csr)
            self.assertEqual(recovered.cert_id, "recovered-cert")


class CollectorFlowTests(unittest.TestCase):
    def setUp(self):
        self.item = material()
        self.env = mock.patch.dict(
            os.environ,
            {
                "CF_API_TOKEN": "cf-secret",
                "CLOUDFLARE_API_TOKEN": "alternate-secret",
                "AC_PFX_PW": "old-password",
            },
            clear=False,
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def _paths(self, raw):
        out = Path(raw)
        cert = out / "test-windows.client.pem"
        key = out / "test-windows.client.key"
        csr = out / "test-windows.client.csr"
        cert.write_bytes(self.item.certificate.public_bytes(serialization.Encoding.PEM))
        key.write_text("exportable private key")
        csr.write_text("csr")
        return out, cert, key, csr

    def test_install_and_machine_id_subprocesses_scrub_secrets(self):
        calls = []
        agent_lookups = 0

        def which(command):
            nonlocal agent_lookups
            if command == "uv":
                return "/tools/uv"
            if command == "agent-collector":
                agent_lookups += 1
                return None if agent_lookups == 1 else "/tools/agent-collector"
            return None

        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            if argv[1:] == ["machine-id"]:
                return types.SimpleNamespace(stdout="test-windows\n", returncode=0)
            if argv[1:] == ["enroll", "--help"]:
                return types.SimpleNamespace(stdout="--import-pfx --client-cert", returncode=0)
            if argv[1:] == ["doctor", "--help"]:
                return types.SimpleNamespace(stdout="--require-current-cert", returncode=0)
            if argv[1:] == ["run", "--help"]:
                return types.SimpleNamespace(stdout="--heartbeat-only", returncode=0)
            return types.SimpleNamespace(stdout="", returncode=0)

        with (
            mock.patch.object(enroll.shutil, "which", side_effect=which),
            mock.patch.object(enroll.subprocess, "run", side_effect=run),
        ):
            collector = enroll.ensure_collector()
            self.assertEqual(enroll.machine_id_for(collector, None), "test-windows")

        self.assertEqual(
            [call[0][1:3] for call in calls],
            [
                ["tool", "install"],
                ["enroll", "--help"],
                ["doctor", "--help"],
                ["run", "--help"],
                ["machine-id"],
            ],
        )
        for argv, kwargs in calls:
            self.assertNotIn("cf-secret", " ".join(argv))
            self.assertNotIn("CF_API_TOKEN", kwargs["env"])
            self.assertNotIn("CLOUDFLARE_API_TOKEN", kwargs["env"])
            self.assertNotIn("AC_PFX_PW", kwargs["env"])

    def test_outdated_collector_is_replaced_from_sibling_source(self):
        calls = []

        def run(argv, **kwargs):
            calls.append((list(argv), kwargs))
            if argv[0] == "/old/agent-collector" and argv[1] == "enroll":
                return types.SimpleNamespace(stdout="--import-pfx --client-cert", returncode=0)
            if argv[0] == "/old/agent-collector" and argv[1] == "doctor":
                return types.SimpleNamespace(stdout="--require-current-cert", returncode=0)
            if argv[0] == "/old/agent-collector" and argv[1] == "run":
                return types.SimpleNamespace(stdout="--once", returncode=0)
            if argv[0] == "/new/agent-collector" and argv[1] == "enroll":
                return types.SimpleNamespace(stdout="--import-pfx --client-cert", returncode=0)
            if argv[0] == "/new/agent-collector" and argv[1] == "doctor":
                return types.SimpleNamespace(stdout="--require-current-cert", returncode=0)
            if argv[0] == "/new/agent-collector" and argv[1] == "run":
                return types.SimpleNamespace(stdout="--heartbeat-only", returncode=0)
            return types.SimpleNamespace(stdout="", returncode=0)

        lookups = iter(["/old/agent-collector", "/tools/uv", "/new/agent-collector"])
        with (
            mock.patch.object(enroll.shutil, "which", side_effect=lambda _command: next(lookups)),
            mock.patch.object(enroll.subprocess, "run", side_effect=run),
        ):
            self.assertEqual(enroll.ensure_collector(), "/new/agent-collector")

        install = next(argv for argv, _kwargs in calls if argv[:3] == ["/tools/uv", "tool", "install"])
        self.assertEqual(
            install[0:5],
            ["/tools/uv", "tool", "install", "--force", "--reinstall"],
        )

    def test_windows_order_password_isolation_and_cleanup(self):
        with tempfile.TemporaryDirectory() as raw:
            out, cert, key, csr = self._paths(raw)
            calls = []

            def run(argv, **kwargs):
                calls.append((list(argv), kwargs["env"], key.exists()))
                if argv[1] == "enroll":
                    (out / "test-windows.client.pfx").unlink()
                return types.SimpleNamespace(returncode=0)

            with (
                mock.patch.object(enroll.os, "name", "nt"),
                mock.patch.object(enroll.subprocess, "run", side_effect=run),
            ):
                enroll.configure_collector(
                    "collector.exe", "test-windows", out, cert, self.item, True
                )

            self.assertEqual([call[0][1] for call in calls], ["enroll", "doctor", "run", "install"])
            self.assertEqual(calls[2][0][1:], ["run", "--heartbeat-only"])
            self.assertTrue(all(key_exists for _, _, key_exists in calls[:3]))
            self.assertFalse(calls[3][2], "key must be removed before scheduler install")
            self.assertFalse(key.exists())
            self.assertFalse(csr.exists())
            for argv, env, _ in calls:
                rendered = " ".join(argv)
                self.assertNotIn("cf-secret", rendered)
                self.assertNotIn("alternate-secret", rendered)
                self.assertNotIn("old-password", rendered)
                self.assertNotIn("CF_API_TOKEN", env)
                self.assertNotIn("CLOUDFLARE_API_TOKEN", env)
            enroll_env = calls[0][1]
            self.assertIn("AC_PFX_PW", enroll_env)
            self.assertNotEqual(enroll_env["AC_PFX_PW"], "old-password")
            for _, env, _ in calls[1:]:
                self.assertNotIn("AC_PFX_PW", env)

    def test_repo_local_promoted_artifact_is_resumed(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            out = root / ".config" / "agent-collector"
            out.mkdir(parents=True)
            (out / "test-windows.client.pem").write_text("certificate")
            with mock.patch.object(enroll.Path, "cwd", return_value=root):
                self.assertEqual(enroll.output_dir_for("test-windows", None), out.resolve())

    def test_legacy_windows_checkout_artifacts_are_discovered(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            home = root / "Users" / "pedro"
            cwd = root / "src" / "agent-sessions-backup"
            legacy = home / "src" / "agent-sessions-backup" / ".config" / "agent-collector"
            cwd.mkdir(parents=True)
            legacy.mkdir(parents=True)
            (legacy / "test-windows.client.pem.new").write_text("certificate")
            with (
                mock.patch.object(enroll.Path, "home", return_value=home),
                mock.patch.object(enroll.Path, "cwd", return_value=cwd),
            ):
                self.assertEqual(enroll.output_dir_for("test-windows", None), legacy.resolve())

    def test_multiple_exact_machine_artifact_directories_are_ambiguous(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            first = root / "current" / ".config" / "agent-collector"
            second = root / "legacy" / ".config" / "agent-collector"
            first.mkdir(parents=True)
            second.mkdir(parents=True)
            (first / "test-windows.client.pem").write_text("first")
            (second / "test-windows.client.key").write_text("second")
            (second / "other-windows.client.pem").write_text("unrelated")
            with mock.patch.object(enroll, "output_dir_candidates", return_value=(first, second)):
                with self.assertRaisesRegex(enroll.EnrollmentError, "multiple candidate directories") as raised:
                    enroll.output_dir_for("test-windows", None)
            self.assertIn(str(first), str(raised.exception))
            self.assertIn(str(second), str(raised.exception))
            self.assertIn("--out <directory>", str(raised.exception))

    def test_artifacts_for_another_machine_do_not_select_legacy_directory(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            home = root / "Users" / "pedro"
            legacy = home / "src" / "agent-sessions-backup" / ".config" / "agent-collector"
            default = home / ".config" / "agent-collector"
            legacy.mkdir(parents=True)
            (legacy / "other-windows.client.pem.new").write_text("unrelated")
            with (
                mock.patch.object(enroll.Path, "home", return_value=home),
                mock.patch.object(enroll, "output_dir_candidates", return_value=(legacy, default)),
            ):
                self.assertEqual(enroll.output_dir_for("test-windows", None), default.resolve())

    def test_explicit_output_directory_wins_over_discovery(self):
        with tempfile.TemporaryDirectory() as raw:
            explicit = Path(raw) / "chosen"
            with mock.patch.object(enroll, "output_dir_candidates") as candidates:
                self.assertEqual(enroll.output_dir_for("test-windows", str(explicit)), explicit.resolve())
            candidates.assert_not_called()

    def test_main_resumes_imported_windows_cert_before_loading_private_key(self):
        class TokenEnvironment(dict):
            def get(self, key, default=None):
                if key == "CF_API_TOKEN":
                    raise AssertionError("main must not read the deprecated token name")
                return super().get(key, default)

        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            cert = out / "test-windows.client.pem"
            cert.write_bytes(self.item.certificate.public_bytes(serialization.Encoding.PEM))
            row = enroll.MachineRow(self.item.fingerprint, self.item.cert_id, 0, "software")
            with (
                mock.patch.object(
                    enroll.os,
                    "environ",
                    TokenEnvironment(CLOUDFLARE_API_TOKEN="token"),
                ),
                mock.patch.object(enroll.os, "name", "nt"),
                mock.patch.object(enroll, "ensure_collector", return_value="collector.exe"),
                mock.patch.object(enroll, "machine_id_for", return_value="test-windows"),
                mock.patch.object(enroll, "output_dir_for", return_value=out),
                mock.patch.object(enroll, "preflight") as preflight,
                mock.patch.object(enroll, "load_recovery", return_value=None),
                mock.patch.object(enroll, "get_machine", return_value=row),
                mock.patch.object(enroll, "load_promoted") as load_promoted,
                mock.patch.object(enroll, "resume_configured_collector") as resume,
            ):
                self.assertEqual(enroll.main(["--no-schedule"]), 0)

            load_promoted.assert_not_called()
            preflight.assert_called_once_with("token")
            resume.assert_called_once_with("collector.exe", False)

    def test_main_installs_staged_material_without_management_token(self):
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            with (
                mock.patch.dict(enroll.os.environ, {}, clear=True),
                mock.patch.object(enroll, "ensure_collector", return_value="collector.exe"),
                mock.patch.object(enroll, "machine_id_for", return_value="test-windows"),
                mock.patch.object(enroll, "output_dir_for", return_value=out),
                mock.patch.object(enroll, "install_staged_collector") as install,
                mock.patch.object(enroll, "preflight") as preflight,
                mock.patch("builtins.print") as emit,
            ):
                self.assertEqual(enroll.main(["--install-staged"]), 0)

            install.assert_called_once_with("collector.exe", "test-windows", out, True)
            preflight.assert_not_called()
            emit.assert_any_call(
                "[ok] test-windows installed, sent an authenticated heartbeat, and scheduled every 15 minutes"
            )

    def test_install_staged_rejects_incomplete_new_stage_before_imported_resume(self):
        with tempfile.TemporaryDirectory() as raw:
            out = Path(raw)
            (out / "test-windows.client.pem").write_bytes(
                self.item.certificate.public_bytes(serialization.Encoding.PEM)
            )
            (out / "test-windows.client.pem.new").write_text("stranded stage")
            with (
                mock.patch.object(enroll.os, "name", "nt"),
                mock.patch.object(enroll, "resume_configured_collector") as resume,
            ):
                with self.assertRaisesRegex(enroll.EnrollmentError, "incomplete staged"):
                    enroll.install_staged_collector("collector.exe", "test-windows", out, True)
            resume.assert_not_called()

    def test_doctor_failure_keeps_key_and_does_not_run_or_schedule(self):
        with tempfile.TemporaryDirectory() as raw:
            out, cert, key, _ = self._paths(raw)
            commands = []

            def run(argv, **_kwargs):
                commands.append(argv[1])
                if argv[1] == "enroll":
                    (out / "test-windows.client.pfx").unlink()
                if argv[1] == "doctor":
                    raise subprocess.CalledProcessError(1, argv)
                return types.SimpleNamespace(returncode=0)

            with (
                mock.patch.object(enroll.os, "name", "nt"),
                mock.patch.object(enroll.subprocess, "run", side_effect=run),
            ):
                with self.assertRaises(subprocess.CalledProcessError):
                    enroll.configure_collector(
                        "collector.exe", "test-windows", out, cert, self.item, True
                    )
            self.assertEqual(commands, ["enroll", "doctor"])
            self.assertTrue(key.exists())

    def test_staged_sidecar_survives_failed_proof_and_precedes_key_cleanup(self):
        with tempfile.TemporaryDirectory() as raw:
            out, cert, key, _ = self._paths(raw)
            sidecar = out / "test-windows.client.pem.new.id"
            sidecar.write_text(f"cert_id={self.item.cert_id}\nfp={self.item.fingerprint}\n")
            calls = []

            def fail_doctor(argv, **_kwargs):
                calls.append(argv[1])
                if argv[1] == "enroll":
                    (out / "test-windows.client.pfx").unlink()
                if argv[1] == "doctor":
                    raise subprocess.CalledProcessError(1, argv)
                return types.SimpleNamespace(returncode=0)

            with (
                mock.patch.object(enroll.os, "name", "nt"),
                mock.patch.object(enroll.subprocess, "run", side_effect=fail_doctor),
            ):
                with self.assertRaises(subprocess.CalledProcessError):
                    enroll.configure_collector(
                        "collector.exe", "test-windows", out, cert, self.item, True, sidecar
                    )
            self.assertEqual(calls, ["enroll", "doctor"])
            self.assertTrue(sidecar.exists())
            self.assertTrue(key.exists())

            sidecar_order = []

            def succeed(argv, **_kwargs):
                sidecar_order.append((argv[1], sidecar.exists(), key.exists()))
                if argv[1] == "enroll":
                    (out / "test-windows.client.pfx").unlink()
                return types.SimpleNamespace(returncode=0)

            with (
                mock.patch.object(enroll.os, "name", "nt"),
                mock.patch.object(enroll.subprocess, "run", side_effect=succeed),
            ):
                enroll.configure_collector(
                    "collector.exe", "test-windows", out, cert, self.item, True, sidecar
                )
            self.assertEqual([entry[0] for entry in sidecar_order], ["enroll", "doctor", "run", "install"])
            self.assertEqual(sidecar_order[-1][1:], (False, False))

    def test_live_upload_failure_keeps_key_and_does_not_schedule(self):
        with tempfile.TemporaryDirectory() as raw:
            out, cert, key, _ = self._paths(raw)
            commands = []

            def run(argv, **_kwargs):
                commands.append(argv[1])
                if argv[1] == "enroll":
                    (out / "test-windows.client.pfx").unlink()
                if argv[1] == "run":
                    raise subprocess.CalledProcessError(1, argv)
                return types.SimpleNamespace(returncode=0)

            with (
                mock.patch.object(enroll.os, "name", "nt"),
                mock.patch.object(enroll.subprocess, "run", side_effect=run),
            ):
                with self.assertRaises(subprocess.CalledProcessError):
                    enroll.configure_collector(
                        "collector.exe", "test-windows", out, cert, self.item, True
                    )
            self.assertEqual(commands, ["enroll", "doctor", "run"])
            self.assertTrue(key.exists())

    def test_no_schedule_option_omits_install(self):
        with tempfile.TemporaryDirectory() as raw:
            out, cert, _key, _ = self._paths(raw)
            commands = []

            def run(argv, **_kwargs):
                commands.append(list(argv[1:]))
                return types.SimpleNamespace(returncode=0)

            with mock.patch.object(enroll.subprocess, "run", side_effect=run):
                enroll.configure_collector(
                    "agent-collector", "test-windows", out, cert, self.item, False
                )
            self.assertEqual([command[0] for command in commands], ["enroll", "doctor", "run"])
            self.assertEqual(commands[-1], ["run", "--once"])


if __name__ == "__main__":
    unittest.main()
