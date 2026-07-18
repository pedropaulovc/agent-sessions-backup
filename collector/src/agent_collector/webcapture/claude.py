"""claude.ai capture: resolve the orgs -> list conversations -> fetch changed ones as raw trees.

Uses the in-page CDP fetch (cookies included): /api/organizations to find EVERY chat-capable org
and detect an expired login, {org}/chat_conversations to page each org's list by updated_at, and
each changed conversation with ?tree=True&rendering_mode=raw so the full branch tree + unrendered
content blocks are staged verbatim for the hub to parse. A Claude account can belong to multiple
workspaces, so all of them are captured (conversation uuids are globally unique, so the per-conv
watermark needs no org key).
"""

from __future__ import annotations

import json
from pathlib import Path

from .cdp import CdpTransport
from .result import CaptureResult, login_expired_event, valid_conv_id

BASE = "https://claude.ai"

_LIST_PAGE = 100  # claude.ai chat_conversations is paginated; conversations requested per page
_MAX_PAGES = 1000  # defensive bound (100k convs) so a broken server can't loop us forever


def capture_claude(transport: CdpTransport, state, staging_root: Path, events: list[dict]) -> CaptureResult:
    res = CaptureResult(product="claude")

    org_ids = _resolve_orgs(transport)
    if not org_ids:
        res.logged_in = False
        events.append(login_expired_event("claude"))
        return res

    staging_root.mkdir(parents=True, exist_ok=True)
    for org_id in org_ids:
        _capture_org(transport, state, staging_root, events, org_id, res)
    return res


def _capture_org(transport: CdpTransport, state, staging_root: Path, events: list[dict], org_id: str, res: CaptureResult) -> None:
    """List + fetch one org's changed conversations, accumulating into `res`."""
    convs = _list_conversations(transport, org_id)
    if convs is None:
        # A non-200 or a 200 that isn't a JSON array (auth/interstitial page, layout drift) on ANY
        # page: a capture error, not an unhandled json.loads that aborts the whole webcapture command.
        res.errors += 1
        events.append({
            "level": "warn", "code": "webcapture_list_failed",
            "message": f"claude conversation list failed for org {org_id}", "count": 1, "store": "claude-web",
        })
        return

    changed = []
    missing_ts = 0
    for c in convs:
        if not isinstance(c, dict):
            continue  # a non-object array item (layout drift) must not raise .get()
        conv_id = c.get("uuid")
        if not conv_id:
            continue
        # Fall back to created_at when updated_at is absent/renamed. An id-bearing item with NEITHER
        # timestamp is layout drift, not "unchanged": count it (surfaced below) instead of silently
        # dropping it and reporting a clean run that captured nothing.
        ts = c.get("updated_at") or c.get("created_at")
        if not ts:
            missing_ts += 1
            continue
        res.checked += 1
        prev = state.get_webcapture_watermark("claude", conv_id)  # conv uuids are globally unique
        # Re-fetch when the watermark advanced OR the local staged file is gone (deleted, or the
        # staging root moved): a watermark-only check would strand an unchanged-but-unstaged
        # conversation, unable to upload until it changed remotely. Re-staging is harmless (hub
        # dedupes by content hash).
        staged_missing = valid_conv_id(conv_id) and not (staging_root / f"{conv_id}.json").exists()
        if prev is None or str(ts) > prev or staged_missing:
            changed.append((conv_id, str(ts)))
    if missing_ts:
        res.errors += 1
        events.append({
            "level": "warn", "code": "webcapture_list_failed",
            "message": f"claude list for org {org_id}: {missing_ts} item(s) with no updated_at/created_at (layout drift)",
            "count": missing_ts, "store": "claude-web",
        })
    res.changed += len(changed)

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


def _list_conversations(transport: CdpTransport, org_id: str):
    """Page through one org's FULL conversation list. chat_conversations is paginated — a bare fetch
    returns only the first page and silently hides older conversations — so loop by limit/offset
    until a short (fewer than a full page) or empty page. Returns the accumulated list, or None on
    ANY page's HTTP error or non-array body so the caller reports the org's list as failed (same
    posture the single fetch had). An empty first page returns [] (zero conversations, not an error)."""
    all_convs: list = []
    offset = 0
    for _ in range(_MAX_PAGES):
        status, body = transport.fetch(
            f"{BASE}/api/organizations/{org_id}/chat_conversations?limit={_LIST_PAGE}&offset={offset}"
        )
        if status != 200:
            return None
        page = _parse_list(body)
        if page is None:
            return None
        all_convs.extend(page)
        if len(page) < _LIST_PAGE:
            return all_convs
        offset += len(page)
    return None  # too many pages — treat as a list failure rather than looping forever


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


def _resolve_orgs(transport: CdpTransport) -> list[str]:
    """Every chat-capable org uuid to capture, or [] when signed out. A Claude account can belong to
    several workspaces; capturing only the first would silently skip the rest. Falls back to all
    uuid-bearing orgs when none advertise the chat capability, so a capability-key rename doesn't
    look like a sign-out."""
    status, body = transport.fetch(f"{BASE}/api/organizations")
    if status != 200 or not body:
        return []
    try:
        orgs = json.loads(body)
    except json.JSONDecodeError:
        return []
    if not isinstance(orgs, list) or not orgs:
        return []
    dict_orgs = [o for o in orgs if isinstance(o, dict)]  # skip non-object items (layout drift)
    chat = [o["uuid"] for o in dict_orgs if o.get("uuid") and "chat" in (o.get("capabilities") or [])]
    if chat:
        return chat
    return [o["uuid"] for o in dict_orgs if o.get("uuid")]
