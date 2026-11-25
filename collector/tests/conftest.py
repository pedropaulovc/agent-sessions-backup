from pathlib import Path
import sqlite3

import pytest

from fake_hub import FakeHub


class _FastTestConnection(sqlite3.Connection):
    """Disable fsync and WAL checkpoint churn on test State databases while preserving locking/rollback."""

    def execute(self, sql, parameters=()):
        if isinstance(sql, str):
            upper = sql.strip().upper()
            if upper == "PRAGMA JOURNAL_MODE = WAL":
                super().execute("PRAGMA synchronous = OFF")
                return super().execute("PRAGMA journal_mode = MEMORY")
            if upper == "PRAGMA SYNCHRONOUS = NORMAL":
                return super().execute("PRAGMA synchronous = OFF")
        return super().execute(sql, parameters)


@pytest.fixture(autouse=True)
def fast_test_sqlite(monkeypatch):
    real_connect = sqlite3.connect

    def _connect(*args, **kwargs):
        is_uri = bool(kwargs.get("uri"))
        db_arg = args[0] if args else kwargs.get("database")
        is_new_file = (
            not is_uri
            and db_arg is not None
            and str(db_arg) != ":memory:"
            and not Path(db_arg).exists()
        )
        if "factory" not in kwargs and not is_uri:
            kwargs["factory"] = _FastTestConnection
        conn = real_connect(*args, **kwargs)
        if is_new_file and isinstance(conn, _FastTestConnection):
            conn.execute("PRAGMA synchronous = OFF")
        return conn

    monkeypatch.setattr(sqlite3, "connect", _connect)


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
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    return tmp_path
