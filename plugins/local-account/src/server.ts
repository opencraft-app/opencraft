import { randomUUID } from 'node:crypto';
import { parsePrincipal, type Principal } from '@opencraft/identity-core';
import type { LocalAccountPasswordUpgrades, LocalAccountProvider, LocalAccountRepository } from '@opencraft/identity-core/local-account';
import { UNKNOWN_ACCOUNT_PASSWORD, type PasswordHasher } from './password-hash.js';

export type { PasswordHasher } from './password-hash.js';

// At most two password derivations (hash, verify or login upgrade) run at once per process.
let hashing = 0;
async function hashingSlot<T>(password: string, work: () => Promise<T>): Promise<T> {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 || hashing >= 2) throw new Error('Password verification unavailable');
  hashing++;
  try { return await work(); } finally { hashing--; }
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
  #upgrades: LocalAccountPasswordUpgrades | null = null;
  /** `hasher` is chosen by the runtime composition (Node native or portable Argon2id). */
  constructor(readonly repository: LocalAccountRepository, readonly hasher: PasswordHasher, readonly now = Date.now) {}
  get available() { return !this.#closed; }
  /**
   * The storage owner that commits login-time record upgrades (Headless: the Server owner Worker).
   * Without it a proven weaker record is kept as is and still verifies.
   */
  useOwnerWrites(upgrades: LocalAccountPasswordUpgrades) { this.#upgrades = upgrades; }
  #assertOpen() { if (this.#closed) throw new Error('Local account plugin unavailable'); }
  #proof(id: string, displayName: string, version: number): Principal {
    const proof = parsePrincipal({ provider: 'local', subject: id, displayName, expiresAt: this.now() + 8 * 3600_000 });
    this.#verified.set(proof, version); return proof;
  }
  async create(username: string, displayName: string, password: string): Promise<Principal> {
    return this.createWithId(randomUUID(), username, displayName, password);
  }
  async createWithId(id: string, username: string, displayName: string, password: string): Promise<Principal> {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id)) throw new Error('Invalid reserved local account');
    this.#assertOpen(); username = localUsername(username); validNewPassword(password);
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 256 || /[\x00-\x1f]/u.test(displayName)) throw new Error('Invalid display name');
    const passwordDigest = await hashingSlot(password, () => this.hasher.hash(password));
    this.#assertOpen();
    this.repository.insert({ id, username, displayName, salt: '', passwordDigest, enabled: true, version: 1 });
    return this.#proof(id, displayName, 1);
  }
  async verify(username: string, password: string): Promise<Principal | null> {
    this.#assertOpen();
    let normalized: string;
    try { normalized = localUsername(username); } catch { normalized = ''; }
    const account = this.repository.byUsername(normalized);
    // Unknown users pay one Argon2id derivation at the current parameters too.
    const upgrades = this.#upgrades;
    const { ok, upgrade } = await hashingSlot(password, async () => {
      const result = await this.hasher.verify(password, account ?? UNKNOWN_ACCOUNT_PASSWORD);
      if (!upgrades || !account?.enabled || !result.ok || !result.needsRehash) return { ok: result.ok, upgrade: null };
      // Upgrade is best effort: the password was proven, an unavailable rehash keeps the old record.
      try { return { ok: true, upgrade: await this.hasher.hash(password) }; } catch { return { ok: true, upgrade: null }; }
    });
    this.#assertOpen();
    if (!ok || !account?.enabled) return null;
    const current = this.repository.byId(account.id);
    if (!current?.enabled || current.version !== account.version) return null;
    if (upgrade && upgrades) {
      // The owner compares-and-sets on the verified version and record; a refused or failed
      // upgrade keeps the old record and never changes this login's result.
      try { await upgrades.upgradeLocalPassword(account.id,
        { version: account.version, salt: account.salt, passwordDigest: account.passwordDigest }, '', upgrade); } catch { /* best effort */ }
      this.#assertOpen();
      const after = this.repository.byId(account.id);
      if (!after?.enabled || after.version !== account.version) return null;
    }
    return this.#proof(account.id, account.displayName, account.version);
  }
  async resetPassword(username: string, password: string, assertCurrent?: () => void): Promise<void> {
    this.#assertOpen(); validNewPassword(password);
    const account = this.repository.byUsername(localUsername(username));
    if (!account) throw new Error('Unknown local account');
    const passwordDigest = await hashingSlot(password, () => this.hasher.hash(password));
    this.#assertOpen();
    assertCurrent?.();
    if (!this.repository.updatePassword(account.id, '', passwordDigest)) throw new Error('Unknown local account');
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
