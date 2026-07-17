"""ChatGPT capture: auth check -> paginate the conversation list -> fetch changed conversations.

Reads first-party endpoints via the in-page CDP fetch (cookies included): /api/auth/session to
detect an expired login, backend-api/conversations to page the list by update watermark, and
backend-api/conversation/{id} for each conversation whose update_time moved past what we last
captured. The raw conversation JSON is staged verbatim (the hub parses it); watermarks live in
the state DB so a re-run only refetches what changed.
"""

from __future__ import annotations

import json
from pathlib import Path

from .cdp import CdpTransport
from .result import CaptureResult, login_expired_event

BASE = "https://chatgpt.com"
PAGE_LIMIT = 100


def capture_chatgpt(transport: CdpTransport, state, staging_root: Path, events: list[dict]) -> CaptureResult:
    res = CaptureResult(product="chatgpt")

    status, body = transport.fetch(f"{BASE}/api/auth/session")
    if not _logged_in(status, body):
        res.logged_in = False
        events.append(login_expired_event("chatgpt"))
        return res

    changed = _list_changed(transport, state, res, events)
    staging_root.mkdir(parents=True, exist_ok=True)
    for conv_id, update_time in changed:
        status, body = transport.fetch(f"{BASE}/backend-api/conversation/{conv_id}")
        if status != 200 or not body:
            res.errors += 1
            events.append({
                "level": "warn", "code": "webcapture_fetch_failed",
                "message": f"chatgpt conversation {conv_id}: HTTP {status}", "count": 1, "store": "chatgpt-web",
            })
            continue
        (staging_root / f"{conv_id}.json").write_text(body, encoding="utf-8")
        state.set_webcapture_watermark("chatgpt", conv_id, update_time)
        res.captured += 1
    return res


def _logged_in(status: int, body: str) -> bool:
    if status != 200 or not body:
        return False
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return False
    # A signed-out session returns `{}`; a signed-in one carries a `user` object.
    return isinstance(data, dict) and bool(data.get("user"))


def _list_changed(transport: CdpTransport, state, res: CaptureResult, events: list[dict]) -> list[tuple[str, str]]:
    changed: list[tuple[str, str]] = []
    offset = 0
    while True:
        url = f"{BASE}/backend-api/conversations?offset={offset}&limit={PAGE_LIMIT}&order=updated"
        status, body = transport.fetch(url)
        if status != 200 or not body:
            res.errors += 1
            events.append({
                "level": "warn", "code": "webcapture_list_failed",
                "message": f"chatgpt conversation list HTTP {status} at offset {offset}", "count": 1, "store": "chatgpt-web",
            })
            break
        data = json.loads(body)
        items = data.get("items") or []
        for it in items:
            conv_id = it.get("id")
            update_time = it.get("update_time")
            if not conv_id or not update_time:
                continue
            res.checked += 1
            prev = state.get_webcapture_watermark("chatgpt", conv_id)
            if prev is None or str(update_time) > prev:
                changed.append((conv_id, str(update_time)))
        offset += len(items)
        total = data.get("total")
        if not items or (isinstance(total, int) and offset >= total):
            break
    res.changed = len(changed)
    return changed
