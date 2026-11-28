// Runtime-neutral domain stores and migration chains for the sharded Million-Scale
// Cloud Relay (`IdentityIndexStore`, `UserRelayStore`, `MachineRelayAuthority`).
// Depends only on `@opencraft/sql`, `@opencraft/document-storage/state`, and
// `@opencraft/relay-protocol` so identical behavior is verified on both Node SQLite
// and Cloudflare Durable Object SQLite.
import type { StateDocumentStore } from "@opencraft/document-storage/state";
import {
  isValidRelayMachineId,
  validateDirectRouteCandidate,
  type DirectRouteCandidate,
  type MuxAccessScope,
} from "@opencraft/relay-protocol";
import type { SqlDatabase } from "@opencraft/sql";
import { applySqlMigrations, hashSqlMigrations, type SqlMigration } from "@opencraft/sql/migrations";

export const IDENTITY_INDEX_SHARD_COUNT = 4096;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const APPROVAL_CODE_TTL_MS = 10 * 60_000;
export const DEFAULT_SHARE_TTL_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_FREE_MACHINE_LIMIT = 3;
export const DEFAULT_FREE_MAX_BLOB_BYTES = 16 * 1024 * 1024;
export const MAX_MACHINES_PER_USER = 500;

/** Maps a 64-hex HMAC of `provider:subject` to one of 4,096 shard names (`idx:000`..`idx:fff`). */
export function identityIndexShardName(bindingHashHex: string): string {
  if (!/^[a-f0-9]{64}$/u.test(bindingHashHex)) throw new Error("Invalid identity binding hash");
  return `idx:${bindingHashHex.slice(0, 3)}`;
}

export function userRelayObjectName(actorId: string): string {
  if (!/^actor_[a-f0-9-]{36}$/u.test(actorId)) throw new Error("Invalid relay actorId");
  return `user:${actorId}`;
}

export function machineRelayObjectName(machineId: string): string {
  if (!isValidRelayMachineId(machineId)) throw new Error("Invalid relay machineId");
  return `machine:${machineId}`;
}

function assertCleanSchemaBeforeLedger(database: SqlDatabase, allowedPrefix = "_cf_"): void {
  const hasLedger = !!database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (hasLedger) return;
  const stray = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .some((row) => typeof row.name === "string" && !row.name.startsWith(allowedPrefix));
  if (stray) throw new Error("Refusing to adopt unversioned database objects");
}

// ---- 1. IdentityIndexStore (4,096 shards) -----------------------------------

export const IDENTITY_INDEX_MIGRATIONS: readonly SqlMigration[] = Object.freeze([
  {
    version: 1,
    name: "0001_identity_bindings",
    sql: `
CREATE TABLE identity_bindings (
  binding_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  password_phc TEXT,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_identity_bindings_actor ON identity_bindings(actor_id);
`.trim(),
  },
  {
    version: 2,
    name: "0002_rate_limits_and_license_claims",
    sql: `
CREATE TABLE ip_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  hit_count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
) STRICT;

CREATE TABLE license_claims (
  license_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
) STRICT;
`.trim(),
  },
  {
    version: 3,
    name: "0003_passkey_credentials",
    sql: `
CREATE TABLE passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  public_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_passkey_credentials_actor ON passkey_credentials(actor_id);
`.trim(),
  },
]);

export interface IdentityBindingRecord {
  readonly bindingHash: string;
  readonly provider: string;
  readonly actorId: string;
  readonly passwordPhc: string | null;
  readonly version: number;
  readonly createdAt: number;
}

export interface PasskeyCredentialRecord {
  readonly credentialId: string;
  readonly actorId: string;
  readonly algorithm: "ES256" | "EdDSA";
  readonly publicKey: string;
  readonly signCount: number;
  readonly label: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

export class IdentityIndexStore {
  constructor(private readonly db: SqlDatabase) {}

  static open(db: SqlDatabase, sha256SyncHex: (text: string) => string): IdentityIndexStore {
    assertCleanSchemaBeforeLedger(db);
    applySqlMigrations(db, hashSqlMigrations(IDENTITY_INDEX_MIGRATIONS, sha256SyncHex));
    return new IdentityIndexStore(db);
  }

  read(bindingHash: string): IdentityBindingRecord | null {
    const row = this.db
      .prepare(
        "SELECT binding_hash, provider, actor_id, password_phc, version, created_at FROM identity_bindings WHERE binding_hash = ?",
      )
      .get(bindingHash);
    if (!row) return null;
    return {
      bindingHash: String(row.binding_hash),
      provider: String(row.provider),
      actorId: String(row.actor_id),
      passwordPhc: row.password_phc === null ? null : String(row.password_phc),
      version: Number(row.version),
      createdAt: Number(row.created_at),
    };
  }

  /**
   * Atomically resolves an existing `(provider, subject)` binding or creates a new
   * `actorId` binding if unclaimed. Local accounts also store their Argon2id PHC
   * digest here so stateless Edge Workers can verify passwords without serializing
   * on a single central DO.
   */
  resolveOrRegister(input: {
    readonly bindingHash: string;
    readonly provider: string;
    readonly candidateActorId: string;
    readonly passwordPhc?: string | null;
    readonly allowExistingResolve: boolean;
    readonly now: number;
  }): { readonly status: "existing" | "created" | "conflict"; readonly record: IdentityBindingRecord } {
    return this.db.transaction(() => {
      const existing = this.read(input.bindingHash);
      if (existing) {
        return { status: input.allowExistingResolve ? "existing" : "conflict", record: existing };
      }
      this.db
        .prepare(
          "INSERT INTO identity_bindings(binding_hash, provider, actor_id, password_phc, version, created_at, updated_at) VALUES(?,?,?,?,1,?,?)",
        )
        .run(
          input.bindingHash,
          input.provider,
          input.candidateActorId,
          input.passwordPhc ?? null,
          input.now,
          input.now,
        );
      return { status: "created", record: this.read(input.bindingHash)! };
    });
  }

