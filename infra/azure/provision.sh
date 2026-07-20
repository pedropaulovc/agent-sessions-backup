#!/bin/bash
# Usage: ./infra/azure/provision.sh <issuer-url>
#
# Provisions Azure observability resources for agent-sessions-backup (idempotent
# — every resource is show-or-create, safe to re-run). Requires: az CLI with an
# active login session (`az login`) and jq. The application-insights,
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
# *** VERIFIED LIVE 2026-07-17 against subscription "Pay-As-You-Go Dev/Test":
# the full script runs clean end to end (exit 0, idempotent on re-run) and
# stands up rg-agent-backup with the DCE/DCR (ARM-deployed — see the DCR section
# for why a raw `az rest` PUT of directDataSources fails), managed identity +
# federated credential, Metrics Publisher role, action group, all three
# scheduled-query alerts, the /healthz webtest, and the availability metric
# alert. The OTLP federation path is proven: a synthetic OTLP log POSTed through
# sessions-telemetry-gateway mints an Entra token via the federated credential
# and is accepted by the DCR (HTTP 204). ***
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
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

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
WORKBOOK_NAME="03c0208e-6d39-4a92-8502-b0c4a983d7e1"
WORKBOOK_DISPLAY_NAME="Agent sessions backup - System health"
# sessions.vza.net/healthz only resolves once the M3 zone routes in
# hub/wrangler.jsonc are uncommented and deployed (currently commented out —
# see that file). If you're running this script before M3, override with a
# workers.dev URL that's live today, e.g.:
#   HEALTHZ_URL=https://sessions-hub.<account>.workers.dev/healthz ./infra/azure/provision.sh <issuer-url>
# and re-run after M3 lands to point the webtest at the real custom domain.
HEALTHZ_URL="${HEALTHZ_URL:-https://sessions.vza.net/healthz}"

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

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required to validate and package the source-controlled Azure Workbook." >&2
    exit 1
