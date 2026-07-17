"""agent-collector CLI: enroll | install | run | backfill | status | doctor | uninstall.

webcapture and renew are later-milestone stubs.
"""

from __future__ import annotations

import argparse
import sys

from . import config as config_mod
from . import run as run_mod
from . import schedule


def _cmd_enroll(args) -> int:
    if not args.dev and not (args.client_cert or args.client_key):
        print("enroll: pass --dev, or --client-cert/--client-key for mTLS", file=sys.stderr)
        return 2
    cfg = config_mod.enroll(
        args.hub,
        dev=args.dev,
        client_cert_path=args.client_cert,
        client_key_path=args.client_key,
    )
    print(f"wrote {cfg.source}")
    print(f"  machine_id: {cfg.machine_id}")
    print(f"  hub_url:    {cfg.hub_url}")
    print(f"  auth:       {cfg.auth}")
    if cfg.auth == "mtls":
        print(f"  client_cert_path: {cfg.client_cert_path}")
        print(f"  client_key_path:  {cfg.client_key_path}")
    return 0


def _cmd_install(args) -> int:
    return schedule.install(args.interval)


def _cmd_uninstall(_args) -> int:
    return schedule.uninstall()


def _not_implemented(name: str):
    def handler(_args) -> int:
        print(f"agent-collector {name}: lands in a later milestone", file=sys.stderr)
        return 2
    return handler


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-collector")
    sub = parser.add_subparsers(dest="command", required=True)

    p_enroll = sub.add_parser("enroll", help="write config (--dev, or --client-cert/--client-key for mTLS)")
    p_enroll.add_argument("--hub", required=True, help="hub base URL, e.g. https://api.sessions.vza.net")
    p_enroll.add_argument("--dev", action="store_true", help="dev auth (x-dev-machine header)")
    p_enroll.add_argument("--client-cert", help="mTLS: path to the PEM client cert (from enroll-cert.sh)")
    p_enroll.add_argument("--client-key", help="mTLS: path to the client private key (from enroll-cert.sh)")
    p_enroll.set_defaults(func=_cmd_enroll)

    p_install = sub.add_parser("install", help="install periodic scheduler")
    p_install.add_argument("--interval", type=int, default=15, help="minutes between runs")
    p_install.set_defaults(func=_cmd_install)

    p_uninstall = sub.add_parser("uninstall", help="remove periodic scheduler")
    p_uninstall.set_defaults(func=_cmd_uninstall)

    p_run = sub.add_parser("run", help="one incremental pass")
    p_run.add_argument("--once", action="store_true", help="single pass (default)")
    p_run.add_argument("--config", default=None, help="config path override")
    p_run.set_defaults(func=run_mod.cmd_run)

    p_backfill = sub.add_parser("backfill", help="hash all, upload what the hub lacks")
    p_backfill.add_argument("--concurrency", type=int, default=6)
    p_backfill.add_argument("--dry-run", action="store_true")
    p_backfill.add_argument("--config", default=None)
    p_backfill.set_defaults(func=run_mod.cmd_backfill)

    p_status = sub.add_parser("status", help="last run, pending/error files, config")
    p_status.add_argument("--config", default=None)
    p_status.set_defaults(func=run_mod.cmd_status)

    p_doctor = sub.add_parser("doctor", help="preflight checks")
    p_doctor.add_argument("--config", default=None)
    p_doctor.set_defaults(func=run_mod.cmd_doctor)

    p_web = sub.add_parser("webcapture", help="(later milestone)")
    p_web.set_defaults(func=_not_implemented("webcapture"))
    p_renew = sub.add_parser("renew", help="(later milestone)")
    p_renew.set_defaults(func=_not_implemented("renew"))

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
