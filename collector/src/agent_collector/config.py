"""Config: TOML at $XDG_CONFIG_HOME/agent-collector/config.toml (default ~/.config/...).

The file is the source of truth for machine_id, hub_url, auth mode, store roots and
user-added exclude globs. Security-critical default excludes (creds/caches/db-sidecars)
are ALWAYS applied on top of the config's list — see DEFAULT_EXCLUDES.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .transport import normalize_thumbprint

# Capture-ALL policy: whole tree per store, minus these. fnmatch-ish on the forward-slash
# relpath (see scanner.path_matches). Security-critical entries (creds, keys) come first.
DEFAULT_EXCLUDES: list[str] = [
    # Credential stores are frequently rewritten through backup/temp siblings. Match the
    # whole filename family, not only the live filename, and prune Claude's profile store.
    "*.credentials.json*",
    "*auth.json*",
    "**/cred-profiles/**",
    "**/oauth*",
    "*.key",
    "*.pem",
    # Cache/temp directories occur below plugin trees as well as at the store root. The
    # matcher is case-insensitive and treats the leading **/ as optional.
    "**/cache/**",
    "**/tmp/**",
    "**/.tmp/**",
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

# Staging stores the webcapture host writes into (CDP JSON) or an operator drops export ZIPs
# into. They are ordinary `stores` entries on that host so the normal run/backfill scan uploads
# them with zero special-casing; other machines never have them, so nothing else changes.
WEBCAPTURE_STORES = ("chatgpt-web", "claude-web", "export-inbox")

# The export-inbox staging store is registered on EVERY enroll (see _ensure_export_inbox), not just
# webcapture hosts: an operator can drop an official export ZIP into it and have `run`/`backfill`
# upload it without ever running CDP capture. The web-capture stores stay webcapture-only.
EXPORT_INBOX_STORE = "export-inbox"

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


def data_dir() -> Path:
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "agent-collector"


def webcapture_dir() -> Path:
    """Local root under which webcapture stages raw conversation JSON (one subdir per store)."""
    return data_dir() / "webcapture"


def config_path() -> Path:
    return config_dir() / "config.toml"


# Files at/above this size use the R2 multipart upload path instead of a single PUT. Default 90MB
# sits safely below Cloudflare's 100MB request-body cap (a single PUT of a >=100MB body is rejected
# at the edge with HTTP 413 before it ever reaches the Worker — the cap is the ZONE plan's, which
# Workers Paid does not raise). Part size is the fixed chunk each part carries; R2 requires every
# part except the last to be >=5MiB and the SAME size, so a fixed part size satisfies both rules by
# construction. 64MiB stays under the edge cap (with header overhead) and the hub isolate's 128MB
# limit while keeping the part count low.
DEFAULT_MULTIPART_THRESHOLD_MB = 90.0
DEFAULT_MULTIPART_PART_SIZE_MB = 64.0
MIN_PART_SIZE_BYTES = 5 * 1024 * 1024  # R2 hard floor for non-final parts

# The multipart threshold is ALSO the part-size ceiling (a large file grows its part size up to the
# threshold to stay under 10000 parts). A threshold below the 5MiB part floor can't produce a legal
# part, so it's a hard config error. And the threshold must stay below Cloudflare's ~100MB edge
# body cap: any file AT/ABOVE the threshold goes multipart, so a threshold above the cap would route
# cap..threshold files to a simple PUT that 413s at the edge. Clamp to this safe ceiling — below
# 100MB with headroom for request headers — and above the 90MB default so a stock config is untouched.
MAX_MULTIPART_THRESHOLD_BYTES = 95_000_000


@dataclass
class Config:
    machine_id: str
    hub_url: str
    auth: str = "dev"
    include_windows_mounts: bool = False
    stores: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_STORES))
    exclude: list[str] = field(default_factory=list)
    # File-based mTLS material (auth="mtls", POSIX/OpenSSL curl): PEM cert + private key that
    # curl presents via --cert/--key. Written by infra/cf/enroll-cert.sh. Absent for dev auth.
    client_cert_path: str | None = None
    client_key_path: str | None = None
    # Windows/Schannel mTLS: SHA-1 thumbprint of the client cert imported into Cert:\CurrentUser\My.
    # Set INSTEAD of the PEM paths above — schannel can't present a file-based cert (see
    # transport.MtlsAuth). key_protection stays orthogonal: a software-PFX-imported key now, a
    # TPM/PCP-backed key (same field) in S2.
    client_cert_thumbprint: str | None = None
    # Multipart tuning (MB, float so tests can use sub-MB values). Files >= threshold upload via
    # the chunked multipart path; each part carries part_size bytes (last part the remainder).
    multipart_threshold_mb: float = DEFAULT_MULTIPART_THRESHOLD_MB
    multipart_part_size_mb: float = DEFAULT_MULTIPART_PART_SIZE_MB
    source: Path | None = None
    # Base dir the webcapture staging stores (WEBCAPTURE_STORES) resolve under in
    # store_roots() when a store isn't already in `stores`. None (default, and what every
    # real config uses) resolves live from webcapture_dir() — i.e. $XDG_DATA_HOME or
    # ~/.local/share — at store_roots() call time. Set explicitly to point that resolution
    # somewhere else without touching environment variables (tests use this so a Config
    # built with only e.g. stores={"claude": ...} can never fall through to this box's real
    # webcapture staging dir, which may hold real export ZIPs).
    # Placed LAST (not earlier, e.g. next to the other optional fields above) so a positional
    # Config(...) construction elsewhere in the codebase can never silently shift `source`
    # (or any other field) into this slot — every existing call site uses keyword args, and
    # this ordering keeps a future positional mistake impossible rather than merely unlikely.
    staging_base: str | None = None

    @property
    def multipart_threshold_bytes(self) -> int:
        return int(self.multipart_threshold_mb * 1024 * 1024)

    @property
    def multipart_part_size_bytes(self) -> int:
        return int(self.multipart_part_size_mb * 1024 * 1024)

    def __post_init__(self) -> None:
        # machine_id and each store name are single URL path segments in the files API; a '/'
        # would shift the segments the hub parses. Reject it here (clear error) in addition to
        # encoding in file_url (defense in both places).
        if "/" in self.machine_id:
            raise ValueError(f"machine_id must not contain '/': {self.machine_id!r}")
        for name in self.stores:
            if "/" in name:
                raise ValueError(f"store name must not contain '/': {name!r}")
        # mTLS material is exactly one mechanism, never both/neither. The mechanism is DERIVED from
        # which fields are set (no separate mode flag): a thumbprint => Windows/Schannel store ref;
        # cert+key paths => POSIX/PEM. Both set is ambiguous; neither leaves auth="mtls" unusable.
        if self.auth == "mtls":
            has_thumb = bool(self.client_cert_thumbprint)
            has_pem = bool(self.client_cert_path and self.client_key_path)
            if has_thumb and (self.client_cert_path or self.client_key_path):
                raise ValueError(
                    "ambiguous mTLS config: set EITHER client_cert_thumbprint (Windows/Schannel) OR "
                    "client_cert_path+client_key_path (POSIX/PEM), not both"
                )
            if not has_thumb and not has_pem:
                raise ValueError(
                    "mTLS config needs client material: client_cert_thumbprint (Windows) or BOTH "
                    "client_cert_path and client_key_path (POSIX). Run infra/cf/enroll-cert.sh."
                )

    def store_roots(self) -> dict[str, Path]:
        """Resolved roots to actually scan. Under WSL with include_windows_mounts=false,
        roots resolving under /mnt/<drive>/ are dropped so a WSL install never captures the
        Windows side as the WSL machine (see dropped_store_roots for what was skipped)."""
        stores = dict(self.stores)
        # Always expose the webcapture staging stores (setdefault: a custom configured root wins).
        # This is the load-layer fix for the "registered only at enroll/webcapture" hole: an
        # already-enrolled collector that upgrades and drops an export ZIP, or a webcapture host, is
        # scanned without a re-enroll. Missing dirs are simply skipped by run/scanner (root.exists()).
        base = Path(self.staging_base).expanduser() if self.staging_base else webcapture_dir()
        for name in WEBCAPTURE_STORES:
            stores.setdefault(name, str(base / name))
        roots = {name: Path(root).expanduser() for name, root in stores.items()}
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
    if cfg.client_cert_path:
        lines.append(f'client_cert_path = "{_toml_escape(cfg.client_cert_path)}"')
    if cfg.client_key_path:
        lines.append(f'client_key_path = "{_toml_escape(cfg.client_key_path)}"')
    if cfg.client_cert_thumbprint:
        lines.append(f'client_cert_thumbprint = "{_toml_escape(cfg.client_cert_thumbprint)}"')
    if cfg.exclude:
        items = ", ".join(f'"{_toml_escape(p)}"' for p in cfg.exclude)
        lines.append(f"exclude = [{items}]")
    else:
        lines.append("# exclude = []  # extra globs, applied on top of built-in security excludes")
    # Only emit multipart tuning when it differs from the default, so a stock config stays clean but
    # a customized threshold/part-size round-trips through save().
    if cfg.multipart_threshold_mb != DEFAULT_MULTIPART_THRESHOLD_MB:
        lines.append(f"multipart_threshold_mb = {cfg.multipart_threshold_mb}")
    else:
        lines.append(f"# multipart_threshold_mb = {DEFAULT_MULTIPART_THRESHOLD_MB}  # files >= this use the multipart upload path")
    if cfg.multipart_part_size_mb != DEFAULT_MULTIPART_PART_SIZE_MB:
        lines.append(f"multipart_part_size_mb = {cfg.multipart_part_size_mb}")
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
    threshold_mb, part_size_mb = _normalize_multipart(
        float(data.get("multipart_threshold_mb", DEFAULT_MULTIPART_THRESHOLD_MB)),
        float(data.get("multipart_part_size_mb", DEFAULT_MULTIPART_PART_SIZE_MB)),
    )
    return Config(
        machine_id=data["machine_id"],
        hub_url=data["hub_url"].rstrip("/"),
        auth=data.get("auth", "dev"),
        include_windows_mounts=bool(data.get("include_windows_mounts", False)),
        stores=dict(data.get("stores") or DEFAULT_STORES),
        exclude=list(data.get("exclude") or []),
        client_cert_path=data.get("client_cert_path"),
        client_key_path=data.get("client_key_path"),
        client_cert_thumbprint=data.get("client_cert_thumbprint"),
        multipart_threshold_mb=threshold_mb,
        multipart_part_size_mb=part_size_mb,
        source=path,
    )


def _normalize_multipart(threshold_mb: float, part_size_mb: float) -> tuple[float, float]:
    """Validate + normalize the multipart tuning at config-load time (not in Config.__post_init__:
    tests build Config directly with sub-MB values, and this normalization is a property of a
    USER-authored config, not of every in-memory Config). Returns the effective (threshold, part_size)
    in MB, or raises ValueError on an unusable threshold. Three cases:
      - threshold below R2's 5MiB part floor -> REJECT (the threshold is also the part-size ceiling, so
        no legal part could ever be sent; a clear error beats every large upload failing on the wire);
      - threshold above the safe sub-100MB ceiling -> CLAMP down + warn (else cap..threshold files ride
        the simple PUT and Cloudflare 413s them at the edge before the Worker sees them);
      - part size below the 5MiB floor -> CLAMP up + warn (else the hub rejects every non-final part
        with bad_or_small_part_size)."""
    floor_mb = MIN_PART_SIZE_BYTES / (1024 * 1024)
    cap_mb = MAX_MULTIPART_THRESHOLD_BYTES / (1024 * 1024)
    if int(threshold_mb * 1024 * 1024) < MIN_PART_SIZE_BYTES:
        raise ValueError(
            f"multipart_threshold_mb={threshold_mb} is below R2's {floor_mb:.0f} MB (5 MiB) minimum "
            f"part size, so no legal multipart part could be sent; set it to at least {floor_mb:.0f} MB "
            f"(default {DEFAULT_MULTIPART_THRESHOLD_MB})"
        )
    if int(threshold_mb * 1024 * 1024) > MAX_MULTIPART_THRESHOLD_BYTES:
        print(
            f"warning: multipart_threshold_mb={threshold_mb} exceeds the safe {cap_mb:.1f} MB ceiling "
            f"below Cloudflare's ~100MB edge cap; clamping to {cap_mb:.1f} MB so large files still "
            "route to multipart instead of failing a simple PUT with 413",
            file=sys.stderr,
        )
        threshold_mb = cap_mb
    if int(part_size_mb * 1024 * 1024) < MIN_PART_SIZE_BYTES:
        print(
            f"warning: multipart_part_size_mb={part_size_mb} is below R2's {floor_mb:.0f} MB (5 MiB) "
            f"minimum part size; clamping to {floor_mb:.0f} MB",
            file=sys.stderr,
        )
        part_size_mb = floor_mb
    return threshold_mb, part_size_mb


def _load_if_exists(path: Path) -> Config | None:
    """The current config at `path`, or None if absent/unreadable. Lets enroll re-use an
    existing box's settings instead of resetting them."""
    if not path.exists():
        return None
    try:
        return load(path)
    except (OSError, KeyError, ValueError, tomllib.TOMLDecodeError):
        return None  # unreadable/legacy config -> treat as a fresh enroll


