import json
import time
from pathlib import Path

import pytest

from agent_sessions_client.config import AuthMode, ClientConfig, DEFAULT_HUB_URL, load_config


def test_grant_mode_from_explicit_args():
    config = load_config(grant_token="agsr_tok123", hub_url="https://hub.example")
    assert config.auth_mode is AuthMode.GRANT
    assert config.grant_token == "agsr_tok123"
    assert config.hub_url == "https://hub.example"


def test_grant_mode_from_env(monkeypatch):
    monkeypatch.setenv("AGENT_SESSIONS_GRANT_TOKEN", "agsr_envtok")
    config = load_config()
    assert config.auth_mode is AuthMode.GRANT
    assert config.grant_token == "agsr_envtok"
    assert config.hub_url == DEFAULT_HUB_URL  # default, unset


def test_grant_mode_from_cache_file(tmp_path):
    cache = tmp_path / "grant.json"
    cache.write_text(json.dumps({"token": "agsr_cached", "expiresAt": (time.time() + 3600) * 1000}))
    config = load_config(grant_cache_path=cache)
    assert config.auth_mode is AuthMode.GRANT
    assert config.grant_token == "agsr_cached"


def test_expired_cache_falls_through_to_mtls_config(tmp_path):
    cache = tmp_path / "grant.json"
    cache.write_text(json.dumps({"token": "agsr_stale", "expiresAt": (time.time() - 10) * 1000}))
    config_path = tmp_path / "config.toml"
    config_path.write_text('client_cert_path = "/from/config.pem"\nclient_key_path = "/from/config.key"\n')
    config = load_config(config_path=config_path, grant_cache_path=cache)
    assert config.auth_mode is AuthMode.MTLS


def test_mtls_reads_collector_config_toml(tmp_path):
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        f'hub_url = "{DEFAULT_HUB_URL}"\n'
        'client_cert_path = "/home/pedro/.config/agent-collector/amet-wsl.client.pem"\n'
        'client_key_path = "/home/pedro/.config/agent-collector/amet-wsl.client.key"\n'
    )
    config = load_config(config_path=config_path)
    assert config.auth_mode is AuthMode.MTLS
    assert config.client_cert_path == Path("/home/pedro/.config/agent-collector/amet-wsl.client.pem")
    assert config.client_key_path == Path("/home/pedro/.config/agent-collector/amet-wsl.client.key")


def test_explicit_args_win_over_config_file(tmp_path):
    config_path = tmp_path / "config.toml"
    config_path.write_text('client_cert_path = "/from/config.pem"\nclient_key_path = "/from/config.key"\n')
    config = load_config(config_path=config_path, client_cert_path="/from/arg.pem", client_key_path="/from/arg.key")
    assert config.client_cert_path == Path("/from/arg.pem")
    assert config.client_key_path == Path("/from/arg.key")


def test_missing_grant_and_cert_raises(tmp_path):
    with pytest.raises(ValueError, match="agent-sessions auth"):
        load_config(config_path=tmp_path / "does-not-exist.toml")


def test_grant_wins_over_mtls_config_when_both_present(tmp_path):
    # The grant is the intended read credential; the cert read path is transitional and
    # goes away entirely once machine certs become ingest-only.
    config_path = tmp_path / "config.toml"
    config_path.write_text('client_cert_path = "/from/config.pem"\nclient_key_path = "/from/config.key"\n')
    config = load_config(config_path=config_path, grant_token="agsr_tok")
    assert config.auth_mode is AuthMode.GRANT


def test_grant_mode_still_uses_configured_hub_url_from_file(tmp_path):
    # Both modes resolve hub_url with the same arg > env > file > default precedence, so a
    # non-default hub_url configured in config.toml applies to grant mode too.
    config_path = tmp_path / "config.toml"
    config_path.write_text('hub_url = "https://hub-from-file.example"\n')
    config = load_config(config_path=config_path, grant_token="agsr_tok")
    assert config.auth_mode is AuthMode.GRANT
    assert config.hub_url == "https://hub-from-file.example"


def test_malformed_hub_url_rejected():
    with pytest.raises(ValueError, match="invalid hub_url"):
        load_config(hub_url="not-a-url", grant_token="agsr_tok")


def test_client_config_coerces_plain_string_auth_mode():
    # AuthMode subclasses str, so a caller (ClientConfig is exported) passing the plain string
    # "grant" instead of AuthMode.GRANT must behave identically — not silently skip the `is
    # AuthMode.GRANT` checks in __post_init__ and HubClient, which would send an
    # unauthenticated request.
    config = ClientConfig(hub_url="https://x", auth_mode="grant", grant_token="agsr_tok")
    assert config.auth_mode is AuthMode.GRANT
    assert isinstance(config.auth_mode, AuthMode)

    mtls = ClientConfig(hub_url="https://x", auth_mode="mtls", client_cert_path="/c.pem", client_key_path="/c.key")
    assert mtls.auth_mode is AuthMode.MTLS


def test_client_config_rejects_invalid_auth_mode_string():
    with pytest.raises(ValueError):
        ClientConfig(hub_url="https://x", auth_mode="nonsense")
