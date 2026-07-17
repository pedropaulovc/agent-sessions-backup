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


def test_claude_list_and_org_skip_non_dict_items(tmp_path):
    # Round 3 Fix 3+6: non-object items in the org list AND the conversation list must be skipped,
    # not raise .get() out of the whole command.
    transport = FakeCdpTransport({
        f"{CLAUDE}/api/organizations": (200, json.dumps(["nope", 42, {"uuid": "org1", "capabilities": ["chat"]}])),
        f"{CLAUDE}/api/organizations/org1/chat_conversations": (200, json.dumps(["str-item", {"uuid": "k1", "updated_at": "t"}])),
        f"{CLAUDE}/api/organizations/org1/chat_conversations/k1?tree=True&rendering_mode=raw": (200, json.dumps({"uuid": "k1", "chat_messages": []})),
    })
    events: list[dict] = []
    with State(tmp_path / "state.db") as st:
        res = capture_claude(transport, st, tmp_path / "claude-web", events)
    assert res.logged_in and res.captured == 1 and res.checked == 1  # only the one real conv


def test_claude_org_list_all_non_dict_signs_out_cleanly(tmp_path):
    transport = FakeCdpTransport({f"{CLAUDE}/api/organizations": (200, json.dumps(["a", "b"]))})
    events: list[dict] = []
    with State(tmp_path / "state.db") as st:
        res = capture_claude(transport, st, tmp_path / "claude-web", events)
    assert res.logged_in is False
    assert any(e["code"] == "webcapture_login_expired" for e in events)


def test_cdp_attaches_to_exact_origin_not_lookalike(monkeypatch):
    # Round 7 Fix 4: tab selection compares the parsed ORIGIN, not a URL-string prefix — a lookalike
    # like https://chatgpt.com.evil/ (which startswith the configured origin) must NOT win, or the
    # capture JS runs in a hostile page's context.
    import sys
    import types as _types
    from agent_collector.webcapture.cdp import ChromeCdpTransport, CdpError

    captured = {}

    def _fake_connect(url, **_kw):
        captured["url"] = url
        return _types.SimpleNamespace(send=lambda *_a: None, recv=lambda: "{}", close=lambda: None)

    monkeypatch.setitem(sys.modules, "websocket", _types.SimpleNamespace(create_connection=_fake_connect))
    tr = ChromeCdpTransport("https://chatgpt.com")
    monkeypatch.setattr(tr, "_list_targets", lambda: [
        {"type": "page", "url": "https://chatgpt.com.evil/phish", "webSocketDebuggerUrl": "ws://evil"},
        {"type": "page", "url": "https://chatgpt.com/", "webSocketDebuggerUrl": "ws://real"},
    ])
    tr._connect()
    assert captured["url"] == "ws://real"  # attached to the exact-origin tab, never the lookalike


def test_cdp_no_matching_origin_raises_cdp_error(monkeypatch):
    # A list with only a lookalike origin -> no tab matches -> CdpError (the signed-out/no-tab path),
    # never an attach to the lookalike.
    import sys
    import types as _types
    from agent_collector.webcapture.cdp import ChromeCdpTransport, CdpError

    monkeypatch.setitem(sys.modules, "websocket", _types.SimpleNamespace(create_connection=lambda *_a, **_k: None))
    tr = ChromeCdpTransport("https://chatgpt.com")
    monkeypatch.setattr(tr, "_list_targets", lambda: [
        {"type": "page", "url": "https://chatgpt.com.evil/phish", "webSocketDebuggerUrl": "ws://evil"},
    ])
    with pytest.raises(CdpError):
        tr._connect()


def test_cdp_connect_failure_becomes_cdp_error(monkeypatch):
    # Round 3 Fix 4: a websocket handshake failure is wrapped as CdpError (which _run_products
    # catches) rather than a raw websocket exception that aborts the whole run.
    import sys
    import types as _types
    from agent_collector.webcapture.cdp import ChromeCdpTransport, CdpError

    def _raise(*_a, **_k):
        raise RuntimeError("websocket handshake failed")

    monkeypatch.setitem(sys.modules, "websocket", _types.SimpleNamespace(create_connection=_raise))
    tr = ChromeCdpTransport("https://chatgpt.com", host="127.0.0.1", port=9222)
    monkeypatch.setattr(tr, "_list_targets", lambda: [
        {"type": "page", "url": "https://chatgpt.com/", "webSocketDebuggerUrl": "ws://127.0.0.1:9222/dev"},
    ])
    with pytest.raises(CdpError):
        tr.fetch("https://chatgpt.com/api/auth/session")


