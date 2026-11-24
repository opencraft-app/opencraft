// Runtime-neutral domain of the employee Git vault: encrypted credential,
// secret and document rows over the SqlDatabase port. The Node owner
// (employee-git-vault-store.node.ts, the `./employee-git-vault-store` export)
// checks the private directory and file, resolves the installation key through
// KeyMaterial, opens the file with openManagedDatabase and supplies the AES-GCM
// cipher; this module never sees key bytes and imports no node:* module.
import type { SqlDatabase } from '@opencraft/sql';
import type { GitGrantScope } from './personal-git-protocol.js';

export type SigningRegistration = 'unregistered' | 'pending' | 'registered' | 'manual_required';
export interface GitVaultCredential {
  identity: { username: string; name: string; email: string; accountId?: string };
  token: string;
  sshAuth?: { generation: string; publicKey: string; fingerprint: string; privateKey: string } | null;
  signing: null | { generation: string; publicKey: string; fingerprint: string; privateKey: string;
    registration: SigningRegistration; remoteKeyId?: number };
}
export interface GitVaultRecord { revision: number; credential: GitVaultCredential | null }
export interface GitVaultStatus {
  revision: number; configured: boolean; identity: GitVaultCredential['identity'] | null;
  sshAuth: Omit<NonNullable<GitVaultCredential['sshAuth']>, 'privateKey'> | null;
  tokenConfigured: boolean; signing: Omit<NonNullable<GitVaultCredential['signing']>, 'privateKey'> | null;
}
import { GitVaultError } from './git-vault-error.js';
export { GitVaultError } from './git-vault-error.js';
const PRIVATE_KEY_HEADER = '-----BEGIN PRIVATE KEY-----';
const SCHEMA = 'CREATE TABLE employee_git_credentials (account TEXT NOT NULL, host TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), credential BLOB, PRIMARY KEY(account,host)) STRICT';
export const EMPLOYEE_GIT_VAULT_MIGRATIONS = [{ version: 1, name: 'employee-git-credentials', sql: SCHEMA }] as const;

function validateKey(account: string, host: string): void {
  if (!account || account.length > 256 || /[\0\r\n]/u.test(account) || !/^[a-z0-9.-]{1,253}$/u.test(host)) throw new GitVaultError('invalid');
}
export function validateGitVaultCredential(value: GitVaultCredential): void {
  const text = (s: unknown, maximum: number) => typeof s === 'string' && s.length > 0 && s.length <= maximum && !/[\0\r\n]/u.test(s);
  if (!value?.identity || !text(value.identity.username, 128) || !text(value.identity.name, 256)
    || !text(value.identity.email, 320) || !/^[^\s@]+@[^\s@]+$/u.test(value.identity.email)
    || !(text(value.token, 4096) || (value.token === '' && value.sshAuth !== undefined))) throw new GitVaultError('invalid');
  if (value.sshAuth && (!text(value.sshAuth.generation, 128) || !text(value.sshAuth.publicKey, 1024)
    || !text(value.sshAuth.fingerprint, 128) || !value.sshAuth.privateKey.startsWith(PRIVATE_KEY_HEADER)
    || value.sshAuth.privateKey.length > 4096)) throw new GitVaultError('invalid');
  if (value.signing && (!['unregistered', 'pending', 'registered', 'manual_required'].includes(value.signing.registration)
    || !text(value.signing.generation, 128) || !text(value.signing.publicKey, 1024)
    || !value.signing.privateKey.startsWith(PRIVATE_KEY_HEADER) || value.signing.privateKey.length > 4096)) throw new GitVaultError('invalid');
}

/** Installation key for this vault, stored beside the database through the KeyMaterial port. */
export const EMPLOYEE_GIT_VAULT_KEY = 'employee-git-vault.key';

