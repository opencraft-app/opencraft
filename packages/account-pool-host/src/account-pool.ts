import { logAccountRecovery } from "./account-diagnostics.js";
import type { CodexAccountMaintenanceView } from "@opencraft/appserver-protocol";
import type { SqlDatabase } from "@opencraft/sql";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  EXTERNAL_CODEX_REAUTH_MESSAGE,
  parseCodexAuthFile,
  parseCodexAuthFileReference,
  type CodexAuthFileReference,
} from "./codex-auth-file-format.js";
import { createCodexAccountPoolLaunch } from "./codex-launch.js";

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
  readonly credentialSource: "external-file" | "managed" | null;
};

export interface AccountPoolSecret {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken?: string | null;
  readonly expiresAt: number | null;
  /** Resolved in memory only; this owner must never refresh or persist it. */
  readonly external?: true;
}

/** Only an external credential read failure may enter the proxy's auth-failure path. */
export class ExternalCodexCredentialError extends Error {
  constructor(readonly accountId: string) {
    super(EXTERNAL_CODEX_REAUTH_MESSAGE);
  }
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
  /** Recorded together with creditsAvailable when the service reports them. */
  readonly creditsUnlimited?: boolean;
  /** Raw balance text from the service; null when it reported credits without a balance. */
  readonly creditBalance?: string | null;
}

export interface AccountPoolCreditStatus {
  readonly available: boolean;
  readonly unlimited: boolean;
  readonly balance: string | null;
  readonly observedAt: number;
}

/** Latest service-reported credit fact across the account's limit windows, or null before any report. */
export function accountCreditStatus(windows: readonly AccountPoolLimitWindow[]): AccountPoolCreditStatus | null {
  let latest: AccountPoolLimitWindow | null = null;
  for (const window of windows) {
    if (window.creditsAvailable === undefined) continue;
    if (latest === null || window.observedAt > latest.observedAt) latest = window;
  }
  return latest === null || latest.creditsAvailable === undefined
    ? null
    : {
        available: latest.creditsAvailable,
        unlimited: latest.creditsUnlimited === true,
        balance: latest.creditBalance ?? null,
        observedAt: latest.observedAt,
      };
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
  if (candidate.refreshToken !== null && typeof candidate.refreshToken !== "string")
    throw new TypeError("Invalid account secret");
  if (candidate.expiresAt !== null && (!Number.isSafeInteger(candidate.expiresAt) || Number(candidate.expiresAt) < 0))
    throw new TypeError("Invalid account secret");
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

export function creditBalanceText(value: unknown): string | null {
  const text =
    typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  return text && text.length <= 64 ? text : null;
}

function parseLimitWindows(value: unknown): AccountPoolLimitWindow[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
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
      ...(typeof candidate.creditsAvailable === "boolean" && typeof candidate.creditsUnlimited === "boolean"
        ? { creditsUnlimited: candidate.creditsUnlimited }
        : {}),
      ...(typeof candidate.creditsAvailable === "boolean" && candidate.creditBalance !== undefined
        ? { creditBalance: creditBalanceText(candidate.creditBalance) }
        : {}),
    });
  }
  return windows;
}

function affinityKey(provider: AccountPoolProvider, hostId: string, affinityId: string): string {
  return JSON.stringify([provider, requiredText(hostId, "host id"), requiredText(affinityId, "affinity id")]);
}

/**
 * Credential records owned by the account pool: one record per account (a
 * managed OAuth secret or a reference to an operator-owned auth file) and one
 * per Host token. Synchronous because selection reads the chosen credential
 * inside the same SQL transaction that reserves its affinity; the Node
 * adapter keeps the existing private files, a Durable Object adapter keeps
 * them in the same storage as the SQL rows. See "AccountCore 存储" in
 * docs/architecture/platform/storage-ports.md.
 */
