"""Per-product capture result + the login-expiry event shape shared by both drivers."""

from __future__ import annotations

from dataclasses import dataclass, field


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
