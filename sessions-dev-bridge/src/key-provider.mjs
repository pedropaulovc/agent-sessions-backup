import { constants } from 'node:fs';
import { chmod, mkdir, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createPublicKey, randomBytes } from 'node:crypto';
import { runProcess, zero } from './secure.mjs';

const CNG_PROVIDER = 'Microsoft Platform Crypto Provider';
const TPM_PROCESS_TIMEOUT_MS = 120_000;

export function platformKeyProvider(stateDirectory, options = {}) {
  if (process.platform === 'win32') return new WindowsCngKeyProvider(options.runProcess ?? runProcess);
  if (process.platform === 'linux') return new LinuxTpm2KeyProvider(join(stateDirectory, 'device-keys'), options.runProcess ?? runProcess);
  return new UnavailableKeyProvider(`unsupported platform ${process.platform}`);
}

export class UnavailableKeyProvider {
  constructor(reason) { this.reason = reason; }
  async available() { return false; }
  async create() { throw new Error(`hardware-backed key unavailable: ${this.reason}`); }
  async sign() { throw new Error(`hardware-backed key unavailable: ${this.reason}`); }
  async remove() {}
}

export class WindowsCngKeyProvider {
  constructor(run = runProcess) { this.run = run; }
  async available() {
    try {
      const result = await this.#powershell("$ErrorActionPreference='Stop'; $p=[System.Security.Cryptography.CngProvider]::MicrosoftPlatformCryptoProvider; if($p.Provider -ne 'Microsoft Platform Crypto Provider'){throw 'provider mismatch'}; [Console]::Out.Write($p.Provider)");
      return result.stdout.toString('utf8') === CNG_PROVIDER;
    } catch { return false; }
  }
  async create() {
    if (!(await this.available())) throw new Error('TPM-backed Windows CNG provider is unavailable; local import remains disabled');
    const name = `sessions-dev-bridge-${randomBytes(18).toString('hex')}`;
    const script = `$ErrorActionPreference='Stop';$name=$env:BRIDGE_KEY_NAME;$p=[System.Security.Cryptography.CngKeyCreationParameters]::new();$p.Provider=[System.Security.Cryptography.CngProvider]::MicrosoftPlatformCryptoProvider;$p.ExportPolicy=[System.Security.Cryptography.CngExportPolicies]::None;$p.KeyUsage=[System.Security.Cryptography.CngKeyUsages]::Signing;$k=[System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256,$name,$p);try{if($k.Provider.Provider -ne '${CNG_PROVIDER}' -or $k.IsEphemeral){throw 'key is not persistent TPM-backed CNG'};$e=[System.Security.Cryptography.ECDsaCng]::new($k);try{[Console]::Out.Write([Convert]::ToBase64String($e.ExportSubjectPublicKeyInfo()))}finally{$e.Dispose()}}finally{$k.Dispose()}`;
    try {
      const result = await this.#powershell(script, { BRIDGE_KEY_NAME: name });
      const spki = Buffer.from(result.stdout.toString('ascii'), 'base64');
      return { provider: 'windows-cng-tpm', keyRef: name, publicKeyJwk: createPublicKey({ key: spki, format: 'der', type: 'spki' }).export({ format: 'jwk' }), hardwareBacked: true };
    } catch (error) {
      await this.remove(name).catch(() => {});
      throw error;
    }
  }
  async sign(keyRef, bytes) {
    validateCngName(keyRef);
    const input = Buffer.from(bytes);
    try {
      const script = `$ErrorActionPreference='Stop';$name=$env:BRIDGE_KEY_NAME;$k=[System.Security.Cryptography.CngKey]::Open($name,[System.Security.Cryptography.CngProvider]::MicrosoftPlatformCryptoProvider);try{if($k.Provider.Provider -ne '${CNG_PROVIDER}' -or $k.IsEphemeral -or (($k.ExportPolicy -band [System.Security.Cryptography.CngExportPolicies]::AllowExport) -ne 0)){throw 'device key is not non-exportable TPM-backed CNG'};$e=[System.Security.Cryptography.ECDsaCng]::new($k);try{$m=[Convert]::FromBase64String([Console]::In.ReadToEnd());$s=$e.SignData($m,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.DSASignatureFormat]::IeeeP1363FixedFieldConcatenation);[Console]::Out.Write([Convert]::ToBase64String($s));[Array]::Clear($m,0,$m.Length)}finally{$e.Dispose()}}finally{$k.Dispose()}`;
      const result = await this.#powershell(script, { BRIDGE_KEY_NAME: keyRef }, Buffer.from(input.toString('base64'), 'ascii'));
      const signature = Buffer.from(result.stdout.toString('ascii'), 'base64');
      if (signature.length !== 64) throw new Error('CNG returned an invalid P-256 signature');
      return signature;
    } finally { zero(input); }
  }
  async remove(keyRef) {
    validateCngName(keyRef);
    await this.#powershell(`$ErrorActionPreference='Stop';$k=[System.Security.Cryptography.CngKey]::Open($env:BRIDGE_KEY_NAME,[System.Security.Cryptography.CngProvider]::MicrosoftPlatformCryptoProvider);try{$k.Delete()}finally{$k.Dispose()}`, { BRIDGE_KEY_NAME: keyRef });
  }
  #powershell(script, extraEnv = {}, stdin) {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return this.run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env: { ...process.env, PSModuleAutoLoadingPreference: 'None', ...extraEnv }, stdin, timeoutMs: TPM_PROCESS_TIMEOUT_MS,
    });
  }
}

