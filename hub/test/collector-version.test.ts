import { describe, it, expect } from 'vitest';
import { EXPECTED_COLLECTOR_VERSION } from '../src/collector-version';
import pyproject from '../../collector/pyproject.toml?raw';

describe('EXPECTED_COLLECTOR_VERSION', () => {
  it('matches the collector package version', () => {
    // Single source of truth: the collector's own pyproject. Without this, bumping the collector and
    // forgetting the hub would leave the fleet "outdated" against a stale expectation — or worse,
    // silently "current" while every machine runs code the hub never expected.
    const declared = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1];
    expect(declared).toBeDefined();
    expect(EXPECTED_COLLECTOR_VERSION).toBe(declared);
  });
});
