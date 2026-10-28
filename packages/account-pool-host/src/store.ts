import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, schemaFingerprint, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { parseCodexAuthFileReference, readCodexAuthFile, type CodexAuthFileReference } from "./codex-auth-file.js";
import { createCodexAccountPoolLaunch } from "./codex-launch.js";

const BASELINE = `
CREATE TABLE pool_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  upstream_account_id TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  email TEXT,
  subscription_type TEXT,
  rate_limit_tier TEXT,
  last_used_at INTEGER,
  last_used_host_id TEXT
) STRICT;
CREATE TABLE pool_affinity (
  affinity_key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES pool_accounts(id) ON DELETE CASCADE,
  last_used_at INTEGER NOT NULL
) STRICT;
CREATE TABLE pool_active_account (
  provider TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES pool_accounts(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE pool_quota (
  account_id TEXT PRIMARY KEY REFERENCES pool_accounts(id) ON DELETE CASCADE,
  utilization REAL,
  reset_at INTEGER,
  held_until INTEGER,
  error TEXT,
  observed_at INTEGER NOT NULL,
  limit_windows_json TEXT NOT NULL DEFAULT '[]'
) STRICT
`.trim();

const RESET_CREDITS_SQL = `
ALTER TABLE pool_accounts ADD COLUMN reset_credit_count INTEGER CHECK(reset_credit_count >= 0);
ALTER TABLE pool_accounts ADD COLUMN reset_credits_observed_at INTEGER;
`.trim();

// Preserve existing accounts' credit behavior; new accounts opt in explicitly.
const CREDIT_POLICY_SQL = `ALTER TABLE pool_accounts ADD COLUMN allow_credits INTEGER NOT NULL DEFAULT 1 CHECK(allow_credits IN (0,1));`;