export interface AccountCredentialRecords {
  /** The stored record; throws when it is missing or unreadable. */
  readAccount(id: string): unknown;
  hasAccount(id: string): boolean;
  /** Atomically replaces the record. */
  writeAccount(id: string, record: unknown): void;
  /** Removing an absent record succeeds. */
  deleteAccount(id: string): void;
  /** Hides the record until `commit()` discards it or `restore()` puts it back. */
  detachAccount(id: string): { restore(): void; commit(): void };
  /** The stored Host token record text, or undefined when none exists. */
  readHostToken(hostId: string): string | undefined;
  /** Creates the Host token record; fails if the runtime cannot store it. */
  writeHostToken(hostId: string, text: string): void;
  /** Every stored Host token record text. */
  hostTokens(): Iterable<string>;
  /** Bytes of an operator-owned external credential file; throws when unavailable or unsupported. */
  readExternalFile(path: string): Uint8Array;
}

export interface AccountPoolSettings {
  readonly ownerActor?: string | null;
  readonly now?: () => number;
  readonly switchThreshold?: number;
  readonly affinityIdleTtlMs?: number;
  readonly maxAffinityBindings?: number;
  /** A fenced successor must inspect the exact source state before any expiry cleanup. */
  readonly preserveAffinity?: boolean;
}

/** Validated before any storage is opened, so invalid settings never create a database. */
export function accountPoolSettings(options: AccountPoolSettings) {
  const settings = {
    ownerActor: options.ownerActor == null ? null : requiredText(options.ownerActor, "Human owner"),
    now: options.now ?? Date.now,
    switchThreshold: options.switchThreshold ?? 0.98,
    affinityIdleTtlMs: options.affinityIdleTtlMs ?? 30 * 60 * 1_000,
    maxAffinityBindings: options.maxAffinityBindings ?? 4_096,
    preserveAffinity: options.preserveAffinity === true,
  };
  if (!(settings.switchThreshold > 0 && settings.switchThreshold <= 1))
    throw new RangeError("Invalid switch threshold");
  if (!Number.isSafeInteger(settings.affinityIdleTtlMs) || settings.affinityIdleTtlMs <= 0)
    throw new RangeError("Invalid affinity idle TTL");
  if (!Number.isSafeInteger(settings.maxAffinityBindings) || settings.maxAffinityBindings <= 0)
    throw new RangeError("Invalid affinity binding limit");
  return settings;
}

/** Storage handed to the account pool by the owner that opened and migrated it. */
export interface AccountPoolStorage {
  readonly database: SqlDatabase;
  readonly credentials: AccountCredentialRecords;
  /** Releases the owner's storage; the pool never closes what it did not open. */
  close(): void;
}

function readExternalCodexAuth(
  credentials: AccountCredentialRecords,
  reference: CodexAuthFileReference,
  expectedAccountId?: string,
): ReturnType<typeof parseCodexAuthFile> {
  let text: string;
  try {
    text = new TextDecoder().decode(credentials.readExternalFile(reference.path));
  } catch {
    throw new Error(EXTERNAL_CODEX_REAUTH_MESSAGE);
  }
  return parseCodexAuthFile(text, expectedAccountId);
}

/** Account pool domain over runtime-neutral storage; the opener owns PRAGMA policy, migrations and close. */
export class AccountPool {
  // Diagnostic observations share the credential/catalog owner, not a browser
  // or background-job cache. They are intentionally not a credential database.
  private readonly maintenanceViews = new Map<string, CodexAccountMaintenanceView>();
  accountMaintenance(id: string): CodexAccountMaintenanceView | undefined {
    return this.maintenanceViews.get(id);
  }
  observeAccountMaintenance(id: string, view: CodexAccountMaintenanceView): void {
    this.getAccount(id);
    if (this.maintenanceViews.size >= 1024 && !this.maintenanceViews.has(id))
      this.maintenanceViews.delete(this.maintenanceViews.keys().next().value!);
    this.maintenanceViews.set(id, Object.freeze(view));
  }

