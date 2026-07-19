import sys
from pathlib import Path

import pytest

from agent_collector import config

# A realistic 40-hex SHA-1 cert thumbprint (see test_transport.TP).
TP = "A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0"


@pytest.mark.parametrize(
    "platform,proc,expected",
    [
        ("linux", "Linux version 6.1.0", "linux"),
        ("linux", "Linux version 5.15.0-microsoft-standard-WSL2", "wsl"),
        ("win32", "", "windows"),
        ("darwin", "", "darwin"),
    ],
)
def test_platform_tagging(monkeypatch, platform, proc, expected):
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setattr(config, "_read_proc_version", lambda: proc)
    assert config.detect_platform_tag() == expected


def test_machine_id_default(monkeypatch):
    monkeypatch.setattr(config.socket, "gethostname", lambda: "boxname")
    monkeypatch.setattr(config, "detect_platform_tag", lambda: "linux")
    assert config.default_machine_id() == "boxname-linux"


def test_enroll_and_load_roundtrip(tmp_path):
    path = tmp_path / "config.toml"
    cfg = config.enroll("http://localhost:8787/", dev=True, path=path, machine_id="m1")
    assert cfg.machine_id == "m1"
    assert cfg.hub_url == "http://localhost:8787"  # trailing slash stripped
    loaded = config.load(path)
    assert loaded.machine_id == "m1"
    assert loaded.auth == "dev"
    # enroll registers the export-inbox store (Fix 11); the DEFAULT_STORES are otherwise intact.
    assert {k: loaded.stores[k] for k in config.DEFAULT_STORES} == config.DEFAULT_STORES
    assert "export-inbox" in loaded.stores
    # Security defaults always apply even though the file lists no excludes.
    assert ".credentials.json*" in loaded.effective_excludes()


def test_enroll_mtls_without_paths_errors(tmp_path):
    # Non-dev enrollment with no client material errors clearly (PEM paths OR a Windows thumbprint).
    with pytest.raises(ValueError, match="mTLS enrollment needs client material"):
        config.enroll("http://x", dev=False, path=tmp_path / "c.toml")


def test_mtls_config_rejects_both_thumbprint_and_pem():
    # The mechanism is derived from which fields are set; both set is ambiguous.
    with pytest.raises(ValueError, match="ambiguous"):
        config.Config(machine_id="m1", hub_url="https://h", auth="mtls",
                      client_cert_thumbprint="ABCD", client_cert_path="/c.pem", client_key_path="/c.key")


def test_mtls_config_rejects_no_material():
    with pytest.raises(ValueError, match="needs client material"):
        config.Config(machine_id="m1", hub_url="https://h", auth="mtls")


def test_mtls_thumbprint_config_roundtrips(tmp_path):
    cfg = config.Config(machine_id="amet-windows", hub_url="https://h", auth="mtls",
                        client_cert_thumbprint=TP)
    path = tmp_path / "config.toml"
    config.save(cfg, path)
    loaded = config.load(path)
    assert loaded.auth == "mtls"
    assert loaded.client_cert_thumbprint == TP
    assert loaded.client_cert_path is None and loaded.client_key_path is None


def test_enroll_thumbprint_writes_windows_mtls_config(tmp_path):
    path = tmp_path / "config.toml"
    # Pass the thumbprint space-separated and lowercase (as certmgr shows it); enroll normalizes.
    separated = " ".join(TP[i:i + 2] for i in range(0, len(TP), 2)).lower()
    cfg = config.enroll("https://api.sessions.vza.net/", dev=False, path=path,
                        machine_id="amet-windows", client_cert_thumbprint=separated)
    assert cfg.auth == "mtls"
    assert cfg.client_cert_thumbprint == TP  # enroll normalizes
    assert cfg.client_cert_path is None
    assert f'client_cert_thumbprint = "{TP}"' in path.read_text()


def test_pfx_import_ps_omits_password_when_absent():
    # Password-less PFX (Import-PfxCertificate docs Example 2): no -Password, no SecureString —
    # ConvertTo-SecureString -String "" throws, so building an empty SecureString would break import.
    ps = config._pfx_import_ps(has_password=False)
    assert "-Password" not in ps
    assert "ConvertTo-SecureString" not in ps
    assert "Import-PfxCertificate" in ps and "Cert:\\CurrentUser\\My" in ps


def test_pfx_import_ps_uses_securestring_when_present():
    ps = config._pfx_import_ps(has_password=True)
    assert "-Password $sec" in ps
    assert "ConvertTo-SecureString -String $env:AC_PFX_PW" in ps


def _write_config(path, extra=""):
    path.write_text('machine_id = "m1"\nhub_url = "http://h"\nauth = "dev"\n' + extra)


