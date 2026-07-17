#!/bin/bash
# Usage: ./infra/azure/provision.sh <issuer-url>
#
# Provisions Azure observability resources for agent-sessions-backup (idempotent
# — every resource is show-or-create, safe to re-run). Requires: az CLI with an
# active login session (`az login`). The application-insights,
# monitor-control-service, and scheduled-query CLI extensions are installed
# automatically by this script if missing (see "Azure CLI Extensions" below) —
# no manual `az extension add` needed first.
#
# <issuer-url> is sessions-oidc-issuer's deployed public URL (see
# infra/cf/telemetry.md step 3), e.g. https://sessions-oidc-issuer.<account>.workers.dev
#
# Adapted from twitter-mirror's scripts/provision-azure-observability.sh, with:
#   - workspace-based Application Insights (not classic) — law-agent-backup + ai-agent-backup
#   - a DCE + DCR with native OTLP ingestion streams (Microsoft-OTLP-Logs,
#     Microsoft-OTLP-Traces), so the gateway posts protobuf straight to a DCR
#     instead of translating to Application-Insights Breeze track envelopes
#   - a user-assigned managed identity (not an Entra app registration) as the
#     federation subject, matching youtube-mirror's pattern
#   - an action group + KQL-based scheduled-query alerts + an availability test
#
# *** UNVERIFIED SECTIONS — see the inline "UNVERIFIED" comments below and the
# task report. The DCE/DCR-with-OTLP-streams shape and the availability webtest
# ARM shape are built from Microsoft Learn docs + a working sibling project's
# *output* (youtube-mirror's infra/federation.md); flag names have been checked
# against this environment's real `az --help` output where noted, but none of
# these commands have been run against a live subscription. Confirm both live
# at M4 deploy before trusting this script end to end. ***
#
# Portability: this script targets bash, but avoids bash-4-only features
# (`declare -A` associative arrays) since macOS ships bash 3.2 as /bin/bash by
# default and this script's shebang doesn't pin a newer one.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ -z "${1:-}" ]; then
    echo "Usage: $0 <issuer-url>"
    echo "  issuer-url: sessions-oidc-issuer's public URL, e.g. https://sessions-oidc-issuer.xxx.workers.dev"
    exit 1
fi

ISSUER_URL="$1"

RG_NAME="rg-agent-backup"
LOCATION="westus2"
LAW_NAME="law-agent-backup"
AI_NAME="ai-agent-backup"
DCE_NAME="dce-agent-backup"
DCR_NAME="dcr-agent-backup"
MI_NAME="mi-agent-backup-cloudflare-wu2"
FED_CRED_NAME="cf-worker-federation"
FED_SUBJECT="cf-worker:sessions-telemetry-gateway"
AG_NAME="ag-pedro-email"
WEBTEST_NAME="agent-backup-healthz"
HEALTHZ_URL="https://sessions.vza.net/healthz"

echo "=== Azure CLI Extensions ==="
# A fresh az CLI install has none of these; `az monitor app-insights`,
# `az monitor data-collection`, and `az monitor scheduled-query` fail outright
# without them. Since every "does it exist" check below is a `show` that falls
# through to `create` under `set -euo pipefail`, a missing extension aborts
# the whole script on the first command that needs it — well before the
# DCE/DCR even get created. Installed explicitly here (rather than via
# `az config set extension.use_dynamic_install=yes_without_prompt`, which
# would silently change az CLI's global behavior for every future invocation
# on this machine, not just this script) so a fresh CLI just works.
for ext in application-insights monitor-control-service scheduled-query; do
    az extension show -n "$ext" >/dev/null 2>&1 \
        || az extension add -n "$ext" --only-show-errors -y >/dev/null
done
echo "OK: application-insights, monitor-control-service, scheduled-query"

echo ""
echo "=== Resource Group ==="
az group show --name "$RG_NAME" --only-show-errors >/dev/null 2>&1 \
    || az group create --name "$RG_NAME" --location "$LOCATION" --only-show-errors >/dev/null
