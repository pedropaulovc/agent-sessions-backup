import json
import types

import pytest

from agent_collector import config, run as run_mod
from agent_collector.state import State
from agent_collector.transport import Transport
from agent_collector.webcapture import PRODUCTS, cmd_webcapture
from agent_collector.webcapture.cdp import FakeCdpTransport
from agent_collector.webcapture.chatgpt import capture_chatgpt
from agent_collector.webcapture.claude import capture_claude

CGPT = "https://chatgpt.com"
CLAUDE = "https://claude.ai"


def _conv_json(cid):
    return json.dumps({"conversation_id": cid, "mapping": {}, "current_node": None})


def _chatgpt_transport(update_time="2026-07-01T10:00:00Z"):
    return FakeCdpTransport({
        f"{CGPT}/api/auth/session": (200, json.dumps({"user": {"id": "u"}})),
        f"{CGPT}/backend-api/conversations": (200, json.dumps({
            "items": [{"id": "c1", "update_time": update_time}, {"id": "c2", "update_time": update_time}],
            "total": 2,
        })),
        f"{CGPT}/backend-api/conversation/c1": (200, _conv_json("c1")),
        f"{CGPT}/backend-api/conversation/c2": (200, _conv_json("c2")),
    })


def test_chatgpt_captures_changed_conversations_and_sets_watermarks(tmp_path):
    staging = tmp_path / "chatgpt-web"
    events: list[dict] = []
    with State(tmp_path / "state.db") as st:
        res = capture_chatgpt(_chatgpt_transport(), st, staging, events)
        assert res.logged_in and res.checked == 2 and res.changed == 2 and res.captured == 2
        assert (staging / "c1.json").exists() and (staging / "c2.json").exists()
        assert st.get_webcapture_watermark("chatgpt", "c1") == "2026-07-01T10:00:00Z"

        # Second pass, nothing changed -> no re-capture.
        res2 = capture_chatgpt(_chatgpt_transport(), st, staging, events)
        assert res2.changed == 0 and res2.captured == 0

        # A newer update_time re-captures.
        res3 = capture_chatgpt(_chatgpt_transport("2026-07-02T12:00:00Z"), st, staging, events)
        assert res3.changed == 2 and res3.captured == 2
    assert events == []


def test_chatgpt_signed_out_emits_login_event(tmp_path):
    transport = FakeCdpTransport({f"{CGPT}/api/auth/session": (200, "{}")})
    events: list[dict] = []
    with State(tmp_path / "state.db") as st:
        res = capture_chatgpt(transport, st, tmp_path / "chatgpt-web", events)
    assert res.logged_in is False and res.captured == 0
    assert any(e["code"] == "webcapture_login_expired" for e in events)
    # It never went on to list/fetch conversations.
    assert transport.calls == [f"{CGPT}/api/auth/session"]


def test_chatgpt_fetch_failure_is_counted_not_fatal(tmp_path):
    transport = FakeCdpTransport({
        f"{CGPT}/api/auth/session": (200, json.dumps({"user": {"id": "u"}})),
        f"{CGPT}/backend-api/conversations": (200, json.dumps({"items": [{"id": "c1", "update_time": "t"}], "total": 1})),
        f"{CGPT}/backend-api/conversation/c1": (500, ""),
    })
    events: list[dict] = []
    with State(tmp_path / "state.db") as st:
        res = capture_chatgpt(transport, st, tmp_path / "chatgpt-web", events)
        assert res.errors == 1 and res.captured == 0
        assert st.get_webcapture_watermark("chatgpt", "c1") is None  # not marked captured
    assert any(e["code"] == "webcapture_fetch_failed" for e in events)


def _claude_transport():
    return FakeCdpTransport({
        f"{CLAUDE}/api/organizations": (200, json.dumps([{"uuid": "org1", "capabilities": ["chat"]}])),
        f"{CLAUDE}/api/organizations/org1/chat_conversations": (200, json.dumps([{"uuid": "k1", "updated_at": "2026-07-01T10:00:00Z"}])),
        f"{CLAUDE}/api/organizations/org1/chat_conversations/k1?tree=True&rendering_mode=raw": (200, json.dumps({"uuid": "k1", "chat_messages": []})),
    })