def test_cmd_webcapture_cdp_error_one_product_still_runs_other(tmp_env):
    # A CdpError capturing ChatGPT must not abort the Claude capture.
    from agent_collector.webcapture.cdp import CdpError

    class _Raising:
        def fetch(self, url):
            raise CdpError("chrome tab closed")

        def close(self):
            pass

    path = config.config_path()
    config.enroll("http://localhost:8787", dev=True, path=path, machine_id="webhost")

    def factory(origin):
        return _Raising() if origin == PRODUCTS["chatgpt"][0] else _claude_transport()

    rc = cmd_webcapture(types.SimpleNamespace(config=str(path), product=None, host="127.0.0.1", port=9222), transport_factory=factory)
    assert rc == 1  # a Chrome/CDP failure is a real error for a hand-run (nonzero exit)...
    assert (config.webcapture_dir() / "claude-web" / "k1.json").exists()  # ...but Claude still captured
    with State() as st:
        assert st.pending_event_count() >= 1  # the CdpError was buffered for the next heartbeat


def test_chatgpt_restages_a_deleted_local_file_even_when_unchanged(tmp_path):
    # Round 6 Fix 3: a conversation whose staged file was lost locally (deleted, or the staging root
    # moved) is re-fetched even when its remote watermark is unchanged — otherwise it can never be
    # uploaded until it changes remotely.
    staging = tmp_path / "chatgpt-web"
    with State(tmp_path / "state.db") as st:
        res1 = capture_chatgpt(_chatgpt_transport(), st, staging, [])
        assert res1.captured == 2 and (staging / "c1.json").exists()
        (staging / "c1.json").unlink()  # local file lost; remote is UNCHANGED (same watermark)
        res2 = capture_chatgpt(_chatgpt_transport(), st, staging, [])
        assert res2.captured == 1  # only c1 re-fetched (c2 is still staged)
        assert (staging / "c1.json").exists()


def test_claude_restages_a_deleted_local_file_even_when_unchanged(tmp_path):
    staging = tmp_path / "claude-web"
    with State(tmp_path / "state.db") as st:
        res1 = capture_claude(_claude_transport(), st, staging, [])
        assert res1.captured == 1 and (staging / "k1.json").exists()
        (staging / "k1.json").unlink()  # local file lost; remote UNCHANGED
        res2 = capture_claude(_claude_transport(), st, staging, [])
        assert res2.captured == 1 and (staging / "k1.json").exists()


def test_claude_captures_all_chat_capable_orgs(tmp_path):
    # Round 5 Fix 1: a multi-workspace account must have EVERY chat-capable org captured, not just
    # the first. conv uuids are globally unique, so the per-conv watermark needs no org key.
    o1 = "11111111-1111-4111-8111-111111111111"
    o2 = "22222222-2222-4222-8222-222222222222"
    k1 = "aaaaaaaa-1111-4111-8111-111111111111"
    k2 = "bbbbbbbb-2222-4222-8222-222222222222"
    transport = FakeCdpTransport({
        f"{CLAUDE}/api/organizations": (200, json.dumps([
            {"uuid": o1, "capabilities": ["chat"]},
            {"uuid": o2, "capabilities": ["chat"]},
        ])),
        f"{CLAUDE}/api/organizations/{o1}/chat_conversations": (200, json.dumps([{"uuid": k1, "updated_at": "2026-07-01T10:00:00Z"}])),
        f"{CLAUDE}/api/organizations/{o1}/chat_conversations/{k1}?tree=True&rendering_mode=raw": (200, json.dumps({"uuid": k1, "chat_messages": []})),
        f"{CLAUDE}/api/organizations/{o2}/chat_conversations": (200, json.dumps([{"uuid": k2, "updated_at": "2026-07-01T11:00:00Z"}])),
        f"{CLAUDE}/api/organizations/{o2}/chat_conversations/{k2}?tree=True&rendering_mode=raw": (200, json.dumps({"uuid": k2, "chat_messages": []})),
    })
    events: list[dict] = []
    staging = tmp_path / "claude-web"
    with State(tmp_path / "state.db") as st:
        res = capture_claude(transport, st, staging, events)
        assert res.logged_in and res.checked == 2 and res.captured == 2  # BOTH orgs
        assert (staging / f"{k1}.json").exists() and (staging / f"{k2}.json").exists()
    assert events == []