  private readonly database: SqlDatabase;
  private readonly credentials: AccountCredentialRecords;
  private readonly closeStorage: () => void;
  private readonly ownerActor: string | null;
  // Local record ownership changes only through this exclusive store. Listing
  // consumes this projection without rereading credential files on every poll.
  private readonly credentialSources = new Map<string, AccountPoolAccountSummary["credentialSource"]>();
  // For an external credential rejected in this process: the shared file's
  // digest at that moment (null when it was unreadable). A rejection lifts as
  // soon as the file holds a different valid credential, e.g. after `codex
  // login` or when a briefly missing file returns. An unchanged file stays
  // rejected, so a token the provider refused is not retried on every request.
  private readonly externalRejections = new Map<string, string | null>();
  private readonly now: () => number;
  private readonly switchThreshold: number;
  private readonly affinityIdleTtlMs: number;
  private readonly maxAffinityBindings: number;

  constructor(storage: AccountPoolStorage, options: AccountPoolSettings = {}) {
    let settings: ReturnType<typeof accountPoolSettings>;
    try {
      settings = accountPoolSettings(options);
    } catch (error) {
      storage.close();
      throw error;
    }
    this.database = storage.database;
    this.credentials = storage.credentials;
    this.closeStorage = () => storage.close();
    this.ownerActor = settings.ownerActor;
    this.now = settings.now;
    this.switchThreshold = settings.switchThreshold;
    this.affinityIdleTtlMs = settings.affinityIdleTtlMs;
    this.maxAffinityBindings = settings.maxAffinityBindings;
    if (!settings.preserveAffinity) this.pruneAffinity(this.now());
    for (const row of this.database.prepare("SELECT id FROM pool_accounts").all()) {
      this.credentialSources.set(String(row.id), this.readCredentialSource(String(row.id)));
    }
  }

  addAccount(
    input: AccountPoolAccountInput,
    rawSecret: AccountPoolSecret | CodexAuthFileReference,
  ): AccountPoolAccount {
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
    if (reference) readExternalCodexAuth(this.credentials, reference, account.upstreamAccountId);
    else if ((rawSecret as AccountPoolSecret).external) throw new Error("Shared credentials require a file reference");
    const secret = reference ?? parseSecret(rawSecret);
    if (
      this.credentials.hasAccount(account.id) ||
      this.database.prepare("SELECT 1 FROM pool_accounts WHERE id=?").get(account.id)
    ) {
      throw new Error("Account already exists");
    }
    try {
      this.transaction(() => {
        this.database
          .prepare(
            "INSERT INTO pool_accounts (id,provider,label,upstream_account_id,priority,enabled,created_at,allow_credits,owner_actor) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            account.id,
            account.provider,
            account.label,
            account.upstreamAccountId,
            account.priority,
            Number(account.enabled),
            account.createdAt,
            Number(account.allowCredits),
            this.ownerActor,
          );
        this.writeSecret(account.id, secret);
      });
    } catch (error) {
      this.credentials.deleteAccount(account.id);
      throw error;
    }
    this.credentialSources.set(account.id, reference ? "external-file" : "managed");
    return account;
  }

  listAccounts(): AccountPoolAccountSummary[] {
    return this.database
      .prepare("SELECT * FROM pool_accounts WHERE owner_actor IS ? ORDER BY priority, created_at, id")
      .all(this.ownerActor)
      .map((row) => {
        const account = this.accountFromRow(row);
        return {
          id: account.id,
          provider: account.provider,
          label: account.label,
          upstreamAccountId: account.upstreamAccountId,
          priority: account.priority,
          enabled: account.enabled,
          allowCredits: account.allowCredits,
          credentialConfigured: this.credentials.hasAccount(account.id),
          credentialSource: this.credentialSources.get(account.id) ?? null,
        };
      });
  }

  private readCredentialSource(id: string): AccountPoolAccountSummary["credentialSource"] {
    try {
      const value = this.credentials.readAccount(accountId(id));
      if (parseCodexAuthFileReference(value)) return "external-file";
      parseSecret(value);
      return "managed";
    } catch {
      return null;
    }
  }

