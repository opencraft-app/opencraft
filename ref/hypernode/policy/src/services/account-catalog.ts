import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  CodexAccountProfile,
  CodexAccountRecord,
} from "../types/account-config.ts";
import type {
  AppServerConnection,
  AppServerParams,
} from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { HostUserRecord } from "../types/host-policy.ts";
import type { SqlValue } from "../types/storage.ts";

type Dependencies =
  | "appServer"
  | "codexAccountBinding"
  | "modelGateway"
  | "remoteControl"
  | "storage"
  | "userDirectory";

interface StoredCodexProfile {
  userId: string;
  profileId: string;
  accountIdentity: string;
  displayName: string;
  email: string | null;
  planType: string | null;
  credentialRef: string;
  createdAtMs: number;
  updatedAtMs: number;
}

interface StoredCodexProfileRow extends Record<string, SqlValue> {
  user_id: string;
  profile_id: string;
  account_identity: string;
  display_name: string;
  email: string | null;
  plan_type: string | null;
  credential_ref: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface AccountCatalogEntry {
  userId?: string;
  username: string;
  installationId?: string | null;
  bindingState?: string;
  authMode: string | null;
  email: string | null;
  planType: string | null;
  boundAtMs?: number | null;
  lastVerifiedAtMs?: number | null;
  remoteControlStatus: string;
  profiles?: readonly CodexAccountProfile[];
  activeProfileId?: string | null;
}

interface ParsedCodexAuth {
  auth_mode?: string;
  tokens?: {
    account_id?: string;
  };
}

interface CaptureOptions {
  ignoreMissing?: boolean;
}

function utf8Decode(bytes: ArrayLike<number>): string {
  let text = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++] ?? 0;
    if (first < 0x80) text += String.fromCodePoint(first);
    else if ((first & 0xe0) === 0xc0) {
      text += String.fromCodePoint(
        ((first & 31) << 6) | ((bytes[index++] ?? 0) & 63),
      );
    } else if ((first & 0xf0) === 0xe0) {
      text += String.fromCodePoint(
        ((first & 15) << 12) |
        (((bytes[index++] ?? 0) & 63) << 6) |
        ((bytes[index++] ?? 0) & 63),
      );
    } else {
      text += String.fromCodePoint(
        ((first & 7) << 18) |
        (((bytes[index++] ?? 0) & 63) << 12) |
        (((bytes[index++] ?? 0) & 63) << 6) |
        ((bytes[index++] ?? 0) & 63),
      );
    }
  }
  return text;
}

function parsedCodexAuth(value: unknown): ParsedCodexAuth | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as ParsedCodexAuth;
}

function activeCodexAccountIdentity(user: HostUserRecord): string | null {
  try {
    const auth = parsedCodexAuth(JSON.parse(utf8Decode(hostIdentity.readCodexAuth(user.username))));
    const accountId = String(auth?.tokens?.account_id ?? "").trim();
    return auth?.auth_mode === "chatgpt" && accountId ? `chatgpt:${accountId}` : null;
  } catch {
    return null;
  }
}

function subscriptionProfileId(accountIdentity: string): string {
  return `subscription-${crypto.sha256(accountIdentity).slice(0, 20)}`;
}

function visibleUsers(
  current: HostUserRecord | null,
  users: readonly HostUserRecord[],
): HostUserRecord[] {
  if (!current) return [];
  return current.role === "administrator"
    ? [...users]
    : users.filter((user) => user.id === current.id);
}

export function renderAccountCatalog(accounts: readonly AccountCatalogEntry[]): string {
  if (accounts.length === 0) return "当前没有可见的 Codex 账户。";
  return [
    "Hypernode Codex 账户：",
    ...accounts.map((account) => {
      const identity = account.email || account.authMode || "尚未绑定";
      const plan = account.planType ? ` · ${account.planType}` : "";
      const header = `- ${account.username} · ${identity}${plan} · 手机控制 ${account.remoteControlStatus}`;
      const profiles = (account.profiles ?? []).map((profile) =>
        `  - ${profile.name}${profile.planType ? ` · ${profile.planType}` : ""} · ${profile.id}`);
      return [header, ...profiles].join("\n");
    }),
    "",
    "使用 Codex Account 技能，可以为当前 SSH 用户新增或恢复账户绑定。",
  ].join("\n");
}