def test_load_rejects_threshold_below_part_floor(tmp_path):
    # A threshold below R2's 5MiB part floor is also below the part-size ceiling, so no legal part
    # could ever be sent — reject at load with a clear message rather than fail on the wire.
    path = tmp_path / "config.toml"
    _write_config(path, "multipart_threshold_mb = 3\n")  # 3 MB < 5 MiB
    with pytest.raises(ValueError, match="minimum part size"):
        config.load(path)


def test_load_clamps_threshold_above_edge_cap(tmp_path, capsys):
    # A threshold above the safe sub-100MB ceiling would route cap..threshold files to the doomed
    # simple PUT (413 at the edge); clamp down and warn.
    path = tmp_path / "config.toml"
    _write_config(path, "multipart_threshold_mb = 250\n")
    cfg = config.load(path)
    assert cfg.multipart_threshold_bytes <= config.MAX_MULTIPART_THRESHOLD_BYTES
    assert "clamping" in capsys.readouterr().err


def test_load_clamps_part_size_below_floor(tmp_path, capsys):
    # A configured part size below the 5MiB floor would make the hub reject every non-final part;
    # clamp up to the floor and warn.
    path = tmp_path / "config.toml"
    _write_config(path, "multipart_threshold_mb = 90\nmultipart_part_size_mb = 1\n")  # 1 MB < 5 MiB
    cfg = config.load(path)
    assert cfg.multipart_part_size_bytes >= config.MIN_PART_SIZE_BYTES
    assert "clamping" in capsys.readouterr().err


def test_load_accepts_default_multipart_config_without_warning(tmp_path, capsys):
    # The stock 90MB/64MiB config passes through untouched and silent.
    path = tmp_path / "config.toml"
    _write_config(path)
    cfg = config.load(path)
    assert cfg.multipart_threshold_mb == config.DEFAULT_MULTIPART_THRESHOLD_MB
    assert cfg.multipart_part_size_mb == config.DEFAULT_MULTIPART_PART_SIZE_MB
    assert "clamp" not in capsys.readouterr().err


def test_enroll_mtls_roundtrip(tmp_path):
    path = tmp_path / "config.toml"
    cert = tmp_path / "box.client.pem"
    key = tmp_path / "box.client.key"
    cfg = config.enroll(
        "https://api.sessions.vza.net",
        dev=False,
        path=path,
        machine_id="m1",
        client_cert_path=str(cert),
        client_key_path=str(key),
    )
    assert cfg.auth == "mtls"
    loaded = config.load(path)
    assert loaded.auth == "mtls"
    assert loaded.client_cert_path == str(cert.resolve())
    assert loaded.client_key_path == str(key.resolve())


def test_enroll_mtls_preserves_existing_machine_id(tmp_path):
    # Re-enrolling for mTLS must keep the id enroll-cert.sh already signed the cert for,
    # not reset it to default_machine_id() (that would diverge -> machine_mismatch).
    path = tmp_path / "config.toml"
    cert = tmp_path / "c.pem"
    key = tmp_path / "c.key"
    cert.write_text("c")
    key.write_text("k")
    config.enroll("http://h", dev=True, path=path, machine_id="my-custom-box")
    cfg = config.enroll(
        "https://api", dev=False, path=path,
        client_cert_path=str(cert), client_key_path=str(key),
    )
    assert cfg.machine_id == "my-custom-box"
    assert config.load(path).machine_id == "my-custom-box"


def test_enroll_mtls_preserves_custom_stores_and_excludes(tmp_path):
    # A customized collector must keep backing up its custom roots / WSL policy after the
    # dev -> mTLS production re-enroll; only auth material + hub_url + machine_id change.
    path = tmp_path / "config.toml"
    cert = tmp_path / "c.pem"
    key = tmp_path / "c.key"
    cert.write_text("c")
    key.write_text("k")
    path.write_text(
        'machine_id = "box"\nhub_url = "http://h"\nauth = "dev"\n'
        "include_windows_mounts = true\n"
        'exclude = ["*.secret"]\n\n'
        '[stores]\nclaude = "~/.claude"\nmystore = "~/custom"\n'
    )
    config.enroll(
        "https://api", dev=False, path=path,
        client_cert_path=str(cert), client_key_path=str(key),
    )
    loaded = config.load(path)
    assert loaded.auth == "mtls"
    assert loaded.machine_id == "box"
    assert loaded.stores["claude"] == "~/.claude"
    assert loaded.stores["mystore"] == "~/custom"
    assert "export-inbox" in loaded.stores  # registered on enroll (Fix 11), custom roots preserved
    assert loaded.exclude == ["*.secret"]
    assert loaded.include_windows_mounts is True