echo "OK: $RG_NAME"

echo ""
echo "=== Log Analytics Workspace ==="
az monitor log-analytics workspace show --resource-group "$RG_NAME" --workspace-name "$LAW_NAME" --only-show-errors >/dev/null 2>&1 \
    || az monitor log-analytics workspace create --resource-group "$RG_NAME" --workspace-name "$LAW_NAME" --location "$LOCATION" --only-show-errors >/dev/null
LAW_ID=$(az monitor log-analytics workspace show --resource-group "$RG_NAME" --workspace-name "$LAW_NAME" --query id -o tsv)
echo "OK: $LAW_NAME ($LAW_ID)"

echo ""
echo "=== Application Insights (workspace-based) ==="
az monitor app-insights component show --app "$AI_NAME" --resource-group "$RG_NAME" --only-show-errors >/dev/null 2>&1 \
    || az monitor app-insights component create --app "$AI_NAME" --resource-group "$RG_NAME" --location "$LOCATION" \
        --kind web --application-type web --workspace "$LAW_ID" --only-show-errors >/dev/null
AI_RESOURCE_ID=$(az monitor app-insights component show --app "$AI_NAME" --resource-group "$RG_NAME" --query id -o tsv)
echo "OK: $AI_NAME ($AI_RESOURCE_ID)"

echo ""
echo "=== Data Collection Endpoint ==="
# UNVERIFIED: `az monitor data-collection endpoint create` syntax confirmed against
# Microsoft Learn's "Configure Azure Monitor pipeline with CLI" doc; not run live here.
az monitor data-collection endpoint show --name "$DCE_NAME" --resource-group "$RG_NAME" --only-show-errors >/dev/null 2>&1 \
    || az monitor data-collection endpoint create --name "$DCE_NAME" --resource-group "$RG_NAME" \
        --location "$LOCATION" --public-network-access "Enabled" --only-show-errors >/dev/null
DCE_ID=$(az monitor data-collection endpoint show --name "$DCE_NAME" --resource-group "$RG_NAME" --query id -o tsv)
DCE_LOGS_INGESTION=$(az monitor data-collection endpoint show --name "$DCE_NAME" --resource-group "$RG_NAME" --query logsIngestion.endpoint -o tsv)
echo "OK: $DCE_NAME ($DCE_ID)"

