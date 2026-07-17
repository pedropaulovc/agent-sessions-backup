"""Windows Task Scheduler install/uninstall.

On Windows we run the generated Register-ScheduledTask script via powershell.exe. On any
other platform we only write the .ps1 next to the config with run instructions (so a WSL
session can hand it to the Windows side).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from .. import config as config_mod

TASK_NAME = "agent-collector"


def _script_path() -> Path:
    return config_mod.config_dir() / "agent-collector-task.ps1"


def _ps_quote(value: str) -> str:
    """Escape a value for a single-quoted PowerShell literal by doubling apostrophes, so a
    path like C:\\Users\\O'Neil\\... doesn't terminate the string early."""
    return value.replace("'", "''")


def _action_parts() -> tuple[str, str]:
    """(-Execute, -Argument): the executable path only, then its arguments separately.

    Never fold arguments into -Execute — Task Scheduler treats -Execute as a single
    program path. Paths with spaces are safe inside the single-quoted PS literal.
    """
    exe = shutil.which("agent-collector")
    if exe:
        return exe, "run --once"
    return sys.executable, "-m agent_collector.cli run --once"


def _install_script(interval: int) -> str:
    execute, argument = _action_parts()
    return (
        f"$action = New-ScheduledTaskAction -Execute '{_ps_quote(execute)}' "
        f"-Argument '{_ps_quote(argument)}'\n"
        f"$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) "
        f"-RepetitionInterval (New-TimeSpan -Minutes {interval}) "
        "-RandomDelay (New-TimeSpan -Minutes 5)\n"
        "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable\n"
        f"Register-ScheduledTask -TaskName '{_ps_quote(TASK_NAME)}' -Action $action "
        "-Trigger $trigger -Settings $settings -Force\n"
    )


def _uninstall_script() -> str:
    return f"Unregister-ScheduledTask -TaskName '{_ps_quote(TASK_NAME)}' -Confirm:$false\n"


def _write_and_maybe_run(script: str, verb: str) -> int:
    path = _script_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(script)
    print(f"wrote {path}")
    if config_mod.detect_platform_tag() != "windows":
        print(f"[warn] not on Windows: run this on the Windows side to {verb} the task:")
        print(f"       powershell.exe -ExecutionPolicy Bypass -File {path}")
        return 0
    if shutil.which("powershell.exe") is None:
        print("[warn] powershell.exe not found; run the .ps1 manually", file=sys.stderr)
        return 0
    proc = subprocess.run(
        ["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", str(path)],
        capture_output=True, text=True,
    )
    print(proc.stdout.strip())
    if proc.returncode != 0:
        print(f"[warn] scheduled task {verb} failed: {proc.stderr.strip()}", file=sys.stderr)
        return 1
    return 0


def install(interval: int = 15) -> int:
    return _write_and_maybe_run(_install_script(interval), "install")


def uninstall() -> int:
    return _write_and_maybe_run(_uninstall_script(), "uninstall")
