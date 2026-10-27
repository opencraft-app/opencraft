import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createSchemaValidator, openManagedDatabase, type DatabaseOutcome } from '@opencraft/sqlite-node';

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
export class GitVaultError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'unavailable', readonly status = 400) { super(code); }
}
const PRIVATE_KEY_HEADER = '-----BEGIN PRIVATE KEY-----';
const SCHEMA = 'CREATE TABLE employee_git_credentials (account TEXT NOT NULL, host TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), credential BLOB, PRIMARY KEY(account,host)) STRICT';
export const EMPLOYEE_GIT_VAULT_MIGRATIONS = [{ version: 1, name: 'employee-git-credentials', sql: SCHEMA }] as const;

function privateFile(path: string, create = false): { bytes: Buffer; fresh: boolean } {
  const fd = openSync(path, constants.O_NOFOLLOW | (create ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY), 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new GitVaultError('unavailable', 503);
    if (!create && st.size !== 32) throw new GitVaultError('unavailable', 503);
    return { bytes: create ? Buffer.alloc(0) : readFileSync(fd), fresh: st.size === 0 };
  } finally { closeSync(fd); }
}
function validateKey(account: string, host: string): void {
  if (!account || account.length > 256 || /[\0\r\n]/u.test(account) || !/^[a-z0-9.-]{1,253}$/u.test(host)) throw new GitVaultError('invalid');
}
export function validateGitVaultCredential(value: GitVaultCredential): void {
  const text = (s: unknown, maximum: number) => typeof s === 'string' && s.length > 0 && s.length <= maximum && !/[\0\r\n]/u.test(s);
  if (!value?.identity || !text(value.identity.username, 128) || !text(value.identity.name, 256)
    || !text(value.identity.email, 320) || !/^[^\s@]+@[^\s@]+$/u.test(value.identity.email)
    || !(text(value.token, 4096) || (value.token === '' && value.sshAuth))) throw new GitVaultError('invalid');
  if (value.sshAuth && (!text(value.sshAuth.generation, 128) || !text(value.sshAuth.publicKey, 1024)
    || !text(value.sshAuth.fingerprint, 128) || !value.sshAuth.privateKey.startsWith(PRIVATE_KEY_HEADER)
    || value.sshAuth.privateKey.length > 4096)) throw new GitVaultError('invalid');
  if (value.signing && (!['unregistered', 'pending', 'registered', 'manual_required'].includes(value.signing.registration)
    || !text(value.signing.generation, 128) || !text(value.signing.publicKey, 1024)
    || !value.signing.privateKey.startsWith(PRIVATE_KEY_HEADER) || value.signing.privateKey.length > 4096)) throw new GitVaultError('invalid');
}

/** Opaque account scope is supplied by the verified identity provider, never by a browser body. */
export class EmployeeGitVaultStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  readonly outcome: DatabaseOutcome;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Managed deployments may retain a data-directory alias after migration.
    // Pin its canonical directory once; key/database files still use NOFOLLOW.
    const physicalDirectory = realpathSync(directory);
    const dir = openSync(physicalDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(dir);
      if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new GitVaultError('unavailable', 503);
    } finally { closeSync(dir); }
    const path = join(physicalDirectory, 'employee-git-vault.sqlite');
    const { fresh } = privateFile(path, true);
    const keyPath = join(physicalDirectory, 'employee-git-vault.key');
    // A nonempty database without its original key is a recovery error.
    if (fresh) {
      const candidate = randomBytes(32);
      try { writeFileSync(keyPath, candidate, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      finally { candidate.fill(0); }
    }
    this.key = privateFile(keyPath).bytes;
    if (this.key.length !== 32) { this.key.fill(0); throw new GitVaultError('unavailable', 503); }
    try {
      const managed = openManagedDatabase({ path, migrations: EMPLOYEE_GIT_VAULT_MIGRATIONS,
        validateSchema: createSchemaValidator(SCHEMA), legacyPolicy: 'reject' });
      this.db = managed.database; this.outcome = managed.outcome;
    } catch (error) { this.key.fill(0); throw error; }
  }
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
    const data = Buffer.from(row.credential as Uint8Array);
    let clear: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      decipher.setAAD(this.aad(account, host)); decipher.setAuthTag(data.subarray(-16));
      clear = Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]);
      const credential: unknown = JSON.parse(clear.toString('utf8'));
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.readValue(account, host).revision !== revision) throw new GitVaultError('conflict', 409);
      // Keep a tombstone on delete: stale revision zero must never overwrite a later generation.
      this.db.prepare('INSERT INTO employee_git_credentials(account,host,revision,credential) VALUES(?,?,?,?) ON CONFLICT(account,host) DO UPDATE SET revision=excluded.revision,credential=excluded.credential')
        .run(account, host, revision + 1, payload);
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { try { this.db.close(); } finally { this.key.fill(0); } }
  private aad(account: string, host: string): Buffer { return Buffer.from(JSON.stringify(['employee-git-vault', 1, account, host, 'credential'])); }
  private encrypt(account: string, host: string, credential: unknown): Buffer {
    const clear = Buffer.from(JSON.stringify(credential)), iv = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(this.aad(account, host));
      return Buffer.concat([iv, cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
    } finally { clear.fill(0); }
  }
}
