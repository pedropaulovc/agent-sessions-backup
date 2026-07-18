from agent_sessions_client.models import (
    HubStatus,
    MachineStatus,
    SessionMeta,
    SessionsPage,
    SessionsSummary,
    UsageReport,
    UsageRow,
)
from agent_sessions_client.report import build_daily_report
from conftest import make_session_row


def meta(**kwargs) -> SessionMeta:
    return SessionMeta.from_row(make_session_row(**kwargs))


def test_report_basic_shape():
    sessions_page = SessionsPage(
        sessions=[meta(session_id="s1", harness="claude-code", machine_id="amet-wsl")],
        indexed_through="2026-07-18T23:59:59.999Z",
        truncated=False,
    )
    usage_report = UsageReport(
        group_by="model",
        rows=[
            UsageRow(
                bucket="claude-sonnet-5",
                calls=10,
                input_tokens=100,
                output_tokens=200,
                reasoning_tokens=0,
                cache_read_tokens=0,
                cache_creation_5m_tokens=0,
                cache_creation_1h_tokens=0,
            )
        ],
    )
    status = HubStatus(
        machines=[
            MachineStatus(
                machine_id="amet-wsl",
                os="wsl",
                last_seen_at="2026-07-18T23:59:59.999Z",
                last_upload_at="2026-07-18T23:59:59.999Z",
                files_pending=0,
                files_error=0,
                files_total=1,
                indexed_through="2026-07-18T23:59:59.999Z",
            )
        ],
        sessions=SessionsSummary(total=1, ready=1, error=0),
    )
    report = build_daily_report(date="2026-07-18", sessions_page=sessions_page, usage_report=usage_report, status=status)
    assert "# Daily Activity Report — 2026-07-18" in report
    assert "amet-wsl" in report
    assert "claude-sonnet-5" in report
    assert "## Staleness caveats" not in report  # everything fully synced through end of day


def test_report_flags_stale_machine():
    sessions_page = SessionsPage(sessions=[meta(session_id="s1")], indexed_through="2026-07-18T09:00:00.000Z", truncated=False)
    status = HubStatus(
        machines=[
            MachineStatus(
                machine_id="amet-wsl",
                os="wsl",
                last_seen_at="2026-07-18T09:00:00.000Z",
                last_upload_at=None,
                files_pending=0,
                files_error=0,
                files_total=1,
                indexed_through="2026-07-18T09:00:00.000Z",  # well before end of day
            )
        ],
        sessions=SessionsSummary(total=1, ready=1, error=0),
    )
    report = build_daily_report(
        date="2026-07-18", sessions_page=sessions_page, usage_report=UsageReport(group_by="model", rows=[]), status=status
    )
    assert "## Staleness caveats" in report
    assert "amet-wsl" in report
    assert "may be an undercount" in report


def test_report_flags_truncation():
    sessions = [meta(session_id=f"s{i}") for i in range(3)]
    sessions_page = SessionsPage(sessions=sessions, indexed_through=None, truncated=True)
    status = HubStatus(machines=[], sessions=SessionsSummary(total=3, ready=3, error=0))
    report = build_daily_report(
        date="2026-07-18", sessions_page=sessions_page, usage_report=UsageReport(group_by="model", rows=[]), status=status
    )
    assert "no pagination cursor" in report


def test_report_empty_sessions():
    sessions_page = SessionsPage(sessions=[], indexed_through=None, truncated=False)
    status = HubStatus(machines=[], sessions=SessionsSummary(total=0, ready=0, error=0))
    report = build_daily_report(
        date="2026-07-18", sessions_page=sessions_page, usage_report=UsageReport(group_by="model", rows=[]), status=status
    )
    assert "No sessions in range." in report
    assert "No usage recorded in range." in report
    assert "## Notable sessions" not in report


def test_report_notable_sessions_sorted_by_size_and_duration():
    small = meta(session_id="small", block_count=1, started_at="2026-07-18T00:00:00.000Z", ended_at="2026-07-18T00:01:00.000Z")
    big = meta(session_id="big", block_count=500, started_at="2026-07-18T00:00:00.000Z", ended_at="2026-07-18T02:00:00.000Z")
    sessions_page = SessionsPage(sessions=[small, big], indexed_through=None, truncated=False)
    status = HubStatus(machines=[], sessions=SessionsSummary(total=2, ready=2, error=0))
    report = build_daily_report(
        date="2026-07-18", sessions_page=sessions_page, usage_report=UsageReport(group_by="model", rows=[]), status=status
    )
    largest_section = report.split("**Largest by block count:**")[1].split("**Longest by duration:**")[0]
    assert largest_section.index("`big`") < largest_section.index("`small`")