// The pre-ledger owner created these four tables and appended the nullable
// account metadata and quota windows columns. Accept only those known shapes.
const legacyAccountPoolMigration = {
  accepts(fingerprint: string): boolean {
    const tables = JSON.parse(fingerprint) as Array<{ name: string; columns: unknown[]; indexes: string[] }>;
    if (!tables.some(table => table.name === "pool_accounts")) return false;
    const target = new DatabaseSync(":memory:");
    try {
      target.exec(BASELINE);
      target.exec(RESET_CREDITS_SQL);
      target.exec(CREDIT_POLICY_SQL);
      const expected = JSON.parse(schemaFingerprint(target)) as typeof tables;
      const minimumColumns: Record<string, number> = { pool_accounts: 7, pool_affinity: 3, pool_active_account: 2, pool_quota: 6 };
      return tables.every(table => {
        const current = expected.find(candidate => candidate.name === table.name);
        return current !== undefined && table.columns.length >= minimumColumns[table.name]!
          && table.columns.length <= current.columns.length
          && JSON.stringify(table.columns) === JSON.stringify(current.columns.slice(0, table.columns.length))
          && JSON.stringify(table.indexes) === JSON.stringify(current.indexes);
      });
    } finally { target.close(); }
  },
  migrate(database: DatabaseSync): void {
    database.exec(BASELINE.replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
    for (const [table, additions] of [
      ["pool_accounts", ["email TEXT", "subscription_type TEXT", "rate_limit_tier TEXT", "last_used_at INTEGER", "last_used_host_id TEXT", "reset_credit_count INTEGER CHECK(reset_credit_count >= 0)", "reset_credits_observed_at INTEGER", "allow_credits INTEGER NOT NULL DEFAULT 1 CHECK(allow_credits IN (0,1))"]],
      ["pool_quota", ["limit_windows_json TEXT NOT NULL DEFAULT '[]'"]],
    ] as const) {
      const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
      for (const definition of additions) {
        if (!columns.has(definition.split(" ")[0]!)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
    }
  },
};

export type AccountPoolProvider = "codex";

export interface AccountPoolAccountInput {
  readonly id: string;
  readonly provider: AccountPoolProvider;
  readonly label: string;
  readonly upstreamAccountId: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly allowCredits?: boolean;
}

export interface AccountPoolAccount extends AccountPoolAccountInput {
  readonly allowCredits: boolean;
  readonly createdAt: number;
}

export type AccountPoolAccountSummary = Omit<AccountPoolAccount, "createdAt"> & {
  readonly credentialConfigured: boolean;
};

export interface AccountPoolSecret {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken?: string | null;
  readonly expiresAt: number | null;
  /** Resolved in memory only; this owner must never refresh or persist it. */
  readonly external?: true;
}

export interface AccountPoolSelectionInput {
  readonly provider: AccountPoolProvider;
  readonly hostId: string;
  readonly affinityId: string;
  readonly parentAffinityId?: string | null;
  readonly excludeAccountIds?: ReadonlySet<string>;
  /** Metadata reads neither allocate a Thread nor advance the routing cursor. */
  readonly purpose?: "conversation" | "metadata";
}

export interface AccountPoolSelection {
  readonly account: AccountPoolAccount;
  readonly secret: AccountPoolSecret;
  readonly heldUntil: number | null;
  readonly retryAfterMs: number;
  readonly keepsAffinity: boolean;
  accept(): void;
}

export interface AccountPoolQuotaObservation {
  readonly utilization: number | null;
  readonly resetAt: number | null;
  readonly heldUntil?: number | null;
  readonly error?: string | null;
  readonly limitWindows?: readonly AccountPoolLimitWindow[];
}

export type AccountPoolStatus = "disabled" | "ready" | "held" | "exhausted" | "error";

export interface AccountPoolLimitWindow {
  readonly slot: "primary" | "secondary";
  readonly windowMinutes: number | null;
  readonly utilization: number | null;
  readonly resetAt: number | null;
  readonly status: string | null;
  readonly observedAt: number;
  readonly source: "header" | "usage";
  /** Server-confirmed extra credits; percentages still describe subscription usage. */
  readonly creditsAvailable?: boolean;
}

export interface AccountPoolAccountState {
  readonly accountId: string;
  readonly email: string | null;
  readonly subscriptionType: string | null;
  readonly rateLimitTier: string | null;
  readonly resetCredits: { readonly availableCount: number; readonly observedAt: number } | null;
  readonly lastUsedAt: number | null;
  readonly lastUsedHostId: string | null;
  readonly observedAt: number | null;
  readonly heldUntil: number | null;
  readonly error: string | null;
  readonly limitWindows: readonly AccountPoolLimitWindow[];
  readonly status: AccountPoolStatus;
}

function requiredText(value: string, label: string, max = 512): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return trimmed;
}

function accountId(value: string): string {
  const id = requiredText(value, "account id", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) throw new TypeError("Invalid account id");
  return id;
}

function secretValue(value: string, label: string): string {
  if (!value || value.length > 65536 || /[\r\n\0]/u.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function parseSecret(value: unknown): AccountPoolSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid account secret");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.accessToken !== "string") throw new TypeError("Invalid account secret");
  if (candidate.refreshToken !== null && typeof candidate.refreshToken !== "string") throw new TypeError("Invalid account secret");
  if (candidate.expiresAt !== null && (!Number.isSafeInteger(candidate.expiresAt) || Number(candidate.expiresAt) < 0)) throw new TypeError("Invalid account secret");
  return {
    accessToken: secretValue(candidate.accessToken, "access token"),
    refreshToken: candidate.refreshToken === null ? null : secretValue(candidate.refreshToken, "refresh token"),
    idToken: candidate.idToken == null ? null : secretValue(String(candidate.idToken), "ID token"),
    expiresAt: candidate.expiresAt === null ? null : Number(candidate.expiresAt),
  };
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseLimitWindows(value: unknown): AccountPoolLimitWindow[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const windows: AccountPoolLimitWindow[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    if (!(["primary", "secondary"] as const).includes(candidate.slot as "primary" | "secondary")) continue;
    if (!(["header", "usage"] as const).includes(candidate.source as "header" | "usage")) continue;
    const windowMinutes = candidate.windowMinutes === null ? null : Number(candidate.windowMinutes);
    const utilization = candidate.utilization === null ? null : Number(candidate.utilization);
    const resetAt = candidate.resetAt === null ? null : Number(candidate.resetAt);
    const observedAt = Number(candidate.observedAt);
    if (windowMinutes !== null && (!Number.isSafeInteger(windowMinutes) || windowMinutes <= 0)) continue;
    if (utilization !== null && (!Number.isFinite(utilization) || utilization < 0 || utilization > 1)) continue;
    if (resetAt !== null && (!Number.isSafeInteger(resetAt) || resetAt < 0)) continue;
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) continue;
    windows.push({
      slot: candidate.slot as "primary" | "secondary",
      windowMinutes,
      utilization,
      resetAt,
      status: nullableText(candidate.status),
      observedAt,
      source: candidate.source as "header" | "usage",
      ...(typeof candidate.creditsAvailable === "boolean" ? { creditsAvailable: candidate.creditsAvailable } : {}),
    });
  }
  return windows;
}

function affinityKey(provider: AccountPoolProvider, hostId: string, affinityId: string): string {
  return JSON.stringify([
    provider,
    requiredText(hostId, "host id"),
    requiredText(affinityId, "affinity id"),
  ]);
}

export class AccountPoolStore {
  private readonly database: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  private readonly secretsDirectory: string;
  private readonly now: () => number;
  private readonly switchThreshold: number;
  private readonly affinityIdleTtlMs: number;
  private readonly maxAffinityBindings: number;

  constructor(options: {
    readonly databasePath: string;
    readonly secretsDirectory: string;
    readonly now?: () => number;
    readonly switchThreshold?: number;
    readonly affinityIdleTtlMs?: number;
    readonly maxAffinityBindings?: number;
    /** A fenced successor must inspect the exact source state before any expiry cleanup. */
    readonly preserveAffinity?: boolean;
  }) {
    mkdirSync(options.secretsDirectory, { recursive: true, mode: 0o700 });
    chmodSync(options.secretsDirectory, 0o700);
    this.secretsDirectory = options.secretsDirectory;
    this.now = options.now ?? Date.now;
    this.switchThreshold = options.switchThreshold ?? 0.98;
    this.affinityIdleTtlMs = options.affinityIdleTtlMs ?? 30 * 60 * 1_000;
    this.maxAffinityBindings = options.maxAffinityBindings ?? 4_096;
    if (!(this.switchThreshold > 0 && this.switchThreshold <= 1)) throw new RangeError("Invalid switch threshold");
    if (!Number.isSafeInteger(this.affinityIdleTtlMs) || this.affinityIdleTtlMs <= 0) throw new RangeError("Invalid affinity idle TTL");
    if (!Number.isSafeInteger(this.maxAffinityBindings) || this.maxAffinityBindings <= 0) throw new RangeError("Invalid affinity binding limit");
    const managed = openManagedDatabase({
      path: options.databasePath,
      migrations: [
        { version: 1, name: "account-pool", sql: BASELINE },
        { version: 2, name: "codex-reset-credit-count", sql: RESET_CREDITS_SQL },
        { version: 3, name: "codex-account-credit-policy", sql: CREDIT_POLICY_SQL },
      ],
      legacyMigration: legacyAccountPoolMigration,
    });
    this.database = managed.database;
    this.outcome = managed.outcome;
    this.database.exec("PRAGMA foreign_keys=ON;");
    if (!options.preserveAffinity) this.pruneAffinity(this.now());
  }

  addAccount(input: AccountPoolAccountInput, rawSecret: AccountPoolSecret | CodexAuthFileReference): AccountPoolAccount {
    const account: AccountPoolAccount = {
      id: accountId(input.id),
      provider: input.provider,
      label: requiredText(input.label, "account label", 160),
      upstreamAccountId: requiredText(input.upstreamAccountId, "upstream account id"),
      priority: input.priority,
      enabled: input.enabled,
      allowCredits: input.allowCredits ?? false,
      createdAt: this.now(),
    };
    if (typeof account.allowCredits !== "boolean") throw new TypeError("Invalid credit policy");
    if (account.provider !== "codex" || !Number.isSafeInteger(account.priority)) throw new TypeError("Invalid account");
    const reference = parseCodexAuthFileReference(rawSecret);
    if (reference) readCodexAuthFile(reference, account.upstreamAccountId);
    else if ((rawSecret as AccountPoolSecret).external) throw new Error("Shared credentials require a file reference");
    const secret = reference ?? parseSecret(rawSecret);
    const secretPath = this.secretPath(account.id);
    if (existsSync(secretPath) || this.database.prepare("SELECT 1 FROM pool_accounts WHERE id=?").get(account.id)) {
      throw new Error("Account already exists");
    }
    try {
      this.transaction(() => {
        this.database.prepare(
          "INSERT INTO pool_accounts (id,provider,label,upstream_account_id,priority,enabled,created_at,allow_credits) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          account.id,
          account.provider,
          account.label,
          account.upstreamAccountId,
          account.priority,
          Number(account.enabled),
          account.createdAt,
          Number(account.allowCredits),
        );
        this.writeSecret(account.id, secret);
      });
    } catch (error) {
      rmSync(secretPath, { force: true });
      throw error;
    }
    return account;
  }

  listAccounts(): AccountPoolAccountSummary[] {
    return this.database.prepare("SELECT * FROM pool_accounts ORDER BY priority, created_at, id").all().map(row => {
      const account = this.accountFromRow(row);
      return {
        id: account.id,
        provider: account.provider,
        label: account.label,
        upstreamAccountId: account.upstreamAccountId,
        priority: account.priority,
        enabled: account.enabled,
        allowCredits: account.allowCredits,
        credentialConfigured: existsSync(this.secretPath(account.id)),
      };
    });
  }

  listAccountStates(): AccountPoolAccountState[] {
    const now = this.now();
    return this.database.prepare(
      `SELECT a.id,a.enabled,a.allow_credits,a.email,a.subscription_type,a.rate_limit_tier,a.last_used_at,a.last_used_host_id,a.reset_credit_count,a.reset_credits_observed_at,
        q.utilization,q.reset_at,q.held_until,q.error,q.observed_at,q.limit_windows_json
       FROM pool_accounts a LEFT JOIN pool_quota q ON q.account_id=a.id
       WHERE a.provider='codex' ORDER BY a.priority,a.created_at,a.id`,
    ).all().map(row => this.accountStateFromRow(row, now));
  }

  getAccount(id: string): AccountPoolAccount {
    const row = this.database.prepare("SELECT * FROM pool_accounts WHERE id=?").get(accountId(id));
    if (!row) throw new Error("Account not found");
    return this.accountFromRow(row);
  }

  readCredential(id: string): AccountPoolSecret {
    this.getAccount(id);
    return this.readSecret(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const result = this.database.prepare("UPDATE pool_accounts SET enabled=? WHERE id=?").run(Number(enabled), accountId(id));
    if (Number(result.changes) !== 1) throw new Error("Account not found");
  }

  setAllowCredits(id: string, allowCredits: boolean): void {
    if (typeof allowCredits !== "boolean") throw new TypeError("Invalid credit policy");
    const result = this.database.prepare("UPDATE pool_accounts SET allow_credits=? WHERE id=?")
      .run(Number(allowCredits), accountId(id));
    if (Number(result.changes) !== 1) throw new Error("Account not found");
  }

  replaceCredential(id: string, rawSecret: AccountPoolSecret): void {
    const normalizedId = accountId(id);
    if (!this.database.prepare("SELECT 1 FROM pool_accounts WHERE id=?").get(normalizedId)) throw new Error("Account not found");
    if (rawSecret.external || parseCodexAuthFileReference(JSON.parse(readFileSync(this.secretPath(normalizedId), "utf8")))) {
      throw new Error("Shared Codex credentials must be updated by their external owner");
    }
    this.writeSecret(normalizedId, parseSecret(rawSecret));
    this.database.prepare("UPDATE pool_quota SET error=NULL,held_until=NULL WHERE account_id=?").run(normalizedId);
  }

  updateSubscriptionMetadata(id: string, input: {
    readonly email?: string | null;
    readonly subscriptionType?: string | null;
    readonly rateLimitTier?: string | null;
    readonly resetCredits?: { readonly availableCount: number; readonly observedAt: number } | null;
  }): void {
    const normalizedId = accountId(id);
    const current = this.database.prepare(
      "SELECT email,subscription_type,rate_limit_tier,reset_credit_count,reset_credits_observed_at FROM pool_accounts WHERE id=?",
    ).get(normalizedId);
    if (current === undefined) throw new Error("Account not found");
    if (input.resetCredits != null && (!Number.isSafeInteger(input.resetCredits.availableCount)
      || input.resetCredits.availableCount < 0 || !Number.isSafeInteger(input.resetCredits.observedAt)
      || input.resetCredits.observedAt < 0)) throw new TypeError("Invalid reset credit observation");
    this.database.prepare(
      "UPDATE pool_accounts SET email=?,subscription_type=?,rate_limit_tier=?,reset_credit_count=?,reset_credits_observed_at=? WHERE id=?",
    ).run(
      input.email === undefined ? current.email : nullableText(input.email),
      input.subscriptionType === undefined ? current.subscription_type : nullableText(input.subscriptionType),
      input.rateLimitTier === undefined ? current.rate_limit_tier : nullableText(input.rateLimitTier),
      input.resetCredits === undefined ? current.reset_credit_count : input.resetCredits?.availableCount ?? null,
      input.resetCredits === undefined ? current.reset_credits_observed_at : input.resetCredits?.observedAt ?? null,
      normalizedId,
    );
  }

  removeAccount(id: string): void {
    const normalizedId = accountId(id);
    this.getAccount(normalizedId);
    const source = this.secretPath(normalizedId);
    const tombstone = `${source}.${randomUUID()}.removed`;
    if (existsSync(source)) renameSync(source, tombstone);
    try {
      this.transaction(() => {
        const result = this.database.prepare("DELETE FROM pool_accounts WHERE id=?").run(normalizedId);
        if (Number(result.changes) !== 1) throw new Error("Account not found");
      });
    } catch (error) {
      if (existsSync(tombstone)) renameSync(tombstone, source);
      throw error;
    }
    rmSync(tombstone, { force: true });
  }

  reorder(provider: AccountPoolProvider, orderedIds: readonly string[]): void {
    if (provider !== "codex") throw new TypeError("Invalid provider");
    const expected = this.database.prepare("SELECT id FROM pool_accounts WHERE provider=? ORDER BY id").all(provider).map(row => String(row.id));
    const normalized = orderedIds.map(accountId);
    if (new Set(normalized).size !== normalized.length
      || normalized.length !== expected.length
      || normalized.some(id => !expected.includes(id))) {
      throw new Error("Include every account for this provider exactly once");
    }
    this.transaction(() => {
      const update = this.database.prepare("UPDATE pool_accounts SET priority=? WHERE id=? AND provider=?");
      normalized.forEach((id, index) => update.run(index + 1, id, provider));
    });
  }

  select(input: AccountPoolSelectionInput): AccountPoolSelection {
    return this.transaction(() => this.selectWithinTransaction(input));
  }

  private selectWithinTransaction(input: AccountPoolSelectionInput): AccountPoolSelection {
    const metadata = input.purpose === "metadata";
    const provider = input.provider;
    if (provider !== "codex") throw new TypeError("Invalid provider");
    const key = affinityKey(provider, input.hostId, input.affinityId);
    const now = this.now();
    const excluded = input.excludeAccountIds ?? new Set<string>();
    this.pruneAffinity(now);
    const orderedAccounts = this.database.prepare(
      `SELECT a.*,q.utilization,q.reset_at,q.held_until,q.error,q.limit_windows_json
       FROM pool_accounts a LEFT JOIN pool_quota q ON q.account_id=a.id
       WHERE a.provider=? ORDER BY a.priority,a.created_at,a.id`,
    ).all(provider).map(row => ({
      account: this.accountFromRow(row),
      utilization: row.utilization == null ? null : Number(row.utilization),
      resetAt: row.reset_at == null ? null : Number(row.reset_at),
      heldUntil: row.held_until == null ? null : Number(row.held_until),
      error: row.error == null ? null : String(row.error),
      limitWindows: parseLimitWindows(row.limit_windows_json),
    }));
    const available = orderedAccounts.filter(candidate => candidate.account.enabled
      && candidate.error === null
      && !this.quotaExhausted(candidate, now, candidate.account.allowCredits));
    const availableById = new Map(available.map(candidate => [candidate.account.id, candidate]));
    const candidates = available.filter(candidate => !excluded.has(candidate.account.id)
      && (candidate.heldUntil === null || candidate.heldUntil <= now));
    const boundRow = metadata ? undefined : this.readAffinity(key, now);
    const parentKey = input.parentAffinityId == null ? null : affinityKey(provider, input.hostId, input.parentAffinityId);
    const parentRow = metadata || parentKey === null ? undefined : this.readAffinity(parentKey, now);
    const activeRow = this.database.prepare("SELECT account_id FROM pool_active_account WHERE provider=?").get(provider);
    const boundAccountId = boundRow?.account_id == null ? null : String(boundRow.account_id);
    const bound = boundAccountId === null || excluded.has(boundAccountId) ? undefined : availableById.get(boundAccountId);
    const inherited = bound === undefined && parentRow?.account_id != null && !excluded.has(String(parentRow.account_id))
      ? availableById.get(String(parentRow.account_id))
      : undefined;
    const activeAccountId = activeRow?.account_id == null ? null : String(activeRow.account_id);
    const active = activeAccountId === null ? undefined : candidates.find(candidate => candidate.account.id === activeAccountId);
    const previousAccountId = [...excluded].at(-1) ?? null;
    const anchorId = previousAccountId ?? boundAccountId ?? activeAccountId;
    const anchorIndex = orderedAccounts.findIndex(candidate => candidate.account.id === anchorId);
    const rotated = [
      ...orderedAccounts.slice(anchorIndex + 1),
      ...orderedAccounts.slice(0, anchorIndex + 1),
    ];
    const next = rotated.map(candidate => candidates.find(eligible => eligible.account.id === candidate.account.id))
      .find((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
    const selected = bound
      ?? inherited
      ?? (metadata ? active : undefined)
      ?? next;
    if (selected === undefined) throw new Error("No eligible account");
    const pinnedAccountId = boundAccountId ?? inherited?.account.id ?? null;
    const keepsAffinity = selected.account.id === pinnedAccountId;
    // Admission, not response completion, owns routing. A durable reservation
    // keeps simultaneous first requests for one Thread on the same account.
    const secret = this.readSecret(selected.account.id);
    if (!metadata) {
      this.database.prepare(
        "INSERT INTO pool_affinity VALUES(?,?,?) ON CONFLICT(affinity_key) DO UPDATE SET account_id=excluded.account_id,last_used_at=excluded.last_used_at",
      ).run(key, selected.account.id, now);
      if (!keepsAffinity) {
        this.database.prepare(
          "INSERT INTO pool_active_account VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET account_id=excluded.account_id",
        ).run(provider, selected.account.id);
      }
      this.pruneAffinity(now);
    }
    let accepted = false;
    return {
      account: selected.account,
      secret,
      heldUntil: selected.heldUntil,
      retryAfterMs: Math.max(0, (selected.heldUntil ?? 0) - now),
      keepsAffinity,
      accept: () => {
        if (accepted || metadata) return;
        accepted = true;
        const now = this.now();
        this.transaction(() => {
          this.database.prepare(
            "UPDATE pool_accounts SET last_used_at=?,last_used_host_id=? WHERE id=?",
          ).run(now, input.hostId, selected.account.id);
          this.pruneAffinity(now);
        });
      },
    };
  }

  observeQuota(id: string, observation: AccountPoolQuotaObservation): void {
    const normalizedId = accountId(id);
    if (observation.utilization !== null && (!Number.isFinite(observation.utilization) || observation.utilization < 0 || observation.utilization > 1)) throw new TypeError("Invalid utilization");
    for (const value of [observation.resetAt, observation.heldUntil]) {
      if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError("Invalid quota timestamp");
    }
    const error = observation.error?.trim() || null;
    const current = this.database.prepare(
      "SELECT limit_windows_json FROM pool_quota WHERE account_id=?",
    ).get(normalizedId);
    const currentWindows = parseLimitWindows(current?.limit_windows_json);
    const observedSlots = new Set(observation.limitWindows?.map(window => window.slot) ?? []);
    const limitWindows = observation.limitWindows === undefined
      ? currentWindows
      : [
          ...currentWindows.filter(window => !observedSlots.has(window.slot)),
          ...observation.limitWindows.map(window => {
            const previous = currentWindows.find(value => value.slot === window.slot);
            // Successful response headers may omit credits. A real rejection
            // explicitly records false; a later usage refresh replaces the fact.
            return window.creditsAvailable === undefined && window.source === "header" && previous?.creditsAvailable !== undefined
              ? { ...window, creditsAvailable: previous.creditsAvailable } : { ...window };
          }),
        ].sort((left, right) => left.slot.localeCompare(right.slot));
    parseLimitWindows(JSON.stringify(limitWindows));
    this.database.prepare(
      `INSERT INTO pool_quota (account_id,utilization,reset_at,held_until,error,observed_at,limit_windows_json) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(account_id) DO UPDATE SET utilization=excluded.utilization,reset_at=excluded.reset_at,held_until=excluded.held_until,error=excluded.error,observed_at=excluded.observed_at,limit_windows_json=excluded.limit_windows_json`,
    ).run(
      normalizedId,
      observation.utilization,
      observation.resetAt,
      observation.heldUntil ?? null,
      error,
      this.now(),
      JSON.stringify(limitWindows),
    );
  }

  markAccountError(id: string, code: "authorization-rejected"): void {
    this.observeQuota(id, { utilization: null, resetAt: null, error: code });
  }

  issueHostToken(hostId: string): string {
    const normalizedHostId = requiredText(hostId, "host id");
    const path = this.hostTokenPath(normalizedHostId);
    try {
      const record = this.parseHostToken(readFileSync(path, "utf8"));
      if (record.hostId !== normalizedHostId) throw new Error("Host token identity mismatch");
      return record.token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const token = randomBytes(32).toString("base64url");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ hostId: normalizedHostId, token })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
    return token;
  }

  authenticateHostToken(token: string, codexBrokerBaseUrl?: string): string | null {
    if (!token || token.length > 4096) return null;
    const presented = Buffer.from(token);
    let matched: string | null = null;
    for (const name of readdirSync(this.secretsDirectory)) {
      if (!name.startsWith("host-") || !name.endsWith(".json")) continue;
      const record = this.parseHostToken(readFileSync(join(this.secretsDirectory, name), "utf8"));
      const expected = Buffer.from(codexBrokerBaseUrl === undefined ? record.token
        : createCodexAccountPoolLaunch({ baseUrl: codexBrokerBaseUrl, hostToken: record.token }).auth.accessToken);
      if (expected.length === presented.length && timingSafeEqual(expected, presented)) matched = record.hostId;
    }
    return matched;
  }

  close(): void {
    this.database.close();
  }

  affinityCount(): number {
    return Number(this.database.prepare("SELECT count(*) AS n FROM pool_affinity").get()!.n);
  }

  private accountFromRow(row: Record<string, unknown>): AccountPoolAccount {
    return {
      id: String(row.id),
      provider: String(row.provider) as AccountPoolProvider,
      label: String(row.label),
      upstreamAccountId: String(row.upstream_account_id),
      priority: Number(row.priority),
      enabled: Boolean(row.enabled),
      allowCredits: Boolean(row.allow_credits),
      createdAt: Number(row.created_at),
    };
  }

  private accountStateFromRow(row: Record<string, unknown>, now: number): AccountPoolAccountState {
    const limitWindows = parseLimitWindows(row.limit_windows_json);
    const heldUntil = row.held_until == null ? null : Number(row.held_until);
    const error = row.error == null ? null : String(row.error);
    const quota = {
      utilization: row.utilization == null ? null : Number(row.utilization),
      resetAt: row.reset_at == null ? null : Number(row.reset_at),
      limitWindows,
    };
    const status: AccountPoolStatus = !Boolean(row.enabled)
      ? "disabled"
      : error !== null
        ? "error"
        : heldUntil !== null && heldUntil > now
          ? "held"
          : this.quotaExhausted(quota, now, Boolean(row.allow_credits))
            ? "exhausted"
            : "ready";
    return {
      accountId: String(row.id),
      email: nullableText(row.email),
      subscriptionType: nullableText(row.subscription_type),
      rateLimitTier: nullableText(row.rate_limit_tier),
      resetCredits: row.reset_credit_count == null || row.reset_credits_observed_at == null ? null : {
        availableCount: Number(row.reset_credit_count), observedAt: Number(row.reset_credits_observed_at),
      },
      lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
      lastUsedHostId: nullableText(row.last_used_host_id),
      observedAt: row.observed_at == null ? null : Number(row.observed_at),
      heldUntil,
      error,
      limitWindows,
      status,
    };
  }

  private quotaExhausted(quota: {
    readonly utilization: number | null;
    readonly resetAt: number | null;
    readonly limitWindows: readonly AccountPoolLimitWindow[];
  }, now: number, allowCredits: boolean): boolean {
    const active = (utilization: number | null, status: string | null, resetAt: number | null) => {
      if (resetAt !== null && resetAt <= now) return false;
      return utilization !== null && utilization >= this.switchThreshold
        || status?.toLowerCase() === "rejected";
    };
    if (quota.limitWindows.length > 0) {
      return quota.limitWindows.some(window => (!allowCredits || window.creditsAvailable !== true) && active(window.utilization, window.status, window.resetAt));
    }
    return active(quota.utilization, null, quota.resetAt);
  }

  private readAffinity(key: string, now: number): Record<string, unknown> | undefined {
    const row = this.database.prepare(
      "SELECT account_id,last_used_at FROM pool_affinity WHERE affinity_key=?",
    ).get(key);
    if (row === undefined) return undefined;
    if (Number(row.last_used_at) > now - this.affinityIdleTtlMs) return row;
    this.database.prepare("DELETE FROM pool_affinity WHERE affinity_key=?").run(key);
    return undefined;
  }

  private pruneAffinity(now: number): void {
    this.database.prepare("DELETE FROM pool_affinity WHERE last_used_at<=?")
      .run(now - this.affinityIdleTtlMs);
    this.database.prepare(
      `DELETE FROM pool_affinity WHERE affinity_key NOT IN (
        SELECT affinity_key FROM pool_affinity ORDER BY last_used_at DESC,rowid DESC LIMIT ?
      )`,
    ).run(this.maxAffinityBindings);
  }

  private secretPath(id: string): string {
    return join(this.secretsDirectory, `account-${accountId(id)}.json`);
  }

  private hostTokenPath(hostId: string): string {
    return join(this.secretsDirectory, `host-${createHash("sha256").update(hostId).digest("hex")}.json`);
  }

  private parseHostToken(text: string): { hostId: string; token: string } {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.hostId !== "string" || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.token)) {
      throw new Error("Invalid Host token record");
    }
    return { hostId: requiredText(value.hostId, "host id"), token: value.token };
  }

  private readSecret(id: string): AccountPoolSecret {
    const value = JSON.parse(readFileSync(this.secretPath(id), "utf8"));
    const reference = parseCodexAuthFileReference(value);
    return reference ? readCodexAuthFile(reference, this.getAccount(id).upstreamAccountId).secret : parseSecret(value);
  }

  private writeSecret(id: string, secret: AccountPoolSecret | CodexAuthFileReference): void {
    const destination = this.secretPath(id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(secret)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, destination);
      chmodSync(destination, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
