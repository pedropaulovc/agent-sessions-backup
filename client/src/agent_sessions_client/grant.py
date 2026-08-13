"""Mint and cache passkey-approved read grants (`agsr_…` bearer tokens).

Flow (mirrors hub/src/auth/read-grants.ts): generate a PKCE S256 challenge, open the
viewer's /grant page where the owner approves with a fresh passkey touch, receive a
single-use authorization code on a 127.0.0.1 loopback callback, then exchange
code+verifier at POST /api/v1/grants/exchange — deliberately unauthenticated; the
single-use code plus the verifier that never left this process is the credential —
for a short-lived read-only bearer.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

DEFAULT_VIEWER_URL = "https://sessions.vza.net"

_TTL_RE = re.compile(r"^(\d+)([smh]?)$")
_TTL_UNIT_SECONDS = {"": 1, "s": 1, "m": 60, "h": 3600}
# Mirrors TTL_MIN/MAX_SECONDS in hub/src/auth/read-grants.ts — reject locally so a typo
# fails before a browser round-trip, not as a 400 page after the passkey prompt.
TTL_MIN_SECONDS = 300
TTL_MAX_SECONDS = 86_400


class GrantError(RuntimeError):
    """The grant flow failed: denied, timed out, or the exchange was rejected."""


def parse_ttl(text: str) -> int:
    """'4h' / '30m' / '900' (bare seconds) -> seconds, bounds-checked against the hub's."""
    match = _TTL_RE.match(text)
    if not match:
        raise ValueError(f"invalid ttl {text!r}: expected e.g. 4h, 30m, or 900 (seconds)")
    seconds = int(match.group(1)) * _TTL_UNIT_SECONDS[match.group(2)]
    if not TTL_MIN_SECONDS <= seconds <= TTL_MAX_SECONDS:
        raise ValueError(f"ttl must be between {TTL_MIN_SECONDS}s (5m) and {TTL_MAX_SECONDS}s (24h)")
    return seconds


def default_label() -> str:
    return f"agent@{socket.gethostname()}"


def default_grant_cache_path() -> Path:
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "agent-sessions" / "grant.json"


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def mint_grant(
    *,
    hub_url: str,
    viewer_url: str = DEFAULT_VIEWER_URL,
    label: str | None = None,
    ttl_seconds: int = 14_400,
    open_url=webbrowser.open,
    timeout: float = 300.0,
) -> dict:
    """Run the full grant ceremony; returns the exchange response
    ({token, tokenType, label, expiresAt}) or raises GrantError."""
    label = label or default_label()
    verifier = _b64u(secrets.token_bytes(32))
    challenge = _b64u(hashlib.sha256(verifier.encode("ascii")).digest())
    result: dict[str, str | None] = {}
    done = threading.Event()

    class _CallbackHandler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:  # silence
            pass

        def do_GET(self) -> None:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            result["code"] = (query.get("code") or [None])[0]
            result["error"] = (query.get("error") or [None])[0]
            body = (
                b"Grant received. You can close this tab."
                if result["code"]
                else b"Grant denied or failed. You can close this tab."
            )
            self.send_response(200)
            self.send_header("content-type", "text/plain; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            done.set()

    server = HTTPServer(("127.0.0.1", 0), _CallbackHandler)
    try:
        callback = f"http://127.0.0.1:{server.server_port}/cb"
        grant_url = f"{viewer_url.rstrip('/')}/grant?" + urllib.parse.urlencode(
            {"challenge": challenge, "callback": callback, "label": label, "ttl": str(ttl_seconds)}
        )
        open_url(grant_url)
        # Single-threaded accept loop: handle_request() returns after each request or after
        # server.timeout, so the deadline is re-checked about once a second either way.
        server.timeout = 1.0
        deadline = time.monotonic() + timeout
        while not done.is_set() and time.monotonic() < deadline:
            server.handle_request()
    finally:
        server.server_close()

    if result.get("error"):
        raise GrantError(f"grant denied: {result['error']}")
    code = result.get("code")
    if not code:
        raise GrantError(f"timed out after {timeout:.0f}s waiting for browser approval")

    exchange_url = f"{hub_url.rstrip('/')}/api/v1/grants/exchange"
    request = urllib.request.Request(
        exchange_url,
        data=json.dumps({"code": code, "codeVerifier": verifier}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30.0) as fp:
            return json.loads(fp.read())
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", errors="replace")
        except OSError:
            detail = "<body unavailable>"
        raise GrantError(f"exchange failed (status={e.code}): {detail}") from e
    except (OSError, ValueError) as e:
        raise GrantError(f"exchange failed: {e}") from e


def save_grant(grant: dict, cache_path: Path | None = None) -> Path:
    """Persist a minted grant for load_cached_token(); owner-only file mode where supported.

    The token is written to a same-directory temp file created 0o600 (O_EXCL, so an existing
    symlink at the temp path can't be followed) and atomically renamed into place — a plain
    write_text + chmod-after would expose the bearer at umask permissions for a window, and
    would follow a pre-planted symlink at the cache path itself.
    """
    path = cache_path or default_grant_cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({
        "token": grant["token"],
        "expiresAt": grant["expiresAt"],
        "label": grant.get("label"),
    })
    temporary_path = path.with_name(f".{path.name}.{secrets.token_hex(16)}.tmp")
    try:
        fd = os.open(temporary_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            fp.write(payload)
        os.replace(temporary_path, path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise
    return path


def load_cached_token(cache_path: Path | None = None) -> str | None:
    """The cached bearer, or None if absent/corrupt/expiring within 60s (expiresAt is ms)."""
    path = cache_path or default_grant_cache_path()
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    token = data.get("token")
    expires_at = data.get("expiresAt")
    if not isinstance(token, str) or not isinstance(expires_at, (int, float)):
        return None
    if expires_at <= (time.time() + 60) * 1000:
        return None
    return token
