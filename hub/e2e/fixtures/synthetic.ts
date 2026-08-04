import { SYNTHETIC_EXPECTATIONS } from '../../scripts/lib/dev-seed.mjs';

export const SYNTHETIC_FIXTURE = Object.freeze({
  sessionId: SYNTHETIC_EXPECTATIONS.primarySessionId,
  title: SYNTHETIC_EXPECTATIONS.primaryTitle,
  searchPhrase: SYNTHETIC_EXPECTATIONS.searchPhrase,
  pagerSessionId: SYNTHETIC_EXPECTATIONS.pagerSessionId,
  pagerTitle: SYNTHETIC_EXPECTATIONS.pagerTitle,
  pagerSearchPhrase: SYNTHETIC_EXPECTATIONS.pagerSearchPhrase,
  machineId: SYNTHETIC_EXPECTATIONS.machine,
});