echo ""
echo "=== Data Collection Rule (native OTLP ingestion: logs + traces) ==="
# UNVERIFIED: this is the riskiest resource in this script — not exercised
# against a live subscription. Per Microsoft Learn's current manual-OTLP-
# ingestion ARM template (learn.microsoft.com/azure/azure-monitor/containers/
# opentelemetry-protocol-ingestion, "Option 2: Manual resource orchestration",
# backed by github.com/microsoft/AzureMonitorCommunity's
# OTLP_DCE_DCR_ARM_Template.txt), the DCR must declare an explicit
# `directDataSources` entry per signal (there is no such thing as a bare
# built-in "Microsoft-OTLP-Logs"/"Microsoft-OTLP-Traces" *stream* usable
# directly in dataFlows — those names are only the OTLP *ingestion route*
# segment in the URL the worker POSTs to; see OTLP_LOGS_ENDPOINT below). The
# actual DCR-internal stream ids the directDataSources declare — and that
# dataFlows must route to a destination — are `Microsoft-OTel-Logs` for logs
# and `Microsoft-OTel-Traces-{Spans,Events,Resources}` for traces (three
# separate stream ids for one signal; the community template always lists all
# three together). Each directDataSources entry also needs a `references`
# block naming an Application Insights resource to enrich against (we already
# create ai-agent-backup for this). If DCR creation rejects this shape or the
# stream ids have since changed, the fallback is: create ai-agent-backup with
# "OTLP support: On" via the portal instead (which auto-provisions an
# equivalent "managed-ai-..." DCE/DCR pair) and copy its endpoint URLs into
# infra/out/azure.env by hand rather than trusting this script's output.
if ! az monitor data-collection rule show --name "$DCR_NAME" --resource-group "$RG_NAME" --only-show-errors >/dev/null 2>&1; then
    # A bare `mktemp` (no template) is a GNU-ism — BSD mktemp (macOS's default,
    # matching this script's bash-3.2 portability elsewhere) requires an
    # explicit template and exits non-zero without one.
    DCR_RULE_FILE=$(mktemp "${TMPDIR:-/tmp}/agent-backup-dcr.XXXXXX")
    trap 'rm -f "$DCR_RULE_FILE"' EXIT
    cat > "$DCR_RULE_FILE" <<EOF
{
  "location": "$LOCATION",
  "properties": {
    "dataCollectionEndpointId": "$DCE_ID",
    "references": {
      "applicationInsights": [
        { "resourceId": "$AI_RESOURCE_ID", "name": "applicationInsightsResource" }
      ]
    },
    "directDataSources": {
      "otelLogs": [
        {
          "streams": ["Microsoft-OTel-Logs"],
          "enrichWithResourceAttributes": ["*"],
          "enrichWithReference": "applicationInsightsResource",
          "replaceResourceIdWithReference": true,
          "name": "otelLogsDataSourceDirect"
        }
      ],
      "otelTraces": [
        {
          "streams": ["Microsoft-OTel-Traces-Spans", "Microsoft-OTel-Traces-Events", "Microsoft-OTel-Traces-Resources"],
          "enrichWithResourceAttributes": ["*"],
          "enrichWithReference": "applicationInsightsResource",
          "replaceResourceIdWithReference": true,
          "name": "otelTracesDataSourceDirect"
        }
      ]
    },
    "destinations": {
      "logAnalytics": [
        { "workspaceResourceId": "$LAW_ID", "name": "lawDestination" }
      ]
    },
    "dataFlows": [
      {
        "streams": ["Microsoft-OTel-Logs", "Microsoft-OTel-Traces-Spans", "Microsoft-OTel-Traces-Events", "Microsoft-OTel-Traces-Resources"],
        "destinations": ["lawDestination"]
      }
    ]
  }
}
EOF
    az monitor data-collection rule create --name "$DCR_NAME" --resource-group "$RG_NAME" \
        --location "$LOCATION" --rule-file "$DCR_RULE_FILE" --only-show-errors >/dev/null
    rm -f "$DCR_RULE_FILE"
    trap - EXIT
fi
DCR_ID=$(az monitor data-collection rule show --name "$DCR_NAME" --resource-group "$RG_NAME" --query id -o tsv)
DCR_IMMUTABLE_ID=$(az monitor data-collection rule show --name "$DCR_NAME" --resource-group "$RG_NAME" --query immutableId -o tsv)
# The URL route segment is "Microsoft-OTLP-{Logs,Traces}" (the OTLP wire
# protocol endpoint name), NOT the DCR-internal "Microsoft-OTel-*" stream ids
# declared above — those are two different names for two different layers.
# Casing matches a known-working sibling deployment (youtube-mirror's
# federation.md), which uses "dataCollectionRules" (capital C, R); Microsoft's
# own docs are inconsistently cased on this point.
OTLP_LOGS_ENDPOINT="${DCE_LOGS_INGESTION}/dataCollectionRules/${DCR_IMMUTABLE_ID}/streams/Microsoft-OTLP-Logs/otlp/v1/logs"
OTLP_TRACES_ENDPOINT="${DCE_LOGS_INGESTION}/dataCollectionRules/${DCR_IMMUTABLE_ID}/streams/Microsoft-OTLP-Traces/otlp/v1/traces"
echo "OK: $DCR_NAME ($DCR_ID)"
echo "  logs endpoint:   $OTLP_LOGS_ENDPOINT"
echo "  traces endpoint: $OTLP_TRACES_ENDPOINT"

