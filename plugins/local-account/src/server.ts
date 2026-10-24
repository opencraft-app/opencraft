import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { parsePrincipal, type Principal } from '@opencraft/identity-core';
import type { LocalAccountProvider, LocalAccountRepository } from '@opencraft/identity-core/local-account';

let hashing = 0;
async function passwordHash(password: string, salt: string): Promise<Buffer> {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 || hashing >= 2) throw new Error('Password verification unavailable');
  hashing++;
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32,
      { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
  } finally { hashing--; }
}
export function localUsername(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/u.test(value)) throw new Error('Invalid username');
  return value.toLowerCase();
}
function validNewPassword(value: string) {
  if (typeof value !== 'string' || [...value].length < 12 || Buffer.byteLength(value) > 1024) throw new Error('Password must contain at least 12 characters');
}

/** Bundled official per-installation account plugin. No network or grants authority. */
export class LocalAccountServerPlugin implements LocalAccountProvider {
  readonly id = 'opencraft.account';
  readonly label = '本地账号';
  #closed = false;
  readonly #verified = new WeakMap<Principal, number>();
  constructor(readonly repository: LocalAccountRepository, readonly now = Date.now) {}
  get available() { return !this.#closed; }
  #assertOpen() { if (this.#closed) throw new Error('Local account plugin unavailable'); }
  #proof(id: string, displayName: string, version: number): Principal {
    const proof = parsePrincipal({ provider: 'local', subject: id, displayName, expiresAt: this.now() + 8 * 3600_000 });
    this.#verified.set(proof, version); return proof;
  }
  async create(username: string, displayName: string, password: string): Promise<Principal> {
    this.#assertOpen(); username = localUsername(username); validNewPassword(password);
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 256 || /[\x00-\x1f]/u.test(displayName)) throw new Error('Invalid display name');
    const id = randomUUID(), salt = randomBytes(32).toString('hex'), digest = await passwordHash(password, salt);
    this.#assertOpen();
    this.repository.insert({ id, username, displayName, salt, passwordDigest: digest.toString('hex'), enabled: true, version: 1 });
    return this.#proof(id, displayName, 1);
  }
  async verify(username: string, password: string): Promise<Principal | null> {
    this.#assertOpen();
    let normalized: string;
    try { normalized = localUsername(username); } catch { normalized = ''; }
    const account = this.repository.byUsername(normalized);
    const actual = await passwordHash(password, account?.salt ?? 'opencraft-unknown-account-password-salt');
    this.#assertOpen();
    const expected = account ? Buffer.from(account.passwordDigest, 'hex') : Buffer.alloc(32);
    if (expected.length !== actual.length || !timingSafeEqual(actual, expected) || !account?.enabled) return null;
    const current = this.repository.byId(account.id);
    if (!current?.enabled || current.version !== account.version) return null;
    return this.#proof(account.id, account.displayName, account.version);
  }
  async resetPassword(username: string, password: string): Promise<void> {
    this.#assertOpen(); validNewPassword(password);
    const account = this.repository.byUsername(localUsername(username));
    if (!account) throw new Error('Unknown local account');
    const salt = randomBytes(32).toString('hex'), digest = await passwordHash(password, salt);
    this.#assertOpen();
    if (!this.repository.updatePassword(account.id, salt, digest.toString('hex'))) throw new Error('Unknown local account');
  }
  setEnabled(username: string, enabled: boolean) {
    this.#assertOpen();
    if (typeof enabled !== 'boolean') throw new Error('Invalid account state');
    const account = this.repository.byUsername(localUsername(username));
    if (!account || !this.repository.setEnabled(account.id, enabled)) throw new Error('Unknown local account');
  }
  identity(username: string): Principal | null {
    this.#assertOpen();
    const account = this.repository.byUsername(localUsername(username));
    // Operator lookup is not a password proof and cannot issue a browser login.
    return account?.enabled ? parsePrincipal({ provider: 'local', subject: account.id, displayName: account.displayName, expiresAt: this.now() + 60_000 }) : null;
  }
  labelFor(subject: string): string | null {
    if (!this.available) return null;
    const account = this.repository.byId(subject); return account ? this.label + ' · ' + account.username : null;
  }
  currentVersion(subject: string): number | null {
    if (!this.available) return null;
    const account = this.repository.byId(subject); return account?.enabled ? account.version : null;
  }
  verifiedVersion(principal: Principal): number | null {
    const version = this.#verified.get(principal);
    return principal.provider === 'local' && version !== undefined && principal.expiresAt > this.now()
      && this.currentVersion(principal.subject) === version ? version : null;
  }
  close() { this.#closed = true; }
}
