from agent_sessions_client.models import UsageRow


def usage_row(bucket, *, input_tokens=0, output_tokens=0, reasoning_tokens=0, cache_read_tokens=0, cache_creation_5m_tokens=0, cache_creation_1h_tokens=0):
    return UsageRow(
        bucket=bucket,
        calls=1,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        reasoning_tokens=reasoning_tokens,
        cache_read_tokens=cache_read_tokens,
        cache_creation_5m_tokens=cache_creation_5m_tokens,
        cache_creation_1h_tokens=cache_creation_1h_tokens,
    )


def test_total_tokens_anthropic_adds_disjoint_cache_read():
    # Anthropic: cache_read_tokens is billed/reported separately from input_tokens, so it's
    # additive.
    row = usage_row("claude-sonnet-5", input_tokens=100, output_tokens=200, reasoning_tokens=0, cache_read_tokens=50, cache_creation_5m_tokens=5, cache_creation_1h_tokens=3)
    assert row.total_tokens == 100 + 200 + 0 + 50 + 5 + 3


def test_total_tokens_openai_does_not_double_count_cached_input_or_reasoning():
    # Exact numbers from hub/test/fixtures.ts's codex usage fixture. Both cache_read_tokens
    # (from cached_input_tokens) and reasoning_tokens (from reasoning_output_tokens) are
    # SUBSETS of input_tokens/output_tokens respectively for OpenAI's Responses API — the
    # real total is 980 (900+80), not 1000 (reasoning double-counted) or 1480 (both are).
    row = usage_row("gpt-5.6-sol", input_tokens=900, output_tokens=80, reasoning_tokens=20, cache_read_tokens=500)
    assert row.total_tokens == 980


def test_total_tokens_codex_variant_model_name_also_excludes_cache_read_and_reasoning():
    row = usage_row("gpt-5.3-codex", input_tokens=900, output_tokens=80, reasoning_tokens=20, cache_read_tokens=500)
    assert row.total_tokens == 980


def test_total_tokens_non_model_bucket_conservatively_excludes_cache_read_and_reasoning():
    # group_by=machine/day/repo buckets mix rows from multiple providers under one aggregate
    # — there's no correct per-row answer, so this falls back to the conservative
    # (undercount, not double-count) OpenAI-style treatment rather than guessing.
    row = usage_row("amet-wsl", input_tokens=900, output_tokens=80, reasoning_tokens=20, cache_read_tokens=500)
    assert row.total_tokens == 980


def test_total_tokens_null_bucket_conservatively_excludes_cache_read_and_reasoning():
    # group_by=day buckets have no model-shaped bucket at all (bucket is a date string in
    # practice, but None is the defensive floor if the hub ever omits it).
    row = usage_row(None, input_tokens=900, output_tokens=80, reasoning_tokens=20, cache_read_tokens=500)
    assert row.total_tokens == 980


def test_total_tokens_synthetic_placeholder_bucket_is_harmless():
    # Production has a '<synthetic>' model placeholder (zero-token usage rows for turns with
    # no real API call) — doesn't start with 'claude', but all fields are 0 in practice, so
    # misclassifying it as non-additive changes nothing.
    row = usage_row("<synthetic>")
    assert row.total_tokens == 0
