import type { Principal } from './index.js';

/** Trusted server storage port; password material never crosses the browser API. */
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

/** Credential authority only. Actor binding, login tokens and grants belong to core. */
export interface LocalAccountProvider {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  create(username: string, displayName: string, password: string): Promise<Principal>;
  verify(username: string, password: string): Promise<Principal | null>;
  resetPassword(username: string, password: string): Promise<void>;
  setEnabled(username: string, enabled: boolean): void;
  identity(username: string): Principal | null;
  labelFor(subject: string): string | null;
  verifiedVersion(principal: Principal): number | null;
  currentVersion(subject: string): number | null;
  close(): void;
}