def test_enroll_explicit_machine_id_wins_over_existing(tmp_path):
    path = tmp_path / "config.toml"
    config.enroll("http://h", dev=True, path=path, machine_id="old-box")
    cfg = config.enroll("http://h", dev=True, path=path, machine_id="new-box")
    assert cfg.machine_id == "new-box"


def test_enroll_mtls_resolves_relative_cert_paths(tmp_path, monkeypatch):
    # enroll-cert.sh defaults to --out . (relative); scheduled jobs run from another cwd,
    # so the stored config must hold absolute paths.
    monkeypatch.chdir(tmp_path)
    (tmp_path / "c.pem").write_text("c")
    (tmp_path / "c.key").write_text("k")
    path = tmp_path / "config.toml"
    cfg = config.enroll(
        "https://api", dev=False, path=path, machine_id="m1",
        client_cert_path="c.pem", client_key_path="c.key",
    )
    assert Path(cfg.client_cert_path).is_absolute()
    assert Path(cfg.client_key_path).is_absolute()
    assert config.load(path).client_cert_path == str((tmp_path / "c.pem").resolve())


def test_store_roots_always_includes_webcapture_stores(tmp_path):
    # Round 6 Fix 2: even a config that never registered the webcapture stores (an already-enrolled
    # collector that upgraded) exposes them via store_roots(), so a dropped export ZIP is scanned
    # without a re-enroll.
    cfg = config.Config(machine_id="m", hub_url="http://h", stores={"claude": "~/.claude"})
    roots = cfg.store_roots()
    for name in config.WEBCAPTURE_STORES:
        assert name in roots
    # A custom configured root still wins over the injected default (setdefault semantics).
    custom = config.Config(machine_id="m", hub_url="http://h", stores={"export-inbox": "/custom/inbox"})
    assert str(custom.store_roots()["export-inbox"]) == "/custom/inbox"


def test_hermetic_by_construction_never_resolves_real_data_dir(tmp_path, monkeypatch):
    """Positive control for the isolate_xdg_data_home autouse fixture (conftest.py). Plants a
    decoy in a stand-in for this box's real ~/.local/share/agent-collector/webcapture/ (a
    fake $HOME, never the actual real one) and proves a plain Config — built the same minimal
    way every test's _cfg()-style helper does, with no explicit webcapture stores or
    staging_base — still never resolves store_roots() into it, and a Scanner walk over the
    resolved roots never sees the decoy.

    Deliberately does NOT touch XDG_DATA_HOME itself: the autouse fixture already set it for
    this test like every other, and that's what's under test here. If isolate_xdg_data_home
    were ever removed from conftest.py, this test would start resolving into `fake_home`
    (data_dir() falls back to $HOME when XDG_DATA_HOME is unset) and fail — exactly the
    regression that let 4 tests in test_run.py pick up this box's real export ZIPs.
    """
    fake_home = tmp_path / "fake-real-home"
    decoy_dir = fake_home / ".local" / "share" / "agent-collector" / "webcapture" / "export-inbox"
    decoy_dir.mkdir(parents=True)
    (decoy_dir / "DECOY-real-export.zip").write_bytes(b"not synthetic test data")
    monkeypatch.setenv("HOME", str(fake_home))

    cfg = config.Config(machine_id="m", hub_url="http://h", stores={"claude": str(tmp_path / "claude")})
    roots = cfg.store_roots()
    assert "DECOY" not in str(roots["export-inbox"])
    assert decoy_dir not in roots["export-inbox"].parents
    assert roots["export-inbox"] != decoy_dir

    from agent_collector.scanner import Scanner

    found = []
    with Scanner(cfg.effective_excludes()) as sc:
        for store, root in roots.items():
            if not root.exists():
                continue
            for item in sc.scan_store(store, root):
                found.append((store, item.relpath))
    assert not any("DECOY" in relpath for _store, relpath in found)


def test_run_scans_a_dropped_export_zip_without_explicit_registration(tmp_env):
    # Round 6 Fix 2 (end-to-end at the scan layer): a config that never registered export-inbox still
    # scans a ZIP dropped into the default inbox, because store_roots() injects it.
    from agent_collector.scanner import Scanner

    inbox = config.webcapture_dir() / "export-inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    (inbox / "backup.zip").write_bytes(b"PK\x03\x04 a real file on disk (contents irrelevant here)")
    cfg = config.Config(machine_id="m", hub_url="http://h", stores=dict(config.DEFAULT_STORES))
    assert "export-inbox" not in cfg.stores  # never explicitly registered

    found = []
    with Scanner(cfg.effective_excludes()) as sc:
        for store, root in cfg.store_roots().items():
            for item in sc.scan_store(store, root):
                found.append((store, item.relpath))
    assert ("export-inbox", "backup.zip") in found