  updatePassword(input: {
    readonly bindingHash: string;
    readonly expectedVersion: number;
    readonly passwordPhc: string;
    readonly now: number;
  }): boolean {
    const res = this.db
      .prepare(
        "UPDATE identity_bindings SET password_phc = ?, version = version + 1, updated_at = ? WHERE binding_hash = ? AND version = ?",
      )
      .run(input.passwordPhc, input.now, input.bindingHash, input.expectedVersion);
    return Number(res.changes) === 1;
  }

  /**
   * Sharded fixed-window per-IP rate limiter across the 4,096 `IdentityIndexDO` shards.
   * Prevents distributed multi-POP botnet floods that bypass single-isolate memory counters.
   */
  consumeRateLimit(input: {
    readonly bucketKey: string;
    readonly limit: number;
    readonly windowMs: number;
    readonly now: number;
  }): { readonly allowed: boolean; readonly remaining: number; readonly retryAfterSec: number } {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM ip_rate_limits WHERE reset_at <= ?").run(input.now);
      const row = this.db
        .prepare("SELECT hit_count, reset_at FROM ip_rate_limits WHERE bucket_key = ?")
        .get(input.bucketKey);
      if (!row) {
        const resetAt = input.now + input.windowMs;
        this.db
          .prepare("INSERT INTO ip_rate_limits(bucket_key, hit_count, reset_at) VALUES(?, 1, ?)")
          .run(input.bucketKey, resetAt);
        return {
          allowed: true,
          remaining: Math.max(0, input.limit - 1),
          retryAfterSec: Math.ceil(input.windowMs / 1000),
        };
      }
      const count = Number(row.hit_count);
      const resetAt = Number(row.reset_at);
      const retryAfterSec = Math.max(1, Math.ceil((resetAt - input.now) / 1000));
      if (count >= input.limit) {
        return { allowed: false, remaining: 0, retryAfterSec };
      }
      this.db.prepare("UPDATE ip_rate_limits SET hit_count = hit_count + 1 WHERE bucket_key = ?").run(input.bucketKey);
      return { allowed: true, remaining: Math.max(0, input.limit - (count + 1)), retryAfterSec };
    });
  }

  /**
   * Atomically binds a commercial `ocl1_` License Key `lid` to the first `actorId`
   * that activates it so a single key cannot be shared across unrelated owners,
   * while remaining idempotent when re-presented by the same owner.
   */
  claimLicense(input: {
    readonly licenseId: string;
    readonly actorId: string;
    readonly tier: "pro" | "team";
    readonly now: number;
  }): { readonly ok: true } | { readonly ok: false; readonly error: "license_already_claimed" } {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT actor_id FROM license_claims WHERE license_id = ?").get(input.licenseId);
      if (existing) {
        return String(existing.actor_id) === input.actorId
          ? { ok: true as const }
          : { ok: false as const, error: "license_already_claimed" as const };
      }
      this.db
        .prepare("INSERT INTO license_claims(license_id, actor_id, tier, claimed_at) VALUES(?,?,?,?)")
        .run(input.licenseId, input.actorId, input.tier, input.now);
      return { ok: true as const };
    });
  }

  readPasskey(credentialId: string): PasskeyCredentialRecord | null {
    const row = this.db
      .prepare(
        "SELECT credential_id, actor_id, algorithm, public_key, sign_count, label, created_at, last_used_at FROM passkey_credentials WHERE credential_id = ?",
      )
      .get(credentialId);
    if (!row) return null;
    return {
      credentialId: String(row.credential_id),
      actorId: String(row.actor_id),
      algorithm: String(row.algorithm) === "EdDSA" ? "EdDSA" : "ES256",
      publicKey: String(row.public_key),
      signCount: Number(row.sign_count),
      label: String(row.label),
      createdAt: Number(row.created_at),
      lastUsedAt: Number(row.last_used_at),
    };
  }

  registerPasskey(input: {
    readonly credentialId: string;
    readonly actorId: string;
    readonly algorithm: "ES256" | "EdDSA";
    readonly publicKey: string;
    readonly signCount: number;
    readonly label: string;
    readonly now: number;
  }):
    | { readonly ok: true; readonly record: PasskeyCredentialRecord }
    | { readonly ok: false; readonly error: "credential_already_registered" } {
    return this.db.transaction(() => {
      const existing = this.readPasskey(input.credentialId);
      if (existing) {
        return existing.actorId === input.actorId
          ? { ok: true as const, record: existing }
          : { ok: false as const, error: "credential_already_registered" as const };
      }
      this.db
        .prepare(
          "INSERT INTO passkey_credentials(credential_id, actor_id, algorithm, public_key, sign_count, label, created_at, last_used_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          input.credentialId,
          input.actorId,
          input.algorithm,
          input.publicKey,
          Math.max(0, Math.trunc(input.signCount)),
          input.label.slice(0, 128),
          input.now,
          input.now,
        );
      return { ok: true as const, record: this.readPasskey(input.credentialId)! };
    });
  }

  touchPasskeyUsage(credentialId: string, newSignCount: number, now: number): boolean {
    const res = this.db
      .prepare("UPDATE passkey_credentials SET sign_count = ?, last_used_at = ? WHERE credential_id = ?")
      .run(Math.max(0, Math.trunc(newSignCount)), now, credentialId);
    return Number(res.changes) === 1;
  }
}

// ---- 2. UserRelayStore (1 DO per human Actor) -------------------------------

