"""Scheduling: pick systemd (Linux/WSL) or Task Scheduler (Windows)."""

from __future__ import annotations

from .. import config as config_mod
from . import systemd, taskscheduler


def install(interval: int = 15) -> int:
    tag = config_mod.detect_platform_tag()
    if tag == "windows":
        return taskscheduler.install(interval)
    return systemd.install(interval)


def uninstall() -> int:
    tag = config_mod.detect_platform_tag()
    if tag == "windows":
        return taskscheduler.uninstall()
    return systemd.uninstall()
