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
infra/azure/provision.sh <issuer-url>
```

**Or apply ONE alert surgically** (the query update below leaves timing unchanged;
use the complete rollup commands later in this document when reconciling timing):
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
  --action-groups "$(az monitor action-group show -g rg-agent-backup -n ag-pedro-email --query id -o tsv)" \
  --skip-query-validation true
```
Register its window in `alert_window_for()` and, when different, its frequency in
`alert_frequency_for()` in provision.sh; provisioning reconciles query and timing drift.

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

## Session-rollup alerts and workbook: surgical deployment

The rollup contract is `hub.session_rollup.run`, with `run_id`, `trigger` (`scheduled`
or `manual`), and `outcome` (`complete`, `partial`, or `failed`). `partial` means
session failures, not unfinished backfill. Returned passes include `examined`,
`pages`, `completed`, `superseded`, `failed`, `pending`, `remaining`, and `ms`; thrown
passes include `error` and `ms`, without invented counters. A page failure also
emits `hub.session_rollup.page_failed`. Manual job claim or terminal persistence
failures emit `hub.session_rollup.delivery_failed`, with `run_id`, `trigger`, and
`error`. Both alert queries restrict `ServiceName` to `sessions-hub` so preview
services cannot satisfy production liveness.

- `session-rollup-errors`: any partial/failed summary, page failure, or manual job
  delivery/persistence failure in the last hour. A subsequent complete pass does
  not erase an earlier error.
- `session-rollup-missing`: no complete/partial summary from either scheduled or
  manual execution in the last 26h. Failed/started/page-failure/delivery-failure
  events alone do not satisfy it. Empty or missing `OTelLogs` still produces the absence row.
- Pending work is expected for a bounded pass and never triggers either rule by
  itself. A manual bootstrap counts as liveness, but does not prove cron delivery.

Apply only after the reviewed worker deployment and first manual complete/partial
summary is visible in Azure; otherwise the missing rule correctly fires during
bootstrap. Deploying worker code or merging this file does not apply Azure changes.
These commands change only one rule at a time and use the existing email action
group, not the full provisioning script.

Run from the repository root in an authenticated Azure shell:

```bash
set -euo pipefail
SUBSCRIPTION_ID="$(az account show --subscription 'Pay-As-You-Go Dev/Test' --query id -o tsv)"
RG_NAME=rg-agent-backup
LAW_ID="$(az monitor log-analytics workspace show --subscription "$SUBSCRIPTION_ID" -g "$RG_NAME" -n law-agent-backup --query id -o tsv)"
AG_ID="$(az monitor action-group show --subscription "$SUBSCRIPTION_ID" -g "$RG_NAME" -n ag-pedro-email --query id -o tsv)"

# Run this block once per rule. After the first manual summary has arrived,
# repeat with BASE=session-rollup-missing.
BASE=session-rollup-errors
case "$BASE" in
  session-rollup-errors) WINDOW=1h ;;
  session-rollup-missing) WINDOW=48h ;;
  *) echo "Unexpected rollup rule: $BASE" >&2; exit 1 ;;
esac
RULE_NAME="agent-backup-$BASE"
QUERY="$(cat "infra/azure/alerts/$BASE.kql")"
# A failed list must abort, not be mistaken for a nonexistent rule.
EXISTING="$(az monitor scheduled-query list --subscription "$SUBSCRIPTION_ID" -g "$RG_NAME" --query "[?name=='$RULE_NAME'].name" -o tsv)"
if [ -z "$EXISTING" ]; then
  az monitor scheduled-query create --subscription "$SUBSCRIPTION_ID" \
    --name "$RULE_NAME" --resource-group "$RG_NAME" \
    --scopes "$LAW_ID" --location westus2 \
    --condition "count 'Placeholder_1' > 0" --condition-query Placeholder_1="$QUERY" \
    --description "agent-sessions-backup: $BASE (see infra/azure/alerts/$BASE.kql)" \
    --evaluation-frequency 1h --window-size "$WINDOW" --severity 2 \
    --action-groups "$AG_ID" --skip-query-validation true --only-show-errors
else
  az monitor scheduled-query update --subscription "$SUBSCRIPTION_ID" \
    --name "$RULE_NAME" --resource-group "$RG_NAME" \
    --condition "count 'Placeholder_1' > 0" --condition-query Placeholder_1="$QUERY" \
    --evaluation-frequency 1h --window-size "$WINDOW" --severity 2 \
    --action-groups "$AG_ID" --skip-query-validation true --only-show-errors
fi
az monitor scheduled-query show --subscription "$SUBSCRIPTION_ID" \
  --name "$RULE_NAME" --resource-group "$RG_NAME" \
  --query '{enabled:enabled,frequency:evaluationFrequency,window:windowSize,override:overrideQueryTimeRange,criteria:criteria,actions:actions}' -o json
```

