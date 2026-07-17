"""Scheduling: pick systemd (Linux/WSL) or Task Scheduler (Windows).

macOS is intentionally unsupported for now: launchd is out of scope, and silently writing
Linux systemd unit files (which "succeed" when systemctl is absent) would leave a mac with
no scheduler while reporting success. So Darwin fails loudly.
"""

from __future__ import annotations

import sys

from .. import config as config_mod
from . import systemd, taskscheduler

_MACOS_MSG = (
    "macOS scheduling not implemented; run `agent-collector run` via launchd manually "
    "(a launchd plist implementation is out of scope for this milestone)."
)


def install(interval: int = 15) -> int:
    tag = config_mod.detect_platform_tag()
    if tag == "windows":
        return taskscheduler.install(interval)
    if tag == "darwin":
        print(f"[FAIL] {_MACOS_MSG}", file=sys.stderr)
        return 1
    return systemd.install(interval)


def uninstall() -> int:
    tag = config_mod.detect_platform_tag()
    if tag == "windows":
        return taskscheduler.uninstall()
    if tag == "darwin":
        print(f"[FAIL] {_MACOS_MSG}", file=sys.stderr)
        return 1
    return systemd.uninstall()