def test_claude_resolves_org_and_captures_with_tree(tmp_path):
    staging = tmp_path / "claude-web"
    events: list[dict] = []
    with State(tmp_path / "state.db") as st:
        res = capture_claude(_claude_transport(), st, staging, events)
        assert res.logged_in and res.checked == 1 and res.captured == 1
        assert (staging / "k1.json").exists()
        assert st.get_webcapture_watermark("claude", "k1") == "2026-07-01T10:00:00Z"
    # The tree/raw query params were actually requested.
    assert any("tree=True&rendering_mode=raw" in u for u in _claude_transport().responses)
    assert events == []


def test_claude_signed_out_emits_login_event(tmp_path):
    transport = FakeCdpTransport({f"{CLAUDE}/api/organizations": (401, "")})
    events: list[dict] = []
    with State(tmp_path / "state.db") as st:
        res = capture_claude(transport, st, tmp_path / "claude-web", events)
    assert res.logged_in is False
    assert any(e["code"] == "webcapture_login_expired" for e in events)


def test_cmd_webcapture_registers_stores_writes_files_and_buffers_events(tmp_env):
    path = config.config_path()
    config.enroll("http://localhost:8787", dev=True, path=path, machine_id="webhost")

    def factory(origin):
        return _chatgpt_transport() if origin == PRODUCTS["chatgpt"][0] else _claude_transport()

    args = types.SimpleNamespace(config=str(path), product=None, host="127.0.0.1", port=9222)
    rc = cmd_webcapture(args, transport_factory=factory)
    assert rc == 0

    # Staging stores are now registered in the config so the next `run` uploads them.
    reloaded = config.load(path)
    for store in ("chatgpt-web", "claude-web", "export-inbox"):
        assert store in reloaded.stores

    base = config.webcapture_dir()
    assert (base / "chatgpt-web" / "c1.json").exists()
    assert (base / "claude-web" / "k1.json").exists()


def test_cmd_webcapture_signed_out_returns_nonzero_and_buffers_event(tmp_env):
    path = config.config_path()
    config.enroll("http://localhost:8787", dev=True, path=path, machine_id="webhost")

    def factory(origin):
        return FakeCdpTransport({f"{CGPT}/api/auth/session": (200, "{}"), f"{CLAUDE}/api/organizations": (401, "")})

    args = types.SimpleNamespace(config=str(path), product=None, host="127.0.0.1", port=9222)
    rc = cmd_webcapture(args, transport_factory=factory)
    assert rc == 1  # a signed-out product makes the hand-run exit nonzero
    with State() as st:
        assert st.pending_event_count() >= 1  # login-expiry events buffered for the next heartbeat


def test_chatgpt_list_html_interstitial_is_an_error_not_a_crash(tmp_path):
    # Fix 4: a 200 non-JSON list body must become a capture error, not an unhandled json.loads.
    transport = FakeCdpTransport({
        f"{CGPT}/api/auth/session": (200, json.dumps({"user": {"id": "u"}})),
        f"{CGPT}/backend-api/conversations": (200, "<html>sign in</html>"),
    })
    events: list[dict] = []
    with State(tmp_path / "state.db") as st:
        res = capture_chatgpt(transport, st, tmp_path / "chatgpt-web", events)
    assert res.errors == 1 and res.captured == 0
    assert any(e["code"] == "webcapture_list_failed" for e in events)