The missing rule uses the supported 48h scan window with hourly evaluation; KQL
itself applies the exact 26h horizon. Do not change the frequency to 26h or shrink
its window to 1h. No `overrideQueryTimeRange` is needed; if an existing rule has a
non-null override, remove it or set it to `P2D` before relying on the window.
The current [scheduled-query CLI](https://learn.microsoft.com/en-us/cli/azure/monitor/scheduled-query)
does not expose a dedicated override flag. Azure documents the
[two-day query maximum](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-create-log-alert-rule#configure-alert-rule-conditions)
separately from evaluation frequency.

Using the same `SUBSCRIPTION_ID`, `RG_NAME`, and `LAW_ID`, update only the existing
workbook (stable resource ID, no new panel):

```bash
WORKBOOK_NAME=03c0208e-6d39-4a92-8502-b0c4a983d7e1
WORKBOOK_BODY_FILE="$(mktemp)"
trap 'rm -f "$WORKBOOK_BODY_FILE"' EXIT
jq -n --arg location westus2 \
  --arg displayName 'Agent sessions backup - System health' \
  --arg sourceId "$LAW_ID" --arg hiddenLink "hidden-link:$LAW_ID" \
  --slurpfile workbook infra/azure/workbooks/system-health.workbook.json \
  '{
    location: $location, kind: "shared", tags: {($hiddenLink): "Resource"},
    properties: {
      displayName: $displayName,
      serializedData: ($workbook[0] | .fallbackResourceIds = [$sourceId] | tojson),
      version: "Notebook/1.0", sourceId: $sourceId, category: "workbook"
    }
  }' > "$WORKBOOK_BODY_FILE"
az rest --method put --subscription "$SUBSCRIPTION_ID" \
  --url "https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RG_NAME/providers/Microsoft.Insights/workbooks/$WORKBOOK_NAME?api-version=2023-06-01" \
  --body "@$WORKBOOK_BODY_FILE" --only-show-errors
rm -f "$WORKBOOK_BODY_FILE"
trap - EXIT
```

The existing recent-errors table explicitly selects partial/failed rollup summaries
even if their log severity is informational. It displays service, outcome, run ID,
error message, returned-pass counters and duration, retaining raw details.

### Synthetic KQL controls

These are scenarios to execute, not claims of already executed validation. Replace
only the `let otel = union ...;` declaration in either source query with the fixture
below, leaving the rule predicates untouched. Set `scenario` to each table value.
The errors query should produce one row for partial, failed, page_failed, and
delivery_failed; the missing query should produce one row for failed, page_failed,
delivery_failed, missing, stale, and foreign. Complete, pending, and partial all satisfy liveness. Also test an
unknown `trigger` on a complete summary: it must not satisfy liveness.

```kusto
let scenario = 'partial';
let otel = datatable(Case:string, Event:string, Outcome:string, Trigger:string, ServiceName:string)
[
  'complete', 'hub.session_rollup.run', 'complete', 'scheduled', 'sessions-hub',
  'pending', 'hub.session_rollup.run', 'complete', 'manual', 'sessions-hub',
  'partial', 'hub.session_rollup.run', 'partial', 'manual', 'sessions-hub',
  'failed', 'hub.session_rollup.run', 'failed', 'scheduled', 'sessions-hub',
  'page_failed', 'hub.session_rollup.page_failed', '', 'manual', 'sessions-hub',
  'delivery_failed', 'hub.session_rollup.delivery_failed', '', 'manual', 'sessions-hub',
  'stale', 'hub.session_rollup.run', 'complete', 'scheduled', 'sessions-hub',
  'foreign', 'hub.session_rollup.run', 'complete', 'manual', 'sessions-hub-preview'
]
| where Case == scenario
| project TimeGenerated=iff(Case == 'stale', ago(27h), ago(5m)), ServiceName,
    Body=tostring(bag_pack('event', Event, 'outcome', Outcome, 'trigger', Trigger,
        'run_id', 'synthetic-rollup', 'failed', iff(Case == 'partial', 1, 0),
        'pending', 100, 'remaining', 'pending', 'ms', 42,
        'error', iff(Case in ('failed', 'page_failed', 'delivery_failed'), 'Synthetic rollup failure', '')));
```

For a missing-table control, retain the original fuzzy union and change only
`OTelLogs` to a verified nonexistent table name. The errors rule must remain empty
and the missing rule must still emit one row. Repeat with a complete summary 25h
old (no missing row) and 27h old (one missing row), and with only failed summaries
plus an old completion. Test a mixed recent failed+complete input too: errors
must still emit the failure while liveness remains satisfied.