export const USER_RELAY_MIGRATIONS: readonly SqlMigration[] = Object.freeze([
  {
    version: 1,
    name: "0001_user_relay_ledger",
    sql: `
CREATE TABLE user_profile (
  actor_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  session_epoch INTEGER NOT NULL,
  machine_limit INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE enrolled_machines (
  machine_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  approval_required INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  approval_required INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER
) STRICT;

CREATE TABLE share_grants (
  grant_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  machine_id TEXT NOT NULL,
  label TEXT NOT NULL,
  allow_execution INTEGER NOT NULL,
  thread_ids_json TEXT,
  grantee_actor_id TEXT,
  grant_epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
  CREATE INDEX idx_share_grants_machine ON share_grants(machine_id);
`.trim(),
  },
  {
    version: 2,
    name: "0002_user_license_tier",
    sql: `
ALTER TABLE user_profile ADD COLUMN plan_tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE user_profile ADD COLUMN license_id TEXT;
ALTER TABLE user_profile ADD COLUMN license_expires_at INTEGER;
ALTER TABLE user_profile ADD COLUMN max_blob_bytes INTEGER NOT NULL DEFAULT 16777216;
`.trim(),
  },
  {
    version: 3,
    name: "0003_personal_hub_index",
    sql: `
CREATE TABLE hub_passkeys (
  credential_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
) STRICT;

CREATE TABLE machine_thread_index (
  machine_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, thread_id)
) STRICT;
CREATE INDEX idx_machine_thread_index_updated ON machine_thread_index(machine_id, updated_at DESC);
`.trim(),
  },
]);

export interface HubPasskeySummary {
  readonly credentialId: string;
  readonly label: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

export type LightweightThreadStatus = "idle" | "running" | "waiting" | "failed";

export interface MachineThreadIndexItem {
  readonly machineId: string;
  readonly threadId: string;
  readonly title: string;
  readonly status: LightweightThreadStatus;
  readonly updatedAt: number;
}

export interface UserMachineSummary {
  readonly machineId: string;
  readonly displayName: string;
  readonly approvalRequired: boolean;
  readonly createdAt: number;
}

export interface ShareGrantSummary {
  readonly grantId: string;
  readonly machineId: string;
  readonly label: string;
  readonly allowExecution: boolean;
  readonly threadIds?: readonly string[];
  readonly granteeActorId: string | null;
  readonly grantEpoch: number;
  readonly expiresAt: number;
  readonly revoked: boolean;
}

export interface UserProfileRecord {
  readonly actorId: string;
  readonly displayName: string;
  readonly sessionEpoch: number;
  readonly machineLimit: number;
  readonly planTier: "free" | "pro" | "team";
  readonly licenseId: string | null;
  readonly licenseExpiresAt: number | null;
  readonly maxBlobBytes: number;
}

export class UserRelayStore {
  constructor(private readonly db: SqlDatabase) {}

  static open(db: SqlDatabase, sha256SyncHex: (text: string) => string): UserRelayStore {
    assertCleanSchemaBeforeLedger(db);
    applySqlMigrations(db, hashSqlMigrations(USER_RELAY_MIGRATIONS, sha256SyncHex));
    return new UserRelayStore(db);
  }

  ensureProfile(input: {
    readonly actorId: string;
    readonly displayName: string;
    readonly defaultMachineLimit: number;
    readonly now: number;
  }): UserProfileRecord {
    return this.db.transaction(() => {
      const existing = this.readProfile(input.now);
      if (existing) {
        if (existing.actorId !== input.actorId) throw new Error("UserRelayDO actor identity mismatch");
        return existing;
      }
      const limit = Math.max(1, Math.min(MAX_MACHINES_PER_USER, Math.trunc(input.defaultMachineLimit)));
      this.db
        .prepare(
          "INSERT INTO user_profile(actor_id, display_name, session_epoch, machine_limit, created_at, plan_tier, license_id, license_expires_at, max_blob_bytes) VALUES(?,?,1,?,?,'free',NULL,NULL,?)",
        )
        .run(input.actorId, input.displayName.slice(0, 128), limit, input.now, DEFAULT_FREE_MAX_BLOB_BYTES);
      return this.readProfile(input.now)!;
    });
  }

  readProfile(now = Date.now()): UserProfileRecord | null {
    const row = this.db
      .prepare(
        "SELECT actor_id, display_name, session_epoch, machine_limit, plan_tier, license_id, license_expires_at, max_blob_bytes FROM user_profile LIMIT 1",
      )
      .get();
    if (!row) return null;
    const licenseExp = row.license_expires_at === null ? null : Number(row.license_expires_at);
    const expired = licenseExp !== null && licenseExp <= now;
    return {
      actorId: String(row.actor_id),
      displayName: String(row.display_name),
      sessionEpoch: Number(row.session_epoch),
      machineLimit: expired ? DEFAULT_FREE_MACHINE_LIMIT : Number(row.machine_limit),
      planTier: expired ? "free" : (String(row.plan_tier) as "free" | "pro" | "team") || "free",
      licenseId: expired || row.license_id === null ? null : String(row.license_id),
      licenseExpiresAt: expired ? null : licenseExp,
      maxBlobBytes: expired ? DEFAULT_FREE_MAX_BLOB_BYTES : Number(row.max_blob_bytes),
    };
  }

  activateLicense(input: {
    readonly licenseId: string;
    readonly tier: "pro" | "team";
    readonly machineLimit: number;
    readonly maxBlobBytes: number;
    readonly expiresAt: number;
    readonly now: number;
  }): UserProfileRecord {
    return this.db.transaction(() => {
      const current = this.readProfile(input.now);
      if (!current) throw new Error("User profile not initialized");
      const clampedMachines = Math.max(1, Math.min(MAX_MACHINES_PER_USER, Math.trunc(input.machineLimit)));
      this.db
        .prepare(
          "UPDATE user_profile SET plan_tier = ?, license_id = ?, license_expires_at = ?, machine_limit = ?, max_blob_bytes = ? WHERE actor_id = ?",
        )
        .run(input.tier, input.licenseId, input.expiresAt, clampedMachines, input.maxBlobBytes, current.actorId);
      return this.readProfile(input.now)!;
    });
  }