def test_chatgpt_conversation_html_interstitial_does_not_stage_or_advance_watermark(tmp_path):
    # Fix 5: a 200 HTML conversation body must not be staged, and the watermark must not advance
    # (or the bad conversation is never re-fetched until it changes again).
    transport = FakeCdpTransport({
        f"{CGPT}/api/auth/session": (200, json.dumps({"user": {"id": "u"}})),
        f"{CGPT}/backend-api/conversations": (200, json.dumps({"items": [{"id": "c1", "update_time": "t"}], "total": 1})),
        f"{CGPT}/backend-api/conversation/c1": (200, "<html>sign in</html>"),
    })
    events: list[dict] = []
    staging = tmp_path / "chatgpt-web"
    with State(tmp_path / "state.db") as st:
        res = capture_chatgpt(transport, st, staging, events)
        assert res.captured == 0 and res.errors == 1
        assert not (staging / "c1.json").exists()
        assert st.get_webcapture_watermark("chatgpt", "c1") is None
    assert any(e["code"] == "webcapture_fetch_failed" for e in events)


def test_claude_list_and_conversation_html_are_errors(tmp_path):
    # Fix 4/5 for the Claude path: list HTML -> list_failed; conversation HTML -> no watermark.
    list_html = FakeCdpTransport({
        f"{CLAUDE}/api/organizations": (200, json.dumps([{"uuid": "org1", "capabilities": ["chat"]}])),
        f"{CLAUDE}/api/organizations/org1/chat_conversations": (200, "<html/>"),
    })
    events: list[dict] = []
    with State(tmp_path / "state.db") as st:
        res = capture_claude(list_html, st, tmp_path / "claude-web", events)
    assert res.errors == 1 and any(e["code"] == "webcapture_list_failed" for e in events)

    conv_html = FakeCdpTransport({
        f"{CLAUDE}/api/organizations": (200, json.dumps([{"uuid": "org1", "capabilities": ["chat"]}])),
        f"{CLAUDE}/api/organizations/org1/chat_conversations": (200, json.dumps([{"uuid": "k1", "updated_at": "t"}])),
        f"{CLAUDE}/api/organizations/org1/chat_conversations/k1?tree=True&rendering_mode=raw": (200, "<html/>"),
    })
    events2: list[dict] = []
    staging = tmp_path / "claude-web"
    with State(tmp_path / "state2.db") as st:
        res = capture_claude(conv_html, st, staging, events2)
        assert res.captured == 0 and res.errors == 1
        assert not (staging / "k1.json").exists()
        assert st.get_webcapture_watermark("claude", "k1") is None
    assert any(e["code"] == "webcapture_fetch_failed" for e in events2)


def test_chatgpt_list_non_array_items_is_an_error_not_a_crash(tmp_path):
    # Round 2 Fix 4: a 200 JSON object whose `items` isn't an array must not `.get` on a non-dict.
    transport = FakeCdpTransport({
        f"{CGPT}/api/auth/session": (200, json.dumps({"user": {"id": "u"}})),
        f"{CGPT}/backend-api/conversations": (200, json.dumps({"items": "nope", "total": 0})),
    })
    events: list[dict] = []
    with State(tmp_path / "state.db") as st:
        res = capture_chatgpt(transport, st, tmp_path / "chatgpt-web", events)
    assert res.errors == 1 and res.captured == 0
    assert any(e["code"] == "webcapture_list_failed" for e in events)


def test_claude_uuid_only_body_is_not_captured(tmp_path):
    # Round 2 Fix 5: a 200 body with metadata but no chat_messages list must not stage/watermark.
    transport = FakeCdpTransport({
        f"{CLAUDE}/api/organizations": (200, json.dumps([{"uuid": "org1", "capabilities": ["chat"]}])),
        f"{CLAUDE}/api/organizations/org1/chat_conversations": (200, json.dumps([{"uuid": "k1", "updated_at": "t"}])),
        f"{CLAUDE}/api/organizations/org1/chat_conversations/k1?tree=True&rendering_mode=raw": (200, json.dumps({"uuid": "k1"})),
    })
    events: list[dict] = []
    staging = tmp_path / "claude-web"
    with State(tmp_path / "state.db") as st:
        res = capture_claude(transport, st, staging, events)
        assert res.captured == 0 and res.errors == 1
        assert not (staging / "k1.json").exists()
        assert st.get_webcapture_watermark("claude", "k1") is None
    assert any(e["code"] == "webcapture_fetch_failed" for e in events)
    # An empty chat_messages list, by contrast, is a legitimately empty conversation -> captured.
    from agent_collector.webcapture.claude import _valid_conversation
    assert _valid_conversation(json.dumps({"uuid": "k1", "chat_messages": []})) is True
    assert _valid_conversation(json.dumps({"uuid": "k1"})) is False