def _pfx_import_ps(has_password: bool) -> str:
    """The PowerShell one-liner that imports $env:AC_PFX_PATH into Cert:\\CurrentUser\\My and prints
    the thumbprint. With a password we build a SecureString from $env:AC_PFX_PW; without one we OMIT
    -Password entirely — `ConvertTo-SecureString -String "" -AsPlainText -Force` throws, so passing an
    empty SecureString would break the advertised password-less PFX path (Import-PfxCertificate docs
    Example 2 calls it with no -Password). Factored out so both branches are unit-testable off-Windows."""
    head = "$ErrorActionPreference='Stop'; "
    tail = "$c.Thumbprint"
    if has_password:
        return (
            head
            + "$sec = ConvertTo-SecureString -String $env:AC_PFX_PW -AsPlainText -Force; "
            "$c = Import-PfxCertificate -FilePath $env:AC_PFX_PATH "
            "-CertStoreLocation Cert:\\CurrentUser\\My -Password $sec; " + tail
        )
    return (
        head
        + "$c = Import-PfxCertificate -FilePath $env:AC_PFX_PATH "
        "-CertStoreLocation Cert:\\CurrentUser\\My; " + tail
    )


def _import_pfx_to_store(pfx_path: str, password: str | None) -> str:
    """Windows only: import a PFX into Cert:\\CurrentUser\\My and return its SHA-1 thumbprint. The
    private key is imported NON-exportable (Import-PfxCertificate's default) — the software-key
    hardening schannel gives us for free. The password rides in via the environment, never on the
    command line, so it can't surface in a process listing or shell history."""
    if not sys.platform.startswith("win"):
        raise RuntimeError(
            "--import-pfx imports into the Windows certificate store and is Windows-only; on POSIX "
            "enroll with --client-cert/--client-key (PEM) instead."
        )
    # Prefer an explicit password, else an already-exported AC_PFX_PW (so the secret can stay out of
    # argv/shell history entirely), else none for a password-less PFX.
    pw = password if password is not None else os.environ.get("AC_PFX_PW", "")
    ps = _pfx_import_ps(has_password=bool(pw))
    env = {**os.environ, "AC_PFX_PATH": str(Path(pfx_path).resolve()), "AC_PFX_PW": pw}
    proc = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
        capture_output=True, text=True, env=env,
    )
    thumb = proc.stdout.strip().splitlines()[-1].strip() if proc.stdout.strip() else ""
    if proc.returncode != 0 or not thumb:
        raise RuntimeError(f"PFX import into Cert:\\CurrentUser\\My failed (rc={proc.returncode}): "
                           f"{proc.stderr.strip()[:400]}")
    return thumb


