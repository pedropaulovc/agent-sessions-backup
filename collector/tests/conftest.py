import pytest

from fake_hub import FakeHub


@pytest.fixture(autouse=True)
def isolate_xdg_data_home(tmp_path, monkeypatch):
    """Every test in this suite must be hermetic against this box's real
    ~/.local/share/agent-collector/webcapture/ — which can hold real export ZIPs the
    operator dropped for backfill. Config.store_roots() setdefault-injects the webcapture
    staging stores (chatgpt-web/claude-web/export-inbox) from config.webcapture_dir(),
    which reads $XDG_DATA_HOME (falling back to ~/.local/share) — so ANY test building a
    Config with only e.g. stores={"claude": tmp_path} still picks up those defaults, and
    without this they'd resolve to the real dir. Autouse + XDG_DATA_HOME (not staging_base
    on individual Configs) so hermeticity holds by construction, not by every test
    remembering to opt in. See config.data_dir()/webcapture_dir() and Config.staging_base
    for the per-Config override tests can use instead when they want to be explicit.
    """
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg-data"))


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
