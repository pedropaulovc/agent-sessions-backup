"""Raw Chrome DevTools Protocol transport for in-page first-party fetches.

Headless Chromium is blocked by Cloudflare on chatgpt.com/claude.ai, so capture drives a REAL
logged-in Chrome (started with --remote-debugging-port) over CDP and runs `fetch()` inside the
already-authenticated page — cookies ride along via `credentials:'include'`, no tokens handled
here. The transport is deliberately tiny (one method, `fetch(url) -> (status, text)`) and hidden
behind a Protocol so the drivers are fully testable against a fake with recorded-shape payloads,
with no browser anywhere in the test path. The websocket dependency (`websocket-client`) is
imported lazily so the base collector stays dependency-free — only the webcapture host installs
the `webcapture` extra.
"""

from __future__ import annotations

import json
import urllib.request
from typing import Protocol, runtime_checkable


@runtime_checkable
class CdpTransport(Protocol):
    def fetch(self, url: str) -> tuple[int, str]:
        """Run `fetch(url)` inside the page; return (http_status, response_text). status 0 marks
        a transport/JS failure (network error, page not reachable) as distinct from an HTTP code."""
        ...

    def close(self) -> None: ...


class CdpError(RuntimeError):
    pass


class ChromeCdpTransport:
    """Drives one already-open, logged-in Chrome tab whose URL matches `origin`."""

    def __init__(self, origin: str, host: str = "127.0.0.1", port: int = 9222, timeout: float = 30.0):
        self.origin = origin.rstrip("/")
        self.host = host
        self.port = port
        self.timeout = timeout
        self._ws = None
        self._msg_id = 0

    def _connect(self) -> None:
        if self._ws is not None:
            return
        try:
            import websocket  # lazy: only the webcapture host needs websocket-client
        except ImportError as e:  # pragma: no cover - exercised only without the extra installed
            raise CdpError(
                "webcapture needs the 'websocket-client' package: uv pip install "
                "'agent-collector[webcapture]'"
            ) from e

        targets = self._list_targets()
        target = next(
            (t for t in targets if t.get("type") == "page" and str(t.get("url", "")).startswith(self.origin)),
            None,
        )
        if target is None:
            raise CdpError(
                f"no open Chrome tab at {self.origin} (open one and sign in; start Chrome with "
                f"--remote-debugging-port={self.port})"
            )
        ws_url = target.get("webSocketDebuggerUrl")
        if not ws_url:
            raise CdpError(f"target for {self.origin} has no webSocketDebuggerUrl")
        try:
            # create_connection raises websocket/OS exceptions (tab closed, handshake failed), none
            # of which _run_products catches — normalize to CdpError so capture of the OTHER product
            # still runs and a heartbeat event is still buffered.
            self._ws = websocket.create_connection(ws_url, timeout=self.timeout, max_size=None)
        except Exception as e:  # noqa: BLE001 - any connect failure is an operational capture error
            raise CdpError(f"websocket connect to {self.origin} tab failed: {e}") from e

    def _list_targets(self) -> list[dict]:
        url = f"http://{self.host}:{self.port}/json"
        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except OSError as e:
            raise CdpError(f"cannot reach Chrome DevTools at {url}: {e}") from e
        # A 200 from a non-Chrome local service (or a Chrome behind a proxy that returns HTML) makes
        # this decode raise JSONDecodeError, or yields a dict/scalar; iterating a dict in _connect()
        # then calls .get on a string. _run_products only catches CdpError, so anything else here
        # would abort the whole command before the OTHER product runs — validate and wrap it.
        try:
            targets = json.loads(raw)
        except json.JSONDecodeError as e:
            raise CdpError(
                f"Chrome DevTools /json at {url} returned non-JSON "
                f"(is --port pointing at Chrome?): {e}"
            ) from e
        if not isinstance(targets, list) or not all(isinstance(t, dict) for t in targets):
            raise CdpError(f"Chrome DevTools /json at {url} did not return a list of target objects")
        return targets

    def fetch(self, url: str) -> tuple[int, str]:
        self._connect()
        # Resolve the fetch to a JSON string {status, body} so both are returned by value in one
        # round trip; a thrown network error becomes status 0 rather than crashing the driver.
        expression = (
            "(async () => { try {"
            f"  const r = await fetch({json.dumps(url)}, {{credentials:'include', headers:{{'accept':'application/json'}}}});"
            "  const body = await r.text();"
            "  return JSON.stringify({status: r.status, body});"
            "} catch (e) { return JSON.stringify({status: 0, body: String(e)}); } })()"
        )
        result = self._eval(expression)
        parsed = json.loads(result)
        return int(parsed["status"]), str(parsed["body"])

    def _eval(self, expression: str) -> str:
        self._msg_id += 1
        mid = self._msg_id
        try:
            self._ws.send(json.dumps({
                "id": mid,
                "method": "Runtime.evaluate",
                "params": {"expression": expression, "awaitPromise": True, "returnByValue": True},
            }))
            while True:
                msg = json.loads(self._ws.recv())
                if msg.get("id") != mid:
                    continue  # skip unrelated CDP events on the same socket
                if "error" in msg:
                    raise CdpError(f"CDP evaluate failed: {msg['error']}")
                result = msg.get("result", {})
                if result.get("exceptionDetails"):
                    raise CdpError(f"in-page fetch threw: {result['exceptionDetails']}")
                return result.get("result", {}).get("value", "")
        except CdpError:
            raise
        except Exception as e:  # noqa: BLE001 - a dropped/broken socket mid-eval is a capture error
            raise CdpError(f"CDP evaluate transport error on {self.origin}: {e}") from e

    def close(self) -> None:
        if self._ws is not None:
            try:
                self._ws.close()
            finally:
                self._ws = None


class FakeCdpTransport:
    """Test double: maps a URL to a canned (status, text) response. Exact match first, then the
    longest registered prefix, so paginated/parameterized URLs are easy to script. Records every
    fetched URL in `.calls` for assertions."""

    def __init__(self, responses: dict[str, tuple[int, str]] | None = None, default: tuple[int, str] = (404, "")):
        self.responses = dict(responses or {})
        self.default = default
        self.calls: list[str] = []

    def fetch(self, url: str) -> tuple[int, str]:
        self.calls.append(url)
        if url in self.responses:
            return self.responses[url]
        prefixes = [k for k in self.responses if url.startswith(k)]
        if prefixes:
            return self.responses[max(prefixes, key=len)]
        return self.default

    def close(self) -> None:
        pass
