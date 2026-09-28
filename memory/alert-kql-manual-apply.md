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

**Or apply ONE alert surgically** when its timing and query range are unchanged:
```bash
az monitor scheduled-query update \
  --name agent-backup-<base> --resource-group rg-agent-backup \
  --condition "count 'Placeholder_1' > 0" \
  --condition-query Placeholder_1="$(cat infra/azure/alerts/<base>.kql)" \
  --skip-query-validation true
```

For `collector-errors`, apply the KQL and timing together; a query-only update would
leave its one-hour range too short for the six-hour check. KQL filters seven hours,
while the supported 24h query window runs hourly with `overrideQueryTimeRange=P1D`:

```bash
set -euo pipefail
SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
RULE_NAME=agent-backup-collector-errors
QUERY="$(cat infra/azure/alerts/collector-errors.kql)"
az monitor scheduled-query update --subscription "$SUBSCRIPTION_ID" \
  --name "$RULE_NAME" --resource-group rg-agent-backup \
  --condition "count 'Placeholder_1' > 0" \
  --condition-query Placeholder_1="$QUERY" \
  --evaluation-frequency 1h --window-size 24h --skip-query-validation true
RULE_URL="https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-agent-backup/providers/Microsoft.Insights/scheduledQueryRules/$RULE_NAME?api-version=2021-08-01"
az rest --method patch --subscription "$SUBSCRIPTION_ID" --url "$RULE_URL" \
  --body '{"properties":{"overrideQueryTimeRange":"P1D"}}'
APPLIED_QUERY="$(az monitor scheduled-query show --subscription "$SUBSCRIPTION_ID" \
  --name "$RULE_NAME" --resource-group rg-agent-backup \
  --query 'criteria.allOf[0].query' -o tsv)"
[ "$APPLIED_QUERY" = "$QUERY" ] || { echo "ERROR: deployed query differs from source" >&2; exit 1; }
APPLIED_TIMING="$(az rest --method get --subscription "$SUBSCRIPTION_ID" \
  --url "$RULE_URL" \
  --query '{frequency:properties.evaluationFrequency,window:properties.windowSize,override:properties.overrideQueryTimeRange}' -o json)"
printf '%s' "$APPLIED_TIMING" | jq -e '
  def minutes:
    capture("^P(?:(?<d>[0-9]+)D)?(?:T(?:(?<h>[0-9]+)H)?(?:(?<m>[0-9]+)M)?(?:(?<s>[0-9]+)S)?)?$")
    | ((.d // "0" | tonumber) * 1440 + (.h // "0" | tonumber) * 60
      + (.m // "0" | tonumber) + (.s // "0" | tonumber) / 60);
  [.frequency, .window, .override] | map(minutes) == [60, 1440, 1440]
'
az monitor scheduled-query show --subscription "$SUBSCRIPTION_ID" \
  --name "$RULE_NAME" --resource-group rg-agent-backup \
  --query '{frequency:evaluationFrequency,window:windowSize,override:overrideQueryTimeRange}' -o json
```
The command fails unless the deployed query matches the file and readback is 1h/24h/24h.

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
For a new `collector-errors` rule, use the 1h frequency and 24h window, then set
`overrideQueryTimeRange` to `P1D` as in the collector-specific procedure above.
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
  session-rollup-errors) WINDOW=1h; FREQUENCY=15m; QUERY_RANGE=PT1H ;;
  session-rollup-missing) WINDOW=48h; FREQUENCY=1h; QUERY_RANGE=P2D ;;
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
    --evaluation-frequency "$FREQUENCY" --window-size "$WINDOW" --severity 2 \
    --action-groups "$AG_ID" --skip-query-validation true --only-show-errors
else
  az monitor scheduled-query update --subscription "$SUBSCRIPTION_ID" \
    --name "$RULE_NAME" --resource-group "$RG_NAME" \
    --condition "count 'Placeholder_1' > 0" --condition-query Placeholder_1="$QUERY" \
    --evaluation-frequency "$FREQUENCY" --window-size "$WINDOW" --severity 2 \
    --action-groups "$AG_ID" --skip-query-validation true --only-show-errors