/**
 * Authenticated encryption held by the vault owner. `seal` returns one opaque
 * byte string that `open` accepts only with the same associated data; the
 * Node owner keeps the original AES-256-GCM layout (IV, ciphertext, tag), so
 * existing rows and envelopes stay readable. The grant methods use the same key.
 */
export interface GitVaultCipher {
  seal(aad: Uint8Array, clear: Uint8Array): Uint8Array;
  open(aad: Uint8Array, sealed: Uint8Array): Uint8Array;
  grantAuthority(accountMode: 'principal' | 'actor'): string;
  sealGrant(scope: GitGrantScope): string;
  /** Erases the key; later calls fail. */
  dispose(): void;
}

const utf8 = new TextEncoder();
// Like Buffer#toString('utf8'): a leading BOM is kept, not stripped.
const text = new TextDecoder('utf-8', { ignoreBOM: true });
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Unpadded base64url, as Buffer's `base64url` encoding writes it. */
export function encodeGitVaultBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]!;
  }
  return out;
}
/** Decodes base64url characters (others count as zero); callers reject input that does not re-encode identically. */
export function decodeGitVaultBase64Url(value: string): Uint8Array {
  const out = new Uint8Array(Math.floor((value.length * 6) / 8));
  let bits = 0, buffer = 0, index = 0;
  for (const character of value) {
    buffer = ((buffer << 6) | Math.max(0, ALPHABET.indexOf(character))) & 0xffffff; bits += 6;
    if (bits >= 8) { bits -= 8; out[index++] = (buffer >> bits) & 255; }
  }
  return out;
}

/** Opaque account scope is supplied by the verified identity provider, never by a browser body.
 * The owner lends a migrated connection and the cipher; `close()` hands both back. */
