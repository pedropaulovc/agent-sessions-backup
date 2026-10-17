import base64
import hashlib
import json
import threading
import time
import urllib.parse
import urllib.request

import pytest

from fake_hub import FakeHub

from agent_sessions_client.config import default_config_path, load_config
from agent_sessions_client.grant import (
    DEFAULT_VIEWER_URL,
    GrantError,
    default_grant_cache_path,
    load_cached_grant,
    mint_grant,
    parse_ttl,
    save_grant,
)
from agent_sessions_client.http import HubClient


def test_parse_ttl_units_and_bounds():
    assert parse_ttl("4h") == 14_400
    assert parse_ttl("30m") == 1_800
    assert parse_ttl("900") == 900
    assert parse_ttl("900s") == 900
    for bad in ("", "1d", "4h30m", "abc", "-1h"):
        with pytest.raises(ValueError, match="invalid ttl"):
            parse_ttl(bad)
    for out_of_range in ("1m", "25h", "0"):
        with pytest.raises(ValueError, match="between"):
            parse_ttl(out_of_range)


def _approving_browser(result_query: str):
    """open_url stand-in: do what the /grant page's finish() does — hit the loopback
    callback with the given query — from a browser-like separate thread."""

    def open_url(url: str) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        assert query["challenge"][0]  # PKCE challenge forwarded to the page
        assert query["ttl"][0]
        callback = query["callback"][0]
        threading.Thread(
            target=lambda: urllib.request.urlopen(f"{callback}?{result_query}", timeout=5).read(),
            daemon=True,
        ).start()

    return open_url


def test_mint_grant_end_to_end(hub):
    opened = []

    def approve(url):
        opened.append(url)
        _approving_browser("code=abc123")(url)

    # Untrusted response metadata must not change the cached credential's destination.
    hub.exchange_response = {"status": 200, "body": {
        "token": "agsr_minted", "expiresAt": (time.time() + 3600) * 1000,
        "viewerUrl": "https://untrusted-response.example",
    }}
    grant = mint_grant(
        viewer_url=f"{hub.url}/",
        label="test agent",
        ttl_seconds=3600,
        open_url=approve,
        timeout=10,
    )
    assert grant["token"] == "agsr_minted"
    assert grant["viewerUrl"] == hub.url
    [approval_url] = opened
    approval = urllib.parse.urlsplit(approval_url)
    assert f"{approval.scheme}://{approval.netloc}" == hub.url
    assert approval.path == "/grant"
    query = urllib.parse.parse_qs(approval.query)
    assert query["label"] == ["test agent"]
    assert query["ttl"] == ["3600"]
    assert "codeVerifier" not in query
    [exchange] = hub.exchange_requests
    assert exchange["code"] == "abc123"
    verifier = exchange["codeVerifier"]
    assert len(verifier) == 43
    expected_challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode().rstrip("=")
    assert query["challenge"] == [expected_challenge]
    [request] = hub.requests
    headers = {key.lower(): value for key, value in request["headers"].items()}
    assert "authorization" not in headers
    assert "cookie" not in headers


def test_mint_grant_denied(hub):
    with pytest.raises(GrantError, match="denied"):
        mint_grant(viewer_url=hub.url, open_url=_approving_browser("error=denied"), timeout=10)
    assert hub.exchange_requests == []


def test_mint_grant_timeout_without_approval():
    with pytest.raises(GrantError, match="timed out"):
        mint_grant(viewer_url="http://127.0.0.1:1", open_url=lambda url: None, timeout=1.5)


def test_mint_grant_surfaces_exchange_rejection(hub):
    hub.exchange_response = {"status": 400, "body": {"error": "bad_code"}}
    with pytest.raises(GrantError, match="bad_code"):
        mint_grant(viewer_url=hub.url, open_url=_approving_browser("code=abc"), timeout=10)


def test_cache_round_trip(tmp_path):
    path = tmp_path / "grant.json"
    save_grant({
        "token": "agsr_x", "expiresAt": (time.time() + 3600) * 1000, "label": "l",
        "viewerUrl": "https://CUSTOM-viewer.example:443/",
    }, path)
    cached = load_cached_grant(path)
    assert cached["token"] == "agsr_x"
    assert cached["label"] == "l"
    assert cached["viewerUrl"] == "https://custom-viewer.example"


def test_cache_rejects_expiring_and_corrupt(tmp_path):
    soon = tmp_path / "soon.json"
    # 30s left is inside the 60s safety margin — a token about to die mid-request is useless.
    save_grant({
        "token": "agsr_x", "expiresAt": (time.time() + 30) * 1000,
        "viewerUrl": DEFAULT_VIEWER_URL,
    }, soon)
    assert load_cached_grant(soon) is None

    corrupt = tmp_path / "corrupt.json"
    corrupt.write_text("{not json")
    assert load_cached_grant(corrupt) is None
    assert load_cached_grant(tmp_path / "missing.json") is None

    wrong_shape = tmp_path / "wrong.json"
    wrong_shape.write_text(json.dumps({"token": 42, "expiresAt": "later", "viewerUrl": DEFAULT_VIEWER_URL}))
    assert load_cached_grant(wrong_shape) is None