export class LinuxTpm2KeyProvider {
  constructor(keyDirectory, run = runProcess) { this.keyDirectory = resolve(keyDirectory); this.run = run; }
  async available() {
    try {
      const result = await this.run('openssl', ['list', '-providers', '-provider', 'default', '-provider', 'tpm2'], { timeoutMs: TPM_PROCESS_TIMEOUT_MS });
      return result.stdout.toString('utf8').includes('tpm2');
    } catch { return false; }
  }
  async create() {
    if (!(await this.available())) throw new Error('Linux OpenSSL TPM2 provider is unavailable; software keys are forbidden and local import remains disabled');
    await mkdir(this.keyDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.keyDirectory, 0o700);
    const keyRef = `${randomBytes(24).toString('hex')}.tss`;
    const path = join(this.keyDirectory, keyRef);
    try {
      await this.run('openssl', ['genpkey', '-provider', 'default', '-provider', 'tpm2', '-propquery', 'provider=tpm2', '-algorithm', 'EC', '-pkeyopt', 'group:P-256', '-out', path], { timeoutMs: TPM_PROCESS_TIMEOUT_MS });
      await chmod(path, 0o600);
      await this.#assertReference(path);
      const result = await this.run('openssl', ['pkey', '-provider', 'default', '-provider', 'tpm2', '-in', path, '-pubout', '-outform', 'DER'], { timeoutMs: TPM_PROCESS_TIMEOUT_MS });
      return { provider: 'tpm2-pkcs11', keyRef, publicKeyJwk: createPublicKey({ key: result.stdout, format: 'der', type: 'spki' }).export({ format: 'jwk' }), hardwareBacked: true };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }
  async sign(keyRef, bytes) {
    const path = await this.#path(keyRef);
    const input = Buffer.from(bytes);
    try {
      const result = await this.run('openssl', ['dgst', '-sha256', '-provider', 'default', '-provider', 'tpm2', '-sign', path], { stdin: input, timeoutMs: TPM_PROCESS_TIMEOUT_MS });
      return derEcdsaToP1363(result.stdout, 32);
    } finally { zero(input); }
  }
  async remove(keyRef) {
    const path = await this.#path(keyRef);
    await rm(path, { force: true });
  }
  async #path(keyRef) {
    if (typeof keyRef !== 'string' || !/^[0-9a-f]{48}\.tss$/.test(keyRef)) throw new Error('invalid TPM key reference');
    const path = resolve(this.keyDirectory, keyRef);
    if (!inside(this.keyDirectory, path)) throw new Error('TPM key reference escapes key directory');
    await this.#assertReference(path);
    return path;
  }
  async #assertReference(path) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('TPM key reference must be a private regular file');
    if (!inside(this.keyDirectory, await realpath(path))) throw new Error('TPM key reference resolves outside key directory');
    const header = (await readFile(path, { encoding: 'utf8' })).slice(0, 100);
    if (!header.includes('TSS2 PRIVATE KEY')) throw new Error('OpenSSL did not create a TPM2-backed key reference');
  }
}

function validateCngName(value) {
  if (typeof value !== 'string' || !/^sessions-dev-bridge-[0-9a-f]{36}$/.test(value)) throw new Error('invalid CNG key reference');
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function derEcdsaToP1363(der, width) {
  let offset = 0;
  const take = () => der[offset++];
  if (take() !== 0x30) throw new Error('invalid ECDSA DER sequence');
  const sequenceLength = readDerLength(der, () => offset, (value) => { offset = value; });
  if (sequenceLength !== der.length - offset) throw new Error('invalid ECDSA DER length');
  const integers = [];
  for (let index = 0; index < 2; index++) {
    if (take() !== 0x02) throw new Error('invalid ECDSA DER integer');
    const length = readDerLength(der, () => offset, (value) => { offset = value; });
    let value = der.subarray(offset, offset + length);
    offset += length;
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > width) throw new Error('oversized ECDSA integer');
    const padded = Buffer.alloc(width);
    value.copy(padded, width - value.length);
    integers.push(padded);
  }
  if (offset !== der.length) throw new Error('trailing ECDSA DER bytes');
  return Buffer.concat(integers);
}

function readDerLength(bytes, getOffset, setOffset) {
  let offset = getOffset();
  let length = bytes[offset++];
  if (length < 0x80) { setOffset(offset); return length; }
  const count = length & 0x7f;
  if (count === 0 || count > 2 || offset + count > bytes.length) throw new Error('invalid DER length');
  length = 0;
  for (let index = 0; index < count; index++) length = length * 256 + bytes[offset++];
  setOffset(offset);
  return length;
}
