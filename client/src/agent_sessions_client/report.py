"""Daily activity report: turns SessionsPage + UsageReport + HubStatus into markdown."""

from __future__ import annotations

from collections import Counter

from .models import HubStatus, SessionMeta, SessionsPage, UsageReport

NOTABLE_COUNT = 5
STALE_MACHINE_NOTE = (
    "has not reported a completed scan through the end of this report's date — "
    "session counts for it may be an undercount"
)
# Codex's history.jsonl running-log ingestion (see docs/agents-api.md) surfaces as this
# synthetic harness — not a bounded interactive session, so it's excluded from size/duration
# rankings (it would dominate every one) but still counted in the per-harness table.
PROMPT_LOG_HARNESS = "prompt-log"


def build_daily_report(
    *,
    date: str,
    sessions_page: SessionsPage,
    usage_report: UsageReport,
    status: HubStatus,
    machine: str | None = None,
    harness: str | None = None,
) -> str:
    # /api/v1/usage and /api/v1/status have no machine/harness query params (verified against
    # the deployed hub — see docs/agents-api.md's contract-gaps section and task #11) — so
    # when either CLI filter is active, those two sections cover more than the sessions list
    # does, and must say so rather than silently presenting fleet-wide numbers as scoped ones.
    filtered = machine is not None or harness is not None
    lines: list[str] = [f"# Daily Activity Report — {date}", ""]
    lines += _caveats_section(date, sessions_page, status, machine=machine, filtered=filtered)
    lines += _counts_section(sessions_page.sessions)
    lines += _notable_sessions_section(sessions_page.sessions)
    lines += _usage_section(usage_report, filtered=filtered)
    return "\n".join(lines).rstrip() + "\n"


def _caveats_section(date: str, page: SessionsPage, status: HubStatus, *, machine: str | None, filtered: bool) -> list[str]:
    end_of_day = f"{date}T23:59:59.999Z"
    caveats: list[str] = []
    if page.truncated:
        caveats.append(
            f"- The session list hit the hub's {len(page.sessions)}-row cap for this window "
            "(`/api/v1/sessions` has no pagination cursor) — counts below may be an undercount."
        )
    # /api/v1/status has no harness dimension (only /api/v1/sessions does), so a --harness-only
    # filter can't narrow which machines are in scope — any machine could run that harness.
    # Only --machine unambiguously narrows this to one machine.
    relevant_machines = [m for m in status.machines if machine is None or m.machine_id == machine]
    for m in relevant_machines:
        if m.indexed_through is None or m.indexed_through < end_of_day:
            caveats.append(f"- `{m.machine_id}` {STALE_MACHINE_NOTE} (indexed_through={m.indexed_through or 'never'}).")
        # A machine can have a perfectly fresh heartbeat (indexed_through caught up) and still
        # have files sitting in files.parse_state='pending'/'error' — an upload only becomes a
        # `sessions` row once the queue consumer parses it (hub/src/ingest/consumer.ts), so
        # "heartbeat is fresh" does NOT imply "everything uploaded today is already counted
        # below." Surface this independently of the staleness check above.
        if m.files_pending > 0 or m.files_error > 0:
            caveats.append(
                f"- `{m.machine_id}`: {m.files_pending} files uploaded but not yet parsed / "
                f"{m.files_error} failed parse — today's counts may be incomplete."
            )
    if page.indexed_through and page.indexed_through < end_of_day:
        scope_note = " — this is fleet-wide across all machines, not scoped to your --machine/--harness filter" if filtered else ""
        caveats.append(
            f"- The bulk endpoint's global `indexed_through` ({page.indexed_through}) is before the end of "
            f"{date}{scope_note} — at least one machine may not have finished syncing yet."
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
    # prompt-log rows are excluded from ranking (see PROMPT_LOG_HARNESS) but stay in the
    # per-harness count table above — this section only reorders/picks from the rest.
    candidates = [s for s in sessions if s.harness != PROMPT_LOG_HARNESS]
    if not candidates:
        return []
    lines = ["## Notable sessions", ""]
    by_size = sorted(candidates, key=lambda s: s.block_count, reverse=True)[:NOTABLE_COUNT]
    lines.append("**Largest by block count:**")
    lines.append("")
    for s in by_size:
        lines.append(f"- `{s.session_id}` ({s.harness}, {s.machine_id}) — {s.block_count} blocks, {s.turn_count} turns, cwd={s.cwd or 'n/a'}")
    lines.append("")

    timed = [s for s in candidates if s.duration_seconds() is not None]
    by_duration = sorted(timed, key=lambda s: s.duration_seconds() or 0, reverse=True)[:NOTABLE_COUNT]
    if by_duration:
        lines.append("**Longest by duration:**")
        lines.append("")
        for s in by_duration:
            minutes = (s.duration_seconds() or 0) / 60
            lines.append(f"- `{s.session_id}` ({s.harness}, {s.machine_id}) — {minutes:.1f} min, cwd={s.cwd or 'n/a'}")
        lines.append("")
    return lines


def _usage_section(usage: UsageReport, *, filtered: bool) -> list[str]:
    heading = "## Token spend per model"
    if filtered:
        heading += " (fleet-wide — /api/v1/usage has no machine/harness filter)"
    lines = [heading, ""]
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
