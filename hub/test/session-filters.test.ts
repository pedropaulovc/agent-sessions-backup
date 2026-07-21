import { describe, expect, it } from 'vitest';
import {
  buildSessionFilterSql,
  FACET_DEFINITIONS,
  MAX_VALUES_PER_FILTER,
  mergeFacetCounts,
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
    expect(filter.clause).toBe('sessions.project_name IN (SELECT value FROM json_each(?1))');
    expect(filter.binds).toEqual(['["alpha","beta"]']);
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
    expect(filter.binds).toEqual(['["a","b"]', '["m1","m2"]']);
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
    expect(filter.binds).toEqual([
      '["2026-07-01","2026-07-02"]',
      '["under-5m","over-2h"]',
    ]);
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
