"""`agent-sessions` CLI. Currently one subcommand: daily-report."""

from __future__ import annotations

import argparse
import sys
from datetime import date as date_cls
from pathlib import Path

from .config import load_config
from .endpoints import SessionsApi
from .http import HubClient, HubError
from .report import build_daily_report


def _daily_report(args: argparse.Namespace) -> int:
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
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    api = SessionsApi(HubClient(config))
    try:
        sessions_page = api.list_sessions(from_=report_date, to=report_date, machine=args.machine, harness=args.harness)
        usage_report = api.usage(group_by="model", from_=report_date, to=report_date)
        status = api.status()
    except HubError as e:
        print(f"error: {e}", file=sys.stderr)
        if e.body:
            print(e.body, file=sys.stderr)
        return 1

    report = build_daily_report(date=report_date, sessions_page=sessions_page, usage_report=usage_report, status=status)
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