fi
# Reconcile query-range drift independently: CLI updates preserve old overrides.
RULE_URL="https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RG_NAME/providers/Microsoft.Insights/scheduledQueryRules/$RULE_NAME?api-version=2021-08-01"
ISO_DURATION_MINUTES='
  def minutes:
    capture("^P(?:(?<d>[0-9]+)D)?(?:T(?:(?<h>[0-9]+)H)?(?:(?<m>[0-9]+)M)?(?:(?<s>[0-9]+)S)?)?$")
    | ((.d // "0" | tonumber) * 1440 + (.h // "0" | tonumber) * 60
      + (.m // "0" | tonumber) + (.s // "0" | tonumber) / 60);
'
EXPECTED_RANGE_MINUTES="$(jq -nr --arg duration "$QUERY_RANGE" "$ISO_DURATION_MINUTES \$duration | minutes")"
CURRENT_RANGE="$(az rest --method get --subscription "$SUBSCRIPTION_ID" --url "$RULE_URL" --query properties.overrideQueryTimeRange -o json)"
CURRENT_RANGE_MINUTES="$(printf '%s' "$CURRENT_RANGE" | jq -r "$ISO_DURATION_MINUTES if . == null then -1 else minutes end")"
if [ "$CURRENT_RANGE_MINUTES" != "$EXPECTED_RANGE_MINUTES" ]; then
  RANGE_PATCH="$(jq -n --arg duration "$QUERY_RANGE" '{properties: {overrideQueryTimeRange: $duration}}')"
  az rest --method patch --subscription "$SUBSCRIPTION_ID" --url "$RULE_URL" \
    --body "$RANGE_PATCH" --only-show-errors
fi
APPLIED_RANGE="$(az rest --method get --subscription "$SUBSCRIPTION_ID" --url "$RULE_URL" --query properties.overrideQueryTimeRange -o json)"
APPLIED_RANGE_MINUTES="$(printf '%s' "$APPLIED_RANGE" | jq -r "$ISO_DURATION_MINUTES if . == null then -1 else minutes end")"
if [ "$APPLIED_RANGE_MINUTES" != "$EXPECTED_RANGE_MINUTES" ]; then
  echo "ERROR: $RULE_NAME query-range readback mismatch: expected $QUERY_RANGE, got $APPLIED_RANGE" >&2
  exit 1
fi
az monitor scheduled-query show --subscription "$SUBSCRIPTION_ID" \
  --name "$RULE_NAME" --resource-group "$RG_NAME" \
  --query '{enabled:enabled,frequency:evaluationFrequency,window:windowSize,override:overrideQueryTimeRange,criteria:criteria,actions:actions}' -o json
```

The `collector-errors` KQL filters seven hours within Azure's supported 24h query
window and evaluates hourly. It requires a six-hour first-to-last span with an error
in every UTC hour bin, grouped by machine/store/code/stable target; the latest full
message remains in the output. Collector events have no source timestamp or explicit
recovery event, so `TimeGenerated` is receipt time. Requiring every hour prevents
buffered heartbeat backlogs or separate error episodes from masquerading as six
hours of continuous failure. The latest event must also be within one hour, which
preserves normal auto-resolution. Provisioning reconciles the 1h frequency, 24h
window, and `P1D` query-range override.

The missing rule uses the supported 48h scan window with hourly evaluation; KQL
itself applies the exact 26h horizon. Do not change the frequency to 26h or shrink
its window to 1h. Provisioning and the surgical commands explicitly reconcile
`overrideQueryTimeRange` to `P2D` for missing completion, `P1D` for collector
errors, and `PT1H` for rollup errors, then fail on a readback mismatch (equivalent
ISO duration spellings are accepted). This prevents a preexisting short override
from silently truncating these queries.
The current [scheduled-query CLI](https://learn.microsoft.com/en-us/cli/azure/monitor/scheduled-query)
does not expose a dedicated override flag, so the commands use the supported
[REST PATCH property](https://learn.microsoft.com/en-us/rest/api/monitor/scheduled-query-rules/update?view=rest-monitor-2021-08-01).
Azure documents the
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

These synthetic scenarios are to execute, not claims of already-executed validation.
For the collector-errors query, replace only its `let otel = union ...;` declaration
with the first fixture below; it should emit exactly three rows for `persistent_file`,
`persistent_check`, and `exact_boundary`, each with its latest full message.
For the session-rollup queries, replace the same declaration with the second fixture
and set `scenario` to each table value. The rollup errors query should emit one row
for partial, failed, page_failed, and delivery_failed; the missing query should emit
one row for failed, page_failed, delivery_failed, missing, stale, foreign, and
unknown_trigger. Complete, pending, and partial all satisfy liveness; a complete
summary with an unknown trigger does not.

#### Collector-errors persistence control

The source query should emit only those three signatures, including an exact six-hour
span. A shorter span, a missing hourly bin, buffered events delivered together, or
a changed target must not emit a row.

```kusto
let evaluationTime = now();
let otel = datatable(age:timespan, machine:string, store:string, code:string, message:string)
[
  390m, "persistent_file", "codex", "upload_failed", "socket.sock: HTTP 500 old",
  330m, "persistent_file", "codex", "upload_failed", "socket.sock: HTTP 502",
  270m, "persistent_file", "codex", "upload_failed", "socket.sock: HTTP 503",
  210m, "persistent_file", "codex", "upload_failed", "socket.sock: HTTP 504",
  150m, "persistent_file", "codex", "upload_failed", "socket.sock: HTTP 500",
  90m, "persistent_file", "codex", "upload_failed", "socket.sock: HTTP 502",
  20m, "persistent_file", "codex", "upload_failed", "socket.sock: HTTP 503 latest",
  380m, "exact_boundary", "codex", "upload_failed", "boundary.sock: HTTP 500",
  320m, "exact_boundary", "codex", "upload_failed", "boundary.sock: HTTP 500",
  260m, "exact_boundary", "codex", "upload_failed", "boundary.sock: HTTP 500",
  200m, "exact_boundary", "codex", "upload_failed", "boundary.sock: HTTP 500",
  140m, "exact_boundary", "codex", "upload_failed", "boundary.sock: HTTP 500",
  80m, "exact_boundary", "codex", "upload_failed", "boundary.sock: HTTP 500",
  20m, "exact_boundary", "codex", "upload_failed", "boundary.sock: HTTP 503 latest",
  390m, "persistent_check", "codex", "check_failed", "files/check HTTP 500",
  330m, "persistent_check", "codex", "check_failed", "files/check HTTP 502",
  270m, "persistent_check", "codex", "check_failed", "files/check HTTP 503",
  210m, "persistent_check", "codex", "check_failed", "files/check HTTP 504",
  150m, "persistent_check", "codex", "check_failed", "files/check HTTP 500",
  90m, "persistent_check", "codex", "check_failed", "files/check HTTP 502",
  20m, "persistent_check", "codex", "check_failed", "files/check HTTP 503 latest",
  390m, "missing_hour", "codex", "upload_failed", "gap.sock: HTTP 500",
  330m, "missing_hour", "codex", "upload_failed", "gap.sock: HTTP 500",
  270m, "missing_hour", "codex", "upload_failed", "gap.sock: HTTP 500",
  150m, "missing_hour", "codex", "upload_failed", "gap.sock: HTTP 500",
  90m, "missing_hour", "codex", "upload_failed", "gap.sock: HTTP 500",
  20m, "missing_hour", "codex", "upload_failed", "gap.sock: HTTP 500",
  390m, "buffered_burst", "codex", "upload_failed", "buffered.sock: HTTP 500",
  20m, "buffered_burst", "codex", "upload_failed", "buffered.sock: HTTP 500",
  390m, "changed_target", "codex", "upload_failed", "old.sock: HTTP 500",
  330m, "changed_target", "codex", "upload_failed", "old.sock: HTTP 500",
  270m, "changed_target", "codex", "upload_failed", "old.sock: HTTP 500",
  210m, "changed_target", "codex", "upload_failed", "old.sock: HTTP 500",
  150m, "changed_target", "codex", "upload_failed", "old.sock: HTTP 500",
  90m, "changed_target", "codex", "upload_failed", "old.sock: HTTP 500",
  20m, "changed_target", "codex", "upload_failed", "new.sock: HTTP 503",
  359m, "short_span", "codex", "upload_failed", "short.sock: HTTP 500",
  299m, "short_span", "codex", "upload_failed", "short.sock: HTTP 500",
  239m, "short_span", "codex", "upload_failed", "short.sock: HTTP 500",
  179m, "short_span", "codex", "upload_failed", "short.sock: HTTP 500",
  119m, "short_span", "codex", "upload_failed", "short.sock: HTTP 500",
  59m, "short_span", "codex", "upload_failed", "short.sock: HTTP 500",
  10m, "short_span", "codex", "upload_failed", "short.sock: HTTP 500",
  20m, "single", "codex", "upload_failed", "single.sock: HTTP 500"
]
| extend TimeGenerated = evaluationTime - age,
    Body = tostring(bag_pack("event", "collector.event", "machine", machine,
        "payload", bag_pack("level", "error", "store", store, "code", code, "message", message)))
| project TimeGenerated, Body;
```

#### Session-rollup controls

For the session-rollup queries, replace the source query's `let otel = union ...;`
declaration with the fixture below.
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
  'unknown_trigger', 'hub.session_rollup.run', 'complete', 'unknown', 'sessions-hub',
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