  listAccountStates(): AccountPoolAccountState[] {
    const now = this.now();
    return this.database
      .prepare(
        `SELECT a.id,a.enabled,a.allow_credits,a.email,a.subscription_type,a.rate_limit_tier,a.last_used_at,a.last_used_host_id,a.reset_credit_count,a.reset_credits_observed_at,
        q.utilization,q.reset_at,q.held_until,q.error,q.observed_at,q.limit_windows_json
       FROM pool_accounts a LEFT JOIN pool_quota q ON q.account_id=a.id
       WHERE a.provider='codex' AND a.owner_actor IS ? ORDER BY a.priority,a.created_at,a.id`,
      )
      .all(this.ownerActor)
      .map((row) => this.accountStateFromRow(row, now));
  }

  getAccount(id: string): AccountPoolAccount {
    const row = this.database
      .prepare("SELECT * FROM pool_accounts WHERE id=? AND owner_actor IS ?")
      .get(accountId(id), this.ownerActor);
    if (!row) throw new Error("Account not found");
    return this.accountFromRow(row);
  }

  readCredential(id: string): AccountPoolSecret {
    this.getAccount(id);
    return this.readSecret(id);
  }

  /** Local credential records must be valid even while an external owner is unavailable. */
  validateCredential(id: string, requireExternal = true): void {
    const account = this.getAccount(id);
    let value: unknown;
    try {
      value = this.credentials.readAccount(accountId(id));
    } catch {
      throw new Error("Account credentials are unavailable");
    }
    const reference = parseCodexAuthFileReference(value);
    if (!reference) parseSecret(value);
    else if (requireExternal) readExternalCodexAuth(this.credentials, reference, account.upstreamAccountId);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.getAccount(id);
    const result = this.database
      .prepare("UPDATE pool_accounts SET enabled=? WHERE id=?")
      .run(Number(enabled), accountId(id));
    if (Number(result.changes) !== 1) throw new Error("Account not found");
  }

  setAllowCredits(id: string, allowCredits: boolean): void {
    this.getAccount(id);
    if (typeof allowCredits !== "boolean") throw new TypeError("Invalid credit policy");
    const result = this.database
      .prepare("UPDATE pool_accounts SET allow_credits=? WHERE id=?")
      .run(Number(allowCredits), accountId(id));
    if (Number(result.changes) !== 1) throw new Error("Account not found");
  }

  replaceCredential(
    id: string,
    rawSecret: AccountPoolSecret,
    options: { preserveAuthorizationError?: boolean } = {},
  ): void {
    const normalizedId = accountId(id);
    this.getAccount(normalizedId);
    if (rawSecret.external || parseCodexAuthFileReference(this.credentials.readAccount(normalizedId))) {
      throw new Error("Shared Codex credentials must be updated by their external owner");
    }
    this.writeSecret(normalizedId, parseSecret(rawSecret));
    this.credentialSources.set(normalizedId, "managed");
    if (!options.preserveAuthorizationError) {
      this.database.prepare("UPDATE pool_quota SET error=NULL,held_until=NULL WHERE account_id=?").run(normalizedId);
    }
  }

