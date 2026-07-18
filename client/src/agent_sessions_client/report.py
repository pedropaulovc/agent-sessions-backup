"""Daily activity report: turns SessionsPage + UsageReport + HubStatus into markdown."""

from __future__ import annotations

from collections import Counter

from .models import HubStatus, SessionMeta, SessionsPage, UsageReport

NOTABLE_COUNT = 5
STALE_MACHINE_NOTE = (
    "has not reported a completed scan through the end of this report's date — "
    "session counts for it may be an undercount"
)


def build_daily_report(*, date: str, sessions_page: SessionsPage, usage_report: UsageReport, status: HubStatus) -> str:
    lines: list[str] = [f"# Daily Activity Report — {date}", ""]
    lines += _caveats_section(date, sessions_page, status)
    lines += _counts_section(sessions_page.sessions)
    lines += _notable_sessions_section(sessions_page.sessions)
    lines += _usage_section(usage_report)
    return "\n".join(lines).rstrip() + "\n"


def _caveats_section(date: str, page: SessionsPage, status: HubStatus) -> list[str]:
    end_of_day = f"{date}T23:59:59.999Z"
    caveats: list[str] = []
    if page.truncated:
        caveats.append(
            f"- The session list hit the hub's {len(page.sessions)}-row cap for this window "
            "(`/api/v1/sessions` has no pagination cursor) — counts below may be an undercount."
        )
    for m in status.machines:
        if m.indexed_through is None or m.indexed_through < end_of_day:
            caveats.append(f"- `{m.machine_id}` {STALE_MACHINE_NOTE} (indexed_through={m.indexed_through or 'never'}).")
    if page.indexed_through and page.indexed_through < end_of_day:
        caveats.append(
            f"- The bulk endpoint's global `indexed_through` ({page.indexed_through}) is before the end of "
            f"{date} — at least one machine may not have finished syncing yet."
        )
    if not caveats:
        return []
    return ["## Staleness caveats", "", *caveats, ""]


def _counts_section(sessions: list[SessionMeta]) -> list[str]:
    lines = ["## Session counts", ""]
    by_machine_harness: Counter[tuple[str, str]] = Counter()
    for s in sessions:
        by_machine_harness[(s.machine_id or "unknown", s.harness)] += 1
    if not by_machine_harness:
        return [*lines, "No sessions in range.", ""]
    lines.append("| Machine | Harness | Sessions |")
    lines.append("|---|---|---|")
    for (machine, harness), n in sorted(by_machine_harness.items()):
        lines.append(f"| {machine} | {harness} | {n} |")
    lines.append("")
    lines.append(f"**Total: {len(sessions)} sessions**")
    lines.append("")
    return lines


def _notable_sessions_section(sessions: list[SessionMeta]) -> list[str]:
    if not sessions:
        return []
    lines = ["## Notable sessions", ""]
    by_size = sorted(sessions, key=lambda s: s.block_count, reverse=True)[:NOTABLE_COUNT]
    lines.append("**Largest by block count:**")
    lines.append("")
    for s in by_size:
        lines.append(f"- `{s.session_id}` ({s.harness}, {s.machine_id}) — {s.block_count} blocks, {s.turn_count} turns, cwd={s.cwd or 'n/a'}")
    lines.append("")

    timed = [s for s in sessions if s.duration_seconds() is not None]
    by_duration = sorted(timed, key=lambda s: s.duration_seconds() or 0, reverse=True)[:NOTABLE_COUNT]
    if by_duration:
        lines.append("**Longest by duration:**")
        lines.append("")
        for s in by_duration:
            minutes = (s.duration_seconds() or 0) / 60
            lines.append(f"- `{s.session_id}` ({s.harness}, {s.machine_id}) — {minutes:.1f} min, cwd={s.cwd or 'n/a'}")
        lines.append("")
    return lines


def _usage_section(usage: UsageReport) -> list[str]:
    lines = ["## Token spend per model", ""]
    if not usage.rows:
        return [*lines, "No usage recorded in range.", ""]
    lines.append("| Model | Calls | Input | Output | Reasoning | Cache read | Cache write (5m/1h) |")
    lines.append("|---|---|---|---|---|---|---|")
    for row in sorted(usage.rows, key=lambda r: r.total_tokens, reverse=True):
        model = row.bucket or "(unknown)"
        lines.append(
            f"| {model} | {row.calls} | {row.input_tokens:,} | {row.output_tokens:,} | {row.reasoning_tokens:,} "
            f"| {row.cache_read_tokens:,} | {row.cache_creation_5m_tokens:,}/{row.cache_creation_1h_tokens:,} |"
        )
    lines.append("")
    lines.append("_Token counts only — the hub does not track per-model pricing, so no dollar figure is computed here._")
    lines.append("")
    return lines
