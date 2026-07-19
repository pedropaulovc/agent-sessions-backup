"""Transport: subprocess curl (system curl on Linux + Windows).

Auth is a strategy so the mTLS variants slot in without touching call sites.
DevAuth adds the x-dev-machine header; MtlsAuth presents a file-based client cert+key
(--cert/--key) for software keys, and raises NotImplementedError for TPM keys (M4).

Backfill fast path (upload_batch): one curl invocation per 50 URLs using a --config file
of `--next`-separated request blocks, run with `--parallel --parallel-max N`. Bodies are
discarded (output=/dev/null) and a PER-BLOCK `write-out "%{url_effective} %{http_code}\\n"`
prints one self-describing status line per transfer (a global -w only fires for the first
transfer under --parallel), so ordering doesn't matter: we map url -> code. Any
ambiguous/failed line falls back to a sequential retrying put().
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path


def _curl_config_quote(value: str) -> str:
    """Escape a value for a double-quoted curl --config entry.

    curl treats backslash as an escape inside quoted config values, so an unescaped
    Windows path (C:\\Users\\...) gets mangled and the upload file can't be found. Escape
    backslashes first, then double-quotes.
    """
    return value.replace("\\", "\\\\").replace('"', '\\"')


def normalize_thumbprint(thumbprint: str) -> str:
    """Canonicalize a cert thumbprint for the schannel store reference. Windows tools sprinkle in
    separators (certmgr shows "ab cd ef ..", openssl uses "AB:CD:.."), and a thumbprint copied from
    the MMC cert UI carries an invisible U+200E left-to-right mark on the first char (MS KB2023835).
    Keep only hex digits, then require exactly 40 (a SHA-1 thumbprint) and uppercase. Anything else —
    a mangled paste, a truncated value, an accidental SHA-256 — raises here so enrollment fails loudly
    rather than writing a config that silently 401s on the first upload with an unfindable store entry."""
    cleaned = re.sub(r"[^0-9a-fA-F]", "", thumbprint)
    if len(cleaned) != 40:
        raise ValueError(
            f"thumbprint must be 40 hex chars (a SHA-1 cert thumbprint); got {len(cleaned)} "
            f"after stripping non-hex from {thumbprint!r}"
        )
    return cleaned.upper()


def _auth_config_directives(auth_args: list[str], q) -> list[str]:
    """Translate an auth strategy's command-line curl args into curl --config directives.

    curl's config file names options by their long form without dashes (`-H "x"` ->
    `header = "x"`, `--cert P` -> `cert = "P"`), so serializing the flags verbatim as
    `header = ...` (the old behavior) turned `--cert`/`--key` into bogus header lines and
    the parallel batch upload ran without a client cert. Every auth flag we emit takes
    exactly one value, so consume the args in (flag, value) pairs and map generically:
    `-H`/`--header` -> `header`, any other `--long` -> `long`. Unknown short flags raise
    rather than silently mis-serialize again."""
    directives: list[str] = []
    i = 0
    while i < len(auth_args):
        flag = auth_args[i]
        value = auth_args[i + 1] if i + 1 < len(auth_args) else ""
        if flag in ("-H", "--header"):
            name = "header"
        elif flag.startswith("--"):
            name = flag[2:]
        else:
            raise ValueError(f"cannot serialize curl auth flag {flag!r} into a --config directive")
        directives.append(f'{name} = "{q(value)}"')
        i += 2
    return directives


BACKOFF = (0.5, 2.0, 8.0)
BATCH_SIZE = 50

# Timeouts so one stuck transfer can never hold the overlap lock forever.
CONNECT_TIMEOUT = 10          # seconds to establish the connection
MAX_TIME = 600                # seconds for a single transfer (curl --max-time)
SUBPROCESS_MARGIN = 30        # subprocess timeout sits this far above curl's own bound

# HTTP statuses worth retrying (transient); everything else 4xx is permanent.
RETRY_STATUSES = frozenset({408, 429})

# --fail-with-body (which every single-transfer call depends on to see 4xx/5xx status via a
# nonzero exit) landed in curl 7.76.0. Older system curl (e.g. Ubuntu 20.04's 7.68) would
# silently return status 0 for every request, so we probe the version and fail loudly.
MIN_CURL_VERSION = (7, 76, 0)
_CURL_FLAG_REQUIRING_MIN = "--fail-with-body"


def _parse_curl_version(version_output: str) -> tuple[int, int, int] | None:
    """Parse the first line of `curl --version`, e.g. 'curl 7.68.0 (x86_64-...) libcurl/...'."""
    m = re.match(r"\s*curl\s+(\d+)\.(\d+)(?:\.(\d+))?", version_output)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))


class AuthStrategy:
    def curl_args(self) -> list[str]:
        raise NotImplementedError


class DevAuth(AuthStrategy):
    def __init__(self, machine_id: str):
        self.machine_id = machine_id

    def curl_args(self) -> list[str]:
        return ["-H", f"x-dev-machine: {self.machine_id}"]


class MtlsAuth(AuthStrategy):
    """mTLS client-cert auth. Two software-key mechanisms, chosen by which config field is set:

    - POSIX (Linux/WSL/macOS, OpenSSL-backed curl): a PEM cert + key file presented via
      `--cert`/`--key` (paths in client_cert_path/client_key_path, produced by infra/cf/enroll-cert.py).
    - Windows (Schannel-backed curl): a client cert imported into Cert:\\CurrentUser\\My, referenced by
      THUMBPRINT via `--cert "CurrentUser\\MY\\<thumbprint>"` and NO `--key`. Schannel rejects
      file-based PEM/PFX client certs (SEC_E_INTERNAL_ERROR — verified against the real hub; see
      the "Windows / Schannel mTLS" section of infra/cf/mtls.md), so the store reference is the
      only working form on the host curl.

    The thumbprint reference is ALSO the S2/TPM path: a TPM/PCP-backed key surfaces as a
    Cert:\\CurrentUser\\My entry with a non-exportable private key, so this transport code is unchanged
    — only enrollment differs (import a software PFX now, provision a PCP key later), both writing
    client_cert_thumbprint. key_protection stays orthogonal ('software' today).

    key_protection != "software" WITHOUT a thumbprint still raises NotImplementedError: a TPM key
    with no store reference has no curl invocation (curl can't take a raw provider handle here).
    """

    def __init__(
        self,
        client_cert_path: str | None = None,
        client_key_path: str | None = None,
        key_protection: str = "software",
        client_cert_thumbprint: str | None = None,
    ):
        self.client_cert_path = client_cert_path
        self.client_key_path = client_key_path
        self.key_protection = key_protection
        self.client_cert_thumbprint = client_cert_thumbprint

    def curl_args(self) -> list[str]:
        # Schannel store reference (Windows software-PFX now, TPM/PCP later): the private key lives in
        # the Windows cert store, so curl gets a thumbprint reference and NO --key. This is the only
        # client-cert form the host's schannel curl accepts (file-based PEM/PFX -> SEC_E_INTERNAL_ERROR).
        if self.client_cert_thumbprint:
            return ["--cert", f"CurrentUser\\MY\\{normalize_thumbprint(self.client_cert_thumbprint)}"]
        if self.key_protection != "software":
            raise NotImplementedError(
                f"TPM-backed mTLS (key_protection={self.key_protection!r}) with no store thumbprint is "
                "not implemented; provision the key into Cert:\\CurrentUser\\My and set "
                "client_cert_thumbprint (S2), or use key_protection=\"software\" with a file-based "
                "cert+key (POSIX) / an imported PFX thumbprint (Windows)."
            )
        cert, key = self.client_cert_path, self.client_key_path
        if not cert or not key:
            missing = "client_key_path" if cert else ("client_cert_path" if key else "client_cert_path and client_key_path")
            raise ValueError(
                f"mTLS auth requires both client_cert_path and client_key_path in the config; "
                f"missing {missing}. Run infra/cf/enroll-cert.py, then set both paths (see mtls.md)."
            )
        for label, path in (("client_cert_path", cert), ("client_key_path", key)):
            if not os.path.exists(path):
                raise FileNotFoundError(
                    f"mTLS {label} points at {path!r}, which does not exist. Re-run "
                    "infra/cf/enroll-cert.py to (re)generate the cert/key, or fix the config path."
                )
        return ["--cert", cert, "--key", key]


def _retryable(returncode: int, status: int) -> bool:
    # A parsed HTTP status is authoritative: --fail-with-body exits nonzero (rc 22) on any
    # 4xx, but a permanent 4xx must NOT be retried. Only fall back to returncode when there
    # is no HTTP response at all (status 0 = connection/network failure).
    if status:
        return status in RETRY_STATUSES or 500 <= status < 600
    return returncode != 0


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
        self._curl_version_ok = False  # cached: probe once per Transport instance

    @staticmethod
    def curl_available(curl: str = "curl") -> bool:
        return shutil.which(curl) is not None

    def _probe_curl_version(self) -> tuple[int, int, int] | None:
        """Run `curl --version` and parse it. Seam for tests to monkeypatch."""
        try:
            proc = subprocess.run([self.curl, "--version"], capture_output=True, text=True,
                                  timeout=CONNECT_TIMEOUT)
        except (OSError, subprocess.SubprocessError):
            return None
        first = proc.stdout.splitlines()[0] if proc.stdout else ""
        return _parse_curl_version(first)

    def check_curl_version(self) -> tuple[int, int, int]:
        """Return the detected curl version, or raise RuntimeError if it's too old (or
        undetectable) for the flags every request depends on."""
        version = self._probe_curl_version()
        if version is None:
            raise RuntimeError(
                f"could not determine the version of curl ({self.curl!r}); "
                f"{_CURL_FLAG_REQUIRING_MIN} needs curl >= "
                f"{'.'.join(map(str, MIN_CURL_VERSION))}"
            )
        if version < MIN_CURL_VERSION:
            raise RuntimeError(
                f"system curl {'.'.join(map(str, version))} is too old: "
                f"{_CURL_FLAG_REQUIRING_MIN} requires curl >= "
                f"{'.'.join(map(str, MIN_CURL_VERSION))} (e.g. Ubuntu 20.04 ships 7.68). "
                "Upgrade curl on this machine."
            )
        return version

    def _ensure_curl_version(self) -> None:
        if self._curl_version_ok:
            return
        self.check_curl_version()  # raises if too old
        self._curl_version_ok = True

    # Common flags on every single-transfer curl call: fail-with-body for 4xx/5xx, the
    # http_code writeout, and the connect/transfer timeouts.
    _COMMON = (
        "-sS", "--fail-with-body", "-w", "\n%{http_code}",
        "--connect-timeout", str(CONNECT_TIMEOUT), "--max-time", str(MAX_TIME),
    )

    def _run(self, argv: list[str], input_bytes: bytes | None = None) -> tuple[int, int, str]:
        self._ensure_curl_version()  # fail loudly on curl too old for --fail-with-body
        # A binary request body (multipart part) is piped to curl's stdin (`--data-binary @-`), which
        # requires bytes mode; the response (a small JSON status line) is decoded back to text so
        # _split_status works the same as the text-mode path.
        try:
            if input_bytes is None:
                proc = subprocess.run(
                    [self.curl, *argv], capture_output=True, text=True,
                    timeout=MAX_TIME + SUBPROCESS_MARGIN,
                )
                stdout = proc.stdout
            else:
                proc = subprocess.run(
                    [self.curl, *argv], capture_output=True, input=input_bytes,
                    timeout=MAX_TIME + SUBPROCESS_MARGIN,
                )
                stdout = proc.stdout.decode("utf-8", errors="replace")
        except subprocess.TimeoutExpired:
            # Belt above curl's own --max-time: treat as a network failure (status 0).
            return 124, 0, "curl subprocess timed out"
        status, body = _split_status(stdout)
        return proc.returncode, status, body

    def _run_retry(self, argv: list[str], input_bytes: bytes | None = None) -> tuple[int, str]:
        # Call _run with a single positional arg on the bodyless path so the many tests that
        # monkeypatch _run(argv) keep working; only the multipart part path passes input_bytes.
        rc, status, body = self._run(argv) if input_bytes is None else self._run(argv, input_bytes)
        for delay in BACKOFF:
            if not _retryable(rc, status):
                break
            time.sleep(delay)
            rc, status, body = self._run(argv) if input_bytes is None else self._run(argv, input_bytes)
        if rc != 0 and status == 0:
            return 0, body  # network failure, never reached the hub
        return status, body

    def get(self, url: str) -> tuple[int, str]:
        # Attach the auth strategy's curl args like put()/post_json() do. Doctor's authenticated
        # identity probe hits the API host, where the WAF rule blocks every
        # uncertified request — a certless probe would report a correctly-enrolled production
        # collector as "hub unreachable". The client cert is not a secret to withhold from a
        # health check, and sending it makes doctor validate the real production auth path.
        return self._run_retry([*self._COMMON, *self.auth.curl_args(), url])

    def put(self, url: str, body_path: Path, headers: dict[str, str]) -> tuple[int, str]:
        argv = [*self._COMMON, "--upload-file", str(body_path)]
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
            argv = [*self._COMMON, "-X", "POST",
                    "-H", "content-type: application/json",
                    "--data-binary", f"@{body_file}"]
            for k, v in (headers or {}).items():
                argv += ["-H", f"{k}: {v}"]
            argv += self.auth.curl_args()
            argv.append(url)
            return self._run_retry(argv)
        finally:
            Path(body_file).unlink(missing_ok=True)

    def request(self, method: str, url: str, headers: dict[str, str] | None = None) -> tuple[int, str]:
        """A bodyless request with the auth strategy attached — used for multipart create (POST
        ?uploads) and abort (DELETE ?uploadId), which carry their inputs entirely in headers/query."""
        argv = [*self._COMMON, "-X", method]
        for k, v in (headers or {}).items():
            argv += ["-H", f"{k}: {v}"]
        argv += self.auth.curl_args()
        argv.append(url)
        return self._run_retry(argv)

    def put_part(self, url: str, data: bytes, headers: dict[str, str] | None = None) -> tuple[int, str]:
        """Upload one multipart part. The part bytes are piped to curl's stdin (`--data-binary @-`)
        so a byte RANGE of the source file uploads without ever staging the whole file to a temp
        copy — the caller reads exactly this part's slice with an offset/length read."""
        argv = [*self._COMMON, "-X", "PUT", "--data-binary", "@-"]
        for k, v in (headers or {}).items():
            argv += ["-H", f"{k}: {v}"]
        argv += self.auth.curl_args()
        argv.append(url)
        return self._run_retry(argv, input_bytes=data)

    def upload_batch(self, uploads: list["Upload"]) -> dict[str, int]:
        """Upload many files with parallel curl. Returns url -> http_code (0 = unknown).

        Callers should retry any url whose code is not a clear 200/201 via put().
        """
        self._ensure_curl_version()
        result: dict[str, int] = {}
        for start in range(0, len(uploads), BATCH_SIZE):
            chunk = uploads[start:start + BATCH_SIZE]
            result.update(self._upload_config(chunk))
        return result

    def _build_upload_config(self, chunk: list["Upload"]) -> str:
        # write-out MUST be per-block: a global -w only fires for the first transfer
        # under --parallel, so every request carries its own self-describing status line.
        # Quoted values are escaped (curl config treats \\ as an escape) so Windows temp
        # paths like C:\Users\... survive; bodies go to the platform null device (NUL on
        # Windows, /dev/null elsewhere).
        q = _curl_config_quote
        null_device = os.devnull
        blocks = []
        for up in chunk:
            block = [
                f'url = "{q(up.url)}"',
                f'upload-file = "{q(up.body_path)}"',
                f'output = "{q(null_device)}"',
                'write-out = "%{url_effective} %{http_code}\\n"',
                f"connect-timeout = {CONNECT_TIMEOUT}",
                f"max-time = {MAX_TIME}",
            ]
            for k, v in up.headers.items():
                block.append(f'header = "{q(k)}: {q(v)}"')
            block.extend(_auth_config_directives(self.auth.curl_args(), q))
            blocks.append("\n".join(block))
        return "\n--next\n".join(blocks) + "\n"

    def _upload_config(self, chunk: list["Upload"]) -> dict[str, int]:
        config_text = self._build_upload_config(chunk)

        with tempfile.NamedTemporaryFile("w", suffix=".curl", delete=False) as f:
            f.write(config_text)
            cfg_path = f.name
        # Each transfer is bounded by max-time; the whole batch runs in waves of
        # parallel_max, so bound the subprocess above the worst-case wall time.
        waves = -(-len(chunk) // max(self.parallel_max, 1))
        batch_timeout = waves * MAX_TIME + SUBPROCESS_MARGIN
        try:
            proc = subprocess.run(
                [self.curl, "-sS", "--parallel", "--parallel-max",
                 str(self.parallel_max), "--config", cfg_path],
                capture_output=True, text=True, timeout=batch_timeout,
            )
        except subprocess.TimeoutExpired:
            # Whole batch is unknown; caller retries each url sequentially via put().
            return {up.url: 0 for up in chunk}
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