  updateSubscriptionMetadata(
    id: string,
    input: {
      readonly email?: string | null;
      readonly subscriptionType?: string | null;
      readonly rateLimitTier?: string | null;
      readonly resetCredits?: { readonly availableCount: number; readonly observedAt: number } | null;
    },
  ): void {
    const normalizedId = accountId(id);
    this.getAccount(normalizedId);
    const current = this.database
      .prepare(
        "SELECT email,subscription_type,rate_limit_tier,reset_credit_count,reset_credits_observed_at FROM pool_accounts WHERE id=?",
      )
      .get(normalizedId);
    if (current === undefined) throw new Error("Account not found");
    if (
      input.resetCredits != null &&
      (!Number.isSafeInteger(input.resetCredits.availableCount) ||
        input.resetCredits.availableCount < 0 ||
        !Number.isSafeInteger(input.resetCredits.observedAt) ||
        input.resetCredits.observedAt < 0)
    )
      throw new TypeError("Invalid reset credit observation");
    this.database
      .prepare(
        "UPDATE pool_accounts SET email=?,subscription_type=?,rate_limit_tier=?,reset_credit_count=?,reset_credits_observed_at=? WHERE id=?",
      )
      .run(
        input.email === undefined ? current.email : nullableText(input.email),
        input.subscriptionType === undefined ? current.subscription_type : nullableText(input.subscriptionType),
        input.rateLimitTier === undefined ? current.rate_limit_tier : nullableText(input.rateLimitTier),
        input.resetCredits === undefined ? current.reset_credit_count : (input.resetCredits?.availableCount ?? null),
        input.resetCredits === undefined ? current.reset_credits_observed_at : (input.resetCredits?.observedAt ?? null),
        normalizedId,
      );
  }

  removeAccount(id: string): void {
    const normalizedId = accountId(id);
    this.getAccount(normalizedId);
    const detached = this.credentials.detachAccount(normalizedId);
    try {
      this.transaction(() => {
        const result = this.database.prepare("DELETE FROM pool_accounts WHERE id=?").run(normalizedId);
        if (Number(result.changes) !== 1) throw new Error("Account not found");
      });
    } catch (error) {
      detached.restore();
      throw error;
    }
    this.credentialSources.delete(normalizedId);
    this.maintenanceViews.delete(normalizedId);
    detached.commit();
  }

