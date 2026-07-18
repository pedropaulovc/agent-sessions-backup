import pytest

from agent_sessions_client.config import AuthMode, ClientConfig, load_config


def test_bearer_mode_from_explicit_args():
    config = load_config(bearer_token="tok123", dev_machine="ci-preview", hub_url="https://preview.example")
    assert config.auth_mode is AuthMode.BEARER
    assert config.bearer_token == "tok123"
    assert config.dev_machine == "ci-preview"
    assert config.hub_url == "https://preview.example"


def test_bearer_mode_from_env(monkeypatch):
    monkeypatch.setenv("AGENT_SESSIONS_BEARER_TOKEN", "env-tok")
    monkeypatch.setenv("AGENT_SESSIONS_DEV_MACHINE", "env-machine")
    config = load_config()
    assert config.auth_mode is AuthMode.BEARER
    assert config.bearer_token == "env-tok"
    assert config.dev_machine == "env-machine"
    assert config.hub_url == "https://api.sessions.vza.net"  # default, unset


def test_mtls_reads_collector_config_toml(tmp_path):
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        'hub_url = "https://api.sessions.vza.net"\n'
        'client_cert_path = "/home/pedro/.config/agent-collector/amet-wsl.client.pem"\n'
        'client_key_path = "/home/pedro/.config/agent-collector/amet-wsl.client.key"\n'
    )
    config = load_config(config_path=config_path)
    assert config.auth_mode is AuthMode.MTLS
    assert str(config.client_cert_path) == "/home/pedro/.config/agent-collector/amet-wsl.client.pem"
    assert str(config.client_key_path) == "/home/pedro/.config/agent-collector/amet-wsl.client.key"


def test_explicit_args_win_over_config_file(tmp_path):
    config_path = tmp_path / "config.toml"
    config_path.write_text('client_cert_path = "/from/config.pem"\nclient_key_path = "/from/config.key"\n')
    config = load_config(config_path=config_path, client_cert_path="/from/arg.pem", client_key_path="/from/arg.key")
    assert str(config.client_cert_path) == "/from/arg.pem"
    assert str(config.client_key_path) == "/from/arg.key"


def test_missing_cert_and_bearer_raises(tmp_path):
    with pytest.raises(ValueError, match="no mTLS client cert/key found"):
        load_config(config_path=tmp_path / "does-not-exist.toml")


def test_bearer_wins_over_mtls_config_when_both_present(tmp_path):
    config_path = tmp_path / "config.toml"
    config_path.write_text('client_cert_path = "/from/config.pem"\nclient_key_path = "/from/config.key"\n')
    config = load_config(config_path=config_path, bearer_token="tok", dev_machine="m1")
    assert config.auth_mode is AuthMode.BEARER


def test_bearer_mode_still_uses_configured_hub_url_from_file(tmp_path):
    # Bearer mode used to return before ever reading config_path, so a non-default hub_url
    # configured there (e.g. pointing local/preview runs away from production) was silently
    # ignored — bearer credentials would target DEFAULT_HUB_URL instead.
    config_path = tmp_path / "config.toml"
    config_path.write_text('hub_url = "https://preview-from-file.example"\n')
    config = load_config(config_path=config_path, bearer_token="tok", dev_machine="m1")
    assert config.auth_mode is AuthMode.BEARER
    assert config.hub_url == "https://preview-from-file.example"


def test_malformed_hub_url_rejected():
    with pytest.raises(ValueError, match="invalid hub_url"):
        load_config(hub_url="not-a-url", bearer_token="tok", dev_machine="m")


def test_client_config_coerces_plain_string_auth_mode():
    # AuthMode subclasses str, so a caller (ClientConfig is exported) passing the plain string
    # "bearer" instead of AuthMode.BEARER must behave identically — not silently skip the `is
    # AuthMode.BEARER` checks in __post_init__ and HubClient, which would send an
    # unauthenticated request.
    config = ClientConfig(hub_url="https://x", auth_mode="bearer", bearer_token="tok", dev_machine="m")
    assert config.auth_mode is AuthMode.BEARER
    assert isinstance(config.auth_mode, AuthMode)

    mtls = ClientConfig(hub_url="https://x", auth_mode="mtls", client_cert_path="/c.pem", client_key_path="/c.key")
    assert mtls.auth_mode is AuthMode.MTLS


def test_client_config_rejects_invalid_auth_mode_string():
    with pytest.raises(ValueError):
        ClientConfig(hub_url="https://x", auth_mode="nonsense")