def test_chatgpt_falls_back_to_create_time_and_flags_missing_timestamps(tmp_path):
    # Round 5 Fix 3: an item with only create_time is still captured (first capture); an id-bearing
    # item with NEITHER timestamp emits a list_failed event instead of a silent clean run.
    transport = FakeCdpTransport({
        f"{CGPT}/api/auth/session": (200, json.dumps({"user": {"id": "u"}})),
        f"{CGPT}/backend-api/conversations": (200, json.dumps({
            "items": [
                {"id": "only-ct", "create_time": "2026-07-01T09:00:00Z"},  # no update_time
                {"id": "no-ts"},  # neither timestamp -> drift
            ],
            "total": 2,
        })),
        f"{CGPT}/backend-api/conversation/only-ct": (200, _conv_json("only-ct")),
    })
    events: list[dict] = []
    staging = tmp_path / "chatgpt-web"
    with State(tmp_path / "state.db") as st:
        res = capture_chatgpt(transport, st, staging, events)
        assert res.captured == 1  # only-ct captured via the create_time fallback
        assert (staging / "only-ct.json").exists()
    assert any(e["code"] == "webcapture_list_failed" for e in events)  # the no-ts item was flagged, not silent


def test_claude_falls_back_to_created_at_and_flags_missing_timestamps(tmp_path):
    org = "11111111-1111-4111-8111-111111111111"
    ct = "aaaaaaaa-1111-4111-8111-111111111111"
    transport = FakeCdpTransport({
        f"{CLAUDE}/api/organizations": (200, json.dumps([{"uuid": org, "capabilities": ["chat"]}])),
        f"{CLAUDE}/api/organizations/{org}/chat_conversations": (200, json.dumps([
            {"uuid": ct, "created_at": "2026-07-01T09:00:00Z"},  # no updated_at
            {"uuid": "bbbbbbbb-2222-4222-8222-222222222222"},  # neither -> drift
        ])),
        f"{CLAUDE}/api/organizations/{org}/chat_conversations/{ct}?tree=True&rendering_mode=raw": (200, json.dumps({"uuid": ct, "chat_messages": []})),
    })
    events: list[dict] = []
    staging = tmp_path / "claude-web"
    with State(tmp_path / "state.db") as st:
        res = capture_claude(transport, st, staging, events)
        assert res.captured == 1  # captured via the created_at fallback
        assert (staging / f"{ct}.json").exists()
    assert any(e["code"] == "webcapture_list_failed" for e in events)


def test_cmd_webcapture_transport_close_failure_does_not_mask_results(tmp_env):
    # Round 5 Fix 2: a transport.close() that raises (already-broken socket) must not drop buffered
    # events or skip the other product — cleanup can't mask the capture result.
    class _ClosesBadly:
        def __init__(self, inner):
            self._inner = inner

        def fetch(self, url):
            return self._inner.fetch(url)

        def close(self):
            raise RuntimeError("socket already closed")

    path = config.config_path()
    config.enroll("http://localhost:8787", dev=True, path=path, machine_id="webhost")

    def factory(origin):
        inner = _chatgpt_transport() if origin == PRODUCTS["chatgpt"][0] else _claude_transport()
        return _ClosesBadly(inner)

    rc = cmd_webcapture(types.SimpleNamespace(config=str(path), product=None, host="127.0.0.1", port=9222), transport_factory=factory)
    assert rc == 0  # both products captured cleanly despite every close() raising
    assert (config.webcapture_dir() / "chatgpt-web" / "c1.json").exists()
    assert (config.webcapture_dir() / "claude-web" / "k1.json").exists()


