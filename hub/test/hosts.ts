/**
 * Request hosts for the suite, derived from the deployed configuration.
 *
 * The workers pool binds `vars` straight out of wrangler.jsonc (vitest.config.ts:9), so
 * API_HOST/VIEWER_HOST here are the same values production runs with. Tests must build
 * URLs from these rather than repeating a hostname literal: the hub gates real behaviour
 * on the vars — viewer/API split in src/router.ts, session audience in src/auth/session.ts,
 * WebAuthn rpID in src/auth/webauthn.ts — so a literal that drifts from the vars silently
 * tests a host the Worker no longer serves. Verified by the vza.net -> pedrovc.com.br move,
 * where flipping the two vars turned 17 assertions red across three files while the Worker
 * itself was correct.
 *
 * auth-session.test.ts deliberately does NOT use these: it injects its own VIEWER_HOST into
 * a synthetic env to exercise the audience gate (including mismatched-host rejection), so it
 * must stay independent of the deployed value.
 */
import { env } from 'cloudflare:test';

const testEnv = env as unknown as Env;

export const API_HOST = testEnv.API_HOST;
export const VIEWER_HOST = testEnv.VIEWER_HOST;

/** `https://<API_HOST>` — mTLS/machine + read-grant API surface. */
export const API = `https://${API_HOST}`;

/** `https://<VIEWER_HOST>` — passkey-authenticated viewer surface. */
export const VIEWER = `https://${VIEWER_HOST}`;
