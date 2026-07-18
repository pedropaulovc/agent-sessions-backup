"""Low-level auth-aware HTTP wrapper for the machine API. Stdlib-only (urllib + ssl) —
matches the collector's zero-runtime-dependency policy; mTLS via file-based cert+key works
fine with Python's ssl module directly (the collector shells out to curl only because TPM-
backed keys aren't file-based; this client never touches a TPM key).
"""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass
from http.client import HTTPResponse
from typing import Any

from .config import AuthMode, ClientConfig

USER_AGENT = "agent-sessions-client/0.1"


class HubError(RuntimeError):
    """A non-2xx response from the hub, or a transport-level failure."""

    def __init__(self, status: int | None, message: str, body: str = ""):
        super().__init__(f"hub request failed (status={status}): {message}")
        self.status = status
        self.body = body


@dataclass
class HubResponse:
    status: int
    headers: dict[str, str]  # lower-cased names
    _fp: HTTPResponse

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())

    def json(self) -> Any:
        try:
            return json.loads(self._fp.read())
        finally:
            self._fp.close()

    def iter_lines(self) -> Iterator[str]:
        """Yield decoded, non-empty lines from a streaming (e.g. NDJSON) body. Closes the
        underlying connection once the generator is exhausted or garbage-collected."""
        try:
            for raw_line in self._fp:
                line = raw_line.decode("utf-8").rstrip("\n")
                if line:
                    yield line
        finally:
            self._fp.close()

    def close(self) -> None:
        self._fp.close()


class HubClient:
    """Auth-aware HTTP wrapper for https://api.sessions.vza.net (or a preview URL).

    Machine API only — every read endpoint under /api/v1 requires an identity of
    kind='machine' (see hub/src/router.ts::apiRoute), which this client's two auth modes
    both resolve to (mTLS cert -> machines row; bearer+x-dev-machine -> dev identity).
    """

    def __init__(self, config: ClientConfig, *, timeout: float = 30.0):
        self._config = config
        self._timeout = timeout
        self._ssl_context = self._build_ssl_context()

    def _build_ssl_context(self) -> ssl.SSLContext | None:
        if self._config.auth_mode is not AuthMode.MTLS:
            return None
        ctx = ssl.create_default_context()
        try:
            ctx.load_cert_chain(certfile=str(self._config.client_cert_path), keyfile=str(self._config.client_key_path))
        except OSError as e:
            # Covers both a missing file (FileNotFoundError) and a malformed one
            # (ssl.SSLError, itself an OSError subclass) — e.g. a stale collector config
            # pointing at a rotated/moved cert. Re-raised as ValueError so it's caught by the
            # same config-error handling load_config()'s own ValueErrors already go through
            # (see cli.py), instead of escaping HubClient's constructor as a raw traceback.
            raise ValueError(
                f"failed to load mTLS client cert/key ({self._config.client_cert_path}, "
                f"{self._config.client_key_path}): {e}"
            ) from e
        return ctx

    def _headers(self) -> dict[str, str]:
        headers = {"user-agent": USER_AGENT, "accept": "application/json, application/x-ndjson"}
        if self._config.auth_mode is AuthMode.BEARER:
            headers["authorization"] = f"Bearer {self._config.bearer_token}"
            if self._config.dev_machine:
                headers["x-dev-machine"] = self._config.dev_machine
        return headers

    def get(self, path: str, params: dict[str, str | int | None] | None = None) -> HubResponse:
        """Issue a GET. Caller owns the returned HubResponse's lifetime — call .json() (which
        closes it) or drain .iter_lines() (also closes on exhaustion); don't leak connections
        by ignoring the return value of a streaming call."""
        url = self._build_url(path, params)
        request = urllib.request.Request(url, headers=self._headers(), method="GET")
        try:
            fp = urllib.request.urlopen(request, timeout=self._timeout, context=self._ssl_context)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            raise HubError(e.code, e.reason, body) from e
        except TimeoutError as e:
            # A connect-phase timeout comes back wrapped in URLError, but a READ-phase stall
            # (hub accepts the connection, then hangs) raises the builtin TimeoutError
            # directly — urlopen doesn't wrap it. Without this, that escapes past every
            # HubError-only except clause (including the CLI's), producing a traceback instead
            # of the documented `error: ...` + nonzero exit.
            raise HubError(None, f"timed out after {self._timeout}s") from e
        except urllib.error.URLError as e:
            raise HubError(None, str(e.reason)) from e
        headers = {k.lower(): v for k, v in fp.headers.items()}
        return HubResponse(status=fp.status, headers=headers, _fp=fp)

    def _build_url(self, path: str, params: dict[str, str | int | None] | None) -> str:
        query = {k: str(v) for k, v in (params or {}).items() if v is not None}
        qs = f"?{urllib.parse.urlencode(query)}" if query else ""
        return f"{self._config.hub_url.rstrip('/')}{path}{qs}"
