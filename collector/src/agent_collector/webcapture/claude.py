"""claude.ai capture: resolve the org -> list conversations -> fetch changed ones as raw trees.

Uses the in-page CDP fetch (cookies included): /api/organizations to find the org and detect an
expired login, {org}/chat_conversations to page the list by updated_at, and each changed
conversation with ?tree=True&rendering_mode=raw so the full branch tree + unrendered content
blocks are staged verbatim for the hub to parse.
"""

from __future__ import annotations

import json
from pathlib import Path

from .cdp import CdpTransport
from .result import CaptureResult, login_expired_event

BASE = "https://claude.ai"


def capture_claude(transport: CdpTransport, state, staging_root: Path, events: list[dict]) -> CaptureResult:
    res = CaptureResult(product="claude")

    org_id = _resolve_org(transport)
    if org_id is None:
        res.logged_in = False
        events.append(login_expired_event("claude"))
        return res

    status, body = transport.fetch(f"{BASE}/api/organizations/{org_id}/chat_conversations")
    convs = _parse_list(body) if status == 200 else None
    if status != 200 or convs is None:
        # Non-200 or a 200 that isn't a JSON array (auth/interstitial page, layout drift): a
        # capture error, not an unhandled json.loads that aborts the whole webcapture command.
        res.errors += 1
        events.append({
            "level": "warn", "code": "webcapture_list_failed",
            "message": f"claude conversation list HTTP {status}", "count": 1, "store": "claude-web",
        })
        return res

    changed = []
    for c in convs:
        conv_id = c.get("uuid")
        updated = c.get("updated_at")
        if not conv_id or not updated:
            continue
        res.checked += 1
        prev = state.get_webcapture_watermark("claude", conv_id)
        if prev is None or str(updated) > prev:
            changed.append((conv_id, str(updated)))
    res.changed = len(changed)

    staging_root.mkdir(parents=True, exist_ok=True)
    for conv_id, updated in changed:
        url = f"{BASE}/api/organizations/{org_id}/chat_conversations/{conv_id}?tree=True&rendering_mode=raw"
        status, body = transport.fetch(url)
        # Validate before staging + advancing the watermark: a 200 interstitial/HTML page must not
        # be staged and marked captured, or the conversation is never re-fetched until it changes.
        if status != 200 or not _valid_conversation(body):
            res.errors += 1
            events.append({
                "level": "warn", "code": "webcapture_fetch_failed",
                "message": f"claude conversation {conv_id}: HTTP {status} or non-conversation body",
                "count": 1, "store": "claude-web",
            })
            continue
        (staging_root / f"{conv_id}.json").write_text(body, encoding="utf-8")
        state.set_webcapture_watermark("claude", conv_id, updated)
        res.captured += 1
    return res


def _parse_list(body: str):
    """The conversation-list payload as a list, or None if the body isn't a JSON array."""
    if not body:
        return None
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, list) else None


def _valid_conversation(body: str) -> bool:
    """True only for a JSON object shaped like a claude.ai conversation (chat_messages / uuid)."""
    if not body:
        return False
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return False
    return isinstance(data, dict) and ("chat_messages" in data or "uuid" in data)


def _resolve_org(transport: CdpTransport) -> str | None:
    """The org uuid to capture, or None when signed out. Prefers an org whose capabilities
    include chat; falls back to the first org with a uuid."""
    status, body = transport.fetch(f"{BASE}/api/organizations")
    if status != 200 or not body:
        return None
    try:
        orgs = json.loads(body)
    except json.JSONDecodeError:
        return None
    if not isinstance(orgs, list) or not orgs:
        return None
    for org in orgs:
        caps = org.get("capabilities") or []
        if org.get("uuid") and "chat" in caps:
            return org["uuid"]
    return orgs[0].get("uuid")