  bumpSessionEpoch(): number {
    return this.db.transaction(() => {
      const profile = this.readProfile();
      if (!profile) throw new Error("User profile not initialized");
      const next = profile.sessionEpoch + 1;
      this.db.prepare("UPDATE user_profile SET session_epoch = ? WHERE actor_id = ?").run(next, profile.actorId);
      return next;
    });
  }

  setMachineLimit(limit: number): void {
    const clamped = Math.max(1, Math.min(MAX_MACHINES_PER_USER, Math.trunc(limit)));
    this.db.prepare("UPDATE user_profile SET machine_limit = ?").run(clamped);
  }

  enrollMachine(input: {
    readonly machineId: string;
    readonly displayName: string;
    readonly secretHash: string;
    readonly approvalRequired: boolean;
    readonly now: number;
  }):
    | { readonly ok: true; readonly machine: UserMachineSummary }
    | { readonly ok: false; readonly error: "machine_limit_reached" } {
    if (!isValidRelayMachineId(input.machineId)) throw new Error("Invalid machineId");
    if (!/^[a-f0-9]{64}$/u.test(input.secretHash)) throw new Error("Invalid secretHash");
    return this.db.transaction(() => {
      const profile = this.readProfile();
      if (!profile) throw new Error("User profile not initialized");
      const existing = this.db
        .prepare("SELECT machine_id, revoked_at FROM enrolled_machines WHERE machine_id = ?")
        .get(input.machineId);
      const activeCount = Number(
        this.db.prepare("SELECT COUNT(*) AS cnt FROM enrolled_machines WHERE revoked_at IS NULL").get()?.cnt ?? 0,
      );
      if (!existing || existing.revoked_at !== null) {
        if (activeCount >= profile.machineLimit) return { ok: false as const, error: "machine_limit_reached" as const };
      }
      if (existing) {
        this.db
          .prepare(
            "UPDATE enrolled_machines SET display_name = ?, secret_hash = ?, approval_required = ?, revoked_at = NULL WHERE machine_id = ?",
          )
          .run(
            input.displayName.trim().slice(0, 128) || "My Machine",
            input.secretHash,
            input.approvalRequired ? 1 : 0,
            input.machineId,
          );
      } else {
        this.db
          .prepare(
            "INSERT INTO enrolled_machines(machine_id, display_name, secret_hash, approval_required, created_at, revoked_at) VALUES(?,?,?,?,?,NULL)",
          )
          .run(
            input.machineId,
            input.displayName.trim().slice(0, 128) || "My Machine",
            input.secretHash,
            input.approvalRequired ? 1 : 0,
            input.now,
          );
      }
      return {
        ok: true as const,
        machine: {
          machineId: input.machineId,
          displayName: input.displayName.trim().slice(0, 128) || "My Machine",
          approvalRequired: input.approvalRequired,
          createdAt: input.now,
        },
      };
    });
  }

  listMachines(): readonly UserMachineSummary[] {
    return this.db
      .prepare(
        "SELECT machine_id, display_name, approval_required, created_at FROM enrolled_machines WHERE revoked_at IS NULL ORDER BY created_at DESC",
      )
      .all()
      .map((row) => ({
        machineId: String(row.machine_id),
        displayName: String(row.display_name),
        approvalRequired: Number(row.approval_required) === 1,
        createdAt: Number(row.created_at),
      }));
  }

  revokeMachine(machineId: string, now: number): boolean {
    return this.db.transaction(() => {
      const res = this.db
        .prepare("UPDATE enrolled_machines SET revoked_at = ? WHERE machine_id = ? AND revoked_at IS NULL")
        .run(now, machineId);
      this.db
        .prepare(
          "UPDATE share_grants SET revoked_at = ?, grant_epoch = grant_epoch + 1 WHERE machine_id = ? AND revoked_at IS NULL",
        )
        .run(now, machineId);
      return Number(res.changes) > 0;
    });
  }

  createPairingCode(input: {
    readonly codeHash: string;
    readonly machineId: string;
    readonly approvalRequired: boolean;
    readonly now: number;
  }): { readonly expiresAt: number } {
    return this.db.transaction(() => {
      const machine = this.db
        .prepare("SELECT machine_id FROM enrolled_machines WHERE machine_id = ? AND revoked_at IS NULL")
        .get(input.machineId);
      if (!machine) throw new Error("Machine is not enrolled");
      this.db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").run(input.now);
      const expiresAt = input.now + PAIRING_CODE_TTL_MS;
      this.db
        .prepare(
          "INSERT INTO pairing_codes(code_hash, machine_id, approval_required, expires_at, redeemed_at) VALUES(?,?,?,?,NULL)",
        )
        .run(input.codeHash, input.machineId, input.approvalRequired ? 1 : 0, expiresAt);
      return { expiresAt };
    });
  }

