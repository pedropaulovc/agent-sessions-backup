import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalBytes, assertExactKeys } from './canonical.mjs';
import { packageRoot } from './provenance.mjs';

export async function loadTrustedServiceConfig() {
  const value = JSON.parse(await readFile(join(packageRoot, 'src', 'release-services.json'), 'utf8'));
  assertExactKeys(value, ['format', 'enrollment']);
  if (value.format !== 1) throw new Error('unsupported protected release service configuration');
  if (value.enrollment !== null) validateEnrollmentConfig(value.enrollment);
  return Object.freeze(value);
}

export class EnrollmentTransport {
  constructor(config) {
    validateEnrollmentConfig(config);
    this.browserOrigin = requireHttpsOrigin(config.browserOrigin);
    this.browserPath = requirePath(config.browserPath);
  }

  async browserUrl(metadata, callback) {
    const callbackUrl = new URL(callback);
    if (callbackUrl.protocol !== 'http:' || callbackUrl.hostname !== '127.0.0.1' || !callbackUrl.port || callbackUrl.pathname !== '/enroll' || callbackUrl.search || callbackUrl.hash) throw new Error('enrollment callback must be an exact loopback URL');
    const url = new URL(this.browserPath, this.browserOrigin);
    url.searchParams.set('request', canonicalBytes(metadata).toString('base64url'));
    url.searchParams.set('callback', callbackUrl.href);
    return url.href;
  }
}

function validateEnrollmentConfig(value) {
  assertExactKeys(value, ['browserOrigin', 'browserPath']);
  requireHttpsOrigin(value.browserOrigin);
  requirePath(value.browserPath);
}

function requireHttpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('trusted service origin must be an HTTPS origin');
  return url.origin;
}

function requirePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('?') || value.includes('#') || value.split('/').includes('..')) throw new Error('trusted service path must be a canonical absolute path');
  return value;
}
