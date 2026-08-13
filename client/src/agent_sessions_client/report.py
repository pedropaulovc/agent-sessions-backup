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
    # /api/v1/usage now takes machine/harness, and cli.py forwards both, so the usage section
    # is scoped exactly like the sessions list and needs no fleet-wide disclaimer. /api/v1/status
    # still has no such params, and the sessions page's `indexed_through` is still a global
    # field — `filtered` marks those remaining spots, which must say so rather than silently
    # presenting fleet-wide numbers as scoped ones.
    filtered = machine is not None or harness is not None
    lines: list[str] = [f"# Daily Activity Report — {date}", ""]
    lines += _caveats_section(date, sessions_page, status, machine=machine, filtered=filtered)
    lines += _counts_section(sessions_page.sessions)
    lines += _notable_sessions_section(sessions_page.sessions)
    lines += _usage_section(usage_report)
    return "\n".join(lines).rstrip() + "\n"


def _caveats_section(date: str, page: SessionsPage, status: HubStatus, *, machine: str | None, filtered: bool) -> list[str]:
    end_of_day = f"{date}T23:59:59.999Z"
    caveats: list[str] = []
    # No "truncated" caveat here: SessionsApi.list_sessions() follows the hub's keyset cursor
    # transparently across as many requests as needed (see docs/agents-api.md), so
    # sessions_page always holds the complete matching set already.
    # /api/v1/status has no harness dimension (only /api/v1/sessions does), so a --harness-only
    # filter can't narrow which machines are in scope — any machine could run that harness.
    # Only --machine unambiguously narrows this to one machine.
    relevant_machines = [m for m in status.machines if machine is None or m.machine_id == machine]
    # A `machines` row that never heartbeated and never uploaded is not a collector — e.g.
    # a dev identity auto-registered by a reporting client (the historical x-dev-machine
    # path did this on first read). Left unfiltered, its indexed_through=null trips the
    # staleness check below on an identity that was never a data source. A real collector
    # that simply hasn't uploaded yet would still have a last_seen_at from its heartbeats,
    # so this predicate doesn't false-positive on a genuinely new machine.
    relevant_machines = [m for m in relevant_machines if not (m.last_seen_at is None and m.files_total == 0)]
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


def _usage_section(usage: UsageReport) -> list[str]:
    lines = ["## Token spend per model", ""]
    if not usage.rows:
        return [*lines, "No usage recorded in range.", ""]
    # A hub older than the pricing work sends no `cost_basis` and no `cost_usd`, which the models
    # default to 0.0. Printing that as "$0.00" under a "these are list-rate costs" note would
    # turn "the server did not compute pricing" into "this usage was free" during ordinary
    # client/server version skew. The response-level basis is the honest signal that the server
    # priced anything at all, so with it absent the column is dropped entirely.
    priced = usage.cost_basis is not None
    cost_header = " Cost (USD) |" if priced else ""
    cost_divider = "---|" if priced else ""
    lines.append(
        "| Model | Calls | Input | Output | Reasoning | Cache read | Cache write (5m/1h) |" + cost_header
    )
    lines.append("|---|---|---|---|---|---|---|" + cost_divider)
    for row in sorted(usage.rows, key=lambda r: r.total_tokens, reverse=True):
        model = row.bucket or "(unknown)"
        # An unpriced row's 0.00 would read as "this was free" rather than "we have no rate".
        cost = "—" if row.unpriced_calls and not row.cost_usd else _fmt_cost(row.cost_usd)
        lines.append(
            f"| {model} | {row.calls} | {row.input_tokens:,} | {row.output_tokens:,} | {row.reasoning_tokens:,} "
            f"| {row.cache_read_tokens:,} | {row.cache_creation_5m_tokens:,}/{row.cache_creation_1h_tokens:,} |"
            + (f" {cost} |" if priced else "")
        )
    lines.append("")
    lines += _cost_note(usage) if priced else [_NO_PRICING_NOTE]
    lines.append("")
    return lines


_NO_PRICING_NOTE = "_Token counts only — this hub did not return pricing, so no dollar figure is available._"


def _fmt_cost(usd: float) -> str:
    """Never print a nonzero cost as `$0.00`.

    Two decimals is the right resolution for a day's spend and the wrong one for a single
    low-volume model bucket: `cost_usd=0.004` rendered as `$0.00`, and since the report carries no
    more precise figure anywhere, real usage was presented as free. A true zero still prints
    `$0.00` -- the marker has to mean "too small to show at this precision", not "cheap".
    """
    if usd == 0:
        return "$0.00"
    # Keyed off the rendered string, not a 0.005 threshold: the threshold has to agree with
    # whatever rounding the format applies, and it does not have to -- 0.005 itself formats as
    # "$0.00" under round-half-even.
    formatted = f"${usd:,.2f}"
    return "<$0.01" if formatted in ("$0.00", "$-0.00") else formatted


# The number is a list-price equivalent, NOT a bill: these tokens were very likely burned under
# a flat-rate subscription, and this hub has no visibility into what was actually charged. Any
# report that prints a dollar figure has to carry that qualifier next to it, or a downstream
# agent reading this file will report it as spend.
_COST_BASIS_NOTE = {
    "litellm_list_price": "at LiteLLM list rates",
    "litellm_list_price_batch": "at LiteLLM batch-tier list rates",
    # `batch=1` is a request, not a guarantee: models with no published batch tier fall back to
    # their standard rates, so a batch query spanning providers mixes the two.
    "litellm_list_price_batch_partial": (
        "at LiteLLM batch-tier list rates where published, standard rates for the rest"
    ),
}


def _cost_note(usage: UsageReport) -> list[str]:
    basis = _COST_BASIS_NOTE.get(usage.cost_basis or "", "at list rates")
    note = (
        f"_Cost is what these tokens would have cost {basis} on the metered API — "
        "not an invoice, and not what a flat-rate plan actually charged._"
    )
    if not usage.unpriced_models:
        return [note]
    models = ", ".join(f"`{m}`" for m in sorted(usage.unpriced_models))
    return [
        note,
        "",
        # NOT "no published rate". `unpriced_calls` is one counter for several distinct failure
        # modes: a missing catalog rate, yes, but also a timestamp too ambiguous to pick a
        # snapshot, an unknown cache-accounting convention, and a rate missing for just one token
        # class the call used. Naming the catalog specifically sends readers hunting for a
        # coverage gap that may not exist.
        f"_Totals are a floor: {usage.unpriced_calls:,} calls could not be priced ({models})._",
    ]