fi

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
echo "=== Data Collection Endpoint + Rule (native OTLP ingestion: logs + traces) ==="
# The DCE and DCR are deployed together via an ARM template — Microsoft's
# documented "manual resource orchestration" path for native OTLP/DCR ingestion
# (learn.microsoft.com/azure/azure-monitor/containers/opentelemetry-protocol-
# ingestion, "Option 2", backed by the community template Azure Services/Azure
# Monitor/OpenTelemetry/OTLP_DCE_DCR_ARM_Template.txt). Trimmed to logs + traces
# only: Cloudflare Workers observability emits no metrics, so no Azure Monitor
# Workspace / Custom-Metrics-Otel stream is wired. Destination is
# law-agent-backup so the scheduled-query alerts below (scoped to that
# workspace) actually see the data — as opposed to enabling "OTLP support: On"
# on the App Insights component (Option 1), which auto-provisions a *separate*
# managed Log Analytics workspace the alerts would then have to be re-scoped to.
#
# Why an ARM deployment and not a raw `az rest` PUT: a direct PUT of a body
# carrying `directDataSources` (even pinned to api-version 2024-03-11) is
# rejected with `InvalidPayload: Application Insights reference
# 'applicationInsightsResource' is not used` — the direct-resource write path
# does not consume the reference the way an ARM deployment does. The template
# below declares BOTH `dataSources` (AMA path) and `directDataSources` (the
# OTel-Collector-direct path the gateway uses), each enriching against the
# `applicationInsightsResource` reference, exactly as Microsoft's community
# template does; that shape deploys cleanly and was verified live.
# `az deployment group create` is natively idempotent (incremental mode), so
# re-running converges without the manual show-or-create-or-update drift dance.
#
# Two distinct name layers, both load-bearing: the DCR-internal stream ids
# (`Microsoft-OTel-Logs`, `Microsoft-OTel-Traces-{Spans,Events,Resources}`) that
# dataSources/directDataSources/dataFlows reference, versus the OTLP URL route
# segment (`Microsoft-OTLP-{Logs,Traces}`) the worker POSTs to (see
# OTLP_LOGS_ENDPOINT below). Verified against the managed DCR a sibling project
# (youtube-mirror) provisions via the portal "OTLP support: On" toggle.
DCR_TEMPLATE_FILE=$(mktemp "${TMPDIR:-/tmp}/agent-backup-otlp-dcr-arm.XXXXXX")
trap 'rm -f "$DCR_TEMPLATE_FILE"' EXIT
cat > "$DCR_TEMPLATE_FILE" <<'ARMEOF'
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "dataCollectionRuleName": { "type": "string" },
    "dataCollectionEndpointName": { "type": "string" },
    "location": { "type": "string" },
    "applicationInsightsResourceId": { "type": "string" },
    "logAnalyticsWorkspaceResourceId": { "type": "string" }
  },
  "resources": [
    {
      "type": "Microsoft.Insights/dataCollectionEndpoints",
      "apiVersion": "2024-03-11",
      "name": "[parameters('dataCollectionEndpointName')]",
      "location": "[parameters('location')]",
      "properties": {
        "description": "OTLP telemetry ingestion endpoint (agent-sessions-backup)",
        "networkAcls": { "publicNetworkAccess": "Enabled" }
      }
    },
    {
      "type": "Microsoft.Insights/dataCollectionRules",
      "apiVersion": "2024-03-11",
      "name": "[parameters('dataCollectionRuleName')]",
      "location": "[parameters('location')]",
      "dependsOn": [
        "[resourceId('Microsoft.Insights/dataCollectionEndpoints', parameters('dataCollectionEndpointName'))]"
      ],
      "properties": {
        "description": "OTLP logs + traces from sessions-telemetry-gateway -> law-agent-backup",
        "dataCollectionEndpointId": "[resourceId('Microsoft.Insights/dataCollectionEndpoints', parameters('dataCollectionEndpointName'))]",
        "references": {
          "applicationInsights": [
            { "resourceId": "[parameters('applicationInsightsResourceId')]", "name": "applicationInsightsResource" }
          ]
        },
        "dataSources": {
          "otelLogs": [
            {
              "streams": ["Microsoft-OTel-Logs"],
              "enrichWithResourceAttributes": ["*"],
              "enrichWithReference": "applicationInsightsResource",
              "replaceResourceIdWithReference": true,
              "name": "otelLogsDataSource"
            }
          ],
          "otelTraces": [
            {
              "streams": ["Microsoft-OTel-Traces-Spans", "Microsoft-OTel-Traces-Events", "Microsoft-OTel-Traces-Resources"],
              "enrichWithResourceAttributes": ["*"],
              "enrichWithReference": "applicationInsightsResource",
              "replaceResourceIdWithReference": true,
              "name": "otelTracesDataSource"
            }
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
            { "workspaceResourceId": "[parameters('logAnalyticsWorkspaceResourceId')]", "name": "lawDestination" }
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
  ],
  "outputs": {
    "dataCollectionRuleId": {
      "type": "string",
      "value": "[resourceId('Microsoft.Insights/dataCollectionRules', parameters('dataCollectionRuleName'))]"
    },
    "dataCollectionRuleImmutableId": {
      "type": "string",
      "value": "[reference(resourceId('Microsoft.Insights/dataCollectionRules', parameters('dataCollectionRuleName')), '2024-03-11', 'full').properties.immutableId]"
    },
    "dataCollectionEndpointLogsIngestion": {
      "type": "string",
      "value": "[reference(resourceId('Microsoft.Insights/dataCollectionEndpoints', parameters('dataCollectionEndpointName')), '2024-03-11', 'full').properties.logsIngestion.endpoint]"
    }
  }
}
ARMEOF

DCR_DEPLOY_OUT=$(az deployment group create --resource-group "$RG_NAME" --name "agent-backup-otlp-dcr" \
    --template-file "$DCR_TEMPLATE_FILE" \
    --parameters \
        dataCollectionEndpointName="$DCE_NAME" \
        dataCollectionRuleName="$DCR_NAME" \
        location="$LOCATION" \
        applicationInsightsResourceId="$AI_RESOURCE_ID" \
        logAnalyticsWorkspaceResourceId="$LAW_ID" \
    --query properties.outputs -o json --only-show-errors)
rm -f "$DCR_TEMPLATE_FILE"
trap - EXIT

DCR_ID=$(echo "$DCR_DEPLOY_OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["dataCollectionRuleId"]["value"])')
DCR_IMMUTABLE_ID=$(echo "$DCR_DEPLOY_OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["dataCollectionRuleImmutableId"]["value"])')
DCE_LOGS_INGESTION=$(echo "$DCR_DEPLOY_OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["dataCollectionEndpointLogsIngestion"]["value"])')

# The URL route segment is "Microsoft-OTLP-{Logs,Traces}" (the OTLP wire
# protocol endpoint name), NOT the DCR-internal "Microsoft-OTel-*" stream ids
# declared above — two different names for two different layers. Casing matches
# a known-working sibling deployment (youtube-mirror), which uses
# "dataCollectionRules" (capital C, R); Microsoft's own docs are inconsistently
# cased here, but the capitalized form is what actually ingests.
OTLP_LOGS_ENDPOINT="${DCE_LOGS_INGESTION}/dataCollectionRules/${DCR_IMMUTABLE_ID}/streams/Microsoft-OTLP-Logs/otlp/v1/logs"
OTLP_TRACES_ENDPOINT="${DCE_LOGS_INGESTION}/dataCollectionRules/${DCR_IMMUTABLE_ID}/streams/Microsoft-OTLP-Traces/otlp/v1/traces"
echo "OK: $DCE_NAME + $DCR_NAME ($DCR_ID)"
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
        d1-size) echo "1h" ;;
        cf-auth-failed) echo "1h" ;;
        cert-orphan-leaked) echo "1h" ;;
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

    # No overrideQueryTimeRange is set for any alert. An earlier design tried
    # P14D for missed-heartbeat (its old absence-JOIN form needed a 14d
    # baseline), but Azure rejects it: overrideQueryTimeRange maxes at 2880 min
    # (48h) — "Supported granularities are: 5,10,15,30,45,60,120,180,240,300,
    # 360,720,1440,2880". That 48h cap is itself shorter than the 72h heartbeat
    # tolerance, which is exactly why missed-heartbeat.kql was rewritten to
    # threshold on the hub watchdog's per-machine `hub.machine.heartbeat_age`
    # gauge (re-emitted every 15 min for every machine, dead or alive) over a
    # short ago(30m) window instead of a self-referential absence JOIN. With the
    # gauge form, the rule's default query range (WindowSize) already covers the
    # ago(30m) the query needs — no override required.

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
WEBTEST_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RG_NAME/providers/microsoft.insights/webtests/$WEBTEST_NAME"
WEBTEST_URL="https://management.azure.com${WEBTEST_ID}?api-version=2022-06-15"

REQUEST_GUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')
TEST_GUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')
WEBTEST_XML="<WebTest Name=\"$WEBTEST_NAME\" Id=\"$TEST_GUID\" Enabled=\"True\" CssProjectStructure=\"\" CssIteration=\"\" Timeout=\"30\" WorkItemIds=\"\" xmlns=\"http://microsoft.com/schemas/VisualStudio/TeamTest/2010\" Description=\"\" CredentialUserName=\"\" CredentialPassword=\"\" PreAuthenticate=\"True\" Proxy=\"default\" StopOnError=\"False\" RecordedResultFile=\"\" ResultsLocale=\"\"><Items><Request Method=\"GET\" Guid=\"$REQUEST_GUID\" Version=\"1.1\" Url=\"$HEALTHZ_URL\" ThinkTime=\"0\" Timeout=\"30\" ParseDependentRequests=\"False\" FollowRedirects=\"True\" RecordResult=\"True\" Cache=\"False\" ResponseTimeGoal=\"0\" Encoding=\"utf-8\" ExpectedHttpStatusCode=\"200\" ExpectedResponseUrl=\"\" ReportingName=\"\" IgnoreHttpStatusCode=\"False\" /></Items></WebTest>"
WEBTEST_XML_ESCAPED=$(printf '%s' "$WEBTEST_XML" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')

# See the DCR_RULE_FILE mktemp comment above — same BSD-mktemp requirement.
WEBTEST_BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/agent-backup-webtest.XXXXXX")
WEBTEST_CURRENT_FILE=$(mktemp "${TMPDIR:-/tmp}/agent-backup-webtest-current.XXXXXX")
trap 'rm -f "$WEBTEST_BODY_FILE" "$WEBTEST_CURRENT_FILE"' EXIT
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

# Show-or-create-or-update-on-drift: a bare existence check would leave an
# already-created webtest permanently pinned to whatever HEALTHZ_URL was set
# on its FIRST run — e.g. the documented pre-M3 workers.dev override — with
# every later re-run (post-M3, without the override) printing OK while Azure
# keeps pinging the stale URL. Compare the URL embedded in the existing
# test's Configuration.WebTest XML against the desired HEALTHZ_URL and PUT on
# drift, same pattern as the DCR and scheduled-query alerts above.
if az rest --method get --url "$WEBTEST_URL" --only-show-errors -o json > "$WEBTEST_CURRENT_FILE" 2>/dev/null; then
    CURRENT_HEALTHZ_URL=$(python3 -c "
import json, re
with open('$WEBTEST_CURRENT_FILE') as f:
    current = json.load(f)
xml = current.get('properties', {}).get('Configuration', {}).get('WebTest', '')
m = re.search(r'Url=\"([^\"]*)\"', xml)
print(m.group(1) if m else '')
")
    if [ "$CURRENT_HEALTHZ_URL" = "$HEALTHZ_URL" ]; then
        WEBTEST_ACTION="unchanged"
    else
        az rest --method put --url "$WEBTEST_URL" --body "@$WEBTEST_BODY_FILE" --only-show-errors >/dev/null
        WEBTEST_ACTION="updated (was $CURRENT_HEALTHZ_URL)"
    fi
else
    az rest --method put --url "$WEBTEST_URL" --body "@$WEBTEST_BODY_FILE" --only-show-errors >/dev/null
    WEBTEST_ACTION="created"
fi
rm -f "$WEBTEST_BODY_FILE" "$WEBTEST_CURRENT_FILE"
trap - EXIT
echo "OK: $WEBTEST_NAME ($WEBTEST_ACTION) (pings $HEALTHZ_URL)"

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

echo ""
echo "=== Azure Workbook (system health) ==="
# Workbooks are ARM resources. Keep the Notebook/1.0 payload in source control
# instead of embedding an escaped JSON string in this shell script; jq validates
# it and serializes it into the ARM `serializedData` property. The stable GUID
# makes this PUT idempotent and lets every re-run converge edits to the existing
# workbook rather than creating another gallery entry.
#
# Every KQL item is scoped through sourceId and fallbackResourceIds to
# law-agent-backup. `sourceId` associates the ARM resource, while the fallback
# resource makes the queries resolve when the workbook is opened from the
# Azure Monitor Workbooks gallery instead of directly from the workspace blade.
# The queries use
# `union isfuzzy=true` empty-datatable guards around OTelLogs, OTelSpans, and
# AppAvailabilityResults so a table that has not received its first record yet
# renders as empty/no-data instead of breaking the entire workbook.
WORKBOOK_DEFINITION="$REPO_ROOT/infra/azure/workbooks/system-health.workbook.json"
WORKBOOK_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RG_NAME/providers/Microsoft.Insights/workbooks/$WORKBOOK_NAME"
WORKBOOK_URL="https://management.azure.com${WORKBOOK_ID}?api-version=2023-06-01"
WORKBOOK_BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/agent-backup-workbook.XXXXXX")
trap 'rm -f "$WORKBOOK_BODY_FILE"' EXIT
jq -e . "$WORKBOOK_DEFINITION" >/dev/null
jq -n \
    --arg location "$LOCATION" \
    --arg displayName "$WORKBOOK_DISPLAY_NAME" \
    --arg sourceId "$LAW_ID" \
    --arg hiddenLink "hidden-link:$LAW_ID" \
    --slurpfile workbook "$WORKBOOK_DEFINITION" \
    '{
      location: $location,
      kind: "shared",
      tags: {($hiddenLink): "Resource"},
      properties: {
        displayName: $displayName,
        serializedData: ($workbook[0] | .fallbackResourceIds = [$sourceId] | tojson),
        version: "Notebook/1.0",
        sourceId: $sourceId,
        category: "workbook"
      }
    }' > "$WORKBOOK_BODY_FILE"

az rest --method put --url "$WORKBOOK_URL" --body "@$WORKBOOK_BODY_FILE" --only-show-errors >/dev/null
rm -f "$WORKBOOK_BODY_FILE"
trap - EXIT
echo "OK: $WORKBOOK_DISPLAY_NAME ($WORKBOOK_ID)"

TENANT_ID=$(az account show --query tenantId -o tsv)

echo ""
echo "=== Outputs ==="
echo "Tenant ID:              $TENANT_ID"
echo "Managed Identity ID:    $MI_CLIENT_ID"
echo "DCR resource ID:        $DCR_ID"
echo "System health workbook: $WORKBOOK_ID"
echo "OTLP logs endpoint:     $OTLP_LOGS_ENDPOINT"
echo "OTLP traces endpoint:   $OTLP_TRACES_ENDPOINT"
echo "OIDC issuer URL:        $ISSUER_URL"

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
OIDC_ISSUER_URL=$ISSUER_URL
EOF
echo ""
echo "Written to: $OUTPUT_FILE"
echo "Next: fill hub/wrangler.telemetry-gateway.jsonc's vars from this file (see infra/cf/telemetry.md)."