  redeemPairingCode(input: {
    readonly codeHash: string;
    readonly machineId: string;
    readonly now: number;
  }): { readonly approvalRequired: boolean } | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT machine_id, approval_required, expires_at, redeemed_at FROM pairing_codes WHERE code_hash = ?")
        .get(input.codeHash);
      if (
        !row ||
        String(row.machine_id) !== input.machineId ||
        row.redeemed_at !== null ||
        Number(row.expires_at) <= input.now
      ) {
        return null;
      }
      const machine = this.db
        .prepare("SELECT machine_id FROM enrolled_machines WHERE machine_id = ? AND revoked_at IS NULL")
        .get(input.machineId);
      if (!machine) return null;
      this.db.prepare("UPDATE pairing_codes SET redeemed_at = ? WHERE code_hash = ?").run(input.now, input.codeHash);
      return { approvalRequired: Number(row.approval_required) === 1 };
    });
  }

  createShareGrant(input: {
    readonly grantId: string;
    readonly tokenHash: string;
    readonly machineId: string;
    readonly label: string;
    readonly allowExecution: boolean;
    readonly threadIds?: readonly string[];
    readonly ttlMs?: number;
    readonly now: number;
  }): ShareGrantSummary {
    return this.db.transaction(() => {
      const machine = this.db
        .prepare("SELECT machine_id FROM enrolled_machines WHERE machine_id = ? AND revoked_at IS NULL")
        .get(input.machineId);
      if (!machine) throw new Error("Machine is not enrolled");
      const expiresAt =
        input.now + Math.max(60_000, Math.min(30 * 24 * 60 * 60_000, input.ttlMs ?? DEFAULT_SHARE_TTL_MS));
      const threadJson = input.threadIds?.length ? JSON.stringify(input.threadIds) : null;
      this.db
        .prepare(
          "INSERT INTO share_grants(grant_id, token_hash, machine_id, label, allow_execution, thread_ids_json, grantee_actor_id, grant_epoch, expires_at, revoked_at, created_at) VALUES(?,?,?,?,?,?,NULL,1,?,NULL,?)",
        )
        .run(
          input.grantId,
          input.tokenHash,
          input.machineId,
          input.label.trim().slice(0, 128) || "Shared Agent",
          input.allowExecution ? 1 : 0,
          threadJson,
          expiresAt,
          input.now,
        );
      return {
        grantId: input.grantId,
        machineId: input.machineId,
        label: input.label.trim().slice(0, 128) || "Shared Agent",
        allowExecution: input.allowExecution,
        ...(input.threadIds?.length ? { threadIds: [...input.threadIds] } : {}),
        granteeActorId: null,
        grantEpoch: 1,
        expiresAt,
        revoked: false,
      };
    });
  }

  claimShareGrant(input: {
    readonly tokenHash: string;
    readonly granteeActorId: string;
    readonly now: number;
  }): ShareGrantSummary | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT grant_id, machine_id, label, allow_execution, thread_ids_json, grantee_actor_id, grant_epoch, expires_at, revoked_at FROM share_grants WHERE token_hash = ?",
        )
        .get(input.tokenHash);
      if (!row || row.revoked_at !== null || Number(row.expires_at) <= input.now) return null;
      if (row.grantee_actor_id !== null && String(row.grantee_actor_id) !== input.granteeActorId) {
        // One share token binds to the first collaborator who claims it, preventing leaked forwarding.
        return null;
      }
      if (row.grantee_actor_id === null) {
        this.db
          .prepare("UPDATE share_grants SET grantee_actor_id = ? WHERE grant_id = ?")
          .run(input.granteeActorId, String(row.grant_id));
      }
      const threads = row.thread_ids_json ? (JSON.parse(String(row.thread_ids_json)) as string[]) : undefined;
      return {
        grantId: String(row.grant_id),
        machineId: String(row.machine_id),
        label: String(row.label),
        allowExecution: Number(row.allow_execution) === 1,
        ...(threads?.length ? { threadIds: threads } : {}),
        granteeActorId: input.granteeActorId,
        grantEpoch: Number(row.grant_epoch),
        expiresAt: Number(row.expires_at),
        revoked: false,
      };
    });
  }

  revokeShareGrant(grantId: string, now: number): { readonly machineId: string; readonly grantEpoch: number } | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT machine_id, grant_epoch FROM share_grants WHERE grant_id = ? AND revoked_at IS NULL")
        .get(grantId);
      if (!row) return null;
      const nextEpoch = Number(row.grant_epoch) + 1;
      this.db
        .prepare("UPDATE share_grants SET revoked_at = ?, grant_epoch = ? WHERE grant_id = ?")
        .run(now, nextEpoch, grantId);
      return { machineId: String(row.machine_id), grantEpoch: nextEpoch };
    });
  }

  listShareGrants(): readonly ShareGrantSummary[] {
    return this.db
      .prepare(
        "SELECT grant_id, machine_id, label, allow_execution, thread_ids_json, grantee_actor_id, grant_epoch, expires_at, revoked_at FROM share_grants ORDER BY created_at DESC",
      )
      .all()
      .map((row) => {
        const threads = row.thread_ids_json ? (JSON.parse(String(row.thread_ids_json)) as string[]) : undefined;
        return {
          grantId: String(row.grant_id),
          machineId: String(row.machine_id),
          label: String(row.label),
          allowExecution: Number(row.allow_execution) === 1,
          ...(threads?.length ? { threadIds: threads } : {}),
          granteeActorId: row.grantee_actor_id === null ? null : String(row.grantee_actor_id),
          grantEpoch: Number(row.grant_epoch),
          expiresAt: Number(row.expires_at),
          revoked: row.revoked_at !== null,
        };
      });
  }

  recordHubPasskey(input: { readonly credentialId: string; readonly label: string; readonly now: number }): void {
    this.db
      .prepare(
        "INSERT INTO hub_passkeys(credential_id, label, created_at, last_used_at) VALUES(?,?,?,?) ON CONFLICT(credential_id) DO UPDATE SET last_used_at = excluded.last_used_at",
      )
      .run(input.credentialId, input.label.slice(0, 128) || "Passkey", input.now, input.now);
  }

  listHubPasskeys(): readonly HubPasskeySummary[] {
    return this.db
      .prepare("SELECT credential_id, label, created_at, last_used_at FROM hub_passkeys ORDER BY created_at DESC")
      .all()
      .map((row) => ({
        credentialId: String(row.credential_id),
        label: String(row.label),
        createdAt: Number(row.created_at),
        lastUsedAt: Number(row.last_used_at),
      }));
  }

  replaceMachineThreadIndex(
    machineId: string,
    items: readonly {
      readonly threadId: string;
      readonly title: string;
      readonly status: LightweightThreadStatus;
      readonly updatedAt: number;
    }[],
  ): void {
    const validStatuses = new Set<string>(["idle", "running", "waiting", "failed"]);
    const bounded = items
      .slice(0, 15)
      .filter((i) => typeof i.threadId === "string" && i.threadId.length > 0 && i.threadId.length <= 256)
      .map((i) => ({
        threadId: i.threadId,
        title: (typeof i.title === "string" ? i.title.trim() : "").slice(0, 140) || "Untitled conversation",
        status: (validStatuses.has(i.status) ? i.status : "idle") as LightweightThreadStatus,
        updatedAt:
          typeof i.updatedAt === "number" && Number.isFinite(i.updatedAt) ? Math.trunc(i.updatedAt) : Date.now(),
      }));

    this.db.transaction(() => {
      const enrolled = this.db
        .prepare("SELECT machine_id FROM enrolled_machines WHERE machine_id = ? AND revoked_at IS NULL")
        .get(machineId);
      if (!enrolled) return;
      this.db.prepare("DELETE FROM machine_thread_index WHERE machine_id = ?").run(machineId);
      const insert = this.db.prepare(
        "INSERT INTO machine_thread_index(machine_id, thread_id, title, status, updated_at) VALUES(?,?,?,?,?)",
      );
      for (const item of bounded) {
        insert.run(machineId, item.threadId, item.title, item.status, item.updatedAt);
      }
    });
  }

  listThreadIndex(): readonly MachineThreadIndexItem[] {
    return this.db
      .prepare(
        `SELECT t.machine_id, t.thread_id, t.title, t.status, t.updated_at
         FROM machine_thread_index t
         INNER JOIN enrolled_machines m ON m.machine_id = t.machine_id AND m.revoked_at IS NULL
         ORDER BY t.updated_at DESC
         LIMIT 60`,
      )
      .all()
      .map((row) => ({
        machineId: String(row.machine_id),
        threadId: String(row.thread_id),
        title: String(row.title),
        status: String(row.status) as LightweightThreadStatus,
        updatedAt: Number(row.updated_at),
      }));
  }
}

