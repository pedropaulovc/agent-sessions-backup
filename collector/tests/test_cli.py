import subprocess
import sys


def test_cli_rejects_unknown_command():
    proc = subprocess.run(
        [sys.executable, "-m", "agent_collector.cli", "frobnicate"],
        capture_output=True,
    )
    assert proc.returncode == 2
