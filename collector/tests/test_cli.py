import os
import subprocess
import sys

from agent_collector import config


def _run(args, env=None):
    return subprocess.run(
        [sys.executable, "-m", "agent_collector.cli", *args],
        capture_output=True, text=True, env=env,
    )


def test_cli_rejects_unknown_command():
    proc = subprocess.run(
        [sys.executable, "-m", "agent_collector.cli", "frobnicate"],
        capture_output=True,
    )
    assert proc.returncode == 2


def test_machine_id_prints_default_without_config(tmp_path):
    # No config under XDG_CONFIG_HOME -> the computed default (what enroll-cert.py must sign).
    env = {**os.environ, "XDG_CONFIG_HOME": str(tmp_path)}
    proc = _run(["machine-id"], env=env)
    assert proc.returncode == 0
    assert proc.stdout.strip() == config.default_machine_id()


def test_machine_id_respects_config_override(tmp_path):
    # An enrolled config's machine_id wins, so enrollment and the collector always agree.
    config.enroll(
        "http://localhost:8787", dev=True,
        path=tmp_path / "agent-collector" / "config.toml", machine_id="custom-box",
    )
    env = {**os.environ, "XDG_CONFIG_HOME": str(tmp_path)}
    proc = _run(["machine-id"], env=env)
    assert proc.returncode == 0
    assert proc.stdout.strip() == "custom-box"
