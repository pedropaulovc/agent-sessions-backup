import { describe, it, expect } from 'vitest';
import { EXPECTED_COLLECTOR_VERSION } from '../src/collector-version';
import initPy from '../../collector/src/agent_collector/__init__.py?raw';
import pyproject from '../../collector/pyproject.toml?raw';

describe('EXPECTED_COLLECTOR_VERSION', () => {
  it('matches the version collectors actually report', () => {
    // Pinned to agent_collector.__version__ specifically, because that is the string the HEARTBEAT
    // carries (run.py sends `collector_version: __version__`). Pinning to pyproject's version instead
    // would pass CI while every machine reports something else — and the outdated alert would then
    // page for the entire fleet on the next release.
    const reported = /^__version__\s*=\s*"([^"]+)"/m.exec(initPy)?.[1];
    expect(reported).toBeDefined();
    expect(EXPECTED_COLLECTOR_VERSION).toBe(reported);
  });

  it('keeps the package version derived rather than duplicated', () => {
    // The moment pyproject carries its own literal again, the two can drift apart silently and the
    // test above stops being enough — so pin the derivation, not just the current values.
    expect(pyproject).toMatch(/^dynamic\s*=\s*\["version"\]/m);
    expect(pyproject).toMatch(/^\[tool\.hatch\.version\]\npath\s*=\s*"src\/agent_collector\/__init__\.py"/m);
    expect(pyproject).not.toMatch(/^version\s*=/m);
  });
});