def test_cdp_list_targets_non_json_or_non_list_becomes_cdp_error(monkeypatch):
    # Round 4 Fix 4: /json returning HTML (a non-Chrome service on --port), or a 200 JSON object
    # instead of a list, must raise CdpError — not a bare JSONDecodeError, and not a value that later
    # makes _connect() call .get on a string. _run_products only catches CdpError, so anything else
    # would abort the whole command before the other product runs.
    from agent_collector.webcapture import cdp as cdp_mod
    from agent_collector.webcapture.cdp import ChromeCdpTransport, CdpError

    class _Resp:
        def __init__(self, data):
            self._data = data

        def read(self):
            return self._data.encode("utf-8")

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

    tr = ChromeCdpTransport("https://chatgpt.com", host="127.0.0.1", port=9222)

    monkeypatch.setattr(cdp_mod.urllib.request, "urlopen", lambda *_a, **_k: _Resp("<html>not chrome</html>"))
    with pytest.raises(CdpError):
        tr._list_targets()

    # A 200 JSON object (not a list of target dicts) is equally invalid.
    monkeypatch.setattr(cdp_mod.urllib.request, "urlopen", lambda *_a, **_k: _Resp(json.dumps({"not": "a list"})))
    with pytest.raises(CdpError):
        tr._list_targets()

    # A list containing a non-dict target is also rejected (iterating it later would .get on a str).
    monkeypatch.setattr(cdp_mod.urllib.request, "urlopen", lambda *_a, **_k: _Resp(json.dumps(["nope"])))
    with pytest.raises(CdpError):
        tr._list_targets()

    # A well-formed list of target objects passes through unchanged.
    good = [{"type": "page", "url": "https://chatgpt.com/", "webSocketDebuggerUrl": "ws://x"}]
    monkeypatch.setattr(cdp_mod.urllib.request, "urlopen", lambda *_a, **_k: _Resp(json.dumps(good)))
    assert tr._list_targets() == good


def test_valid_conv_id_accepts_uuids_rejects_traversal():
    # Round 4 Fix 6: the shared guard admits every real (UUID) id and any safe path segment, but
    # rejects anything that could escape staging_root when used verbatim as a filename.
    from agent_collector.webcapture.result import valid_conv_id

    assert valid_conv_id("6867a0e1-1234-4abc-8def-0123456789ab")  # a real UUID id
    assert valid_conv_id("c1")  # a synthetic short id is still a safe segment
    for bad in ("../evil", "a/b", "/abs", "..", ".", "a\\b", "", None, 123, "a b"):
        assert not valid_conv_id(bad)


def test_chatgpt_rejects_path_traversal_conversation_id(tmp_path):
    # Round 4 Fix 6: a conversation id that isn't a safe path segment must be rejected BEFORE the
    # conversation fetch and BEFORE any path join — a fetch-failed event, no watermark advance, and
    # no file written outside staging.
    transport = FakeCdpTransport({
        f"{CGPT}/api/auth/session": (200, json.dumps({"user": {"id": "u"}})),
        f"{CGPT}/backend-api/conversations": (200, json.dumps({"items": [{"id": "../evil", "update_time": "t"}], "total": 1})),
    })
    events: list[dict] = []
    staging = tmp_path / "chatgpt-web"
    with State(tmp_path / "state.db") as st:
        res = capture_chatgpt(transport, st, staging, events)
        assert res.captured == 0 and res.errors == 1
        assert st.get_webcapture_watermark("chatgpt", "../evil") is None
    assert any(e["code"] == "webcapture_fetch_failed" for e in events)
    assert not any("/backend-api/conversation/" in u for u in transport.calls)  # the bad id never fetched
    assert not (tmp_path / "evil.json").exists()  # nothing escaped staging_root


def test_claude_rejects_path_traversal_conversation_id(tmp_path):
    transport = FakeCdpTransport({
        f"{CLAUDE}/api/organizations": (200, json.dumps([{"uuid": "org1", "capabilities": ["chat"]}])),
        f"{CLAUDE}/api/organizations/org1/chat_conversations": (200, json.dumps([{"uuid": "../../etc/passwd", "updated_at": "t"}])),
    })
    events: list[dict] = []
    staging = tmp_path / "claude-web"
    with State(tmp_path / "state.db") as st:
        res = capture_claude(transport, st, staging, events)
        assert res.captured == 0 and res.errors == 1
        assert st.get_webcapture_watermark("claude", "../../etc/passwd") is None
    assert any(e["code"] == "webcapture_fetch_failed" for e in events)
    assert not any("etc/passwd" in u for u in transport.calls)  # the bad id never fetched


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


