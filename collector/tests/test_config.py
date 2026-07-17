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


def test_enroll_non_dev_not_implemented(tmp_path):
    with pytest.raises(NotImplementedError):
        config.enroll("http://x", dev=False, path=tmp_path / "c.toml")


def test_load_missing_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        config.load(tmp_path / "nope.toml")


def test_effective_excludes_extends_defaults(tmp_path):
    path = tmp_path / "config.toml"
    config.enroll("http://x", dev=True, path=path, machine_id="m1")
    cfg = config.load(path)
    cfg.exclude = ["custom/**"]
    eff = cfg.effective_excludes()
    assert "custom/**" in eff
    assert "*.pem" in eff  # default still present
