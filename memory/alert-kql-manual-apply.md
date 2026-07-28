---
name: alert-kql-manual-apply
description: Azure alert KQL in infra/azure/alerts/*.kql does NOT auto-deploy on merge — apply by hand (provision.sh, or az create for a NEW alert / az update for an edited one), else prod evaluates a stale query or no query at all
metadata:
  type: project
---

**Editing an `infra/azure/alerts/*.kql` file and merging does NOT update the live Azure alert.**

Same class of gap as [[deploy-migrations-gap]]: nothing in CI or Workers Builds pushes alert
changes to Azure. The Scheduled Query Alert keeps evaluating whatever KQL was last applied until
someone re-runs provisioning or updates it directly. So a merged alert fix is a no-op in prod until
you apply it.

**This gap recurs and has bitten twice.** Confirmed 2026-07-28: `collector-errors` had been
evaluating a query stale since 2026-07-18 (commit 88f187b, which nested collector-supplied fields
under `body.payload.*` so a collector couldn't forge `event`/`machine`, and updated the .kql to
match). The live alert kept reading `body.{level,code,message}` — fields that no longer existed — so
for ten days it **could not have fired on any collector error**, while the repo read as if it were
watching. A stale alert is worse than a missing one: it looks healthy. Re-run provisioning after
ANY .kql change, and treat a long gap since the last run as "assume every alert is stale."

**A NEW .kql file is worse than an unapplied edit in one respect: it does not exist in Azure at all.** Adding
`alerts/foo.kql` and merging creates nothing — the repo then *reads* as if the monitor exists while
nothing is watching. Confirmed 2026-07-28: `cert-orphan-leaked` and `cf-auth-failed` had .kql files
but no Azure alert, so nobody had run provisioning since they were added. Reconcile with:
```
diff <(az monitor scheduled-query list -g rg-agent-backup --query "[].name" -o tsv | sort) \
     <(ls infra/azure/alerts/*.kql | xargs -n1 basename | sed 's/.kql//;s/^/agent-backup-/' | sort)
```

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
**Creating a NEW alert** needs `create`, not `update` (update fails on a nonexistent alert), and
unlike update it needs the scope/location/severity/action-group too — values used 2026-07-28:
```
az monitor scheduled-query create --name agent-backup-<base> --resource-group rg-agent-backup \
  --scopes "$(az monitor log-analytics workspace show -g rg-agent-backup -n law-agent-backup --query id -o tsv)" \
  --location westus2 --condition "count 'Placeholder_1' > 0" \
  --condition-query Placeholder_1="$(cat infra/azure/alerts/<base>.kql)" \
  --evaluation-frequency 1h --window-size 1h --severity 2 \
  --action-groups "$(az monitor action-group list -g rg-agent-backup --query '[0].id' -o tsv)" \
  --skip-query-validation true
```
Add the alert's window to `alert_window_for()` in provision.sh too, or the next full provision run
silently regrades it to the 15m default.

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