  reorder(provider: AccountPoolProvider, orderedIds: readonly string[]): void {
    if (provider !== "codex") throw new TypeError("Invalid provider");
    const expected = this.database
      .prepare("SELECT id FROM pool_accounts WHERE provider=? AND owner_actor IS ? ORDER BY id")
      .all(provider, this.ownerActor)
      .map((row) => String(row.id));
    const normalized = orderedIds.map(accountId);
    if (
      new Set(normalized).size !== normalized.length ||
      normalized.length !== expected.length ||
      normalized.some((id) => !expected.includes(id))
    ) {
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
    const scopedHost =
      this.ownerActor === null
        ? input.hostId
        : createHash("sha256")
            .update(JSON.stringify([this.ownerActor, input.hostId]))
            .digest("hex");
    const providerState = this.ownerActor === null ? provider : JSON.stringify([provider, this.ownerActor]);
    const key = affinityKey(provider, scopedHost, input.affinityId);
    const now = this.now();
    const excluded = input.excludeAccountIds ?? new Set<string>();
    this.pruneAffinity(now);
    const orderedAccounts = this.database
      .prepare(
        `SELECT a.*,q.utilization,q.reset_at,q.held_until,q.error,q.limit_windows_json
       FROM pool_accounts a LEFT JOIN pool_quota q ON q.account_id=a.id
       WHERE a.provider=? AND a.owner_actor IS ? ORDER BY a.priority,a.created_at,a.id`,
      )
      .all(provider, this.ownerActor)
      .map((row) => ({
        account: this.accountFromRow(row),
        utilization: row.utilization == null ? null : Number(row.utilization),
        resetAt: row.reset_at == null ? null : Number(row.reset_at),
        heldUntil: row.held_until == null ? null : Number(row.held_until),
        error: row.error == null ? null : String(row.error),
        limitWindows: parseLimitWindows(row.limit_windows_json),
      }));
    for (const candidate of orderedAccounts) {
      if (
        candidate.error === "authorization-rejected" &&
        candidate.account.enabled &&
        this.recoverExternalCredential(candidate.account.id)
      )
        candidate.error = null;
    }
    const available = orderedAccounts.filter(
      (candidate) =>
        candidate.account.enabled &&
        candidate.error === null &&
        !this.quotaExhausted(candidate, now, candidate.account.allowCredits),
    );
    const availableById = new Map(available.map((candidate) => [candidate.account.id, candidate]));
    const candidates = available.filter(
      (candidate) =>
        !excluded.has(candidate.account.id) && (candidate.heldUntil === null || candidate.heldUntil <= now),
    );
    const boundRow = metadata ? undefined : this.readAffinity(key, now);
    const parentKey = input.parentAffinityId == null ? null : affinityKey(provider, scopedHost, input.parentAffinityId);
    const parentRow = metadata || parentKey === null ? undefined : this.readAffinity(parentKey, now);
    const activeRow = this.database
      .prepare("SELECT account_id FROM pool_active_account WHERE provider=?")
      .get(providerState);
    const boundAccountId = boundRow?.account_id == null ? null : String(boundRow.account_id);
    const bound =
      boundAccountId === null || excluded.has(boundAccountId) ? undefined : availableById.get(boundAccountId);
    const inherited =
      bound === undefined && parentRow?.account_id != null && !excluded.has(String(parentRow.account_id))
        ? availableById.get(String(parentRow.account_id))
        : undefined;
    const activeAccountId = activeRow?.account_id == null ? null : String(activeRow.account_id);
    const active =
      activeAccountId === null ? undefined : candidates.find((candidate) => candidate.account.id === activeAccountId);
    const previousAccountId = [...excluded].at(-1) ?? null;
    const anchorId = previousAccountId ?? boundAccountId ?? activeAccountId;
    const anchorIndex = orderedAccounts.findIndex((candidate) => candidate.account.id === anchorId);
    const rotated = [...orderedAccounts.slice(anchorIndex + 1), ...orderedAccounts.slice(0, anchorIndex + 1)];
    const next = rotated
      .map((candidate) => candidates.find((eligible) => eligible.account.id === candidate.account.id))
      .find((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
    const selected = bound ?? inherited ?? (metadata ? active : undefined) ?? next;
    if (selected === undefined) throw new Error("No eligible account");
    const pinnedAccountId = boundAccountId ?? inherited?.account.id ?? null;
    const keepsAffinity = selected.account.id === pinnedAccountId;
    // Admission, not response completion, owns routing. A durable reservation
    // keeps simultaneous first requests for one Thread on the same account.
    let secret: AccountPoolSecret;
    try {
      secret = this.readSecret(selected.account.id);
    } catch (error) {
      if (this.credentialSources.get(selected.account.id) === "external-file")
        throw new ExternalCodexCredentialError(selected.account.id);
      throw error;
    }
    if (!metadata) {
      this.database
        .prepare(
          "INSERT INTO pool_affinity VALUES(?,?,?) ON CONFLICT(affinity_key) DO UPDATE SET account_id=excluded.account_id,last_used_at=excluded.last_used_at",
        )
        .run(key, selected.account.id, now);
      if (!keepsAffinity) {
        this.database
          .prepare(
            "INSERT INTO pool_active_account VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET account_id=excluded.account_id",
          )
          .run(providerState, selected.account.id);
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
          this.database
            .prepare("UPDATE pool_accounts SET last_used_at=?,last_used_host_id=? WHERE id=?")
            .run(now, input.hostId, selected.account.id);
          this.pruneAffinity(now);
        });
      },
    };
  }

  observeQuota(id: string, observation: AccountPoolQuotaObservation): void {
    const normalizedId = accountId(id);
    this.getAccount(normalizedId);
    if (
      observation.utilization !== null &&
      (!Number.isFinite(observation.utilization) || observation.utilization < 0 || observation.utilization > 1)
    )
      throw new TypeError("Invalid utilization");
    for (const value of [observation.resetAt, observation.heldUntil]) {
      if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0))
        throw new TypeError("Invalid quota timestamp");
    }
    const error = observation.error?.trim() || null;
    const current = this.database
      .prepare("SELECT limit_windows_json FROM pool_quota WHERE account_id=?")
      .get(normalizedId);
    const currentWindows = parseLimitWindows(current?.limit_windows_json);
    const observedSlots = new Set(observation.limitWindows?.map((window) => window.slot) ?? []);
    const limitWindows =
      observation.limitWindows === undefined
        ? currentWindows
        : [
            ...currentWindows.filter((window) => !observedSlots.has(window.slot)),
            ...observation.limitWindows.map((window) => {
              const previous = currentWindows.find((value) => value.slot === window.slot);
              // Successful response headers may omit credits. A real rejection
              // explicitly records false; a later usage refresh replaces the fact.
              return window.creditsAvailable === undefined &&
                window.source === "header" &&
                previous?.creditsAvailable !== undefined
                ? {
                    ...window,
                    creditsAvailable: previous.creditsAvailable,
                    ...(previous.creditsUnlimited === undefined ? {} : { creditsUnlimited: previous.creditsUnlimited }),
                    ...(previous.creditBalance === undefined ? {} : { creditBalance: previous.creditBalance }),
                  }
                : { ...window };
            }),
          ].sort((left, right) => left.slot.localeCompare(right.slot));
    parseLimitWindows(JSON.stringify(limitWindows));
    this.database
      .prepare(
        `INSERT INTO pool_quota (account_id,utilization,reset_at,held_until,error,observed_at,limit_windows_json) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(account_id) DO UPDATE SET utilization=excluded.utilization,reset_at=excluded.reset_at,held_until=excluded.held_until,error=excluded.error,observed_at=excluded.observed_at,limit_windows_json=excluded.limit_windows_json`,
      )
      .run(
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
    const normalizedId = accountId(id);
    if (this.credentialSources.get(normalizedId) === "external-file") {
      this.externalRejections.set(normalizedId, this.externalCredentialDigest(normalizedId));
    }
    this.observeQuota(id, { utilization: null, resetAt: null, error: code });
  }

