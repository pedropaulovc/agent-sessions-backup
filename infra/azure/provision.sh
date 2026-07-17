#!/bin/bash
# Usage: ./infra/azure/provision.sh <issuer-url>
#
# Provisions Azure observability resources for agent-sessions-backup (idempotent
# — every resource is show-or-create, safe to re-run). Requires: az CLI with an
# active login session (`az login`).
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
# *output* (youtube-mirror's infra/federation.md), not from a run of this exact
# script against a live subscription — nobody has run `az` in this environment.
# Confirm both live at M4 deploy before trusting this script end to end. ***

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
echo "=== Data Collection Rule (Microsoft-OTLP-Logs + Microsoft-OTLP-Traces) ==="
# UNVERIFIED: this is the riskiest resource in this script. `Microsoft-OTLP-Logs`
# and `Microsoft-OTLP-Traces` are Microsoft **built-in** stream names (no
# streamDeclarations needed, unlike Custom-* streams) per Azure Monitor's native
# OTLP ingestion docs (learn.microsoft.com/azure/azure-monitor/containers/
# opentelemetry-protocol-ingestion, "Construct endpoint URLs" section) — that doc's
# own worked example DCR was created via the Azure portal ("Create an Application
# Insights resource" with "OTLP support: On"), NOT this manual az/rule-file path.
# If this DCR create call rejects the built-in stream names (e.g. demands a
# streamDeclaration, or the stream names differ from what's shown here), the
# fallback is: create ai-agent-backup with "OTLP support: On" via the portal
# (or `az rest` PATCH once the exact property is confirmed), which auto-provisions
# an equivalent "managed-ai-..." DCE/DCR pair — copy its endpoint URLs into
# infra/out/azure.env by hand instead of relying on this script's output.
if ! az monitor data-collection rule show --name "$DCR_NAME" --resource-group "$RG_NAME" --only-show-errors >/dev/null 2>&1; then
    DCR_RULE_FILE=$(mktemp)
    trap 'rm -f "$DCR_RULE_FILE"' EXIT
    cat > "$DCR_RULE_FILE" <<EOF
{
  "location": "$LOCATION",
  "properties": {
    "dataCollectionEndpointId": "$DCE_ID",
    "destinations": {
      "logAnalytics": [
        { "workspaceResourceId": "$LAW_ID", "name": "lawDestination" }
      ]
    },
    "dataFlows": [
      { "streams": ["Microsoft-OTLP-Logs"], "destinations": ["lawDestination"] },
      { "streams": ["Microsoft-OTLP-Traces"], "destinations": ["lawDestination"] }
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
az identity federated-credential show --name "$FED_CRED_NAME" --identity-name "$MI_NAME" --resource-group "$RG_NAME" --only-show-errors >/dev/null 2>&1 \
    || az identity federated-credential create --name "$FED_CRED_NAME" --identity-name "$MI_NAME" --resource-group "$RG_NAME" \
        --issuer "$ISSUER_URL" --subject "$FED_SUBJECT" --audiences "api://AzureADTokenExchange" --only-show-errors >/dev/null
echo "OK: $FED_CRED_NAME (issuer=$ISSUER_URL, subject=$FED_SUBJECT)"

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
declare -A ALERT_WINDOWS=(
    [missed-heartbeat]="1h"
    [collector-errors]="1h"
    [parse-errors]="15m"
)
for kql_file in "$REPO_ROOT"/infra/azure/alerts/*.kql; do
    [ -e "$kql_file" ] || continue
    base_name=$(basename "$kql_file" .kql)
    alert_name="agent-backup-$base_name"
    window="${ALERT_WINDOWS[$base_name]:-15m}"

    if ! az monitor scheduled-query show --name "$alert_name" --resource-group "$RG_NAME" --only-show-errors >/dev/null 2>&1; then
        query=$(cat "$kql_file")
        az monitor scheduled-query create --name "$alert_name" --resource-group "$RG_NAME" \
            --scopes "$LAW_ID" --location "$LOCATION" \
            --condition "count 'Placeholder_1' > 0" \
            --condition-query Placeholder_1="$query" \
            --description "agent-sessions-backup: $base_name (see infra/azure/alerts/$base_name.kql)" \
            --evaluation-frequency "$window" --window-size "$window" \
            --severity 2 --action-groups "$AG_ID" --only-show-errors >/dev/null
    fi
    echo "OK: $alert_name (window=$window)"
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

    WEBTEST_BODY_FILE=$(mktemp)
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
# UNVERIFIED: the `availabilityResults/availabilityPercentage` metric + the
# `webtest/name` dimension filter are the standard portal-generated shape for
# "alert when an availability test fails"; not exercised live here.
AVAIL_ALERT_NAME="agent-backup-healthz-availability"
if ! az monitor metrics alert show --name "$AVAIL_ALERT_NAME" --resource-group "$RG_NAME" --only-show-errors >/dev/null 2>&1; then
    az monitor metrics alert create --name "$AVAIL_ALERT_NAME" --resource-group "$RG_NAME" \
        --scopes "$AI_RESOURCE_ID" \
        --condition "avg availabilityResults/availabilityPercentage < 100 where webtest/name includes $WEBTEST_NAME" \
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
