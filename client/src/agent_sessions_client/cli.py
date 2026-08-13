"""`agent-sessions` CLI. Subcommands: auth (mint a passkey-approved read grant),
daily-report."""

from __future__ import annotations

import argparse
import re
import sys
import webbrowser
from datetime import date as date_cls
from datetime import datetime as datetime_cls
from datetime import timezone
from pathlib import Path

from .config import load_config
from .endpoints import SessionsApi
from .grant import DEFAULT_VIEWER_URL, GrantError, mint_grant, parse_ttl, save_grant
from .http import HubClient, HubError
from .report import build_daily_report

# Strict YYYY-MM-DD: exactly 4-2-2 digits. Needed ALONGSIDE strptime, not instead of it —
# datetime.strptime("%Y-%m-%d") is NOT strict about zero-padding despite the format string
# implying it (verified: strptime("2026-7-8", "%Y-%m-%d") parses fine, same as "2026-07-08"),
# so strptime alone doesn't reject the unpadded shape this check exists for. The regex catches
# the shape; strptime (below) still catches shape-valid-but-not-a-real-date input like
# "2026-02-30" or "2026-13-01" that the regex can't.
_STRICT_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _daily_report(args: argparse.Namespace) -> int:
    if args.date is not None:
        try:
            valid = bool(_STRICT_DATE_RE.match(args.date))
            if valid:
                datetime_cls.strptime(args.date, "%Y-%m-%d")
        except ValueError:
            valid = False
        if not valid:
            # The hub only inclusive-expands a strict YYYY-MM-DD date-only `to` bound (see
            # normalizeToBound in hub/src/api/sessions.ts) — a malformed date must be rejected
            # here, not silently forwarded to mis-scope (or empty) the query.
            print(f"error: invalid --date '{args.date}', expected YYYY-MM-DD", file=sys.stderr)
            return 2
    report_date = args.date or date_cls.today().isoformat()
    try:
        config = load_config(
            hub_url=args.hub_url,
            config_path=Path(args.config) if args.config else None,
            client_cert_path=args.client_cert,
            client_key_path=args.client_key,
            grant_token=args.grant_token,
        )
        # HubClient's constructor loads the mTLS cert chain eagerly — a stale/moved cert path
        # raises here, not on the first request, so it belongs in this same config-error try
        # block (both map to the ValueError-> "error: ..." + exit 2 path below).
        api = SessionsApi(HubClient(config))
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    try:
        sessions_page = api.list_sessions(from_=report_date, to=report_date, machine=args.machine, harness=args.harness)
        usage_report = api.usage(
            group_by="model", from_=report_date, to=report_date, machine=args.machine, harness=args.harness
        )
        status = api.status()
    except HubError as e:
        print(f"error: {e}", file=sys.stderr)
        if e.body:
            print(e.body, file=sys.stderr)
        return 1

    report = build_daily_report(
        date=report_date,
        sessions_page=sessions_page,
        usage_report=usage_report,
        status=status,
        machine=args.machine,
        harness=args.harness,
    )
    if args.out:
        Path(args.out).write_text(report)
    else:
        print(report, end="")
    return 0


def _auth(args: argparse.Namespace) -> int:
    try:
        ttl_seconds = parse_ttl(args.ttl)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    def open_url(url: str) -> None:
        # Always print the URL: webbrowser.open silently no-ops on headless boxes, and the
        # owner may be approving from a different device anyway.
        print(f"Approve the read grant in your browser:\n  {url}", file=sys.stderr)
        if not args.no_browser:
            webbrowser.open(url)

    try:
        grant = mint_grant(
            hub_url=args.hub_url or "https://api.sessions.vza.net",
            viewer_url=args.viewer_url,
            label=args.label,
            ttl_seconds=ttl_seconds,
            open_url=open_url,
            timeout=args.timeout,
        )
    except GrantError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    try:
        path = save_grant(grant, Path(args.grant_cache) if args.grant_cache else None)
    except OSError as e:
        # The grant was minted (the owner already approved) but caching it failed — surface
        # the documented `error: ...` + nonzero exit rather than a traceback.
        print(f"error: failed to save read grant: {e}", file=sys.stderr)
        return 1
    expires = datetime_cls.fromtimestamp(grant["expiresAt"] / 1000, tz=timezone.utc)
    print(f"read grant saved to {path} (label {grant.get('label')!r}, expires {expires.isoformat()})", file=sys.stderr)
    if args.print_token:
        print(grant["token"])
    return 0


def _add_connection_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--hub-url", help="Override hub base URL (default from config.toml, else https://api.sessions.vza.net)")
    parser.add_argument("--config", help="Path to agent-collector config.toml (default ~/.config/agent-collector/config.toml)")
    parser.add_argument("--client-cert", help="mTLS client cert path (overrides config)")
    parser.add_argument("--client-key", help="mTLS client key path (overrides config)")
    parser.add_argument("--grant-token", help="Read-grant bearer (agsr_…); default from $AGENT_SESSIONS_GRANT_TOKEN or the `agent-sessions auth` cache")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-sessions", description="Client CLI for the AI agent session hub")
    sub = parser.add_subparsers(dest="command", required=True)

    auth_cmd = sub.add_parser("auth", help="Mint a passkey-approved read grant (browser approval + PKCE loopback)")
    auth_cmd.add_argument("--label", help="Shown on the approval page and /settings (default agent@<hostname>)")
    auth_cmd.add_argument("--ttl", default="4h", help="Grant lifetime: e.g. 4h, 30m, 900 (seconds); 5m–24h (default 4h)")
    auth_cmd.add_argument("--hub-url", help="Hub API base URL for the token exchange (default https://api.sessions.vza.net)")
    auth_cmd.add_argument("--viewer-url", default=DEFAULT_VIEWER_URL, help=f"Viewer base URL serving /grant (default {DEFAULT_VIEWER_URL})")
    auth_cmd.add_argument("--grant-cache", help="Write the token here instead of ~/.config/agent-sessions/grant.json")
    auth_cmd.add_argument("--timeout", type=float, default=300.0, help="Seconds to wait for browser approval (default 300)")
    auth_cmd.add_argument("--no-browser", action="store_true", help="Print the approval URL instead of opening a browser")
    auth_cmd.add_argument("--print-token", action="store_true", help="Also print the raw token to stdout (for piping into env)")
    auth_cmd.set_defaults(func=_auth)

    report_cmd = sub.add_parser("daily-report", help="Generate a markdown daily activity report")
    report_cmd.add_argument("--date", help="Report date, YYYY-MM-DD (default: today's local date)")
    report_cmd.add_argument("--machine", help="Filter to one machine_id")
    report_cmd.add_argument("--harness", help="Filter to one harness")
    report_cmd.add_argument("--out", help="Write markdown to this path instead of stdout")
    _add_connection_args(report_cmd)
    report_cmd.set_defaults(func=_daily_report)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
