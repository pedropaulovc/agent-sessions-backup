"""systemd --user timer install/uninstall (Linux, WSL with systemd)."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

UNIT_DIR = Path.home() / ".config" / "systemd" / "user"
SERVICE = UNIT_DIR / "agent-collector.service"
TIMER = UNIT_DIR / "agent-collector.timer"


def _exec_start() -> str:
    exe = shutil.which("agent-collector")
    if exe:
        return f"{exe} run --once"
    return f"{sys.executable} -m agent_collector.cli run --once"


def _service_unit() -> str:
    return (
        "[Unit]\n"
        "Description=agent-collector incremental session upload\n"
        "After=network-online.target\n"
        "Wants=network-online.target\n\n"
        "[Service]\n"
        "Type=oneshot\n"
        f"ExecStart={_exec_start()}\n"
    )


def _timer_unit(interval: int) -> str:
    return (
        "[Unit]\n"
        "Description=Run agent-collector periodically\n\n"
        "[Timer]\n"
        f"OnCalendar=*:0/{interval}\n"
        "RandomizedDelaySec=300\n"
        "Persistent=true\n\n"
        "[Install]\n"
        "WantedBy=timers.target\n"
    )


def _systemctl(*args: str) -> bool:
    if shutil.which("systemctl") is None:
        print("[warn] systemctl not available; wrote unit files only", file=sys.stderr)
        return False
    proc = subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        print(f"[warn] systemctl --user {' '.join(args)} failed: {proc.stderr.strip()}",
              file=sys.stderr)
        return False
    return True


def install(interval: int = 15) -> int:
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    SERVICE.write_text(_service_unit())
    TIMER.write_text(_timer_unit(interval))
    print(f"wrote {SERVICE}")
    print(f"wrote {TIMER}")
    _systemctl("daemon-reload")
    _systemctl("enable", "--now", "agent-collector.timer")
    if shutil.which("loginctl"):
        subprocess.run(["loginctl", "enable-linger"], capture_output=True, text=True)
        print("enabled linger so the timer runs while logged out")
    return 0


def uninstall() -> int:
    _systemctl("disable", "--now", "agent-collector.timer")
    for unit in (TIMER, SERVICE):
        if unit.exists():
            unit.unlink()
            print(f"removed {unit}")
    _systemctl("daemon-reload")
    return 0