echo ""
echo "=== User-Assigned Managed Identity ==="
az identity show --name "$MI_NAME" --resource-group "$RG_NAME" --only-show-errors >/dev/null 2>&1 \
    || az identity create --name "$MI_NAME" --resource-group "$RG_NAME" --location "$LOCATION" --only-show-errors >/dev/null
MI_CLIENT_ID=$(az identity show --name "$MI_NAME" --resource-group "$RG_NAME" --query clientId -o tsv)
MI_PRINCIPAL_ID=$(az identity show --name "$MI_NAME" --resource-group "$RG_NAME" --query principalId -o tsv)
echo "OK: $MI_NAME (clientId=$MI_CLIENT_ID)"

echo ""
echo "=== Federated Credential ==="
# Not a pure show-or-create: a re-run with a different <issuer-url> (e.g. the
# issuer worker got redeployed to a new workers.dev subdomain) must actually
# update the existing credential, or Entra keeps trusting the OLD issuer and
# every token exchange starts failing with no error surfaced here. The drift
# check compares issuer, subject, AND audiences — Entra matches all three
# against the assertion (whose aud is always "api://AzureADTokenExchange"), so
# a credential that matches on issuer+subject but has a stale/wrong audience
# would otherwise be treated as fine while token exchange keeps failing.
FED_AUDIENCE="api://AzureADTokenExchange"
EXISTING_ISSUER=$(az identity federated-credential show --name "$FED_CRED_NAME" --identity-name "$MI_NAME" --resource-group "$RG_NAME" --query issuer -o tsv 2>/dev/null || true)
if [ -z "$EXISTING_ISSUER" ]; then
    az identity federated-credential create --name "$FED_CRED_NAME" --identity-name "$MI_NAME" --resource-group "$RG_NAME" \
        --issuer "$ISSUER_URL" --subject "$FED_SUBJECT" --audiences "$FED_AUDIENCE" --only-show-errors >/dev/null
    echo "OK: $FED_CRED_NAME created (issuer=$ISSUER_URL, subject=$FED_SUBJECT, audiences=$FED_AUDIENCE)"
else
    EXISTING_SUBJECT=$(az identity federated-credential show --name "$FED_CRED_NAME" --identity-name "$MI_NAME" --resource-group "$RG_NAME" --query subject -o tsv)
    # audiences is an array; join it deterministically rather than relying on
    # -o tsv's array formatting, so a single-element comparison is unambiguous.
    EXISTING_AUDIENCES=$(az identity federated-credential show --name "$FED_CRED_NAME" --identity-name "$MI_NAME" --resource-group "$RG_NAME" --query "join(',', audiences)" -o tsv)
    if [ "$EXISTING_ISSUER" != "$ISSUER_URL" ] || [ "$EXISTING_SUBJECT" != "$FED_SUBJECT" ] || [ "$EXISTING_AUDIENCES" != "$FED_AUDIENCE" ]; then
        echo "Drift detected: existing issuer=$EXISTING_ISSUER subject=$EXISTING_SUBJECT audiences=$EXISTING_AUDIENCES — updating to issuer=$ISSUER_URL subject=$FED_SUBJECT audiences=$FED_AUDIENCE"
        az identity federated-credential update --name "$FED_CRED_NAME" --identity-name "$MI_NAME" --resource-group "$RG_NAME" \
            --issuer "$ISSUER_URL" --subject "$FED_SUBJECT" --audiences "$FED_AUDIENCE" --only-show-errors >/dev/null
        echo "OK: $FED_CRED_NAME updated (issuer=$ISSUER_URL, subject=$FED_SUBJECT, audiences=$FED_AUDIENCE)"
    else
        echo "OK: $FED_CRED_NAME already matches (issuer=$ISSUER_URL, subject=$FED_SUBJECT, audiences=$FED_AUDIENCE)"
    fi
fi