export class EmployeeGitVault {
  constructor(private readonly db: SqlDatabase, private readonly cipher: GitVaultCipher, private readonly release: () => void = () => {}) {}
  /** Binding presence only: never decrypt credentials to decide host-wide fallback. */
  hasBindings(host: string): boolean {
    validateKey('binding-presence', host);
    return !!this.db.prepare('SELECT 1 FROM employee_git_credentials WHERE host=? AND credential IS NOT NULL LIMIT 1').get(host);
  }
  private readValue(account: string, host: string): { revision: number; credential: unknown } {
    validateKey(account, host);
    const row = this.db.prepare('SELECT revision,credential FROM employee_git_credentials WHERE account=? AND host=?').get(account, host);
    if (!row) return { revision: 0, credential: null };
    if (row.credential === null) return { revision: Number(row.revision), credential: null };
    let clear: Uint8Array | undefined;
    try {
      clear = this.cipher.open(this.aad(account, host), row.credential as Uint8Array);
      const credential: unknown = JSON.parse(text.decode(clear));
      return { revision: Number(row.revision), credential };
    } finally { clear?.fill(0); }
  }
  read(account: string, host: string): GitVaultRecord {
    const record = this.readValue(account, host);
    if (record.credential !== null) validateGitVaultCredential(record.credential as GitVaultCredential);
    return record as GitVaultRecord;
  }
  /** Separate namespace for a service secret. It is never a Git credential. */
  readSecret(account: string, service: string): { revision: number; secret: string | null } {
    const record = this.readValue(account, service);
    if (record.credential !== null && (typeof record.credential !== 'string' || !record.credential || record.credential.length > 4096 || /[\r\n\0]/u.test(record.credential))) throw new GitVaultError('unavailable', 503);
    return { revision: record.revision, secret: record.credential as string | null };
  }
  /** Internal encrypted document port. Consumers own their schema and namespace;
   * this port is never exposed as an HTTP read operation. */
  readDocument(account: string, namespace: string): { revision: number; document: unknown } {
    if (!namespace.startsWith('document-')) throw new GitVaultError('invalid');
    const record = this.readValue(account, namespace);
    return { revision: record.revision, document: record.credential };
  }
  /** Authenticated private execution metadata, using the same key and AAD owner.
   * The envelope carries identity/scope only, never environment values. */
  personalGitAuthority(accountMode:'principal'|'actor'='principal'): string { return this.cipher.grantAuthority(accountMode); }
  sealPersonalGitGrant(scope: GitGrantScope): string { return this.cipher.sealGrant(scope); }
  sealExecutionContext(document: unknown): string {
    return encodeGitVaultBase64Url(this.encrypt('platform', 'document-execution-context', document));
  }
  openExecutionContext(envelope: string): unknown {
    if (typeof envelope !== 'string' || envelope.length > 8192 || !/^[A-Za-z0-9_-]+$/u.test(envelope)) throw new GitVaultError('invalid');
    const data = decodeGitVaultBase64Url(envelope);
    if (encodeGitVaultBase64Url(data) !== envelope) throw new GitVaultError('invalid');
    let clear: Uint8Array | undefined;
    try {
      clear = this.cipher.open(this.aad('platform', 'document-execution-context'), data);
      return JSON.parse(text.decode(clear));
    } catch { throw new GitVaultError('invalid'); }
    finally { clear?.fill(0); }
  }
  writeDocument(account: string, namespace: string, revision: number, document: unknown): void {
    if (!namespace.startsWith('document-')) throw new GitVaultError('invalid');
    this.writeValue(account, namespace, revision, document);
  }
  writeSecret(account: string, service: string, revision: number, secret: string | null): { revision: number; configured: boolean } {
    if (secret !== null && (typeof secret !== 'string' || !secret || secret.length > 4096 || /[\r\n\0]/u.test(secret))) throw new GitVaultError('invalid');
    this.writeValue(account, service, revision, secret);
    return { revision: revision + 1, configured: secret !== null };
  }
  status(account: string, host: string): GitVaultStatus {
    const { revision, credential } = this.read(account, host);
    const signing = credential?.signing;
    return { revision, configured: credential !== null, tokenConfigured: !!credential?.token,
      sshAuth: credential?.sshAuth ? { generation: credential.sshAuth.generation, publicKey: credential.sshAuth.publicKey, fingerprint: credential.sshAuth.fingerprint } : null,
      identity: credential?.identity ?? null, signing: signing ? { generation: signing.generation, publicKey: signing.publicKey,
        fingerprint: signing.fingerprint, registration: signing.registration, ...(signing.remoteKeyId ? { remoteKeyId: signing.remoteKeyId } : {}) } : null };
  }
  write(account: string, host: string, revision: number, credential: GitVaultCredential | null): GitVaultStatus {
    if (credential) validateGitVaultCredential(credential);
    this.writeValue(account, host, revision, credential);
    return this.status(account, host);
  }
  private writeValue(account: string, host: string, revision: number, credential: unknown): void {
    validateKey(account, host);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new GitVaultError('invalid');
    const payload = credential ? this.encrypt(account, host, credential) : null;
    this.db.transaction(() => {
      if (this.readValue(account, host).revision !== revision) throw new GitVaultError('conflict', 409);
      // Keep a tombstone on delete: stale revision zero must never overwrite a later generation.
      this.db.prepare('INSERT INTO employee_git_credentials(account,host,revision,credential) VALUES(?,?,?,?) ON CONFLICT(account,host) DO UPDATE SET revision=excluded.revision,credential=excluded.credential')
        .run(account, host, revision + 1, payload);
    });
  }
  close(): void { try { this.release(); } finally { this.cipher.dispose(); } }
  private aad(account: string, host: string): Uint8Array { return utf8.encode(JSON.stringify(['employee-git-vault', 1, account, host, 'credential'])); }
  private encrypt(account: string, host: string, credential: unknown): Uint8Array {
    const clear = utf8.encode(JSON.stringify(credential));
    try { return this.cipher.seal(this.aad(account, host), clear); }
    finally { clear.fill(0); }
  }
}