// ---- 3. MachineRelayAuthority (per-machine state document) ------------------

export interface ApprovedDeviceEntry {
  readonly thumbprint: string;
  readonly label: string;
  readonly approvedAt: number;
}

export interface PendingDeviceApproval {
  readonly shortCode: string;
  readonly thumbprint: string;
  readonly label: string;
  readonly expiresAt: number;
}

export interface MachineGrantProjection {
  readonly grantId: string;
  readonly granteeActorId: string;
  readonly allowExecution: boolean;
  readonly threadIds?: readonly string[];
  readonly grantEpoch: number;
  readonly expiresAt: number;
}

export interface MachineAuthorityDocument {
  readonly schemaVersion: 1;
  readonly machineId: string;
  readonly displayName: string;
  readonly ownerActorId: string;
  readonly ownerDeviceThumbprint?: string;
  readonly secretHash: string;
  readonly approvalRequired: boolean;
  readonly maxBlobBytes?: number;
  readonly revoked: boolean;
  readonly generation: number;
  readonly approvedDevices: Readonly<Record<string, ApprovedDeviceEntry>>;
  readonly revokedDevices?: Readonly<Record<string, number>>;
  readonly pendingApprovals: Readonly<Record<string, PendingDeviceApproval>>;
  readonly grants: Readonly<Record<string, MachineGrantProjection>>;
  readonly directRoutes: readonly DirectRouteCandidate[];
  /** Offline-friendly summary published by the host so collaborators see clean status while laptop sleeps. */
  readonly offlineCatalogSummary: {
    readonly updatedAt: number;
    readonly sharedThreads: readonly { readonly threadId: string; readonly title: string }[];
  } | null;
}

const AUTHORITY_KEY = "machine-authority";

export class MachineRelayAuthority {
  /**
   * Write-through in-memory cache of `MachineAuthorityDocument`. Because every
   * control-plane mutation for `machineId` runs inside this single-threaded DO,
   * `#cache` eliminates per-frame DO SQLite/KV reads on the WebSocket hot path.
   */
  #cache: MachineAuthorityDocument | null | undefined = undefined;

  constructor(private readonly documents: StateDocumentStore) {}

  peekCached(): MachineAuthorityDocument | null | undefined {
    return this.#cache;
  }

  async read(): Promise<MachineAuthorityDocument | null> {
    if (this.#cache !== undefined) return this.#cache;
    const raw = await this.documents.read(AUTHORITY_KEY);
    const doc = raw ? (raw as MachineAuthorityDocument) : null;
    this.#cache = doc;
    return doc;
  }

  async #mutate<T>(
    updater: (prev: MachineAuthorityDocument | undefined) => { result: T; next?: MachineAuthorityDocument },
  ): Promise<T> {
    try {
      let committedNext: MachineAuthorityDocument | null | undefined;
      const out = await this.documents.update<T>(AUTHORITY_KEY, (current) => {
        const prev = current as MachineAuthorityDocument | undefined;
        const step = updater(prev);
        committedNext = step.next !== undefined ? step.next : (prev ?? null);
        return step.next !== undefined ? { result: step.result, next: step.next } : { result: step.result };
      });
      this.#cache = committedNext ?? null;
      return out;
    } catch (err) {
      this.#cache = undefined;
      throw err;
    }
  }