export class AccountCatalogService extends Service {
  static inject = [
    "appServer",
    "codexAccountBinding",
    "modelGateway",
    "remoteControl",
    "storage",
    "userDirectory",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private readonly fallbackProfiles = new Map<string, StoredCodexProfile[]>();
  private readonly beforeProfileActivated = new Set<(user: HostUserRecord) => void>();
  private readonly profileActivated = new Set<(user: HostUserRecord) => void>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "accountCatalog");
    this.ensureSchema();
    ctx.effect(() => ctx.modelGateway.attachCodexProfileSource({
      list: (user) => this.profilesForUser(user),
      activate: (user, profileId) => this.activateProfile(user, profileId),
    }));
    ctx.effect(() => ctx.codexAccountBinding.onBound((userId, account) => {
      if (account.type !== "chatgpt") return;
      const user = ctx.userDirectory.find(userId);
      if (!user) return;
      const profile = this.captureCurrentProfile(user, account);
      if (profile) {
        this.ctx.modelGateway.markCodexProfileActive(user, profile.profileId);
        this.emitProfileActivated(user);
      }
    }));
    ctx.effect(() => ctx.appServer.register(
      "hypernode/accounts/list",
      (_params, connection) => ({ accounts: this.list(connection) }),
    ));
    ctx.effect(() => ctx.appServer.register(
      "hypernode/accounts/add",
      (params, connection) => ({
        message: this.add(connection, stringParam(params, "threadId")),
      }),
    ));
    ctx.effect(() => ctx.appServer.register(
      "hypernode/accountProfiles/list",
      (_params, connection) => ({
        profiles: this.profilesForUser(this.currentUser(connection)),
      }),
    ));
    ctx.effect(() => ctx.appServer.register(
      "hypernode/accountProfiles/select",
      (params, connection) => this.selectProfile(connection, params),
    ));
    // The persisted execution-profile selection is authoritative across a
    // policy/host restart.  The active auth.json is only a materialized view
    // and may be absent after Workspace recovery, so restore it before the
    // first Codex Runtime is admitted.
    this.reconcileSelectedProfiles();
  }

  reconcileSelectedProfiles(): number {
    let restored = 0;
    for (const user of this.ctx.userDirectory.list()) {
      const selection = this.ctx.modelGateway.selectionForUser(user.id);
      if (selection.kind !== "codex" || selection.profileId === "default") continue;
      // A shared subscription has its own durable active marker and must not
      // be replaced by the consumer's previously selected personal profile.
      if (hostIdentity.readActiveCodexShare?.(user.username)) continue;
      const profile = this.rawProfilesForUser(user.id)
        .find((candidate) => candidate.profileId === selection.profileId);
      if (!profile || activeCodexAccountIdentity(user) === profile.accountIdentity) continue;
      try {
        this.activateProfile(user, profile.profileId);
        restored += 1;
        console.info(
          `[account-catalog] restored selected Codex profile user=${user.id} ` +
          `profile=${profile.profileId}`,
        );
      } catch (error) {
        console.warn(
          `[account-catalog] failed to restore selected Codex profile user=${user.id} ` +
          `profile=${profile.profileId}: ${String(error)}`,
        );
      }
    }
    return restored;
  }

  onBeforeProfileActivated(listener: (user: HostUserRecord) => void): () => boolean {
    this.beforeProfileActivated.add(listener);
    return () => this.beforeProfileActivated.delete(listener);
  }

  onProfileActivated(listener: (user: HostUserRecord) => void): () => boolean {
    this.profileActivated.add(listener);
    return () => this.profileActivated.delete(listener);
  }

  private emitBeforeProfileActivated(user: HostUserRecord): void {
    for (const listener of this.beforeProfileActivated) listener(user);
  }

  private emitProfileActivated(user: HostUserRecord): void {
    for (const listener of this.profileActivated) listener(user);
  }

  ensureSchema(): void {
    const sql = this.ctx.storage.sql;
    if (!this.ctx.storage.available || sql === null) return;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS do_codex_account_profiles (
        user_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        account_identity TEXT NOT NULL,
        display_name TEXT NOT NULL,
        email TEXT,
        plan_type TEXT,
        credential_ref TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(user_id, profile_id),
        UNIQUE(user_id, account_identity)
      )
    `);
  }

  currentUser(connection: AppServerConnection): HostUserRecord | null {
    const userId = connection.identity?.id;
    return userId ? this.ctx.userDirectory.find(userId) : null;
  }

  requiredCurrentUser(connection: AppServerConnection): HostUserRecord {
    const user = this.currentUser(connection);
    if (!user) throw new Error("the current SSH user is not registered");
    return user;
  }

  list(connection: AppServerConnection): AccountCatalogEntry[] {
    const current = this.currentUser(connection);
    return visibleUsers(current, this.ctx.userDirectory.list()).map((user) => {
      const selection = this.ctx.modelGateway.selectionForUser(user.id);
      const profiles = this.profilesForUser(user);
      const activeAccountIdentity = activeCodexAccountIdentity(user);
      const activeCredentialProfileId = profiles.find((profile) =>
        profile.accountIdentity === activeAccountIdentity)?.id ?? null;
      return {
        userId: user.id,
        username: user.username,
        installationId: user.installationId ?? null,
        bindingState: user.codexBindingState ?? "unbound",
        authMode: user.codexAuthMode ?? null,
        email: user.codexAccountEmail ?? null,
        planType: user.codexPlanType ?? null,
        boundAtMs: user.codexBoundAtMs ?? null,
        lastVerifiedAtMs: user.codexLastVerifiedAtMs ?? null,
        remoteControlStatus: this.ctx.remoteControl.statusForUser(user.id)?.status ?? "disabled",
        profiles,
        activeProfileId: activeCredentialProfileId ?? (
          selection.kind === "codex" ? selection.profileId : null
        ),
      };
    });
  }

  rawProfilesForUser(userId: string): StoredCodexProfile[] {
    const sql = this.ctx.storage.sql;
    if (!this.ctx.storage.available || sql === null) {
      return [...(this.fallbackProfiles.get(userId) ?? [])];
    }
    return sql.exec<StoredCodexProfileRow>(`
      SELECT user_id, profile_id, account_identity, display_name, email, plan_type,
             credential_ref, created_at_ms, updated_at_ms
      FROM do_codex_account_profiles WHERE user_id = ?
      ORDER BY created_at_ms, profile_id
    `, userId).toArray().map((row) => ({
      userId: row.user_id,
      profileId: row.profile_id,
      accountIdentity: row.account_identity,
      displayName: row.display_name,
      email: row.email,
      planType: row.plan_type,
      credentialRef: row.credential_ref,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
    }));
  }

  profilesForUser(user: HostUserRecord | null): CodexAccountProfile[] {
    if (!user) return [];
    const legacyInstallationId = user.installationId?.trim();
    const current = this.captureCurrentProfile(user, null, { ignoreMissing: true });
    const selection = this.ctx.modelGateway.selectionForUser(user.id);
    if (current && selection.kind === "codex" && selection.profileId === "default") {
      this.ctx.modelGateway.markCodexProfileActive(user, current.profileId);
    }
    const profiles = this.rawProfilesForUser(user.id);
    if (legacyInstallationId) {
      for (const profile of profiles) {
        hostIdentity.ensureCodexAuthProfileInstallation(
          user.username,
          profile.profileId,
          legacyInstallationId,
        );
      }
    }
    return profiles.map((profile) => ({
      id: profile.profileId,
      name: profile.displayName,
      email: profile.email,
      planType: profile.planType,
      accountIdentity: profile.accountIdentity,
    }));
  }

  codexProfileForIdentity(
    user: HostUserRecord | null,
    accountIdentity: string | null,
  ): CodexAccountProfile | null {
    if (!user || !accountIdentity) return null;
    const profile = this.rawProfilesForUser(user.id)
      .find((candidate) => candidate.accountIdentity === accountIdentity);
    return profile ? {
      id: profile.profileId,
      name: profile.displayName,
      email: profile.email,
      planType: profile.planType,
      accountIdentity: profile.accountIdentity,
    } : null;
  }

  captureCurrentProfile(
    user: HostUserRecord,
    account: CodexAccountRecord | null = null,
    options: CaptureOptions = {},
  ): StoredCodexProfile | null {
    if (hostIdentity.readActiveCodexShare?.(user.username)) return null;
    let auth: ParsedCodexAuth | null;
    try {
      auth = parsedCodexAuth(JSON.parse(utf8Decode(hostIdentity.readCodexAuth(user.username))));
    } catch (error) {
      if (options.ignoreMissing) return null;
      throw error;
    }
    const accountId = String(auth?.tokens?.account_id ?? "").trim();
    if (auth?.auth_mode !== "chatgpt" || !accountId) {
      if (options.ignoreMissing) return null;
      throw new Error("the active Codex credential is not a ChatGPT subscription");
    }
    const accountIdentity = `chatgpt:${accountId}`;
    const profileId = subscriptionProfileId(accountIdentity);
    const now = Date.now();
    const previous = this.rawProfilesForUser(user.id)
      .find((profile) => profile.accountIdentity === accountIdentity);
    const email = account?.email ?? previous?.email ?? user.codexAccountEmail ?? null;
    const planType = account?.planType ?? previous?.planType ?? user.codexPlanType ?? null;
    const displayName = email ||
      (planType ? `ChatGPT ${planType}` : `ChatGPT ${accountId.slice(0, 8)}`);
    const credentialRef = hostIdentity.saveCodexAuthProfile(user.username, profileId);
    const installationId = hostIdentity.readCodexInstallationId(user.username);
    this.ctx.userDirectory.setInstallationId(user.id, installationId);
    const record: StoredCodexProfile = {
      userId: user.id,
      profileId,
      accountIdentity,
      displayName,
      email,
      planType,
      credentialRef,
      createdAtMs: previous?.createdAtMs ?? now,
      updatedAtMs: now,
    };
    const sql = this.ctx.storage.sql;
    if (this.ctx.storage.available && sql !== null) {
      sql.exec(`
        INSERT INTO do_codex_account_profiles(
          user_id, profile_id, account_identity, display_name, email, plan_type,
          credential_ref, created_at_ms, updated_at_ms
        ) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id, profile_id) DO UPDATE SET
          display_name = excluded.display_name,
          email = excluded.email,
          plan_type = excluded.plan_type,
          credential_ref = excluded.credential_ref,
          updated_at_ms = excluded.updated_at_ms
      `, record.userId, record.profileId, record.accountIdentity, record.displayName,
      record.email, record.planType, record.credentialRef, record.createdAtMs, record.updatedAtMs);
    } else {
      const profiles = this.fallbackProfiles.get(user.id) ?? [];
      const index = profiles.findIndex((profile) => profile.profileId === profileId);
      if (index < 0) profiles.push(record);
      else profiles[index] = record;
      this.fallbackProfiles.set(user.id, profiles);
    }
    return record;
  }

  activateProfile(user: HostUserRecord, profileId: string): StoredCodexProfile {
    const profile = this.rawProfilesForUser(user.id)
      .find((candidate) => candidate.profileId === profileId);
    if (!profile) throw new Error(`unknown Codex subscription profile ${JSON.stringify(profileId)}`);
    this.emitBeforeProfileActivated(user);
    if (user.installationId) {
      hostIdentity.ensureCodexAuthProfileInstallation(
        user.username,
        profileId,
        user.installationId,
      );
    }
    const installationId = hostIdentity.activateCodexAuthProfile(user.username, profileId);
    this.ctx.userDirectory.setInstallationId(user.id, installationId);
    this.ctx.userDirectory.setCodexAccount(user.id, {
      type: "chatgpt",
      email: profile.email,
      planType: profile.planType,
    });
    this.emitProfileActivated(user);
    return profile;
  }

  selectProfile(
    connection: AppServerConnection,
    params: AppServerParams,
  ): { profile: StoredCodexProfile; runtimeRefresh: import("../types/account-config.ts").RuntimeRefreshResult } {
    const user = this.requiredCurrentUser(connection);
    const profileId = stringParam(params, "profileId") ?? "";
    if (!profileId) throw new Error("profileId is required");
    const profile = this.activateProfile(user, profileId);
    const switched = this.ctx.modelGateway.useSubscriptionForUser(user, profileId);
    return { profile, runtimeRefresh: switched.runtimeRefresh };
  }

  render(connection: AppServerConnection): string {
    return renderAccountCatalog(this.list(connection));
  }

  add(connection: AppServerConnection, threadId: string | null = null): string {
    if (!threadId) throw new Error("adding a Codex account requires a management thread id");
    const user = this.requiredCurrentUser(connection);
    this.emitBeforeProfileActivated(user);
    const profiles = this.profilesForUser(user);
    const selection = this.ctx.modelGateway.selectionForUser(user.id);
    this.ctx.modelGateway.useSubscriptionForUser(
      user,
      selection.kind === "codex" ? selection.profileId : "default",
    );
    return this.ctx.codexAccountBinding.begin(
      connection,
      threadId,
      { forceNew: profiles.length > 0 },
    );
  }
}

function stringParam(params: AppServerParams, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