def test_webcapture_writes_to_configured_store_root_not_default(tmp_env):
    # Round 4 Fix 8: a custom configured chatgpt-web root must receive the staged capture (so the
    # subsequent `run`, which scans cfg.store_roots(), uploads it) — not a recomputed default base.
    path = config.config_path()
    config.enroll("http://localhost:8787", dev=True, path=path, machine_id="webhost")
    custom = tmp_env / "custom-cgpt-root"
    cfg = config.load(path)
    cfg.stores["chatgpt-web"] = str(custom)
    config.save(cfg, path)

    def factory(origin):
        return _chatgpt_transport() if origin == PRODUCTS["chatgpt"][0] else _claude_transport()

    rc = cmd_webcapture(types.SimpleNamespace(config=str(path), product="chatgpt", host="127.0.0.1", port=9222), transport_factory=factory)
    assert rc == 0
    assert (custom / "c1.json").exists()  # written under the configured root
    assert not (config.webcapture_dir() / "chatgpt-web" / "c1.json").exists()  # NOT the recomputed default


def test_webcapture_staging_io_error_is_buffered_and_other_product_runs(tmp_env):
    # Round 4 Fix 9: an unwritable chatgpt-web staging root (OSError on mkdir) buffers an event and
    # does NOT abort the Claude capture.
    path = config.config_path()
    config.enroll("http://localhost:8787", dev=True, path=path, machine_id="webhost")
    # Point chatgpt-web at a path UNDER a regular file so mkdir(parents=True) raises NotADirectoryError.
    blocker = tmp_env / "blocker-file"
    blocker.write_text("i am a file, not a dir")
    cfg = config.load(path)
    cfg.stores["chatgpt-web"] = str(blocker / "sub" / "chatgpt-web")
    config.save(cfg, path)

    def factory(origin):
        return _chatgpt_transport() if origin == PRODUCTS["chatgpt"][0] else _claude_transport()

    rc = cmd_webcapture(types.SimpleNamespace(config=str(path), product=None, host="127.0.0.1", port=9222), transport_factory=factory)
    assert rc == 1  # the staging I/O failure is surfaced as a real error for the hand-run...
    assert (config.webcapture_dir() / "claude-web" / "k1.json").exists()  # ...but Claude still captured
    with State() as st:
        assert st.pending_event_count() >= 1  # the I/O failure was buffered for the next heartbeat


def test_enroll_registers_export_inbox_store_dev_and_mtls(tmp_path):
    # Round 4 Fix 11: export-inbox is registered on enroll (dev AND mTLS) so an export-only operator
    # gets it scanned without ever running webcapture; the web-capture stores stay webcapture-only.
    dev_path = tmp_path / "dev.toml"
    config.enroll("http://h", dev=True, path=dev_path, machine_id="m")
    dev_cfg = config.load(dev_path)
    assert "export-inbox" in dev_cfg.store_roots()
    assert "chatgpt-web" not in dev_cfg.stores and "claude-web" not in dev_cfg.stores

    mtls_path = tmp_path / "mtls.toml"
    cert = tmp_path / "c.pem"
    cert.write_text("x")
    key = tmp_path / "k.pem"
    key.write_text("x")
    config.enroll("http://h", dev=False, path=mtls_path, machine_id="m", client_cert_path=str(cert), client_key_path=str(key))
    mtls_cfg = config.load(mtls_path)
    assert "export-inbox" in mtls_cfg.store_roots()


def test_ensure_webcapture_stores_is_idempotent_and_preserves_existing(tmp_path):
    path = tmp_path / "config.toml"
    config.enroll("http://h", dev=True, path=path, machine_id="m")
    cfg = config.load(path)
    added = config.ensure_webcapture_stores(cfg, path)
    # export-inbox is already registered by enroll (Fix 11), so ensure_webcapture_stores newly adds
    # only the two web-capture stores; the full set is still present afterwards (asserted below).
    assert set(added) == {"chatgpt-web", "claude-web"}
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