def test_auth_cli_cache_then_read_stays_on_viewer_origin(hub, capsys, monkeypatch):
    from agent_sessions_client import cli

    monkeypatch.setattr(cli.webbrowser, "open", _approving_browser("code=abc123"))
    cache = default_grant_cache_path()
    with FakeHub() as machine:
        config_path = default_config_path()
        config_path.parent.mkdir(parents=True)
        machine_config = (
            f'hub_url = "{machine.url}"\n'
            'client_cert_path = "/machine/cert.pem"\nclient_key_path = "/machine/key.pem"\n'
        )
        config_path.write_text(machine_config)
        rc = cli.main([
            "auth", "--viewer-url", hub.url, "--grant-cache", str(cache),
            "--ttl", "1h", "--print-token", "--timeout", "10",
        ])
        assert rc == 0
        captured = capsys.readouterr()
        token = captured.out.strip()
        assert token.startswith("agsr_")
        assert token not in captured.err
        assert "read grant saved to" in captured.err
        assert load_cached_grant(cache)["viewerUrl"] == hub.url
        config = load_config()
        assert config.hub_url == hub.url
        assert HubClient(config).get("/api/v1/status").json()["sessions"]["total"] == 0
        assert machine.requests == []
        assert config_path.read_text() == machine_config
    read_request = hub.requests[-1]
    assert read_request["path"] == "/api/v1/status"
    headers = {key.lower(): value for key, value in read_request["headers"].items()}
    assert headers["authorization"] == f"Bearer {token}"


def test_auth_cli_cache_write_failure_is_a_clean_error(hub, tmp_path, capsys, monkeypatch):
    # The grant was minted (owner already approved) but caching failed — documented
    # `error: ...` + exit 1, never a traceback.
    from agent_sessions_client import cli

    monkeypatch.setattr(cli.webbrowser, "open", _approving_browser("code=abc123"))

    def failing_save(grant, cache_path=None):
        raise OSError("disk full")

    monkeypatch.setattr(cli, "save_grant", failing_save)
    rc = cli.main(["auth", "--viewer-url", hub.url, "--ttl", "1h", "--timeout", "10"])
    assert rc == 1
    assert "failed to save read grant" in capsys.readouterr().err


def test_save_grant_leaves_no_temp_file_behind(tmp_path):
    path = tmp_path / "grant.json"
    save_grant({
        "token": "agsr_x", "expiresAt": (time.time() + 3600) * 1000,
        "viewerUrl": DEFAULT_VIEWER_URL,
    }, path)
    assert load_cached_grant(path)["token"] == "agsr_x"
    assert [p.name for p in tmp_path.iterdir()] == ["grant.json"]


def test_auth_cli_rejects_bad_ttl(capsys):
    from agent_sessions_client import cli

    rc = cli.main(["auth", "--ttl", "9d"])
    assert rc == 2
    assert "error:" in capsys.readouterr().err


@pytest.mark.parametrize("selection", ["arg", "env", "config"])
def test_cached_grant_origin_conflict_fails_before_http(hub, tmp_path, capsys, monkeypatch, selection):
    from agent_sessions_client import cli

    token = "agsr_cached_secret"
    save_grant({
        "token": token, "expiresAt": (time.time() + 3600) * 1000,
        "viewerUrl": hub.url,
    })
    with FakeHub() as other:
        args = ["daily-report", "--date", "2026-10-17"]
        if selection == "arg":
            args.extend(["--hub-url", other.url])
        elif selection == "env":
            monkeypatch.setenv("AGENT_SESSIONS_HUB_URL", other.url)
        else:
            config_path = tmp_path / "explicit.toml"
            config_path.write_text(f'hub_url = "{other.url}"\n')
            args.extend(["--config", str(config_path)])
        assert cli.main(args) == 2
        captured = capsys.readouterr()
        assert "cached read grant's viewer origin" in captured.err
        assert "agent-sessions auth" in captured.err
        assert token not in captured.out + captured.err
        assert hub.requests == []
        assert other.requests == []


@pytest.mark.parametrize("viewer_url", [
    None, "", "not-a-url", "https://viewer.example/path",
    "https://viewer.example?next=elsewhere", "https://user:secret@viewer.example",
])
def test_cache_rejects_missing_or_invalid_origin(tmp_path, viewer_url):
    path = tmp_path / "grant.json"
    payload = {"token": "agsr_x", "expiresAt": (time.time() + 3600) * 1000}
    if viewer_url is not None:
        payload["viewerUrl"] = viewer_url
    path.write_text(json.dumps(payload))
    assert load_cached_grant(path) is None


def test_auth_cli_exchange_failure_does_not_replace_cache(hub, tmp_path, capsys, monkeypatch):
    from agent_sessions_client import cli

    cache = tmp_path / "grant.json"
    old_cache = '{"token":"previous-cache-must-remain"}'
    cache.write_text(old_cache)
    monkeypatch.setattr(cli.webbrowser, "open", _approving_browser("code=abc123"))
    hub.exchange_response = {"status": 403, "body": {"error": "grant_rejected"}}
    assert cli.main([
        "auth", "--viewer-url", hub.url, "--grant-cache", str(cache), "--timeout", "10",
    ]) == 1
    captured = capsys.readouterr()
    assert "status=403" in captured.err
    assert "grant_rejected" in captured.err
    assert not captured.out
    assert cache.read_text() == old_cache
