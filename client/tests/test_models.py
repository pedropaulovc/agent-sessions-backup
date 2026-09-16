from agent_sessions_client.models import UsageRow


def usage_row(bucket, *, cache_basis=None, input_tokens=0, output_tokens=0, reasoning_tokens=0, cache_read_tokens=0, cache_creation_5m_tokens=0, cache_creation_1h_tokens=0):
    return UsageRow(
        bucket=bucket,
        calls=1,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        reasoning_tokens=reasoning_tokens,
        cache_read_tokens=cache_read_tokens,
        cache_creation_5m_tokens=cache_creation_5m_tokens,
        cache_creation_1h_tokens=cache_creation_1h_tokens,
        cache_basis=cache_basis,
    )


def test_total_tokens_disjoint_basis_adds_cache_read():
    # "disjoint" means the source reported cache reads BESIDE input (OMP for every provider,
    # claude-code): they are real tokens nothing else counts, so dropping them undercounts.
    row = usage_row("claude-sonnet-5", cache_basis="disjoint", input_tokens=100, output_tokens=200, cache_read_tokens=50, cache_creation_5m_tokens=5, cache_creation_1h_tokens=3)
    assert row.total_tokens == 100 + 200 + 50 + 5 + 3


def test_total_tokens_subset_basis_excludes_cached_input_and_reasoning():
    # Exact numbers from hub/test/fixtures.ts's codex usage fixture. Under "subset" the cache
    # read is inside input_tokens and the reasoning count is inside output_tokens — the real
    # total is 980 (900+80), not 1000 (reasoning double-counted) or 1480 (cache read too).
    row = usage_row("gpt-5.6-sol", cache_basis="subset", input_tokens=900, output_tokens=80, reasoning_tokens=20, cache_read_tokens=500)
    assert row.total_tokens == 980


def test_total_tokens_mixed_basis_falls_back_to_the_conservative_total():
    # A bucket aggregating both conventions (a day/machine/repo grouping spanning OMP and
    # Codex sessions) has no single right total; this value feeds "biggest spender" rankings,
    # where an undercount is safer than a double count.
    row = usage_row("2026-07-18", cache_basis="mixed", input_tokens=900, output_tokens=80, reasoning_tokens=20, cache_read_tokens=500)
    assert row.total_tokens == 980


def test_total_tokens_unknown_basis_falls_back_to_the_conservative_total():
    # None is "no row under this bucket recorded a convention" — unknown, not zero and not a
    # default of either convention.
    row = usage_row("2026-07-18", cache_basis=None, input_tokens=900, output_tokens=80, reasoning_tokens=20, cache_read_tokens=500)
    assert row.total_tokens == 980


def test_total_tokens_ignores_a_model_shaped_bucket_label():
    # The regression that matters: this used to switch on a `claude` prefix in the label. The
    # convention is a property of the ingested transcript source, not of the model — an
    # OMP-recorded gpt-* bucket is disjoint (the prefix rule silently dropped all 500 of its
    # cache reads) while a claude-named bucket can be subset. Identical numbers, identical
    # labels, different basis => different totals; identical basis, different labels => same.
    omp_gpt = usage_row("gpt-5.6-sol", cache_basis="disjoint", input_tokens=900, output_tokens=80, reasoning_tokens=20, cache_read_tokens=500)
    codex_gpt = usage_row("gpt-5.6-sol", cache_basis="subset", input_tokens=900, output_tokens=80, reasoning_tokens=20, cache_read_tokens=500)
    claude_named = usage_row("claude-fable-5", cache_basis="subset", input_tokens=900, output_tokens=80, reasoning_tokens=20, cache_read_tokens=500)
    assert omp_gpt.total_tokens == 1480
    assert codex_gpt.total_tokens == 980
    assert claude_named.total_tokens == 980