def enroll(
    hub_url: str,
    dev: bool,
    path: Path | str | None = None,
    machine_id: str | None = None,
    client_cert_path: str | None = None,
    client_key_path: str | None = None,
    client_cert_thumbprint: str | None = None,
    import_pfx: str | None = None,
    pfx_password: str | None = None,
) -> Config:
    """Write a collector config. `dev=True` writes dev auth (x-dev-machine); otherwise a
    file-based mTLS config, which requires both a client cert and key path (produced by
    infra/cf/enroll-cert.sh). TPM-backed mTLS enrollment lands in M4.

    Re-enrolling an existing box (e.g. dev -> mTLS for production) only swaps the auth
    material, hub_url, and machine_id. Every OTHER field — stores, exclude globs,
    include_windows_mounts — is carried over from the existing config so a customized
    collector doesn't silently revert to defaults and stop backing up its custom roots.

    machine_id resolution: explicit override > existing config's id > computed default.
    Preserving the existing id keeps mTLS consistent — enroll-cert.sh signs the cert for the
    id `agent-collector machine-id` reports (the configured one), so resetting to the default
    would make cert identity and upload URLs diverge and every upload 401 as machine_mismatch.
    """
    path = Path(path) if path else config_path()
    existing = _load_if_exists(path)
    resolved_id = (
        machine_id if machine_id is not None
        else existing.machine_id if existing is not None
        else default_machine_id()
    )
    carried = dict(
        stores=dict(existing.stores) if existing is not None else dict(DEFAULT_STORES),
        exclude=list(existing.exclude) if existing is not None else [],
        include_windows_mounts=existing.include_windows_mounts if existing is not None else False,
        multipart_threshold_mb=existing.multipart_threshold_mb if existing is not None else DEFAULT_MULTIPART_THRESHOLD_MB,
        multipart_part_size_mb=existing.multipart_part_size_mb if existing is not None else DEFAULT_MULTIPART_PART_SIZE_MB,
    )
    # Register the export-inbox store so an export-only operator (drops a ZIP, runs `run`/`backfill`,
    # never CDP) still gets it scanned + uploaded. setdefault preserves a custom configured root.
    carried["stores"].setdefault(EXPORT_INBOX_STORE, str(webcapture_dir() / EXPORT_INBOX_STORE))
    if dev:
        cfg = Config(machine_id=resolved_id, hub_url=hub_url.rstrip("/"), auth="dev", **carried)
    else:
        thumbprint = client_cert_thumbprint
        if import_pfx:
            # Windows: import the PFX into the store (non-exportable key), take its thumbprint, then
            # delete the throwaway PFX below — the private key then lives ONLY in Cert:\CurrentUser\My.
            thumbprint = _import_pfx_to_store(import_pfx, pfx_password)
        if thumbprint:
            cfg = Config(
                machine_id=resolved_id,
                hub_url=hub_url.rstrip("/"),
                auth="mtls",
                client_cert_thumbprint=normalize_thumbprint(thumbprint),
                **carried,
            )
            if import_pfx:
                Path(import_pfx).unlink(missing_ok=True)
        elif client_cert_path and client_key_path:
            cfg = Config(
                machine_id=resolved_id,
                hub_url=hub_url.rstrip("/"),
                auth="mtls",
                # Absolute (resolve()), not just expanduser(): scheduled systemd/Task Scheduler
                # runs start from a different cwd, so a relative path (enroll-cert.sh's `--out .`
                # default) would make MtlsAuth fail its file-existence check before every upload.
                client_cert_path=str(Path(client_cert_path).expanduser().resolve()),
                client_key_path=str(Path(client_key_path).expanduser().resolve()),
                **carried,
            )
        else:
            raise ValueError(
                "mTLS enrollment needs client material: --client-cert-thumbprint or --import-pfx "
                "(Windows/Schannel), or --client-cert + --client-key (POSIX/PEM). Run "
                "infra/cf/enroll-cert.sh first. Use --dev for the dev-header config instead."
            )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_dump_toml(cfg))
    cfg.source = path
    return cfg


def save(cfg: Config, path: Path | str | None = None) -> None:
    """Persist a config back to disk (round-trips every field via _dump_toml)."""
    path = Path(path) if path else (cfg.source or config_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_dump_toml(cfg))
    cfg.source = path


def ensure_webcapture_stores(cfg: Config, path: Path | str | None = None) -> list[str]:
    """Register the webcapture staging stores in the config (idempotent) so the normal run
    path uploads them. Returns the store names newly added (persists the config if any were).
    The roots point under webcapture_dir(); the directories are created by the caller."""
    base = webcapture_dir()
    added: list[str] = []
    for name in WEBCAPTURE_STORES:
        if name not in cfg.stores:
            cfg.stores[name] = str(base / name)
            added.append(name)
    if added:
        save(cfg, path)
    return added
