import { createHash, randomBytes } from 'node:crypto';

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('canonical JSON accepts only safe integers');
    return value;
  }
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`undefined canonical field: ${key}`);
      out[key] = sortValue(value[key]);
    }
    return out;
  }
  throw new TypeError(`unsupported canonical value: ${typeof value}`);
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function randomId(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

export function assertExactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected object');
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unexpected field: ${key}`);
  for (const key of required) if (!(key in value)) throw new TypeError(`missing field: ${key}`);
}

export function assertHex(value, length = 64, label = 'digest') {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new TypeError(`${label} must be ${length} lowercase hex characters`);
  }
  return value;
}

export function assertBase64url(value, label = 'value') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError(`${label} must be base64url`);
  return value;
}
