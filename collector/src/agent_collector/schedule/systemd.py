"""systemd --user timer install/uninstall (Linux, WSL with systemd)."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

UNIT_DIR = Path.home() / ".config" / "systemd" / "user"
SERVICE = UNIT_DIR / "agent-collector.service"
TIMER = UNIT_DIR / "agent-collector.timer"


def _sd_quote(arg: str) -> str:
    """Double-quote an Exec* argument so systemd doesn't split a path at its spaces.
    systemd strips the quotes and unescapes \\\\ and \\" inside them."""
    escaped = arg.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _exec_start() -> str:
    exe = shutil.which("agent-collector")
    if exe:
        return f"{_sd_quote(exe)} run --once"
    return f"{_sd_quote(sys.executable)} -m agent_collector.cli run --once"


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
    # Elapsed timers honor "minutes between runs" for ANY interval. OnCalendar=*:0/N breaks
    # for values that don't divide 60 (e.g. 45 -> :45,:00 gives a 15-min gap; 90 is invalid).
    return (
        "[Unit]\n"
        "Description=Run agent-collector periodically\n\n"
        "[Timer]\n"
        f"OnBootSec={interval}min\n"
        f"OnUnitActiveSec={interval}min\n"
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
    reloaded = _systemctl("daemon-reload")
    enabled = _systemctl("enable", "--now", "agent-collector.timer")
    if not (reloaded and enabled):
        print(
            "[FAIL] wrote unit files but could not activate the timer via systemctl --user. "
            "Finish manually:\n"
            "  systemctl --user daemon-reload\n"
            "  systemctl --user enable --now agent-collector.timer",
            file=sys.stderr,
        )
        return 1
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
