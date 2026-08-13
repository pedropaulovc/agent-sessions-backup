import { describe, expect, it } from 'vitest';
import { derivedPreviewBearer } from '../e2e/preview-bearer';
import { previewBearerToken, resourceNames } from '../../infra/cf/preview-trust.mjs';

const SEED = 's'.repeat(48);

describe('Playwright preview bearer derivation', () => {
  it('derives the exact token the provisioner bakes into the Worker (lockstep pin)', () => {
    const url = `https://${resourceNames(42).host}`;
    expect(derivedPreviewBearer(url, { PREVIEW_BEARER_SEED: SEED })).toBe(previewBearerToken(SEED, 42));
  });

  it('derives nothing off-preview or without a usable seed', () => {
    const url = `https://${resourceNames(42).host}`;
    expect(derivedPreviewBearer('http://127.0.0.1:8787', { PREVIEW_BEARER_SEED: SEED })).toBeNull();
    expect(derivedPreviewBearer(url, {})).toBeNull();
    expect(derivedPreviewBearer(url, { PREVIEW_BEARER_SEED: 'short' })).toBeNull();
    expect(derivedPreviewBearer('https://pr-42-app.evil.example.com', { PREVIEW_BEARER_SEED: SEED })).toBeNull();
  });
});
