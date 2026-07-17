import sys

import pytest

from agent_collector import config


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
    assert loaded.stores == config.DEFAULT_STORES
    # Security defaults always apply even though the file lists no excludes.
    assert ".credentials.json" in loaded.effective_excludes()


def test_enroll_mtls_without_paths_errors(tmp_path):
    # Non-dev enrollment needs both cert and key; otherwise a clear error, not a broken config.
    with pytest.raises(ValueError, match="--client-cert and --client-key"):
        config.enroll("http://x", dev=False, path=tmp_path / "c.toml")


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
    assert loaded.client_cert_path == str(cert)
    assert loaded.client_key_path == str(key)


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
