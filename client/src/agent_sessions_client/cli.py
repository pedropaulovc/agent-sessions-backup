"""`agent-sessions` CLI. Currently one subcommand: daily-report."""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date as date_cls
from datetime import datetime as datetime_cls
from pathlib import Path

from .config import load_config
from .endpoints import SessionsApi
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
            bearer_token=args.bearer_token,
            dev_machine=args.dev_machine,
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
        usage_report = api.usage(group_by="model", from_=report_date, to=report_date)
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


def _add_connection_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--hub-url", help="Override hub base URL (default from config.toml, else https://api.sessions.vza.net)")
    parser.add_argument("--config", help="Path to agent-collector config.toml (default ~/.config/agent-collector/config.toml)")
    parser.add_argument("--client-cert", help="mTLS client cert path (overrides config)")
    parser.add_argument("--client-key", help="mTLS client key path (overrides config)")
    parser.add_argument("--bearer-token", help="DEV_AUTH bearer token, for preview environments only")
    parser.add_argument("--dev-machine", help="x-dev-machine identity to present alongside --bearer-token")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-sessions", description="Client CLI for the AI agent session hub")
    sub = parser.add_subparsers(dest="command", required=True)

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
