from agent_sessions_client.cli import main
from conftest import make_session_row


def test_daily_report_end_to_end(hub, capsys):
    hub.sessions = [make_session_row("s1", started_at="2026-07-18T01:00:00.000Z", ended_at="2026-07-18T01:05:00.000Z")]
    hub.indexed_through = "2026-07-18T23:59:59.999Z"
    hub.status_machines = [
        {
            "machine_id": "amet-wsl",
            "os": "wsl",
            "last_seen_at": "2026-07-18T23:59:59.999Z",
            "last_upload_at": "2026-07-18T23:59:59.999Z",
            "files_pending": 0,
            "files_error": 0,
            "files_total": 1,
            "indexed_through": "2026-07-18T23:59:59.999Z",
        }
    ]
    hub.status_sessions = {"total": 1, "ready": 1, "error": 0}
    hub.usage_rows = [
        {
            "bucket": "claude-sonnet-5",
            "calls": 3,
            "input_tokens": 10,
            "output_tokens": 20,
            "reasoning_tokens": 0,
            "cache_read_tokens": 0,
            "cache_creation_5m_tokens": 0,
            "cache_creation_1h_tokens": 0,
        }
    ]

    rc = main(
        [
            "daily-report",
            "--date",
            "2026-07-18",
            "--hub-url",
            hub.url,
            "--bearer-token",
            "tok",
            "--dev-machine",
            "test-machine",
        ]
    )
    assert rc == 0
    out = capsys.readouterr().out
    assert "# Daily Activity Report — 2026-07-18" in out
    assert "amet-wsl" in out
    assert "claude-sonnet-5" in out


def test_daily_report_writes_to_out_file(hub, tmp_path):
    hub.sessions = []
    out_path = tmp_path / "report.md"
    rc = main(
        [
            "daily-report",
            "--date",
            "2026-07-18",
            "--hub-url",
            hub.url,
            "--bearer-token",
            "tok",
            "--dev-machine",
            "m",
            "--out",
            str(out_path),
        ]
    )
    assert rc == 0
    assert out_path.exists()
    assert "Daily Activity Report" in out_path.read_text()


def test_daily_report_missing_auth_returns_error(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("AGENT_SESSIONS_BEARER_TOKEN", raising=False)
    monkeypatch.delenv("AGENT_SESSIONS_DEV_MACHINE", raising=False)
    rc = main(["daily-report", "--config", str(tmp_path / "nope.toml")])
    assert rc == 2
    assert "error:" in capsys.readouterr().err


def test_daily_report_connection_failure_returns_error(capsys):
    rc = main(
        [
            "daily-report",
            "--hub-url",
            "http://127.0.0.1:1",
            "--bearer-token",
            "tok",
            "--dev-machine",
            "m",
        ]
    )
    assert rc == 1
    assert "error:" in capsys.readouterr().err


def test_daily_report_bad_mtls_cert_returns_error_not_traceback(tmp_path, capsys, monkeypatch):
    # A stale collector config pointing at a moved/rotated cert must produce the documented
    # `error: ...` + exit 2, not an unhandled FileNotFoundError/ssl.SSLError traceback.
    monkeypatch.delenv("AGENT_SESSIONS_BEARER_TOKEN", raising=False)
    monkeypatch.delenv("AGENT_SESSIONS_DEV_MACHINE", raising=False)
    rc = main(
        [
            "daily-report",
            "--hub-url",
            "https://example.invalid",
            "--client-cert",
            str(tmp_path / "nonexistent.pem"),
            "--client-key",
            str(tmp_path / "nonexistent.key"),
        ]
    )
    assert rc == 2
    assert "error:" in capsys.readouterr().err
