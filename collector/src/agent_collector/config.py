"""Config: TOML at $XDG_CONFIG_HOME/agent-collector/config.toml (default ~/.config/...).

The file is the source of truth for machine_id, hub_url, auth mode, store roots and
user-added exclude globs. Security-critical default excludes (creds/caches/db-sidecars)
are ALWAYS applied on top of the config's list — see DEFAULT_EXCLUDES.
"""

from __future__ import annotations

import os
import socket
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

# Capture-ALL policy: whole tree per store, minus these. fnmatch-ish on the forward-slash
# relpath (see scanner.path_matches). Security-critical entries (creds, keys) come first.
DEFAULT_EXCLUDES: list[str] = [
    ".credentials.json",
    "auth.json",
    "**/oauth*",
    "*.key",
    "*.pem",
    "cache/**",
    "Cache/**",
    "tmp/**",
    "**/.DS_Store",
    ".last-cleanup",
    "statsig/**",
    "telemetry/**",
    # SQLite sidecars append to the FULL filename (state.db-wal, cache.vscdb-shm,
    # foo-journal), not just *.sqlite-*; match generically. False positives are
    # implausible in ~/.claude and ~/.codex, and the DB itself is still captured
    # (snapshotted). The snapshot reads committed WAL content, so change detection
    # sees sidecar writes even though the sidecars are never uploaded.
    "*-wal",
    "*-shm",
    "*-journal",
    "*.lock",
    "ide/**",
    "shell-snapshots/**",
    "projects/**/backups/**",
]

DEFAULT_STORES: dict[str, str] = {
    "claude": "~/.claude",
    "codex": "~/.codex",
}

VALID_AUTH = ("dev", "mtls")


def _read_proc_version() -> str:
    """Seam for WSL detection; monkeypatched in tests."""
    try:
        return Path("/proc/version").read_text()
    except OSError:
        return ""


def detect_platform_tag() -> str:
    """One of linux|windows|wsl|darwin. WSL wins over linux via /proc/version."""
    if sys.platform == "darwin":
        return "darwin"
    if sys.platform.startswith("win"):
        return "windows"
    if sys.platform.startswith("linux"):
        if "microsoft" in _read_proc_version().lower():
            return "wsl"
        return "linux"
    return sys.platform


def default_machine_id() -> str:
    return f"{socket.gethostname()}-{detect_platform_tag()}"


def _is_windows_mount(path: Path) -> bool:
    """True for /mnt/<single-drive-letter>/... — the WSL view of a Windows drive."""
    parts = path.parts
    return (
        len(parts) >= 3
        and parts[1] == "mnt"
        and len(parts[2]) == 1
        and parts[2].isalpha()
    )


def _root_is_windows_mount(path: Path) -> bool:
    """Guard decision: catch both a literal /mnt/<drive> root AND a symlink that resolves
    under one (os.walk follows a symlinked top root, so ~/.claude -> /mnt/c/... would still
    be captured). Resolve only for the decision; the caller scans the unresolved path so
    relpaths stay stable."""
    if _is_windows_mount(path):
        return True
    try:
        return _is_windows_mount(path.resolve())
    except OSError:
        return False


def config_dir() -> Path:
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "agent-collector"


def config_path() -> Path:
    return config_dir() / "config.toml"


@dataclass
class Config:
    machine_id: str
    hub_url: str
    auth: str = "dev"
    include_windows_mounts: bool = False
    stores: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_STORES))
    exclude: list[str] = field(default_factory=list)
    source: Path | None = None

    def __post_init__(self) -> None:
        # machine_id and each store name are single URL path segments in the files API; a '/'
        # would shift the segments the hub parses. Reject it here (clear error) in addition to
        # encoding in file_url (defense in both places).
        if "/" in self.machine_id:
            raise ValueError(f"machine_id must not contain '/': {self.machine_id!r}")
        for name in self.stores:
            if "/" in name:
                raise ValueError(f"store name must not contain '/': {name!r}")

    def store_roots(self) -> dict[str, Path]:
        """Resolved roots to actually scan. Under WSL with include_windows_mounts=false,
        roots resolving under /mnt/<drive>/ are dropped so a WSL install never captures the
        Windows side as the WSL machine (see dropped_store_roots for what was skipped)."""
        roots = {name: Path(root).expanduser() for name, root in self.stores.items()}
        if not self._drop_windows_mounts():
            return roots
        return {n: p for n, p in roots.items() if not _root_is_windows_mount(p)}

    def dropped_store_roots(self) -> dict[str, Path]:
        """Roots excluded by the WSL windows-mount guard, so callers can surface a warning."""
        if not self._drop_windows_mounts():
            return {}
        return {
            n: p
            for n, r in self.stores.items()
            if _root_is_windows_mount(p := Path(r).expanduser())
        }

    def _drop_windows_mounts(self) -> bool:
        return not self.include_windows_mounts and detect_platform_tag() == "wsl"

    def effective_excludes(self) -> list[str]:
        return DEFAULT_EXCLUDES + list(self.exclude)


def _toml_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _dump_toml(cfg: Config) -> str:
    lines = [
        f'machine_id = "{_toml_escape(cfg.machine_id)}"',
        f'hub_url = "{_toml_escape(cfg.hub_url)}"',
        f'auth = "{_toml_escape(cfg.auth)}"',
        f"include_windows_mounts = {str(cfg.include_windows_mounts).lower()}",
    ]
    if cfg.exclude:
        items = ", ".join(f'"{_toml_escape(p)}"' for p in cfg.exclude)
        lines.append(f"exclude = [{items}]")
    else:
        lines.append("# exclude = []  # extra globs, applied on top of built-in security excludes")
    lines.append("")
    lines.append("[stores]")
    for name, root in cfg.stores.items():
        lines.append(f'{name} = "{_toml_escape(root)}"')
    return "\n".join(lines) + "\n"


def load(path: Path | str | None = None) -> Config:
    path = Path(path) if path else config_path()
    if not path.exists():
        raise FileNotFoundError(
            f"No config at {path}. Run: agent-collector enroll --hub <URL> --dev"
        )
    data = tomllib.loads(path.read_text())
    return Config(
        machine_id=data["machine_id"],
        hub_url=data["hub_url"].rstrip("/"),
        auth=data.get("auth", "dev"),
        include_windows_mounts=bool(data.get("include_windows_mounts", False)),
        stores=dict(data.get("stores") or DEFAULT_STORES),
        exclude=list(data.get("exclude") or []),
        source=path,
    )


def enroll(hub_url: str, dev: bool, path: Path | str | None = None, machine_id: str | None = None) -> Config:
    """Write a dev-mode config. mTLS enrollment lands in a later milestone."""
    if not dev:
        raise NotImplementedError(
            "Only --dev enrollment is supported now; mTLS enrollment (TPM keygen -> CSR -> "
            "Cloudflare managed CA) lands in a later milestone."
        )
    path = Path(path) if path else config_path()
    cfg = Config(
        machine_id=machine_id or default_machine_id(),
        hub_url=hub_url.rstrip("/"),
        auth="dev",
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_dump_toml(cfg))
    cfg.source = path
    return cfg
