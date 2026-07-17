"""`agent-collector webcapture`: drive real logged-in Chrome over CDP to stage ChatGPT/Claude
conversations, which the normal run path then uploads.

Everything below the transport is browser-free and injectable (`transport_factory`) so the whole
flow is testable against a fake with recorded-shape payloads. Login expiry is surfaced as a
buffered heartbeat event (delivered by the next run), never silently.
"""

from __future__ import annotations

import json
import sys
from typing import Callable

from .. import config as config_mod
from ..state import State, OverlapLock
from .cdp import CdpError, ChromeCdpTransport, CdpTransport
from .chatgpt import capture_chatgpt
from .claude import capture_claude
from .result import CaptureResult

# product -> (page origin to attach to, staging store name, capture function)
PRODUCTS = {
    "chatgpt": ("https://chatgpt.com", "chatgpt-web", capture_chatgpt),
    "claude": ("https://claude.ai", "claude-web", capture_claude),
}

TransportFactory = Callable[[str], CdpTransport]


def cmd_webcapture(args, transport_factory: TransportFactory | None = None) -> int:
    cfg = config_mod.load(getattr(args, "config", None))
    products = [args.product] if getattr(args, "product", None) else list(PRODUCTS)
    host = getattr(args, "host", "127.0.0.1")
    port = getattr(args, "port", 9222)

    if transport_factory is None:
        def transport_factory(origin: str) -> CdpTransport:  # noqa: E306
            return ChromeCdpTransport(origin, host=host, port=port)

    # Register the staging stores so the next `run` uploads whatever we write, then resolve the
    # capture roots from cfg.store_roots() — the SAME source `run`/the scanner use. Building each
    # root from a freshly recomputed webcapture_dir() would diverge from a custom configured root
    # (or an XDG_DATA_HOME change made after the stores were first persisted), so captures would
    # land where the scanner never looks and never upload.
    config_mod.ensure_webcapture_stores(cfg, cfg.source)
    store_roots = cfg.store_roots()

    lock = OverlapLock()
    if not lock.acquire():
        print("another collector run holds the lock; exiting cleanly", file=sys.stderr)
        return 0
    try:
        with State() as st:
            results, events = _run_products(cfg, st, products, store_roots, transport_factory)
            if events:
                st.buffer_events(events)  # login-expiry / fetch failures ride the next heartbeat
    finally:
        lock.release()

    any_login_expired = any(not r.logged_in for r in results)
    print(json.dumps({"mode": "webcapture", "products": [r.as_dict() for r in results]}))
    # Non-zero only when a product is signed out — an operator running this by hand sees it, and
    # scheduled runs still surface it via the buffered heartbeat event regardless of exit code.
    return 1 if any_login_expired else 0


def _run_products(cfg, st: State, products: list[str], store_roots: dict, transport_factory: TransportFactory):
    results: list[CaptureResult] = []
    events: list[dict] = []
    for product in products:
        spec = PRODUCTS.get(product)
        if spec is None:
            print(f"unknown product {product!r} (expected chatgpt|claude)", file=sys.stderr)
            continue
        origin, store, capture = spec
        staging_root = store_roots[store]
        transport = transport_factory(origin)
        try:
            results.append(capture(transport, st, staging_root, events))
        except CdpError as e:
            # Chrome not reachable / no tab open: a real operational error, surfaced both to the
            # console and (buffered) to the next heartbeat — but capture of the OTHER product still runs.
            print(f"[FAIL] {product} webcapture: {e}", file=sys.stderr)
            events.append({
                "level": "error", "code": "webcapture_cdp_error",
                "message": f"{product}: {e}"[:500], "count": 1, "store": store,
            })
            results.append(CaptureResult(product=product, logged_in=False, errors=1))
        except OSError as e:
            # A full/unwritable staging disk makes mkdir()/write_text() raise OSError, which is NOT a
            # CdpError — without this it would abort the whole command before the OTHER product runs
            # and before any heartbeat event is buffered. Record it like a CDP failure so scheduled
            # captures never fail silently, and keep going.
            print(f"[FAIL] {product} webcapture staging I/O: {e}", file=sys.stderr)
            events.append({
                "level": "error", "code": "webcapture_io_error",
                "message": f"{product}: staging write failed: {e}"[:500], "count": 1, "store": store,
            })
            results.append(CaptureResult(product=product, logged_in=False, errors=1))
        finally:
            # An already-broken DevTools socket can make close() raise. That must NEVER escape here:
            # it would drop the events accumulated so far AND skip the remaining product(s). Cleanup
            # can't mask the capture result — swallow it (noted to the console).
            try:
                transport.close()
            except Exception as e:  # noqa: BLE001 - a cleanup failure must not mask the capture result
                print(f"[warn] {product} transport close failed: {e}", file=sys.stderr)
    return results, events
