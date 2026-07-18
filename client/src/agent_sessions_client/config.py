"""Connection config: resolves how to reach the hub and authenticate.

Two auth modes (see hub/src/auth/identity.ts::machineIdentity, which this mirrors):
- mTLS (production): client cert+key, read from ~/.config/agent-collector/config.toml
  (the same file the collector writes) unless overridden.
- bearer (preview envs only): `Authorization: Bearer <DEV_AUTH>` + `x-dev-machine: <id>`.
  Production's mTLS-fronting Worker never accepts this; it only works against a Workers
  Builds PR preview URL, which gates on DEV_AUTH precisely because it's publicly reachable
  without a real client cert. There is no config.toml field for it — it's env/arg-only.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

DEFAULT_HUB_URL = "https://api.sessions.vza.net"


class AuthMode(str, Enum):
    MTLS = "mtls"
    BEARER = "bearer"


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
    bearer_token: str | None = None
    dev_machine: str | None = None

    def __post_init__(self) -> None:
        if self.auth_mode is AuthMode.MTLS and (self.client_cert_path is None or self.client_key_path is None):
            raise ValueError("mtls auth requires client_cert_path and client_key_path")
        if self.auth_mode is AuthMode.BEARER and (self.bearer_token is None or self.dev_machine is None):
            raise ValueError("bearer auth requires bearer_token and dev_machine")


def load_config(
    *,
    hub_url: str | None = None,
    config_path: Path | None = None,
    client_cert_path: str | Path | None = None,
    client_key_path: str | Path | None = None,
    bearer_token: str | None = None,
    dev_machine: str | None = None,
) -> ClientConfig:
    """Resolve hub connection settings.

    Precedence (highest first): explicit keyword args > environment variables >
    ~/.config/agent-collector/config.toml (or $XDG_CONFIG_HOME override). Bearer mode
    wins over mTLS whenever a bearer token is supplied (by arg or env) — it's meant for
    one-off preview-env runs, never silently mixed with a machine's production cert.
    """
    env = os.environ
    resolved_bearer = bearer_token or env.get("AGENT_SESSIONS_BEARER_TOKEN")
    resolved_dev_machine = dev_machine or env.get("AGENT_SESSIONS_DEV_MACHINE")
    if resolved_bearer:
        return ClientConfig(
            hub_url=hub_url or env.get("AGENT_SESSIONS_HUB_URL") or DEFAULT_HUB_URL,
            auth_mode=AuthMode.BEARER,
            bearer_token=resolved_bearer,
            dev_machine=resolved_dev_machine,
        )

    path = config_path or default_config_path()
    file_data: dict = {}
    if path.is_file():
        file_data = tomllib.loads(path.read_text())

    resolved_hub_url = hub_url or env.get("AGENT_SESSIONS_HUB_URL") or file_data.get("hub_url") or DEFAULT_HUB_URL
    resolved_cert = client_cert_path or env.get("AGENT_SESSIONS_CLIENT_CERT") or file_data.get("client_cert_path")
    resolved_key = client_key_path or env.get("AGENT_SESSIONS_CLIENT_KEY") or file_data.get("client_key_path")
    if not resolved_cert or not resolved_key:
        raise ValueError(
            f"no mTLS client cert/key found (checked args, env vars, and {path}); "
            "pass bearer_token/dev_machine (or --bearer-token/--dev-machine on the CLI) "
            "for a preview-env DEV_AUTH client instead"
        )
    return ClientConfig(
        hub_url=resolved_hub_url,
        auth_mode=AuthMode.MTLS,
        client_cert_path=Path(resolved_cert).expanduser(),
        client_key_path=Path(resolved_key).expanduser(),
    )
