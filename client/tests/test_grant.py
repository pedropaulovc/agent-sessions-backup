import json
import threading
import time
import urllib.parse
import urllib.request

import pytest

from agent_sessions_client.grant import (
    GrantError,
    load_cached_token,
    mint_grant,
    parse_ttl,
    save_grant,
)


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
    grant = mint_grant(
        hub_url=hub.url,
        viewer_url="https://viewer.example",
        label="test agent",
        ttl_seconds=3600,
        open_url=_approving_browser("code=abc123"),
        timeout=10,
    )
    assert grant["token"].startswith("agsr_")
    [exchange] = hub.exchange_requests
    assert exchange["code"] == "abc123"
    # The verifier is 32 random bytes base64url-encoded (43 chars) and never left this
    # process before the exchange.
    assert len(exchange["codeVerifier"]) == 43


def test_mint_grant_denied(hub):
    with pytest.raises(GrantError, match="denied"):
        mint_grant(hub_url=hub.url, open_url=_approving_browser("error=denied"), timeout=10)
    assert hub.exchange_requests == []


def test_mint_grant_timeout_without_approval():
    with pytest.raises(GrantError, match="timed out"):
        mint_grant(hub_url="http://127.0.0.1:1", open_url=lambda url: None, timeout=1.5)


def test_mint_grant_surfaces_exchange_rejection(hub):
    hub.exchange_response = {"status": 400, "body": {"error": "bad_code"}}
    with pytest.raises(GrantError, match="bad_code"):
        mint_grant(hub_url=hub.url, open_url=_approving_browser("code=abc"), timeout=10)


def test_cache_round_trip(tmp_path):
    path = tmp_path / "grant.json"
    save_grant({"token": "agsr_x", "expiresAt": (time.time() + 3600) * 1000, "label": "l"}, path)
    assert load_cached_token(path) == "agsr_x"


def test_cache_rejects_expiring_and_corrupt(tmp_path):
    soon = tmp_path / "soon.json"
    # 30s left is inside the 60s safety margin — a token about to die mid-request is useless.
    save_grant({"token": "agsr_x", "expiresAt": (time.time() + 30) * 1000}, soon)
    assert load_cached_token(soon) is None

    corrupt = tmp_path / "corrupt.json"
    corrupt.write_text("{not json")
    assert load_cached_token(corrupt) is None
    assert load_cached_token(tmp_path / "missing.json") is None

    wrong_shape = tmp_path / "wrong.json"
    wrong_shape.write_text(json.dumps({"token": 42, "expiresAt": "later"}))
    assert load_cached_token(wrong_shape) is None


def test_auth_cli_end_to_end(hub, tmp_path, capsys, monkeypatch):
    from agent_sessions_client import cli

    monkeypatch.setattr(cli.webbrowser, "open", _approving_browser("code=abc123"))
    cache = tmp_path / "grant.json"
    rc = cli.main([
        "auth", "--hub-url", hub.url, "--grant-cache", str(cache),
        "--ttl", "1h", "--print-token", "--timeout", "10",
    ])
    assert rc == 0
    captured = capsys.readouterr()
    assert captured.out.strip().startswith("agsr_")  # --print-token: stdout is the raw token
    assert "read grant saved to" in captured.err
    assert load_cached_token(cache) is not None


def test_auth_cli_rejects_bad_ttl(capsys):
    from agent_sessions_client import cli

    rc = cli.main(["auth", "--ttl", "9d"])
    assert rc == 2
    assert "error:" in capsys.readouterr().err
