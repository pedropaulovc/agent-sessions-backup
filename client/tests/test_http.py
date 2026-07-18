import ssl

import pytest

from agent_sessions_client.config import AuthMode, ClientConfig
from agent_sessions_client.http import HubClient, HubError


def bearer_config(url: str) -> ClientConfig:
    return ClientConfig(hub_url=url, auth_mode=AuthMode.BEARER, bearer_token="tok", dev_machine="test-machine")


def test_get_json_and_headers(hub):
    hub.status_machines = [{"machine_id": "m1", "os": "linux"}]
    client = HubClient(bearer_config(hub.url))
    resp = client.get("/api/v1/status")
    assert resp.status == 200
    body = resp.json()
    assert body["machines"] == [{"machine_id": "m1", "os": "linux"}]


def test_bearer_and_dev_machine_headers_sent(hub):
    client = HubClient(bearer_config(hub.url))
    client.get("/api/v1/status").json()
    assert len(hub.requests) == 1
    headers = hub.requests[0]["headers"]
    assert headers["Authorization"] == "Bearer tok"
    assert headers["X-Dev-Machine"] == "test-machine"


def test_query_params_encoded_and_none_values_dropped(hub):
    client = HubClient(bearer_config(hub.url))
    client.get("/api/v1/sessions", {"from": "2026-07-18", "harness": None, "limit": 5}).json()
    params = hub.requests[0]["params"]
    assert params == {"from": ["2026-07-18"], "limit": ["5"]}


def test_response_header_case_insensitive_lookup(hub):
    hub.indexed_through = "2026-07-18T00:00:00.000Z"
    client = HubClient(bearer_config(hub.url))
    resp = client.get("/api/v1/sessions")
    resp.json()
    # re-request since json() closes the connection; header() must be checked before draining the body
    resp2 = client.get("/api/v1/sessions")
    assert resp2.header("X-Indexed-Through") == "2026-07-18T00:00:00.000Z"
    resp2.close()


def test_404_raises_hub_error_with_body(hub):
    client = HubClient(bearer_config(hub.url))
    with pytest.raises(HubError) as exc_info:
        client.get("/api/v1/sessions/nonexistent").json()
    assert exc_info.value.status == 404
    assert "not_found" in exc_info.value.body


def test_connection_refused_raises_hub_error_with_none_status():
    client = HubClient(bearer_config("http://127.0.0.1:1"))  # port 1 refuses
    with pytest.raises(HubError) as exc_info:
        client.get("/api/v1/status")
    assert exc_info.value.status is None


def test_mtls_config_builds_ssl_context_with_configured_paths(tmp_path, monkeypatch):
    cert = tmp_path / "client.pem"
    key = tmp_path / "client.key"
    cert.write_text("not-a-real-cert")
    key.write_text("not-a-real-key")

    calls = []
    original_load_cert_chain = ssl.SSLContext.load_cert_chain

    def fake_load_cert_chain(self, certfile=None, keyfile=None, **kwargs):
        calls.append((certfile, keyfile))
        # Don't actually call the real implementation — these aren't valid PEM files.

    monkeypatch.setattr(ssl.SSLContext, "load_cert_chain", fake_load_cert_chain)
    config = ClientConfig(hub_url="https://example", auth_mode=AuthMode.MTLS, client_cert_path=cert, client_key_path=key)
    HubClient(config)

    assert calls == [(str(cert), str(key))]
    monkeypatch.setattr(ssl.SSLContext, "load_cert_chain", original_load_cert_chain)
