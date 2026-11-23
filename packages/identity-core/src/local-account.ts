import type { Principal } from './index.js';

/**
 * Trusted server storage port; password material never crosses the browser API.
 * `passwordDigest` is an Argon2id PHC string with an empty `salt`, or a pre-Argon2id
 * scrypt record (non-empty salt text, 64 hex digits) kept readable until the next login.
 */
export interface LocalAccountRecord {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly salt: string;
  readonly passwordDigest: string;
  readonly enabled: boolean;
  readonly version: number;
}

export interface LocalAccountRepository {
  byUsername(username: string): LocalAccountRecord | null;
  byId(id: string): LocalAccountRecord | null;
  insert(account: LocalAccountRecord): void;
  updatePassword(id: string, salt: string, passwordDigest: string): boolean;
  setEnabled(id: string, enabled: boolean): boolean;
}

export type LocalAccountPasswordExpectation = Pick<LocalAccountRecord, 'version' | 'salt' | 'passwordDigest'>;
/**
 * Login-time upgrade of a proven password to a stronger record, committed by the storage owner.
 * Same password, so no version bump; resolves false when the account was disabled or its
 * version or record changed since `expected` was read (a concurrent password change wins).
 */
export interface LocalAccountPasswordUpgrades {
  upgradeLocalPassword(id: string, expected: LocalAccountPasswordExpectation, salt: string, passwordDigest: string): Promise<boolean>;
}

/** Credential authority only. Actor binding, login tokens and grants belong to core. */
export interface LocalAccountProvider {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  create(username: string, displayName: string, password: string): Promise<Principal>;
  /** Trusted provisioning only: a durable operation reserves this subject before hashing. */
  createWithId?(subject: string, username: string, displayName: string, password: string): Promise<Principal>;
  verify(username: string, password: string): Promise<Principal | null>;
  resetPassword(username: string, password: string, assertCurrent?: () => void): Promise<void>;
  setEnabled(username: string, enabled: boolean): void;
  identity(username: string): Principal | null;
  labelFor(subject: string): string | null;
  verifiedVersion(principal: Principal): number | null;
  currentVersion(subject: string): number | null;
  close(): void;
}
