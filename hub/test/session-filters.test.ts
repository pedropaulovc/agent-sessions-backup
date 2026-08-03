import { describe, expect, it } from 'vitest';
import { searchHitsSql } from '../src/api/search';
import {
  buildSessionFilterSql,
  canonicalSessionFilterEntries,
  canonicalizeMultiValueFilters,
  FACET_DEFINITIONS,
  facetLabelValue,
  MAX_VALUES_PER_FILTER,
  mergeFacetCounts,
  selectedFacetValues,
  selectedValues,
} from '../src/session-filters';

function facet(key: string) {
  return FACET_DEFINITIONS.find((definition) => definition.key === key)!;
}

describe('session multi-value filters', () => {
  it('registers project as a first-class repeated column facet', () => {
    const project = facet('project_name');
    expect(project).toMatchObject({
      param: 'project',
      kind: 'column',
      column: 'project_name',
      label: 'Project',
    });

    const filter = buildSessionFilterSql(new URLSearchParams('project=alpha&project=beta'), 'sessions');
    expect(filter.clause).toBe(
      "sessions.project_name IN (SELECT value FROM json_each(?1)) AND " +
      "(CASE WHEN sessions.parent_session_id IS NOT NULL OR COALESCE(sessions.is_sidechain, 0) = 1 THEN 'yes' ELSE 'no' END) IN (SELECT value FROM json_each(?2))",
    );
    expect(filter.binds).toEqual(['["alpha","beta"]', '["no"]']);
  });

  it('defaults subagent filtering to primary sessions and keeps its facet disjunctive', () => {
    const subagent = facet('subagent');
    expect(subagent).toMatchObject({
      param: 'subagent',
      kind: 'subagent',
      label: 'Is subagent session',
    });
    expect(selectedValues(new URLSearchParams(), subagent)).toEqual(['no']);
    expect(selectedFacetValues(new URLSearchParams()).subagent).toEqual(['no']);
    expect(facetLabelValue(subagent, 'no')).toBe('No');
    expect(facetLabelValue(subagent, 'yes')).toBe('Yes');

    const absent = buildSessionFilterSql(new URLSearchParams(), 's');
    expect(absent).toEqual({
      clause: "(CASE WHEN s.parent_session_id IS NOT NULL OR COALESCE(s.is_sidechain, 0) = 1 THEN 'yes' ELSE 'no' END) IN (SELECT value FROM json_each(?1))",
      binds: ['["no"]'],
    });
    expect(buildSessionFilterSql(new URLSearchParams(), 's', 1, 'subagent')).toEqual({ clause: '', binds: [] });
    expect(searchHitsSql('', null, 20, 0)).toContain(
      "(CASE WHEN s.parent_session_id IS NOT NULL OR COALESCE(s.is_sidechain, 0) = 1 THEN 'yes' ELSE 'no' END) AS subagent",
    );
  });

  it('uses one deterministic subagent enum value rather than an OR union', () => {
    const subagent = facet('subagent');
    const params = new URLSearchParams('subagent=yes&subagent=no');

    expect(selectedValues(params, subagent)).toEqual(['yes']);
    expect(buildSessionFilterSql(params, 's')).toEqual({
      clause: "(CASE WHEN s.parent_session_id IS NOT NULL OR COALESCE(s.is_sidechain, 0) = 1 THEN 'yes' ELSE 'no' END) IN (SELECT value FROM json_each(?1))",
      binds: ['["yes"]'],
    });

    canonicalizeMultiValueFilters(params);
    expect(params.toString()).toBe('subagent=yes');
  });

  it('treats invalid subagent values as no without making an absent default canonical', () => {
    const subagent = facet('subagent');
    const invalid = new URLSearchParams('subagent=invalid&subagent=yes');

    expect(selectedValues(invalid, subagent)).toEqual(['no']);
    expect(buildSessionFilterSql(invalid, 's').binds).toEqual(['["no"]']);
    canonicalizeMultiValueFilters(invalid);
    expect(invalid.toString()).toBe('subagent=no');

    const absent = new URLSearchParams();
    canonicalizeMultiValueFilters(absent);
    expect(absent.toString()).toBe('');
    expect(canonicalSessionFilterEntries(absent)).toEqual([]);
  });

  it('keeps Repo as the final facet', () => {
    expect(FACET_DEFINITIONS.at(-1)?.key).toBe('repo_url');
  });

  it('trims, stable-dedupes, drops blanks, and caps each filter at 100', () => {
    const params = new URLSearchParams();
    params.append('harness', '  first  ');
    params.append('harness', 'second');
    params.append('harness', 'first');
    params.append('harness', '   ');
    for (let index = 0; index < 105; index++) params.append('harness', `extra-${index}`);

    const values = selectedValues(params, facet('harness'));
    expect(values).toHaveLength(MAX_VALUES_PER_FILTER);
    expect(values.slice(0, 4)).toEqual(['first', 'second', 'extra-0', 'extra-1']);
    expect(values).not.toContain('extra-104');
  });

  it('uses one bounded JSON bind per facet with IN inside and AND across facets', () => {
    const params = new URLSearchParams('harness=a&harness=b&machine=m1&machine=m2');
    const filter = buildSessionFilterSql(params, 'sessions');

    expect(filter.clause).toContain(
      'sessions.harness IN (SELECT value FROM json_each(?1))',
    );
    expect(filter.clause).toContain(
      'sessions.machine_id IN (SELECT value FROM json_each(?2))',
    );
    expect(filter.clause).toContain(') AND sessions.machine_id');
    expect(filter.binds).toEqual(['["a","b"]', '["m1","m2"]', '["no"]']);
  });

  it('dedupes and validates repeated date and duration buckets', () => {
    const params = new URLSearchParams(
      'session_date=%202026-07-01%20&session_date=bad&session_date=2026-07-01&' +
      'session_date=2026-07-02&session_time=%20under-5m%20&session_time=bad&session_time=over-2h',
    );

    expect(selectedValues(params, facet('session_date'))).toEqual(['2026-07-01', '2026-07-02']);
    expect(selectedValues(params, facet('session_time'))).toEqual(['under-5m', 'over-2h']);
    const filter = buildSessionFilterSql(params, 's', 2);
    expect(filter.clause).toContain('substr(s.started_at, 1, 10) IN (SELECT value FROM json_each(?2))');
    expect(filter.clause).toContain("CASE WHEN MAX(0, (julianday(s.ended_at)");
    expect(filter.clause).toContain('IN (SELECT value FROM json_each(?3))');
    expect(filter.clause).toContain(
      "CASE WHEN s.parent_session_id IS NOT NULL OR COALESCE(s.is_sidechain, 0) = 1 THEN 'yes' ELSE 'no' END",
    );
    expect(filter.clause).toContain('IN (SELECT value FROM json_each(?4))');
    expect(filter.binds).toEqual([
      '["2026-07-01","2026-07-02"]',
      '["under-5m","over-2h"]',
      '["no"]',
    ]);
  });

  it('filters sessions by the presence of a star', () => {
    const definition = facet('has_star');
    expect(definition).toMatchObject({
      param: 'has_star',
      kind: 'has-star',
      label: 'Has star',
    });

    const params = new URLSearchParams('has_star=1&has_star=0&has_star=yes&has_star=1');
    expect(selectedValues(params, definition)).toEqual(['1']);

    const filter = buildSessionFilterSql(params, 's', 3);
    expect(filter.clause).toBe(
      `(CASE WHEN EXISTS (SELECT 1 FROM starred_turns st WHERE st.session_id = s.session_id) THEN '1' END) ` +
      `IN (SELECT value FROM json_each(?3)) AND ` +
      `(CASE WHEN s.parent_session_id IS NOT NULL OR COALESCE(s.is_sidechain, 0) = 1 THEN 'yes' ELSE 'no' END) IN (SELECT value FROM json_each(?4))`,
    );
    expect(filter.binds).toEqual(['["1"]', '["no"]']);
    expect(buildSessionFilterSql(params, 's', 1, 'has_star')).toEqual({
      clause: "(CASE WHEN s.parent_session_id IS NOT NULL OR COALESCE(s.is_sidechain, 0) = 1 THEN 'yes' ELSE 'no' END) IN (SELECT value FROM json_each(?1))",
      binds: ['["no"]'],
    });
  });

  it('retains facet names that collide with Object prototype keys', () => {
    const counts = mergeFacetCounts(
      [{ v: '__proto__', n: 7 }],
      ['__proto__', 'constructor', 'toString'],
    );

    expect(Object.getPrototypeOf(counts)).toBeNull();
    expect(Object.entries(counts)).toEqual([
      ['__proto__', 7],
      ['constructor', 0],
      ['toString', 0],
    ]);
  });
});
