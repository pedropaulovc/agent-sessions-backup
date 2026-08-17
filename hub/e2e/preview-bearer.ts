import { createHmac } from 'node:crypto';

/**
 * Derive the per-PR preview bearer the same way the provisioner bakes it into the Worker:
 * HMAC-SHA256(seed, pr), with the PR number read off the stable workers.dev hostname. The
 * derivation MUST stay in lockstep with `previewBearerToken` in infra/cf/preview-trust.mjs —
 * pinned by hub/test/playwright-harness.test.ts. Returns null off-preview (local runs need
 * no auth). Standalone module (no Playwright imports) so the vitest workers pool can load it.
 */
export function derivedPreviewBearer(
  environmentURL: string,
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const seed = environment.PREVIEW_BEARER_SEED?.trim();
  if (!seed || seed.length < 32) return null;
  const match = /^pr-([1-9][0-9]*)-app\.sessions-ppe\.workers\.dev$/
    .exec(new URL(environmentURL).hostname);
  if (!match) return null;
  return createHmac('sha256', seed).update(`sessions-preview-bearer:pr-${match[1]}`).digest('base64url');
}