def test_load_missing_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        config.load(tmp_path / "nope.toml")


def test_sqlite_sidecar_excludes_match_full_filenames():
    from agent_collector.scanner import path_matches
    for pat in ("*-wal", "*-shm", "*-journal"):
        assert pat in config.DEFAULT_EXCLUDES
    # Real sidecars append to the FULL filename, not just *.sqlite-*.
    assert path_matches("state.db-wal", "*-wal")
    assert path_matches("cache.vscdb-shm", "*-shm")
    assert path_matches("foo.db-journal", "*-journal")
    assert path_matches("todos.sqlite-wal", "*-wal")
    # the DB itself is NOT excluded by these
    assert not path_matches("todos.sqlite", "*-wal")


def test_wsl_drops_windows_mount_roots(monkeypatch):
    monkeypatch.setattr(config, "detect_platform_tag", lambda: "wsl")
    cfg = config.Config(machine_id="m", hub_url="http://x",
                        stores={"claude": "~/.claude", "win": "/mnt/c/Users/x/.claude"})
    roots = cfg.store_roots()
    assert "win" not in roots and "claude" in roots
    assert set(cfg.dropped_store_roots()) == {"win"}


def test_wsl_include_windows_mounts_true_keeps_them(monkeypatch):
    monkeypatch.setattr(config, "detect_platform_tag", lambda: "wsl")
    cfg = config.Config(machine_id="m", hub_url="http://x", include_windows_mounts=True,
                        stores={"win": "/mnt/c/x"})
    assert "win" in cfg.store_roots()
    assert cfg.dropped_store_roots() == {}


def test_non_wsl_keeps_mount_roots(monkeypatch):
    monkeypatch.setattr(config, "detect_platform_tag", lambda: "linux")
    cfg = config.Config(machine_id="m", hub_url="http://x", stores={"win": "/mnt/c/x"})
    assert "win" in cfg.store_roots()
    assert cfg.dropped_store_roots() == {}


def _symlink_to_mnt(tmp_path):
    link = tmp_path / "claude_link"
    try:
        link.symlink_to("/mnt/c/Users/fake/.claude")  # target need not exist to resolve
    except (OSError, NotImplementedError):
        pytest.skip("filesystem cannot create symlinks")
    return link


def test_wsl_symlink_root_to_mnt_is_dropped(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "detect_platform_tag", lambda: "wsl")
    link = _symlink_to_mnt(tmp_path)
    cfg = config.Config(machine_id="m", hub_url="http://x", stores={"claude": str(link)})
    assert "claude" not in cfg.store_roots()          # symlink resolves under /mnt/c -> dropped
    assert set(cfg.dropped_store_roots()) == {"claude"}


def test_wsl_symlink_root_kept_when_include_windows_mounts(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "detect_platform_tag", lambda: "wsl")
    link = _symlink_to_mnt(tmp_path)
    cfg = config.Config(machine_id="m", hub_url="http://x",
                        include_windows_mounts=True, stores={"claude": str(link)})
    roots = cfg.store_roots()
    assert "claude" in roots
    assert roots["claude"] == link  # unresolved path kept as scan root (stable relpaths)


def test_store_name_with_slash_rejected():
    with pytest.raises(ValueError):
        config.Config(machine_id="m", hub_url="http://x", stores={"foo/bar": "~/.x"})


def test_machine_id_with_slash_rejected():
    with pytest.raises(ValueError):
        config.Config(machine_id="a/b", hub_url="http://x")


def test_load_rejects_slash_in_store(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text(
        'machine_id = "m"\nhub_url = "http://x"\nauth = "dev"\n'
        'include_windows_mounts = false\n\n[stores]\n"foo/bar" = "~/.x"\n'
    )
    with pytest.raises(ValueError):
        config.load(path)


def test_effective_excludes_extends_defaults(tmp_path):
    path = tmp_path / "config.toml"
    config.enroll("http://x", dev=True, path=path, machine_id="m1")
    cfg = config.load(path)
    cfg.exclude = ["custom/**"]
    eff = cfg.effective_excludes()
    assert "custom/**" in eff
    assert "*.pem" in eff  # default still present


def test_security_excludes_cannot_be_removed_by_user_config(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text(
        'machine_id = "m"\nhub_url = "http://x"\nauth = "dev"\n'
        'exclude = []\n'
    )
    cfg = config.load(path)
    effective = cfg.effective_excludes()
    assert ".credentials.json*" in effective
    assert "auth.json*" in effective
    assert "**/cred-profiles/**" in effective
    assert "**/cache/**" in effective