echo ""
echo "=== Role Assignment (Monitoring Metrics Publisher on the DCR) ==="
ROLE_NAME="Monitoring Metrics Publisher"
EXISTING_ROLE=$(az role assignment list --assignee "$MI_PRINCIPAL_ID" --role "$ROLE_NAME" --scope "$DCR_ID" --query "[0].id" -o tsv 2>/dev/null || true)
if [ -z "$EXISTING_ROLE" ]; then
    az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
        --role "$ROLE_NAME" --scope "$DCR_ID" --only-show-errors >/dev/null
fi
echo "OK: $ROLE_NAME on $DCR_NAME"

echo ""
echo "=== Action Group (email) ==="
az monitor action-group show --name "$AG_NAME" --resource-group "$RG_NAME" --only-show-errors >/dev/null 2>&1 \
    || az monitor action-group create --name "$AG_NAME" --resource-group "$RG_NAME" --short-name pedroemail \
        --action email pedro-email pedro@vezza.com.br --only-show-errors >/dev/null
AG_ID=$(az monitor action-group show --name "$AG_NAME" --resource-group "$RG_NAME" --query id -o tsv)
echo "OK: $AG_NAME ($AG_ID)"

echo ""
echo "=== Scheduled Query Alerts (from infra/azure/alerts/*.kql) ==="
# Bash 3.2 (macOS's default /bin/bash — this script has no bash4+ shebang pin)
# has no associative arrays; `declare -A` aborts the whole script before a
# single alert is created. A case statement is portable to both.
alert_window_for() {
    case "$1" in
        missed-heartbeat) echo "1h" ;;
        collector-errors) echo "1h" ;;
        parse-errors) echo "15m" ;;
        *) echo "15m" ;;
    esac
}

