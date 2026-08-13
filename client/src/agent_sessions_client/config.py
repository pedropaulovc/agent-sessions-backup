"""Connection config: resolves how to reach the hub and authenticate.

Two auth modes (see hub/src/router.ts::apiRoute, which this mirrors):
- grant (preferred): `Authorization: Bearer agsr_…` — a short-lived read-only token the
  owner minted with a passkey touch via `agent-sessions auth` (see grant.py). Resolved
  from an explicit arg, $AGENT_SESSIONS_GRANT_TOKEN, or the token cache grant.py writes.
- mTLS (transitional): client cert+key, read from ~/.config/agent-collector/config.toml
  (the same file the collector writes) unless overridden. Machine certs are moving to
  ingest-only; cert-authenticated reads disappear once that migration completes, at which
  point this mode dies with them.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from urllib.parse import urlparse

from .grant import load_cached_token

DEFAULT_HUB_URL = "https://api.sessions.vza.net"


class AuthMode(str, Enum):
    MTLS = "mtls"
    GRANT = "grant"


def default_config_path() -> Path:
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "agent-collector" / "config.toml"


@dataclass(frozen=True)
class ClientConfig:
    hub_url: str
    auth_mode: AuthMode
    client_cert_path: Path | None = None
    client_key_path: Path | None = None
    grant_token: str | None = None

    def __post_init__(self) -> None:
        # AuthMode subclasses str, so a caller passing the plain string "mtls"/"grant" (this
        # class is exported — that's a reasonable thing to do) would otherwise sail past every
        # `is AuthMode.X` identity check below AND in HubClient, silently sending an
        # unauthenticated request instead of failing fast. Coerce unconditionally — AuthMode(x)
        # is a no-op for an already-valid member and raises ValueError for anything else, which
        # is exactly the "fail fast" behavior we want for garbage input.
        object.__setattr__(self, "auth_mode", AuthMode(self.auth_mode))
        # A malformed --hub-url (e.g. missing scheme) otherwise sails past construction here
        # and only blows up later as a raw ValueError out of urllib.request.Request() inside
        # HubClient.get() — by then it's past the CLI's HubError-only handler for API calls
        # and produces a traceback instead of the documented `error: ...` + exit 2. Fail fast
        # here instead, where the CLI's config-error ValueError handler already catches it.
        parsed = urlparse(self.hub_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError(f"invalid hub_url {self.hub_url!r}: expected an http(s) URL, e.g. https://api.sessions.vza.net")
        if self.auth_mode is AuthMode.MTLS and (self.client_cert_path is None or self.client_key_path is None):
            raise ValueError("mtls auth requires client_cert_path and client_key_path")
        if self.auth_mode is AuthMode.GRANT and self.grant_token is None:
            raise ValueError("grant auth requires grant_token")


def load_config(
    *,
    hub_url: str | None = None,
    config_path: Path | None = None,
    client_cert_path: str | Path | None = None,
    client_key_path: str | Path | None = None,
    grant_token: str | None = None,
    grant_cache_path: Path | None = None,
) -> ClientConfig:
    """Resolve hub connection settings.

    Precedence (highest first): explicit keyword args > environment variables > the token
    cache `agent-sessions auth` wrote > ~/.config/agent-collector/config.toml (or
    $XDG_CONFIG_HOME override). A usable grant token wins over mTLS whenever both exist —
    the grant is the intended read credential; the cert read path is transitional.
    """
    env = os.environ
    # Read the config file BEFORE branching on auth mode, so a non-default hub_url configured
    # there applies to grant mode too — both modes resolve hub_url with the same
    # arg > env > file > default precedence.
    path = config_path or default_config_path()
    file_data: dict = {}
    if path.is_file():
        file_data = tomllib.loads(path.read_text())
    resolved_hub_url = hub_url or env.get("AGENT_SESSIONS_HUB_URL") or file_data.get("hub_url") or DEFAULT_HUB_URL

    resolved_grant = grant_token or env.get("AGENT_SESSIONS_GRANT_TOKEN") or load_cached_token(grant_cache_path)
    if resolved_grant:
        return ClientConfig(
            hub_url=resolved_hub_url,
            auth_mode=AuthMode.GRANT,
            grant_token=resolved_grant,
        )

    resolved_cert = client_cert_path or env.get("AGENT_SESSIONS_CLIENT_CERT") or file_data.get("client_cert_path")
    resolved_key = client_key_path or env.get("AGENT_SESSIONS_CLIENT_KEY") or file_data.get("client_key_path")
    if not resolved_cert or not resolved_key:
        raise ValueError(
            f"no read grant or mTLS client cert/key found (checked args, env vars, the grant "
            f"cache, and {path}); run `agent-sessions auth` to mint a passkey-approved read "
            "grant, or pass --grant-token"
        )
    return ClientConfig(
        hub_url=resolved_hub_url,
        auth_mode=AuthMode.MTLS,
        client_cert_path=Path(resolved_cert).expanduser(),
        client_key_path=Path(resolved_key).expanduser(),
    )