  async configure(input: {
    readonly machineId: string;
    readonly displayName: string;
    readonly ownerActorId: string;
    readonly secretHash: string;
    readonly approvalRequired: boolean;
    readonly maxBlobBytes?: number;
    readonly ownerDeviceThumbprint?: string;
  }): Promise<MachineAuthorityDocument> {
    return this.#mutate((prev) => {
      if (prev && prev.ownerActorId !== input.ownerActorId) {
        throw new Error("Machine already belongs to another owner");
      }
      const nextOwnerThumbprint = input.ownerDeviceThumbprint ?? prev?.ownerDeviceThumbprint;
      const next: MachineAuthorityDocument = {
        schemaVersion: 1,
        machineId: input.machineId,
        displayName: input.displayName,
        ownerActorId: input.ownerActorId,
        ...(nextOwnerThumbprint ? { ownerDeviceThumbprint: nextOwnerThumbprint } : {}),
        secretHash: input.secretHash,
        approvalRequired: input.approvalRequired,
        maxBlobBytes: input.maxBlobBytes ?? prev?.maxBlobBytes ?? DEFAULT_FREE_MAX_BLOB_BYTES,
        revoked: false,
        generation: prev?.generation ?? 0,
        approvedDevices: prev?.approvedDevices ?? {},
        ...(prev?.revokedDevices ? { revokedDevices: prev.revokedDevices } : {}),
        pendingApprovals: prev?.pendingApprovals ?? {},
        grants: prev?.grants ?? {},
        directRoutes: prev?.directRoutes ?? [],
        offlineCatalogSummary: prev?.offlineCatalogSummary ?? null,
      };
      return { result: next, next };
    });
  }

  async transferOwner(input: {
    readonly newOwnerActorId: string;
    readonly displayName?: string;
    readonly ownerDeviceThumbprint: string;
    readonly approvedBrowserThumbprint?: string;
    readonly approvedBrowserLabel?: string;
    readonly now: number;
  }): Promise<{ readonly prevOwnerActorId: string; readonly doc: MachineAuthorityDocument }> {
    return this.#mutate((prev) => {
      if (!prev || prev.revoked) throw new Error("Machine is unavailable");
      const prevOwnerActorId = prev.ownerActorId;
      const nextApproved: Record<string, ApprovedDeviceEntry> = {
        ...prev.approvedDevices,
        [input.ownerDeviceThumbprint]: {
          thumbprint: input.ownerDeviceThumbprint,
          label: "Owner Workstation",
          approvedAt: input.now,
        },
      };
      const nextRevoked: Record<string, number> = { ...(prev.revokedDevices ?? {}) };
      delete nextRevoked[input.ownerDeviceThumbprint];
      if (input.approvedBrowserThumbprint) {
        delete nextRevoked[input.approvedBrowserThumbprint];
        nextApproved[input.approvedBrowserThumbprint] = {
          thumbprint: input.approvedBrowserThumbprint,
          label: (input.approvedBrowserLabel ?? "Personal Hub Browser").slice(0, 128),
          approvedAt: input.now,
        };
      }
      const next: MachineAuthorityDocument = {
        ...prev,
        ownerActorId: input.newOwnerActorId,
        ownerDeviceThumbprint: input.ownerDeviceThumbprint,
        displayName: input.displayName?.trim().slice(0, 128) || prev.displayName,
        approvedDevices: nextApproved,
        revokedDevices: nextRevoked,
      };
      return { result: { prevOwnerActorId, doc: next }, next };
    });
  }

  async setMaxBlobBytes(maxBlobBytes: number): Promise<void> {
    await this.#mutate((prev) => {
      if (!prev || prev.revoked) return { result: undefined };
      return { result: undefined, next: { ...prev, maxBlobBytes } };
    });
  }

  async nextGeneration(): Promise<number> {
    return this.#mutate((prev) => {
      if (!prev || prev.revoked) throw new Error("Machine is unavailable");
      const generation = prev.generation + 1;
      return { result: generation, next: { ...prev, generation } };
    });
  }

  async revokeMachine(): Promise<void> {
    await this.#mutate((prev) => {
      if (!prev) return { result: undefined };
      return {
        result: undefined,
        next: { ...prev, revoked: true, grants: {}, directRoutes: [] },
      };
    });
  }

  async upsertGrant(grant: MachineGrantProjection): Promise<void> {
    await this.#mutate((prev) => {
      if (!prev || prev.revoked) throw new Error("Machine is unavailable");
      return {
        result: undefined,
        next: { ...prev, grants: { ...prev.grants, [grant.grantId]: grant } },
      };
    });
  }

  async revokeGrant(grantId: string): Promise<void> {
    await this.#mutate((prev) => {
      if (!prev) return { result: undefined };
      const { [grantId]: _removed, ...rest } = prev.grants;
      return { result: undefined, next: { ...prev, grants: rest } };
    });
  }

  async registerDeviceOrQueueApproval(input: {
    readonly thumbprint: string;
    readonly label: string;
    readonly forceApprove: boolean;
    readonly clearRevocation?: boolean;
    readonly ownerBootstrap?: boolean;
    readonly shortCode: string;
    readonly now: number;
  }): Promise<
    | { readonly status: "approved" }
    | { readonly status: "revoked" }
    | { readonly status: "pending_approval"; readonly shortCode: string; readonly expiresAt: number }
  > {
    type RegistrationOutcome =
      | { readonly status: "approved" }
      | { readonly status: "revoked" }
      | { readonly status: "pending_approval"; readonly shortCode: string; readonly expiresAt: number };
    return this.#mutate<RegistrationOutcome>((prev) => {
      if (!prev || prev.revoked) throw new Error("Machine is unavailable");
      const nextRevoked: Record<string, number> = { ...(prev.revokedDevices ?? {}) };
      if (input.clearRevocation === true || input.ownerBootstrap === true) {
        delete nextRevoked[input.thumbprint];
      } else if (nextRevoked[input.thumbprint]) {
        return { result: { status: "revoked" as const } };
      }
      if (
        prev.approvedDevices[input.thumbprint] ||
        input.ownerBootstrap === true ||
        (!prev.approvalRequired && input.forceApprove)
      ) {
        const existing = prev.approvedDevices[input.thumbprint];
        const entry: ApprovedDeviceEntry = {
          thumbprint: input.thumbprint,
          label:
            existing && input.label === "Personal Hub Browser"
              ? existing.label
              : input.label.slice(0, 128) || "Paired Device",
          approvedAt: existing?.approvedAt ?? input.now,
        };
        return {
          result: { status: "approved" as const },
          next: {
            ...prev,
            approvedDevices: { ...prev.approvedDevices, [input.thumbprint]: entry },
            revokedDevices: nextRevoked,
          },
        };
      }
      const cleaned: Record<string, PendingDeviceApproval> = {};
      for (const [code, item] of Object.entries(prev.pendingApprovals)) {
        if (item.expiresAt > input.now && item.thumbprint !== input.thumbprint) cleaned[code] = item;
      }
      const expiresAt = input.now + APPROVAL_CODE_TTL_MS;
      cleaned[input.shortCode] = {
        shortCode: input.shortCode,
        thumbprint: input.thumbprint,
        label: input.label.slice(0, 128) || "New Device",
        expiresAt,
      };
      return {
        result: { status: "pending_approval" as const, shortCode: input.shortCode, expiresAt },
        next: { ...prev, pendingApprovals: cleaned, revokedDevices: nextRevoked },
      };
    });
  }

  async approvePendingDevice(shortCode: string, now: number): Promise<ApprovedDeviceEntry | null> {
    const normalized = shortCode.trim().toUpperCase();
    return this.#mutate((prev) => {
      if (!prev || prev.revoked) return { result: null };
      const pending = prev.pendingApprovals[normalized];
      if (!pending || pending.expiresAt <= now) return { result: null };
      const { [normalized]: _done, ...restPending } = prev.pendingApprovals;
      const nextRevoked: Record<string, number> = { ...(prev.revokedDevices ?? {}) };
      delete nextRevoked[pending.thumbprint];
      const approved: ApprovedDeviceEntry = {
        thumbprint: pending.thumbprint,
        label: pending.label,
        approvedAt: now,
      };
      return {
        result: approved,
        next: {
          ...prev,
          pendingApprovals: restPending,
          approvedDevices: { ...prev.approvedDevices, [approved.thumbprint]: approved },
          revokedDevices: nextRevoked,
        },
      };
    });
  }

  async revokeDevice(thumbprint: string, now: number): Promise<boolean> {
    return this.#mutate((prev) => {
      if (!prev || prev.revoked) return { result: false };
      if (prev.ownerDeviceThumbprint && thumbprint === prev.ownerDeviceThumbprint) {
        return { result: false };
      }
      const { [thumbprint]: removedApproved, ...restApproved } = prev.approvedDevices;
      const restPending: Record<string, PendingDeviceApproval> = {};
      for (const [code, item] of Object.entries(prev.pendingApprovals)) {
        if (item.thumbprint !== thumbprint) restPending[code] = item;
      }
      return {
        result: Boolean(removedApproved || prev.revokedDevices?.[thumbprint] === undefined),
        next: {
          ...prev,
          approvedDevices: restApproved,
          pendingApprovals: restPending,
          revokedDevices: { ...(prev.revokedDevices ?? {}), [thumbprint]: now },
        },
      };
    });
  }

  async updateDirectRoutes(candidates: readonly DirectRouteCandidate[]): Promise<void> {
    const validated = candidates
      .slice(0, 16)
      .map(validateDirectRouteCandidate)
      .sort((a, b) => a.priority - b.priority);
    await this.#mutate((prev) => {
      if (!prev || prev.revoked) return { result: undefined };
      return { result: undefined, next: { ...prev, directRoutes: validated } };
    });
  }

  async updateOfflineSummary(
    sharedThreads: readonly { readonly threadId: string; readonly title: string }[],
    now: number,
  ): Promise<void> {
    const sanitized = sharedThreads.slice(0, 64).map((t) => ({
      threadId: String(t.threadId).slice(0, 256),
      title: String(t.title).slice(0, 256),
    }));
    await this.#mutate((prev) => {
      if (!prev || prev.revoked) return { result: undefined };
      return {
        result: undefined,
        next: { ...prev, offlineCatalogSummary: { updatedAt: now, sharedThreads: sanitized } },
      };
    });
  }

  /**
   * Authorizes a caller (`actorId` + optional `deviceThumbprint`) against the machine's
   * current owner/device policy or active collaborator `ShareGrant`s.
   */
  authorizeAccess(
    doc: MachineAuthorityDocument | null,
    caller: { readonly actorId: string; readonly deviceThumbprint?: string; readonly grantId?: string },
    now: number,
  ):
    | { readonly allowed: true; readonly scope: MuxAccessScope; readonly directRoutes: readonly DirectRouteCandidate[] }
    | { readonly allowed: false; readonly status: 403 | 404; readonly error: string } {
    if (!doc || doc.revoked) return { allowed: false, status: 404, error: "machine_unavailable" };
    if (caller.actorId === doc.ownerActorId) {
      if (caller.deviceThumbprint && doc.revokedDevices?.[caller.deviceThumbprint]) {
        return { allowed: false, status: 403, error: "device_revoked" };
      }
      const hasPendingForDevice = caller.deviceThumbprint
        ? Object.values(doc.pendingApprovals).some((p) => p.thumbprint === caller.deviceThumbprint)
        : false;
      if (doc.approvalRequired || hasPendingForDevice) {
        if (!caller.deviceThumbprint || !doc.approvedDevices[caller.deviceThumbprint]) {
          return { allowed: false, status: 403, error: "device_approval_required" };
        }
      }
      return {
        allowed: true,
        scope: { role: "owner", allowExecution: true, grantEpoch: 0 },
        // Private LAN and Tailscale direct routes are disclosed ONLY to the machine owner!
        directRoutes: doc.directRoutes,
      };
    }
    const matchingGrant = caller.grantId
      ? doc.grants[caller.grantId]
      : Object.values(doc.grants).find((g) => g.granteeActorId === caller.actorId && g.expiresAt > now);
    if (!matchingGrant || matchingGrant.granteeActorId !== caller.actorId || matchingGrant.expiresAt <= now) {
      return { allowed: false, status: 403, error: "access_denied" };
    }
    return {
      allowed: true,
      scope: {
        role: "collaborator",
        allowExecution: matchingGrant.allowExecution,
        grantEpoch: matchingGrant.grantEpoch,
        ...(matchingGrant.threadIds ? { threadIds: matchingGrant.threadIds } : {}),
      },
      // Collaborators never receive private LAN / Tailnet IP candidates.
      directRoutes: [],
    };
  }
}
