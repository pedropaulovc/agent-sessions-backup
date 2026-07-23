---
name: alert-kql-manual-apply
description: Azure alert KQL in infra/azure/alerts/*.kql does NOT auto-deploy on merge — apply it by hand (provision.sh or a surgical az update) or prod keeps evaluating the stale query
metadata:
  type: project
---

**Editing an `infra/azure/alerts/*.kql` file and merging does NOT update the live Azure alert.**

Same class of gap as [[deploy-migrations-gap]]: nothing in CI or Workers Builds pushes alert
changes to Azure. The Scheduled Query Alert keeps evaluating whatever KQL was last applied until
someone re-runs provisioning or updates it directly. So a merged alert fix is a no-op in prod until
you apply it.

**Apply the whole set** (idempotent; updates every alert on drift — also touches federated creds,
role assignments, action groups):
```
infra/azure/provision.sh
```

**Or apply ONE alert surgically** (what provision.sh's drift branch does, lines ~391-394 — safer
when you only changed one .kql and don't want to re-run full provisioning):
```
az monitor scheduled-query update \
  --name agent-backup-<base> --resource-group rg-agent-backup \
  --condition "count 'Placeholder_1' > 0" \
  --condition-query Placeholder_1="$(cat infra/azure/alerts/<base>.kql)" \
  --skip-query-validation true
```
`<base>` = the .kql basename (e.g. `parse-errors` → alert `agent-backup-parse-errors`). The shared
`count 'Placeholder_1' > 0` condition is generic across all alerts, so any summarize/threshold logic
must live INSIDE the .kql (emit a row only when it should fire). `--skip-query-validation` because the
workspace may lack the OTelLogs table on a fresh provision.

**Confirm drift / verify after apply:** compare the deployed query to the file —
`az monitor scheduled-query show --name agent-backup-<base> --resource-group rg-agent-backup --query "criteria.allOf[0].query" -o tsv`
(command substitution strips trailing newlines on both sides, so trailing whitespace won't cause a
spurious mismatch).

**Diagnosing what an alert actually fired on:** `az` is authed to the alerting sub. Query the raw
event bodies in Log Analytics workspace `law-agent-backup`
(customerId 8ea9a5fa-d706-4c12-b952-5b7ba9631221), e.g. for parse errors:
`OTelLogs | extend body=todynamic(Body) | where body.event=='parse.error' | project TimeGenerated, body.file_id, body.error`.