  /** Called only after provider-accepted authorization, without replacing quota facts. */
  clearAuthorizationError(id: string): void {
    this.getAccount(id);
    this.database
      .prepare("UPDATE pool_quota SET error=NULL WHERE account_id=? AND error='authorization-rejected'")
      .run(accountId(id));
    const checkedAt = this.now();
    logAccountRecovery(id, checkedAt, this.accountMaintenance(id));
    this.observeAccountMaintenance(id, { state: "ok", checkedAt, lastSuccessAt: checkedAt });
  }

  /** A successful external-auth check need not report or replace quota windows. */
  clearExternalAuthorizationError(id: string): void {
    this.getAccount(id);
    const normalizedId = accountId(id);
    if (this.credentialSources.get(normalizedId) !== "external-file") return;
    this.externalRejections.delete(normalizedId);
    this.database
      .prepare("UPDATE pool_quota SET error=NULL WHERE account_id=? AND error='authorization-rejected'")
      .run(normalizedId);
  }

  /** Digest of the shared auth file a reference names, or null when it is unreadable. */
  private externalCredentialDigest(id: string): string | null {
    try {
      const reference = parseCodexAuthFileReference(this.credentials.readAccount(accountId(id)));
      return reference
        ? createHash("sha256").update(this.credentials.readExternalFile(reference.path)).digest("hex")
        : null;
    } catch {
      return null;
    }
  }

  /** Lift a rejection recorded in this process once the shared file holds a different valid credential. */
  private recoverExternalCredential(id: string): boolean {
    if (!this.externalRejections.has(id)) return false;
    const digest = this.externalCredentialDigest(id);
    if (digest === null || digest === this.externalRejections.get(id)) return false;
    try {
      this.readSecret(id);
    } catch {
      return false;
    }
    this.clearExternalAuthorizationError(id);
    return true;
  }

  issueHostToken(hostId: string): string {
    const normalizedHostId = requiredText(hostId, "host id");
    const existing = this.credentials.readHostToken(normalizedHostId);
    if (existing !== undefined) {
      const record = this.parseHostToken(existing);
      if (record.hostId !== normalizedHostId) throw new Error("Host token identity mismatch");
      return record.token;
    }
    const token = randomBytes(32).toString("base64url");
    this.credentials.writeHostToken(normalizedHostId, `${JSON.stringify({ hostId: normalizedHostId, token })}\n`);
    return token;
  }

