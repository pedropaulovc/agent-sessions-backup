import pytest

from fake_hub import FakeHub


@pytest.fixture
def hub():
    h = FakeHub().start()
    try:
        yield h
    finally:
        h.stop()


@pytest.fixture
def tmp_env(tmp_path, monkeypatch):
    """Point XDG config/state and HOME at a temp dir so nothing touches the real home."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    return tmp_path
