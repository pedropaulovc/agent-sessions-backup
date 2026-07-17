"""Transport: subprocess curl (system curl on Linux + Windows).

Auth is a strategy so the mTLS variants can slot in later without touching call sites.
DevAuth adds the x-dev-machine header; MtlsAuth raises NotImplementedError for now.

Backfill fast path (upload_batch): one curl invocation per 50 URLs using a --config file
of `--next`-separated request blocks, run with `--parallel --parallel-max N`. Bodies are
discarded (output=/dev/null) and a global `-w "%{url_effective} %{http_code}\\n"` prints one
self-describing status line per transfer, so ordering under --parallel doesn't matter: we
map url -> code. Any ambiguous/failed line falls back to a sequential retrying put().
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

BACKOFF = (0.5, 2.0, 8.0)
BATCH_SIZE = 50


class AuthStrategy:
    def curl_args(self) -> list[str]:
        raise NotImplementedError


class DevAuth(AuthStrategy):
    def __init__(self, machine_id: str):
        self.machine_id = machine_id

    def curl_args(self) -> list[str]:
        return ["-H", f"x-dev-machine: {self.machine_id}"]


class MtlsAuth(AuthStrategy):
    """Placeholder: mTLS lands in a later milestone (TPM keygen -> CSR -> managed CA)."""

    def __init__(self, key_protection: str = "software"):
        self.key_protection = key_protection

    def curl_args(self) -> list[str]:
        raise NotImplementedError(
            f"mTLS transport (key_protection={self.key_protection!r}) is not implemented "
            "yet; it lands in a later milestone. For TPM-backed keys the private key never "
            "leaves the TPM, so curl must be invoked with an engine/provider that references "
            "the key handle — wire that here when the mTLS milestone starts. Use auth=\"dev\" "
            "for now."
        )


def _retryable(returncode: int, status: int) -> bool:
    if returncode != 0:
        return True  # curl network-level failure
    if status == 429:
        return True
    return 500 <= status < 600


def _split_status(stdout: str) -> tuple[int, str]:
    """Body + '\\n%{http_code}' -> (status, body). status 0 if unparseable."""
    idx = stdout.rfind("\n")
    if idx == -1:
        code = stdout.strip()
        return (int(code) if code.isdigit() else 0), ""
    body, code = stdout[:idx], stdout[idx + 1:].strip()
    return (int(code) if code.isdigit() else 0), body


class Transport:
    def __init__(self, auth: AuthStrategy, curl: str = "curl", parallel_max: int = 6):
        self.auth = auth
        self.curl = curl
        self.parallel_max = parallel_max

    @staticmethod
    def curl_available(curl: str = "curl") -> bool:
        return shutil.which(curl) is not None

    def _run(self, argv: list[str]) -> tuple[int, int, str]:
        proc = subprocess.run(
            [self.curl, *argv], capture_output=True, text=True
        )
        status, body = _split_status(proc.stdout)
        return proc.returncode, status, body

    def _run_retry(self, argv: list[str]) -> tuple[int, str]:
        rc, status, body = self._run(argv)
        for delay in BACKOFF:
            if not _retryable(rc, status):
                break
            time.sleep(delay)
            rc, status, body = self._run(argv)
        if rc != 0 and status == 0:
            return 0, body  # network failure, never reached the hub
        return status, body

    def get(self, url: str) -> tuple[int, str]:
        return self._run_retry(
            ["-sS", "--fail-with-body", "-w", "\n%{http_code}", url]
        )

    def put(self, url: str, body_path: Path, headers: dict[str, str]) -> tuple[int, str]:
        argv = ["-sS", "--fail-with-body", "-w", "\n%{http_code}",
                "--upload-file", str(body_path)]
        for k, v in headers.items():
            argv += ["-H", f"{k}: {v}"]
        argv += self.auth.curl_args()
        argv.append(url)
        return self._run_retry(argv)

    def post_json(self, url: str, obj: dict, headers: dict[str, str] | None = None) -> tuple[int, str]:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(obj, f)
            body_file = f.name
        try:
            argv = ["-sS", "--fail-with-body", "-w", "\n%{http_code}", "-X", "POST",
                    "-H", "content-type: application/json",
                    "--data-binary", f"@{body_file}"]
            for k, v in (headers or {}).items():
                argv += ["-H", f"{k}: {v}"]
            argv += self.auth.curl_args()
            argv.append(url)
            return self._run_retry(argv)
        finally:
            Path(body_file).unlink(missing_ok=True)

    def upload_batch(self, uploads: list["Upload"]) -> dict[str, int]:
        """Upload many files with parallel curl. Returns url -> http_code (0 = unknown).

        Callers should retry any url whose code is not a clear 200/201 via put().
        """
        result: dict[str, int] = {}
        for start in range(0, len(uploads), BATCH_SIZE):
            chunk = uploads[start:start + BATCH_SIZE]
            result.update(self._upload_config(chunk))
        return result

    def _upload_config(self, chunk: list["Upload"]) -> dict[str, int]:
        # write-out MUST be per-block: a global -w only fires for the first transfer
        # under --parallel, so every request carries its own self-describing status line.
        blocks = []
        for up in chunk:
            block = [
                f'url = "{up.url}"',
                f'upload-file = "{up.body_path}"',
                'output = "/dev/null"',
                'write-out = "%{url_effective} %{http_code}\\n"',
            ]
            for k, v in up.headers.items():
                block.append(f'header = "{k}: {v}"')
            for arg in self.auth.curl_args():
                if arg == "-H":
                    continue
                block.append(f'header = "{arg}"')
            blocks.append("\n".join(block))
        config_text = "\n--next\n".join(blocks) + "\n"

        with tempfile.NamedTemporaryFile("w", suffix=".curl", delete=False) as f:
            f.write(config_text)
            cfg_path = f.name
        try:
            proc = subprocess.run(
                [self.curl, "-sS", "--parallel", "--parallel-max",
                 str(self.parallel_max), "--config", cfg_path],
                capture_output=True, text=True,
            )
        finally:
            Path(cfg_path).unlink(missing_ok=True)

        codes: dict[str, int] = {}
        for line in proc.stdout.splitlines():
            parts = line.rsplit(" ", 1)
            if len(parts) != 2 or not parts[1].isdigit():
                continue
            codes[parts[0]] = int(parts[1])
        return {up.url: codes.get(up.url, 0) for up in chunk}


class Upload:
    __slots__ = ("url", "body_path", "headers")

    def __init__(self, url: str, body_path: str, headers: dict[str, str]):
        self.url = url
        self.body_path = body_path
        self.headers = headers
