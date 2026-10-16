import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const subscription = '07aba226-fd59-489a-b07b-4158fef12a5d';
const tenant = '6f10d2eb-7cce-444c-bf11-d6fe61d7b8f8';
const resourceGroup = 'rg-agent-backup';
const identity = 'mi-agent-backup-cloudflare-wu2';
const credentialName = 'migration-github-production';
const desired = Object.freeze({
  name: credentialName,
  issuer: 'https://token.actions.githubusercontent.com',
  subject: 'repo:pedropaulovc/agent-sessions-backup:environment:production',
  audiences: ['api://AzureADTokenExchange'],
});

export function migrationFederationPlan(credentials) {
  if (!Array.isArray(credentials)) throw new Error('Invalid federation metadata');
  const credential = credentials.find((entry) => entry.name === credentialName);
  if (!credential) return 'create';
  if (credential.issuer !== desired.issuer || credential.subject !== desired.subject
    || credential.audiences?.length !== 1 || credential.audiences[0] !== desired.audiences[0]) {
    throw new Error('Migration federation credential drift; refusing to replace trust');
  }
  return 'unchanged';
}

export async function provisionMigrationFederation(mode, { az } = {}) {
  if (!['--observe', '--apply'].includes(mode)) throw new Error('Use --observe or --apply explicitly');
  az ??= async (args) => {
    try {
      const { stdout } = await execute('az', [...args, '--only-show-errors', '--output', 'json'], {
        timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      return JSON.parse(stdout);
    } catch (error) {
      const operation = args.slice(0, args.findIndex((arg) => arg.startsWith('--'))).join(' ');
      const category = /AADSTS|az login|AuthenticationFailed|InvalidAuthenticationToken|AuthorizationFailed/i.test(error.stderr ?? '')
        ? 'authentication-or-authorization' : error.killed ? 'deadline' : 'request';
      const exitCode = Number.isInteger(error.code) ? error.code : 'unknown';
      // Never replay CLI error text, arguments or response bodies.
      throw new Error(`Azure ${operation} failed (${category}, exit=${exitCode}); inspect the named resource with az`);
    }
  };
  const account = await az(['account', 'show', '--subscription', subscription]);
  if (account.id !== subscription || account.tenantId !== tenant) throw new Error('Unexpected Azure account');
  const scope = ['--subscription', subscription, '--resource-group', resourceGroup];
  const managedIdentity = await az(['identity', 'show', '--name', identity, ...scope]);
  const credentials = await az(['identity', 'federated-credential', 'list', '--identity-name', identity, ...scope]);
  const plan = migrationFederationPlan(credentials);
  const dcr = await az(['monitor', 'data-collection', 'rule', 'show', '--name', 'dcr-agent-backup', ...scope]);
  const dce = await az(['monitor', 'data-collection', 'endpoint', 'show', '--name', 'dce-agent-backup', ...scope]);
  const roles = await az(['role', 'assignment', 'list', '--subscription', subscription,
    '--assignee', managedIdentity.principalId, '--scope', dcr.id]);
  if (!roles.some((role) => role.scope?.toLowerCase() === dcr.id.toLowerCase()
    && (role.roleDefinitionName === 'Monitoring Metrics Publisher'
      || role.roleDefinitionId?.toLowerCase().endsWith('/3913510d-42f4-4e42-8a64-420c390055eb')))) {
    throw new Error('Existing identity lacks DCR-scoped Monitoring Metrics Publisher; no role changes made');
  }
  if (mode === '--apply' && plan === 'create') {
    await az(['identity', 'federated-credential', 'create', '--name', credentialName,
      '--identity-name', identity, ...scope, '--issuer', desired.issuer, '--subject', desired.subject,
      '--audiences', ...desired.audiences]);
  }
  const endpoint = dce.logsIngestion?.endpoint ?? dce.properties?.logsIngestion?.endpoint;
  const immutableId = dcr.immutableId ?? dcr.properties?.immutableId;
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ingest\.monitor\.azure\.com\/?$/.test(endpoint ?? '')
    || !/^dcr-[a-f0-9]{32}$/.test(immutableId ?? '')
    || !/^[a-f0-9-]{36}$/i.test(managedIdentity.clientId ?? '')) throw new Error('Invalid Azure resource metadata');
  return {
    mode: mode.slice(2), federation: mode === '--apply' && plan === 'create' ? 'created' : plan,
    credential: desired,
    variables: {
      MIGRATION_AZURE_TENANT_ID: tenant,
      MIGRATION_AZURE_CLIENT_ID: managedIdentity.clientId,
      MIGRATION_AZURE_LOGS_ENDPOINT: `${endpoint.replace(/\/$/, '')}/dataCollectionRules/${immutableId}/streams/Microsoft-OTLP-Logs/otlp/v1/logs`,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    console.error('Usage: node infra/azure/provision-migration-federation.mjs --observe|--apply');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await provisionMigrationFederation(process.argv[2]), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
