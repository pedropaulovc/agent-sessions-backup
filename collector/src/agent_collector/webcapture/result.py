"""Per-product capture result + the login-expiry event shape shared by both drivers."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# A captured conversation id must be safe to use verbatim as a single path segment. Real ChatGPT
# conversation ids and claude.ai conversation uuids are canonical UUIDs, which are a strict subset
# of this charset; the guard here is deliberately the SECURITY boundary (no path separators, no '.'
# runs, no absolute paths), not a format assertion — so a benign id-scheme change never silently
# drops real conversations, while '/', '\', '..', and absolute paths are all rejected.
_CONV_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def valid_conv_id(conv_id: object) -> bool:
    """True only for an id that is safe as a single staging-path segment. An id carrying '/', '\\',
    '..', or an absolute path (API drift or a hostile endpoint) would otherwise escape staging_root
    when used verbatim as a filename — at best raising out of the product loop, at worst overwriting
    an unrelated local file. Anything outside `[A-Za-z0-9_-]` (which still admits every real UUID
    id) is rejected by the caller with a webcapture_fetch_failed event and skipped; both products
    share this guard, applied BEFORE the id ever reaches a fetch URL or a path join."""
    return isinstance(conv_id, str) and _CONV_ID_RE.match(conv_id) is not None


@dataclass
class CaptureResult:
    product: str
    logged_in: bool = True
    checked: int = 0   # conversations seen in the list
    changed: int = 0   # conversations whose watermark moved
    captured: int = 0  # conversations actually re-fetched and staged
    errors: int = 0

    def as_dict(self) -> dict:
        return {
            "product": self.product, "logged_in": self.logged_in, "checked": self.checked,
            "changed": self.changed, "captured": self.captured, "errors": self.errors,
        }


def login_expired_event(product: str) -> dict:
    """Buffered into the state DB so the NEXT heartbeat delivers it — the hub re-emits it as an
    alertable telemetry event (webcapture-login-expired). Never silent: capture stops for this
    product until the operator signs the Chrome profile back in."""
    return {
        "level": "error",
        "code": "webcapture_login_expired",
        "message": f"{product} web capture is signed out; sign the Chrome profile back in",
        "count": 1,
        "store": f"{product}-web" if product == "chatgpt" else "claude-web",
    }
