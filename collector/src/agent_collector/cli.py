"""agent-collector CLI: enroll | install | run | backfill | webcapture | status | renew | doctor | uninstall."""

import argparse
import sys

COMMANDS = [
    "enroll",
    "install",
    "run",
    "backfill",
    "webcapture",
    "status",
    "renew",
    "doctor",
    "uninstall",
]


def main() -> int:
    parser = argparse.ArgumentParser(prog="agent-collector")
    parser.add_argument("command", choices=COMMANDS)
    args, _rest = parser.parse_known_args()
    print(f"agent-collector {args.command}: not implemented yet (M3)", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
