import { normalizeToBound } from './api/sessions';

export const MAX_VALUES_PER_FILTER = 100;

export const SESSION_TIME_BUCKETS = [
  { value: 'under-5m', label: 'Under 5 minutes', min: 0, max: 5 * 60 },
  { value: '5m-30m', label: '5–30 minutes', min: 5 * 60, max: 30 * 60 },
  { value: '30m-2h', label: '30 minutes–2 hours', min: 30 * 60, max: 2 * 60 * 60 },
  { value: 'over-2h', label: 'Over 2 hours', min: 2 * 60 * 60, max: null },
] as const;

type SessionColumn = 'harness' | 'machine_id' | 'os' | 'primary_model' | 'repo_url' | 'project_name' | 'cwd';
type FacetOrder = 'count' | 'value-desc' | 'bucket';

export interface MultiValueFilterDefinition {
  key: string;
  param: string;
  kind: 'column' | 'session-date' | 'session-time';
  column?: SessionColumn;
  label?: string;
  facetOrder?: FacetOrder;
  valueLimit?: number;
}

/** Adding a column-backed facet (for example project_name) should require only one entry here. */
export const FACET_DEFINITIONS: readonly MultiValueFilterDefinition[] = [
  { key: 'harness', param: 'harness', kind: 'column', column: 'harness', label: 'Harness', facetOrder: 'count', valueLimit: 200 },
  { key: 'machine_id', param: 'machine', kind: 'column', column: 'machine_id', label: 'Machine', facetOrder: 'count', valueLimit: 200 },
  { key: 'os', param: 'os', kind: 'column', column: 'os', label: 'OS', facetOrder: 'count', valueLimit: 200 },
  { key: 'primary_model', param: 'model', kind: 'column', column: 'primary_model', label: 'Model', facetOrder: 'count', valueLimit: 200 },
  { key: 'repo_url', param: 'repo', kind: 'column', column: 'repo_url', label: 'Repo', facetOrder: 'count' },
  { key: 'project_name', param: 'project', kind: 'column', column: 'project_name', label: 'Project', facetOrder: 'count', valueLimit: 200 },
  { key: 'session_date', param: 'session_date', kind: 'session-date', label: 'Session date/time', facetOrder: 'value-desc' },
  { key: 'session_time', param: 'session_time', kind: 'session-time', label: 'Session time', facetOrder: 'bucket' },
] as const;

const NON_FACET_MULTI_FILTERS: readonly MultiValueFilterDefinition[] = [
  { key: 'cwd', param: 'cwd', kind: 'column', column: 'cwd' },
];

const ALL_MULTI_FILTERS = [...FACET_DEFINITIONS, ...NON_FACET_MULTI_FILTERS];
const SESSION_TIME_VALUES = new Set<string>(SESSION_TIME_BUCKETS.map((bucket) => bucket.value));

export interface SessionFilterSql {
  clause: string;
  binds: string[];
}

export function sessionDurationSql(alias: string): string {
  return `MAX(0, (julianday(${alias}.ended_at) - julianday(${alias}.started_at)) * 86400)`;
}

export function totalTokensSql(alias: string): string {
  // Reasoning output is already included in output tokens, and cached input is not new work.
  return `COALESCE(${alias}.tokens_in, 0) + COALESCE(${alias}.tokens_out, 0)`;
}

export function facetExpressionSql(definition: MultiValueFilterDefinition, alias: string): string {
  if (definition.kind === 'column') return `${alias}.${definition.column}`;
  if (definition.kind === 'session-date') return `substr(${alias}.started_at, 1, 10)`;

  const duration = sessionDurationSql(alias);
  const cases = SESSION_TIME_BUCKETS.map((bucket) => {
    const upper = bucket.max === null ? '' : ` AND ${duration} < ${bucket.max}`;
    return `WHEN ${duration} >= ${bucket.min}${upper} THEN '${bucket.value}'`;
  }).join(' ');
  return `(CASE ${cases} END)`;
}

export function facetOrderSql(definition: MultiValueFilterDefinition): string {
  if (definition.facetOrder === 'value-desc') return 'v DESC';
  if (definition.facetOrder === 'bucket') {
    const cases = SESSION_TIME_BUCKETS.map((bucket, index) => `WHEN '${bucket.value}' THEN ${index}`).join(' ');
    return `CASE v ${cases} ELSE ${SESSION_TIME_BUCKETS.length} END`;
  }
  return 'n DESC, v';
}

export function selectedValues(params: URLSearchParams, definition: MultiValueFilterDefinition): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const rawValue of params.getAll(definition.param)) {
    const value = rawValue.trim();
    if (!value || seen.has(value) || !validValue(definition, value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length === MAX_VALUES_PER_FILTER) break;
  }
  return values;
}

export function selectedFacetValues(params: URLSearchParams): Record<string, string[]> {
  return Object.fromEntries(FACET_DEFINITIONS.map((definition) => [
    definition.key,
    selectedValues(params, definition),
  ]));
}

export function canonicalSessionFilterEntries(params: URLSearchParams): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const definition of ALL_MULTI_FILTERS) {
    for (const value of selectedValues(params, definition)) entries.push([definition.param, value]);
  }
  for (const param of ['from', 'to'] as const) {
    const value = params.get(param);
    if (value) entries.push([param, value]);
  }
  return entries;
}

export function canonicalizeMultiValueFilters(params: URLSearchParams): void {
  const canonical = ALL_MULTI_FILTERS.map((definition) => ({
    definition,
    values: selectedValues(params, definition),
  }));
  for (const { definition } of canonical) params.delete(definition.param);
  for (const { definition, values } of canonical) {
    for (const value of values) params.append(definition.param, value);
  }
}

export function hasSessionFilters(params: URLSearchParams): boolean {
  return canonicalSessionFilterEntries(params).length > 0;
}

export function buildSessionFilterSql(
  params: URLSearchParams,
  alias: string,
  startIndex = 1,
  omitFacet?: string,
): SessionFilterSql {
  const clauses: string[] = [];
  const binds: string[] = [];
  const add = (clause: string, value: string) => {
    const placeholder = `?${startIndex + binds.length}`;
    clauses.push(clause.replace('?', placeholder));
    binds.push(value);
  };

  for (const definition of ALL_MULTI_FILTERS) {
    if (definition.key === omitFacet) continue;
    const values = selectedValues(params, definition);
    if (values.length === 0) continue;
    add(`${facetExpressionSql(definition, alias)} IN (SELECT value FROM json_each(?))`, JSON.stringify(values));
  }

  const from = params.get('from');
  if (from) add(`${alias}.started_at >= ?`, from);
  const to = params.get('to');
  if (to) add(`${alias}.started_at <= ?`, normalizeToBound(to));
  return { clause: clauses.join(' AND '), binds };
}

export function mergeFacetCounts(
  rows: Array<{ v: string; n: number }>,
  selected: readonly string[],
): Record<string, number> {
  const counts = Object.create(null) as Record<string, number>;
  for (const row of rows) counts[row.v] = Number(row.n);
  for (const value of selected) {
    if (!Object.hasOwn(counts, value)) counts[value] = 0;
  }
  return counts;
}

export function facetLabelValue(definition: MultiValueFilterDefinition, value: string): string {
  if (definition.kind !== 'session-time') return value;
  return SESSION_TIME_BUCKETS.find((bucket) => bucket.value === value)?.label ?? value;
}

function validValue(definition: MultiValueFilterDefinition, value: string): boolean {
  if (definition.kind === 'session-date') return /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (definition.kind === 'session-time') return SESSION_TIME_VALUES.has(value);
  return true;
}
