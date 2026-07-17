import re
import sys

from agent_collector import schedule
from agent_collector.schedule import systemd, taskscheduler


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


def test_apostrophe_in_path_doubled_in_ps_literal(monkeypatch):
    monkeypatch.setattr(taskscheduler.shutil, "which",
                        lambda _n: r"C:\Users\O'Neil\agent-collector.exe")
    script = taskscheduler._install_script(15)
    # single-quoted PS literal: an apostrophe must be doubled ('') or the string terminates early
    assert r"C:\Users\O''Neil\agent-collector.exe" in script
    assert r"C:\Users\O'Neil\agent-collector.exe" not in script  # un-doubled form must be gone


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


def test_systemd_execstart_quotes_spaced_path(monkeypatch):
    monkeypatch.setattr(systemd.shutil, "which", lambda _n: "/opt/my tools/agent-collector")
    unit = systemd._service_unit()
    assert 'ExecStart="/opt/my tools/agent-collector" run --once' in unit


def test_systemd_execstart_module_fallback_quotes_python(monkeypatch):
    monkeypatch.setattr(systemd.shutil, "which", lambda _n: None)
    monkeypatch.setattr(systemd.sys, "executable", "/py path/python")
    unit = systemd._service_unit()
    assert 'ExecStart="/py path/python" -m agent_collector.cli run --once' in unit


def test_systemd_timer_uses_elapsed_timers_for_any_interval():
    unit = systemd._timer_unit(45)  # 45 doesn't divide 60; OnCalendar=*:0/45 would misbehave
    assert "OnBootSec=45min" in unit
    assert "OnUnitActiveSec=45min" in unit
    assert "OnCalendar" not in unit
    assert "RandomizedDelaySec=300" in unit and "Persistent=true" in unit


def test_systemd_install_fails_when_activation_fails(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(systemd, "UNIT_DIR", tmp_path)
    monkeypatch.setattr(systemd, "SERVICE", tmp_path / "agent-collector.service")
    monkeypatch.setattr(systemd, "TIMER", tmp_path / "agent-collector.timer")
    monkeypatch.setattr(systemd, "_systemctl", lambda *a: False)
    rc = systemd.install(15)
    assert rc == 1
    assert "systemctl --user" in capsys.readouterr().err
    assert (tmp_path / "agent-collector.timer").exists()  # unit files still written