def test_cmd_webcapture_list_failure_still_runs_other_product_and_buffers_event(tmp_env):
    # Fix 4 at the command level: a malformed ChatGPT list must not abort the Claude capture.
    path = config.config_path()
    config.enroll("http://localhost:8787", dev=True, path=path, machine_id="webhost")

    def factory(origin):
        if origin == PRODUCTS["chatgpt"][0]:
            return FakeCdpTransport({
                f"{CGPT}/api/auth/session": (200, json.dumps({"user": {"id": "u"}})),
                f"{CGPT}/backend-api/conversations": (200, "<html>interstitial</html>"),
            })
        return _claude_transport()

    rc = cmd_webcapture(types.SimpleNamespace(config=str(path), product=None, host="127.0.0.1", port=9222), transport_factory=factory)
    assert rc == 0  # neither product signed out; the list error is a warning, not a login failure
    assert (config.webcapture_dir() / "claude-web" / "k1.json").exists()  # claude still captured
    with State() as st:
        assert st.pending_event_count() >= 1  # the list failure was buffered for the next heartbeat


def test_fake_transport_prefix_matches_query_variants():
    t = FakeCdpTransport({"https://x/list": (200, "base")})
    assert t.fetch("https://x/list?offset=100") == (200, "base")  # longest-prefix match
    assert t.fetch("https://x/other") == (404, "")


def test_state_watermark_roundtrip_and_upsert(tmp_path):
    with State(tmp_path / "state.db") as st:
        assert st.get_webcapture_watermark("chatgpt", "c1") is None
        st.set_webcapture_watermark("chatgpt", "c1", "2026-07-01T00:00:00Z")
        assert st.get_webcapture_watermark("chatgpt", "c1") == "2026-07-01T00:00:00Z"
        st.set_webcapture_watermark("chatgpt", "c1", "2026-07-02T00:00:00Z")  # upsert
        assert st.get_webcapture_watermark("chatgpt", "c1") == "2026-07-02T00:00:00Z"
        # product-scoped: same conv_id under a different product is independent
        assert st.get_webcapture_watermark("claude", "c1") is None


def test_ensure_webcapture_stores_is_idempotent_and_preserves_existing(tmp_path):
    path = tmp_path / "config.toml"
    config.enroll("http://h", dev=True, path=path, machine_id="m")
    cfg = config.load(path)
    added = config.ensure_webcapture_stores(cfg, path)
    assert set(added) == set(config.WEBCAPTURE_STORES)
    # Persisted, and the original stores survive.
    reloaded = config.load(path)
    assert reloaded.stores["claude"] == "~/.claude"
    assert all(s in reloaded.stores for s in config.WEBCAPTURE_STORES)
    # Second call is a no-op (nothing new to add).
    assert config.ensure_webcapture_stores(config.load(path), path) == []


@pytest.mark.skipif(not Transport.curl_available(), reason="system curl not available")
def test_staged_files_upload_through_the_normal_run_path(tmp_env, hub):
    path = config.config_path()
    config.enroll(hub.url, dev=True, path=path, machine_id="webhost")

    def factory(origin):
        return _chatgpt_transport() if origin == PRODUCTS["chatgpt"][0] else _claude_transport()

    cmd_webcapture(types.SimpleNamespace(config=str(path), product=None, host="127.0.0.1", port=9222), transport_factory=factory)

    cfg = config.load(path)  # now includes the staging stores
    with State(machine_id=cfg.machine_id, hub_url=cfg.hub_url) as st:
        run_mod._do_run(cfg, st)

    assert ("webhost", "chatgpt-web", "c1.json") in hub.files
    assert ("webhost", "chatgpt-web", "c2.json") in hub.files
    assert ("webhost", "claude-web", "k1.json") in hub.files
