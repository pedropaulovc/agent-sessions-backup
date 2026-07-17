import re
import sys

from agent_collector import schedule
from agent_collector.schedule import taskscheduler


def _action_line(script: str) -> str:
    return next(l for l in script.splitlines() if "New-ScheduledTaskAction" in l)


def _parse_action(script: str):
    m = re.search(r"-Execute '([^']*)' -Argument '([^']*)'", _action_line(script))
    assert m, script
    return m.group(1), m.group(2)


def test_console_script_execute_and_argument_split(monkeypatch):
    monkeypatch.setattr(taskscheduler.shutil, "which", lambda _n: "C:/tools/agent-collector.exe")
    script = taskscheduler._install_script(15)
    execute, argument = _parse_action(script)
    assert execute == "C:/tools/agent-collector.exe"
    assert argument == "run --once"
    # arguments must NOT be folded into -Execute
    assert "run --once" not in execute


def test_module_fallback_execute_is_python_only(monkeypatch):
    monkeypatch.setattr(taskscheduler.shutil, "which", lambda _n: None)
    script = taskscheduler._install_script(15)
    execute, argument = _parse_action(script)
    assert execute == sys.executable
    assert "agent_collector.cli" not in execute      # module lives in -Argument
    assert argument == "-m agent_collector.cli run --once"


def test_randomdelay_on_trigger_not_settings(monkeypatch):
    monkeypatch.setattr(taskscheduler.shutil, "which", lambda _n: "agent-collector")
    script = taskscheduler._install_script(15)
    trigger = next(l for l in script.splitlines() if "New-ScheduledTaskTrigger" in l)
    settings = next(l for l in script.splitlines() if "New-ScheduledTaskSettingsSet" in l)
    assert "-RandomDelay" in trigger        # belongs on the trigger
    assert "-RandomDelay" not in settings   # would throw before Register-ScheduledTask
    assert "-StartWhenAvailable" in settings


def test_macos_install_fails_loudly(monkeypatch, capsys):
    monkeypatch.setattr("agent_collector.config.detect_platform_tag", lambda: "darwin")
    rc = schedule.install(15)
    assert rc != 0
    assert "launchd" in capsys.readouterr().err.lower()


def test_macos_uninstall_fails_loudly(monkeypatch, capsys):
    monkeypatch.setattr("agent_collector.config.detect_platform_tag", lambda: "darwin")
    rc = schedule.uninstall()
    assert rc != 0
    assert "launchd" in capsys.readouterr().err.lower()