  authenticateHostToken(token: string, codexBrokerBaseUrl?: string): string | null {
    if (!token || token.length > 4096) return null;
    const presented = Buffer.from(token);
    let matched: string | null = null;
    for (const text of this.credentials.hostTokens()) {
      const record = this.parseHostToken(text);
      const expected = Buffer.from(
        codexBrokerBaseUrl === undefined
          ? record.token
          : createCodexAccountPoolLaunch({ baseUrl: codexBrokerBaseUrl, hostToken: record.token }).auth.accessToken,
      );
      if (expected.length === presented.length && timingSafeEqual(expected, presented)) matched = record.hostId;
    }
    return matched;
  }

  close(): void {
    this.closeStorage();
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
      resetCredits:
        row.reset_credit_count == null || row.reset_credits_observed_at == null
          ? null
          : {
              availableCount: Number(row.reset_credit_count),
              observedAt: Number(row.reset_credits_observed_at),
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

  private quotaExhausted(
    quota: {
      readonly utilization: number | null;
      readonly resetAt: number | null;
      readonly limitWindows: readonly AccountPoolLimitWindow[];
    },
    now: number,
    allowCredits: boolean,
  ): boolean {
    const active = (utilization: number | null, status: string | null, resetAt: number | null) => {
      if (resetAt !== null && resetAt <= now) return false;
      return (utilization !== null && utilization >= this.switchThreshold) || status?.toLowerCase() === "rejected";
    };
    if (quota.limitWindows.length > 0) {
      return quota.limitWindows.some(
        (window) =>
          (!allowCredits || window.creditsAvailable !== true) &&
          active(window.utilization, window.status, window.resetAt),
      );
    }
    return active(quota.utilization, null, quota.resetAt);
  }

  private readAffinity(key: string, now: number): Record<string, unknown> | undefined {
    const row = this.database
      .prepare("SELECT account_id,last_used_at FROM pool_affinity WHERE affinity_key=?")
      .get(key);
    if (row === undefined) return undefined;
    if (Number(row.last_used_at) > now - this.affinityIdleTtlMs) return row;
    this.database.prepare("DELETE FROM pool_affinity WHERE affinity_key=?").run(key);
    return undefined;
  }

  private pruneAffinity(now: number): void {
    this.database.prepare("DELETE FROM pool_affinity WHERE last_used_at<=?").run(now - this.affinityIdleTtlMs);
    this.database
      .prepare(
        `DELETE FROM pool_affinity WHERE affinity_key NOT IN (
        SELECT affinity_key FROM pool_affinity ORDER BY last_used_at DESC,rowid DESC LIMIT ?
      )`,
      )
      .run(this.maxAffinityBindings);
  }

  private parseHostToken(text: string): { hostId: string; token: string } {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid Host token record");
    }
    if (
      typeof value.hostId !== "string" ||
      typeof value.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.token)
    ) {
      throw new Error("Invalid Host token record");
    }
    return { hostId: requiredText(value.hostId, "host id"), token: value.token };
  }

  private readSecret(id: string): AccountPoolSecret {
    let value: unknown;
    try {
      value = this.credentials.readAccount(accountId(id));
    } catch {
      throw new Error("Account credentials are unavailable");
    }
    const reference = parseCodexAuthFileReference(value);
    return reference
      ? readExternalCodexAuth(this.credentials, reference, this.getAccount(id).upstreamAccountId).secret
      : parseSecret(value);
  }

  private writeSecret(id: string, secret: AccountPoolSecret | CodexAuthFileReference): void {
    this.credentials.writeAccount(accountId(id), secret);
  }

  private transaction<T>(action: () => T): T {
    return this.database.transaction(action);
  }
}
