import json
import time
from pathlib import Path

import pytest

from agent_sessions_client.config import AuthMode, ClientConfig, DEFAULT_HUB_URL, default_config_path, load_config
from agent_sessions_client.grant import DEFAULT_VIEWER_URL, save_grant


def test_grant_mode_from_explicit_args():
    config = load_config(grant_token="agsr_tok123", hub_url="https://hub.example")
    assert config.auth_mode is AuthMode.GRANT
    assert config.grant_token == "agsr_tok123"
    assert config.hub_url == "https://hub.example"


def test_grant_mode_from_env_ignores_discovered_machine_endpoint(monkeypatch):
    path = default_config_path()
    path.parent.mkdir(parents=True)
    path.write_text('hub_url = "https://machine.example"\n')
    monkeypatch.setenv("AGENT_SESSIONS_GRANT_TOKEN", "agsr_envtok")
    config = load_config()
    assert config.auth_mode is AuthMode.GRANT
    assert config.grant_token == "agsr_envtok"
    assert config.hub_url == DEFAULT_VIEWER_URL


def test_grant_mode_from_cache_file(tmp_path):
    cache = tmp_path / "grant.json"
    save_grant({
        "token": "agsr_cached", "expiresAt": (time.time() + 3600) * 1000,
        "viewerUrl": "https://custom-viewer.example",
    }, cache)
    config = load_config(grant_cache_path=cache)
    assert config.auth_mode is AuthMode.GRANT
    assert config.grant_token == "agsr_cached"
    assert config.hub_url == "https://custom-viewer.example"


def test_expired_cache_falls_through_to_mtls_config(tmp_path):
    cache = tmp_path / "grant.json"
    save_grant({
        "token": "agsr_stale", "expiresAt": (time.time() - 10) * 1000,
        "viewerUrl": "https://custom-viewer.example",
    }, cache)
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
    assert config.hub_url == DEFAULT_HUB_URL
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


def test_explicit_config_endpoint_applies_to_caller_supplied_grant(tmp_path):
    # Selecting a config path explicitly retains its generic endpoint override.
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


def test_cached_grant_ignores_discovered_collector_origin_and_cert(tmp_path):
    path = default_config_path()
    path.parent.mkdir(parents=True)
    machine_config = (
        'hub_url = "https://custom-machine.example"\n'
        'client_cert_path = "/machine/cert.pem"\nclient_key_path = "/machine/key.pem"\n'
    )
    path.write_text(machine_config)
    cache = tmp_path / "grant.json"
    save_grant({
        "token": "agsr_cached", "expiresAt": (time.time() + 3600) * 1000,
        "viewerUrl": "https://custom-viewer.example",
    }, cache)
    config = load_config(grant_cache_path=cache)
    assert config.auth_mode is AuthMode.GRANT
    assert config.hub_url == "https://custom-viewer.example"
    assert config.client_cert_path is None
    assert config.client_key_path is None
    assert path.read_text() == machine_config


def test_same_origin_explicit_endpoint_is_preserved_for_cached_grant(tmp_path):
    cache = tmp_path / "grant.json"
    save_grant({
        "token": "agsr_cached", "expiresAt": (time.time() + 3600) * 1000,
        "viewerUrl": "https://custom-viewer.example",
    }, cache)
    endpoint = "https://CUSTOM-VIEWER.example:443/prefix"
    config = load_config(hub_url=endpoint, grant_cache_path=cache)
    assert config.hub_url == endpoint
    assert config.grant_token == "agsr_cached"


@pytest.mark.parametrize("token_source", ["arg", "env"])
def test_caller_supplied_token_can_override_cache_origin(tmp_path, monkeypatch, token_source):
    cache = tmp_path / "grant.json"
    save_grant({
        "token": "agsr_cached", "expiresAt": (time.time() + 3600) * 1000,
        "viewerUrl": "https://custom-viewer.example",
    }, cache)
    kwargs = {}
    if token_source == "arg":
        kwargs["grant_token"] = "agsr_explicit"
    else:
        monkeypatch.setenv("AGENT_SESSIONS_GRANT_TOKEN", "agsr_explicit")
    config = load_config(hub_url="https://caller-selected.example", grant_cache_path=cache, **kwargs)
    assert config.grant_token == "agsr_explicit"
    assert config.hub_url == "https://caller-selected.example"


def test_originless_cache_requires_reauthentication(tmp_path):
    cache = tmp_path / "grant.json"
    old_cache = json.dumps({"token": "agsr_old", "expiresAt": (time.time() + 3600) * 1000})
    cache.write_text(old_cache)
    with pytest.raises(ValueError, match="agent-sessions auth"):
        load_config(config_path=tmp_path / "missing.toml", grant_cache_path=cache)
    assert cache.read_text() == old_cache


@pytest.mark.parametrize("selection", ["discovered", "env", "arg"])
def test_mtls_endpoint_precedence_is_unchanged(monkeypatch, selection):
    path = default_config_path()
    path.parent.mkdir(parents=True)
    machine_config = (
        'hub_url = "https://custom-machine.example"\n'
        'client_cert_path = "/machine/cert.pem"\nclient_key_path = "/machine/key.pem"\n'
    )
    path.write_text(machine_config)
    kwargs = {}
    expected_url = "https://custom-machine.example"
    if selection in ("env", "arg"):
        monkeypatch.setenv("AGENT_SESSIONS_HUB_URL", "https://env-machine.example")
        expected_url = "https://env-machine.example"
    if selection == "arg":
        kwargs["hub_url"] = "https://arg-machine.example"
        expected_url = "https://arg-machine.example"
    config = load_config(**kwargs)
    assert config.auth_mode is AuthMode.MTLS
    assert config.hub_url == expected_url
    assert config.client_cert_path == Path("/machine/cert.pem")
    assert config.client_key_path == Path("/machine/key.pem")
    assert path.read_text() == machine_config


@pytest.mark.parametrize("endpoint", [
    "http://custom-viewer.example", "https://custom-viewer.example:8443",
    "https://custom-viewer.example.attacker.example",
])
def test_cached_grant_requires_exact_origin_not_hostname_substring(tmp_path, endpoint):
    cache = tmp_path / "grant.json"
    save_grant({
        "token": "agsr_cached", "expiresAt": (time.time() + 3600) * 1000,
        "viewerUrl": "https://custom-viewer.example",
    }, cache)
    with pytest.raises(ValueError, match="cached read grant's viewer origin"):
        load_config(hub_url=endpoint, grant_cache_path=cache)
