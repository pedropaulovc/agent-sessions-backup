import { SYNTHETIC_EXPECTATIONS } from '../../scripts/lib/dev-seed.mjs';

export const SYNTHETIC_FIXTURE = Object.freeze({
  sessionId: SYNTHETIC_EXPECTATIONS.primarySessionId,
  title: SYNTHETIC_EXPECTATIONS.primaryTitle,
  searchPhrase: SYNTHETIC_EXPECTATIONS.searchPhrase,
  pagerSessionId: SYNTHETIC_EXPECTATIONS.pagerSessionId,
  pagerTitle: SYNTHETIC_EXPECTATIONS.pagerTitle,
  pagerSearchPhrase: SYNTHETIC_EXPECTATIONS.pagerSearchPhrase,
  machineId: SYNTHETIC_EXPECTATIONS.machine,
  skillName: SYNTHETIC_EXPECTATIONS.skillName,
  skillSourceMarker: SYNTHETIC_EXPECTATIONS.skillSourceMarker,
  costParentSessionId: SYNTHETIC_EXPECTATIONS.costParentSessionId,
  costParentTitle: SYNTHETIC_EXPECTATIONS.costParentTitle,
  costParentModel: SYNTHETIC_EXPECTATIONS.costParentModel,
  costSubagentSessionIds: SYNTHETIC_EXPECTATIONS.costSubagentSessionIds,
  costSubtreeLabel: SYNTHETIC_EXPECTATIONS.costSubtreeLabel,
  costParentOwnLabel: SYNTHETIC_EXPECTATIONS.costParentOwnLabel,
});
