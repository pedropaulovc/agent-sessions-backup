"""systemd --user timer install/uninstall (Linux, WSL with systemd)."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def _unit_dir() -> Path:
    # Read XDG_CONFIG_HOME at call time: systemd --user looks under
    # $XDG_CONFIG_HOME/systemd/user, not a hardcoded ~/.config, when the var is set.
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "systemd" / "user"


def _service_path() -> Path:
    return _unit_dir() / "agent-collector.service"


def _timer_path() -> Path:
    return _unit_dir() / "agent-collector.timer"


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
    service, timer = _service_path(), _timer_path()
    service.parent.mkdir(parents=True, exist_ok=True)
    service.write_text(_service_unit())
    timer.write_text(_timer_unit(interval))
    print(f"wrote {service}")
    print(f"wrote {timer}")
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
        linger = subprocess.run(["loginctl", "enable-linger"], capture_output=True, text=True)
        if linger.returncode == 0:
            print("enabled linger so the timer runs while logged out")
        else:
            # The timer is installed and active, so this is not a hard failure (rc stays 0),
            # but without linger it only fires while a login session is open. Say so plainly.
            print(
                "[warn] could not enable linger: "
                f"{linger.stderr.strip()}\n"
                "  The timer will only run while you are logged in. To fix, retry:\n"
                "  loginctl enable-linger",
                file=sys.stderr,
            )
    return 0


def uninstall() -> int:
    # Disable first. If systemctl can't disable the timer, do NOT delete the unit files: a
    # leftover-but-disabled unit is recoverable, but deleting files while the timer stays
    # enabled leaves systemd referencing units that no longer exist. Fail loudly instead.
    if not _systemctl("disable", "--now", "agent-collector.timer"):
        print(
            "[FAIL] could not disable the timer via systemctl --user; kept unit files. "
            "Finish manually:\n"
            "  systemctl --user disable --now agent-collector.timer\n"
            "  rm -f " + " ".join(str(u) for u in (_timer_path(), _service_path())) + "\n"
            "  systemctl --user daemon-reload",
            file=sys.stderr,
        )
        return 1
    for unit in (_timer_path(), _service_path()):
        if unit.exists():
            unit.unlink()
            print(f"removed {unit}")
    if not _systemctl("daemon-reload"):
        print("[warn] removed unit files but daemon-reload failed; run "
              "'systemctl --user daemon-reload' manually", file=sys.stderr)
        return 1
    return 0
