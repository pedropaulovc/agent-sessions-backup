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
from .result import CaptureResult, login_expired_event, valid_conv_id

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
        if not isinstance(c, dict):
            continue  # a non-object array item (layout drift) must not raise .get()
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
        # Reject a non-UUID id before it reaches EITHER the fetch URL or the `{conv_id}.json`
        # staging path — a '/', '..' or absolute-path id (API drift / hostile endpoint) would
        # otherwise escape staging_root. Buffer a fetch-failed event and leave the watermark so a
        # since-corrected id is retried next run.
        if not valid_conv_id(conv_id):
            res.errors += 1
            events.append({
                "level": "warn", "code": "webcapture_fetch_failed",
                "message": f"claude conversation id rejected (not a uuid): {conv_id!r}",
                "count": 1, "store": "claude-web",
            })
            continue
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
    """True only for a conversation carrying the message tree. `chat_messages` must be a list (an
    empty list is a legitimately empty conversation; a uuid-only metadata body — missing the key —
    is not, and must not be staged + watermarked as if captured)."""
    if not body:
        return False
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return False
    return isinstance(data, dict) and isinstance(data.get("chat_messages"), list)


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
    dict_orgs = [o for o in orgs if isinstance(o, dict)]  # skip non-object items (layout drift)
    for org in dict_orgs:
        caps = org.get("capabilities") or []
        if org.get("uuid") and "chat" in caps:
            return org["uuid"]
    for org in dict_orgs:
        if org.get("uuid"):
            return org["uuid"]
    return None