for kql_file in "$REPO_ROOT"/infra/azure/alerts/*.kql; do
    [ -e "$kql_file" ] || continue
    base_name=$(basename "$kql_file" .kql)
    alert_name="agent-backup-$base_name"
    window=$(alert_window_for "$base_name")
    query=$(cat "$kql_file")

    # --skip-query-validation: this script can run before the gateway has ever
    # forwarded any OTLP data, so the workspace may have no OTelLogs table yet
    # (and infra/azure/alerts/*.kql's own header comments flag the table/
    # column names themselves as unverified assumptions). Without this flag,
    # `az monitor scheduled-query create`/`update` validates the KQL against
    # the current workspace schema and fails outright on a fresh workspace,
    # aborting the rest of provisioning.
    if ! az monitor scheduled-query show --name "$alert_name" --resource-group "$RG_NAME" --only-show-errors >/dev/null 2>&1; then
        az monitor scheduled-query create --name "$alert_name" --resource-group "$RG_NAME" \
            --scopes "$LAW_ID" --location "$LOCATION" \
            --condition "count 'Placeholder_1' > 0" \
            --condition-query Placeholder_1="$query" \
            --description "agent-sessions-backup: $base_name (see infra/azure/alerts/$base_name.kql)" \
            --evaluation-frequency "$window" --window-size "$window" \
            --severity 2 --action-groups "$AG_ID" --skip-query-validation true --only-show-errors >/dev/null
        alert_action="created"
    else
        # A bare existence check means editing a .kql file and rerunning this
        # script never pushes the change to Azure — the script would print OK
        # while the stale/broken query keeps evaluating. Compare the deployed
        # query text (command substitution strips trailing newlines on both
        # sides, so that alone won't cause a spurious mismatch) and update on
        # drift.
        CURRENT_QUERY=$(az monitor scheduled-query show --name "$alert_name" --resource-group "$RG_NAME" --query "criteria.allOf[0].query" -o tsv)
        if [ "$CURRENT_QUERY" != "$query" ]; then
            az monitor scheduled-query update --name "$alert_name" --resource-group "$RG_NAME" \
                --condition "count 'Placeholder_1' > 0" \
                --condition-query Placeholder_1="$query" \
                --skip-query-validation true --only-show-errors >/dev/null
            alert_action="updated"
        else
            alert_action="unchanged"
        fi
    fi

    # missed-heartbeat.kql looks back ago(14d)/ago(72h), but scheduled-query
    # rules default the query time range to WindowSize*NumberOfEvaluationPeriods
    # (1h here), so without an explicit override the absence join only ever
    # sees ~1h of data and quiet machines never produce a row. Neither
    # `az monitor scheduled-query create` nor `update` exposes a flag for this
    # (checked --help in this environment: no such option in the
    # scheduled-query CLI extension) — set it directly via `az rest` PATCH on
    # the ARM resource. ARM property: properties.overrideQueryTimeRange (ISO
    # 8601 duration), confirmed against Microsoft's scheduledQueryRules
    # template reference (learn.microsoft.com/azure/templates/microsoft.insights/
    # scheduledqueryrules). The PATCH is idempotent, so it's applied
    # unconditionally on every run rather than trying to read back and compare
    # the current value first.
    if [ "$base_name" = "missed-heartbeat" ]; then
        RULE_ID=$(az monitor scheduled-query show --name "$alert_name" --resource-group "$RG_NAME" --query id -o tsv)
        az rest --method patch --url "https://management.azure.com${RULE_ID}?api-version=2022-06-15" \
            --body '{"properties":{"overrideQueryTimeRange":"P14D"}}' --only-show-errors >/dev/null
        echo "  overrideQueryTimeRange=P14D (missed-heartbeat needs 14d/72h of history; window/eval-frequency alone only cover 1h)"
    fi

    echo "OK: $alert_name ($alert_action, window=$window)"
done

echo ""
echo "=== Availability Test (webtest) ==="
# UNVERIFIED: az CLI has no first-class `az monitor app-insights web-test` command;
# classic ping webtests are the `Microsoft.Insights/webtests` ARM resource type,
# created here via `az rest`. The XML `Configuration.WebTest` shape and the
# `hidden-link:<appInsightsId>` tag (which associates the test with the AI
# resource in the portal UI) follow the long-standing classic-webtest schema;
# not exercised against a live subscription in this environment.
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
WEBTEST_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RG_NAME/providers/microsoft.insights/webtests/$WEBTEST_NAME"
if ! az rest --method get --url "https://management.azure.com${WEBTEST_ID}?api-version=2022-06-15" --only-show-errors >/dev/null 2>&1; then
    REQUEST_GUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')
    TEST_GUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')
    WEBTEST_XML="<WebTest Name=\"$WEBTEST_NAME\" Id=\"$TEST_GUID\" Enabled=\"True\" CssProjectStructure=\"\" CssIteration=\"\" Timeout=\"30\" WorkItemIds=\"\" xmlns=\"http://microsoft.com/schemas/VisualStudio/TeamTest/2010\" Description=\"\" CredentialUserName=\"\" CredentialPassword=\"\" PreAuthenticate=\"True\" Proxy=\"default\" StopOnError=\"False\" RecordedResultFile=\"\" ResultsLocale=\"\"><Items><Request Method=\"GET\" Guid=\"$REQUEST_GUID\" Version=\"1.1\" Url=\"$HEALTHZ_URL\" ThinkTime=\"0\" Timeout=\"30\" ParseDependentRequests=\"False\" FollowRedirects=\"True\" RecordResult=\"True\" Cache=\"False\" ResponseTimeGoal=\"0\" Encoding=\"utf-8\" ExpectedHttpStatusCode=\"200\" ExpectedResponseUrl=\"\" ReportingName=\"\" IgnoreHttpStatusCode=\"False\" /></Items></WebTest>"
    WEBTEST_XML_ESCAPED=$(printf '%s' "$WEBTEST_XML" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')

    # See the DCR_RULE_FILE mktemp comment above — same BSD-mktemp requirement.
    WEBTEST_BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/agent-backup-webtest.XXXXXX")
    trap 'rm -f "$WEBTEST_BODY_FILE"' EXIT
    cat > "$WEBTEST_BODY_FILE" <<EOF
{
  "location": "$LOCATION",
  "kind": "ping",
  "tags": { "hidden-link:$AI_RESOURCE_ID": "Resource" },
  "properties": {
    "SyntheticMonitorId": "$WEBTEST_NAME",
    "Name": "$WEBTEST_NAME",
    "Description": "agent-sessions-backup hub health check",
    "Enabled": true,
    "Frequency": 300,
    "Timeout": 30,
    "Kind": "ping",
    "RetryEnabled": true,
    "Locations": [
      { "Id": "us-ca-sjc-azr" },
      { "Id": "us-tx-sn1-azr" },
      { "Id": "us-il-ch1-azr" },
      { "Id": "emea-nl-ams-azr" },
      { "Id": "apac-sg-sin-azr" }
    ],
    "Configuration": { "WebTest": $WEBTEST_XML_ESCAPED }
  }
}
EOF
    az rest --method put --url "https://management.azure.com${WEBTEST_ID}?api-version=2022-06-15" \
        --body "@$WEBTEST_BODY_FILE" --only-show-errors >/dev/null
    rm -f "$WEBTEST_BODY_FILE"
    trap - EXIT
fi
echo "OK: $WEBTEST_NAME (pings $HEALTHZ_URL)"

echo ""
echo "=== Availability Metric Alert ==="
# The `availabilityResults/availabilityPercentage` metric's dimension is
# `availabilityResult/name` (not `webtest/name`) — doc-verified against
# Microsoft's supported-metrics reference for microsoft.insights/components:
# https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-insights-components-metrics
# (Category: Availability). `az monitor metrics alert create` validates
# dimension names against this list, so the wrong name would have failed
# provisioning outright here; the end-to-end alert (does it actually fire when
# the webtest fails) remains UNVERIFIED until M4 — only the dimension name
# itself is doc-verified, not a live run of this command.
AVAIL_ALERT_NAME="agent-backup-healthz-availability"
if ! az monitor metrics alert show --name "$AVAIL_ALERT_NAME" --resource-group "$RG_NAME" --only-show-errors >/dev/null 2>&1; then
    az monitor metrics alert create --name "$AVAIL_ALERT_NAME" --resource-group "$RG_NAME" \
        --scopes "$AI_RESOURCE_ID" \
        --condition "avg availabilityResults/availabilityPercentage < 100 where availabilityResult/name includes $WEBTEST_NAME" \
        --window-size 5m --evaluation-frequency 1m --severity 1 \
        --description "agent-sessions-backup: $HEALTHZ_URL availability test failing" \
        --action "$AG_ID" --only-show-errors >/dev/null
fi
echo "OK: $AVAIL_ALERT_NAME"

TENANT_ID=$(az account show --query tenantId -o tsv)

echo ""
echo "=== Outputs ==="
echo "Tenant ID:              $TENANT_ID"
echo "Managed Identity ID:    $MI_CLIENT_ID"
echo "DCR resource ID:        $DCR_ID"
echo "OTLP logs endpoint:     $OTLP_LOGS_ENDPOINT"
echo "OTLP traces endpoint:   $OTLP_TRACES_ENDPOINT"

OUTPUT_FILE="$REPO_ROOT/infra/out/azure.env"
mkdir -p "$(dirname "$OUTPUT_FILE")"
cat > "$OUTPUT_FILE" <<EOF
TENANT_ID=$TENANT_ID
APP_CLIENT_ID=$MI_CLIENT_ID
OTLP_LOGS_ENDPOINT=$OTLP_LOGS_ENDPOINT
OTLP_TRACES_ENDPOINT=$OTLP_TRACES_ENDPOINT
GATEWAY_FEDERATION_SUBJECT=$FED_SUBJECT
DCR_RESOURCE_ID=$DCR_ID
LOG_ANALYTICS_WORKSPACE_ID=$LAW_ID
EOF
echo ""
echo "Written to: $OUTPUT_FILE"
echo "Next: fill hub/wrangler.telemetry-gateway.jsonc's vars from this file (see infra/cf/telemetry.md)."
