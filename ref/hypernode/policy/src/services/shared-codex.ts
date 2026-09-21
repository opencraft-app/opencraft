import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { HostUserRecord } from "../types/host-policy.ts";
import type {
  SharedCodexActivationResult,
  SharedCodexPort,
  SharedCodexProfile,
} from "../types/shared-codex.ts";
import type { SqlValue } from "../types/storage.ts";

type Dependencies =
  | "accountCatalog"
  | "credential"
  | "modelGateway"
  | "storage"
  | "userDirectory";

interface SharedRow extends Record<string, SqlValue> {
  share_id: string;
  owner_user_id: string;
  owner_username: string;
  owner_profile_id: string;
  display_name: string;
  email: string | null;
  plan_type: string | null;
  published_at_ms: number;
  updated_at_ms: number;
}

function shareId(ownerUserId: string, profileId: string): string {
  return `shared-${crypto.sha256(`${ownerUserId}\0${profileId}`).slice(0, 24)}`;
}

function rowProfile(row: SharedRow): SharedCodexProfile {
  return {
    shareId: row.share_id,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    ownerProfileId: row.owner_profile_id,
    displayName: row.display_name,
    email: row.email,
    planType: row.plan_type,
    publishedAtMs: Number(row.published_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export class SharedCodexService extends Service implements SharedCodexPort {
  static inject = [
    "accountCatalog",
    "credential",
    "modelGateway",
    "storage",
    "userDirectory",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private readonly fallback = new Map<string, SharedCodexProfile>();
  private readonly fallbackActivations = new Map<string, string>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "sharedCodex");
    this.ensureSchema();
    ctx.effect(() => ctx.modelGateway.attachCodexFallbackSource({
      available: () => this.list().length > 0,
    }));
    ctx.effect(() => ctx.credential.attachCodexFallbackSource({
      ensureActiveForUser: (userId) => this.ensureActiveForUser(userId),
    }));
    ctx.effect(() => ctx.accountCatalog.onBeforeProfileActivated((user) => {
      const shared = this.activeForUser(user.id);
      if (shared) this.syncConsumerCredential(shared, user);
    }));
    ctx.effect(() => ctx.accountCatalog.onProfileActivated((user) => {
      this.deleteActivation(user.id);
    }));
  }

  private ensureSchema(): void {
    const sql = this.ctx.storage.sql;
    if (!this.ctx.storage.available || sql === null) return;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS do_shared_codex_profiles (
        share_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        owner_username TEXT NOT NULL,
        owner_profile_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        email TEXT,
        plan_type TEXT,
        published_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(owner_user_id, owner_profile_id)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS do_shared_codex_activations (
        user_id TEXT PRIMARY KEY,
        share_id TEXT NOT NULL,
        activated_at_ms INTEGER NOT NULL
      )
    `);
  }

  private currentUser(connection: AppServerConnection): HostUserRecord {
    const userId = connection.identity?.id;
    const user = userId ? this.ctx.userDirectory.find(userId) : null;
    if (!user) throw new Error("the current SSH user is not registered");
    return user;
  }

  list(): SharedCodexProfile[] {
    const sql = this.ctx.storage.sql;
    if (!this.ctx.storage.available || sql === null) {
      return [...this.fallback.values()].sort((a, b) =>
        a.publishedAtMs - b.publishedAtMs || a.shareId.localeCompare(b.shareId));
    }
    return sql.exec<SharedRow>(`
      SELECT share_id, owner_user_id, owner_username, owner_profile_id,
             display_name, email, plan_type, published_at_ms, updated_at_ms
      FROM do_shared_codex_profiles
      ORDER BY published_at_ms, share_id
    `).toArray().map(rowProfile);
  }

  shareForOwnerProfile(ownerUserId: string, profileId: string): SharedCodexProfile | null {
    return this.list().find((share) =>
      share.ownerUserId === ownerUserId && share.ownerProfileId === profileId) ?? null;
  }

  activeForUser(userId: string | null | undefined): SharedCodexProfile | null {
    const user = userId ? this.ctx.userDirectory.find(userId) : null;
    if (!user) return null;
    const activeShareId = hostIdentity.readActiveCodexShare(user.username);
    if (!activeShareId) return null;
    return this.list().find((share) => share.shareId === activeShareId) ?? null;
  }

  ensureActiveForUser(userId: string | null | undefined): SharedCodexProfile | null {
    const consumer = userId ? this.ctx.userDirectory.find(userId) : null;
    if (!consumer) return null;
    const previous = this.activeForUser(consumer.id);
    const shared = previous ?? this.list()[0] ?? null;
    if (!shared) return null;
    this.materialize(consumer, shared, false);
    if (!previous) {
      console.info(
        `[shared-codex] auto-materialized share=${shared.shareId} consumer=${consumer.id}`,
      );
    }
    return shared;
  }

  publish(connection: AppServerConnection, profileId: string): SharedCodexProfile {
    const user = this.currentUser(connection);
    const profile = this.ctx.accountCatalog.profilesForUser(user)
      .find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error("only one of your own Codex profiles can be published");
    const previous = this.shareForOwnerProfile(user.id, profile.id);
    const now = Date.now();
    const shared: SharedCodexProfile = {
      shareId: previous?.shareId ?? shareId(user.id, profile.id),
      ownerUserId: user.id,
      ownerUsername: user.username,
      ownerProfileId: profile.id,
      displayName: profile.name,
      email: profile.email,
      planType: profile.planType,
      publishedAtMs: previous?.publishedAtMs ?? now,
      updatedAtMs: now,
    };
    const sql = this.ctx.storage.sql;
    if (this.ctx.storage.available && sql !== null) {
      sql.exec(`
        INSERT INTO do_shared_codex_profiles(
          share_id, owner_user_id, owner_username, owner_profile_id,
          display_name, email, plan_type, published_at_ms, updated_at_ms
        ) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_user_id, owner_profile_id) DO UPDATE SET
          display_name = excluded.display_name,
          email = excluded.email,
          plan_type = excluded.plan_type,
          updated_at_ms = excluded.updated_at_ms
      `, shared.shareId, shared.ownerUserId, shared.ownerUsername, shared.ownerProfileId,
      shared.displayName, shared.email, shared.planType, shared.publishedAtMs, shared.updatedAtMs);
    } else {
      this.fallback.set(shared.shareId, shared);
    }
    return shared;
  }

  unpublish(connection: AppServerConnection, shareIdValue: string): boolean {
    const user = this.currentUser(connection);
    const shared = this.list().find((candidate) => candidate.shareId === shareIdValue);
    if (!shared) return false;
    if (shared.ownerUserId !== user.id) {
      throw new Error("only the publisher can withdraw a shared Codex profile");
    }
    this.restoreConsumers(shared);
    const sql = this.ctx.storage.sql;
    if (this.ctx.storage.available && sql !== null) {
      sql.exec("DELETE FROM do_shared_codex_activations WHERE share_id = ?", shared.shareId);
      sql.exec("DELETE FROM do_shared_codex_profiles WHERE share_id = ?", shared.shareId);
    } else {
      for (const [userId, activeShareId] of this.fallbackActivations) {
        if (activeShareId === shared.shareId) this.fallbackActivations.delete(userId);
      }
      this.fallback.delete(shared.shareId);
    }
    return true;
  }

  activate(connection: AppServerConnection, shareIdValue: string): SharedCodexActivationResult {
    const consumer = this.currentUser(connection);
    const shared = this.list().find((candidate) => candidate.shareId === shareIdValue);
    if (!shared) throw new Error("the shared Codex profile is no longer available");
    return this.materialize(consumer, shared, true);
  }

  private materialize(
    consumer: HostUserRecord,
    shared: SharedCodexProfile,
    selectSubscription: boolean,
  ): SharedCodexActivationResult {
    const previous = this.activeForUser(consumer.id);
    if (previous && previous.shareId !== shared.shareId) {
      this.syncConsumerCredential(previous, consumer);
      this.deleteActivation(consumer.id);
    }
    const installationId = hostIdentity.activateSharedCodexAuthProfile(
      shared.ownerUsername,
      shared.ownerProfileId,
      consumer.username,
      shared.shareId,
    );
    this.ctx.userDirectory.setInstallationId(consumer.id, installationId);
    this.ctx.userDirectory.setCodexAccount(consumer.id, {
      type: "chatgpt",
      email: shared.email,
      planType: shared.planType,
    });
    const sql = this.ctx.storage.sql;
    if (this.ctx.storage.available && sql !== null) {
      sql.exec(`
        INSERT INTO do_shared_codex_activations(user_id, share_id, activated_at_ms)
        VALUES(?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET
          share_id = excluded.share_id,
          activated_at_ms = excluded.activated_at_ms
      `, consumer.id, shared.shareId, Date.now());
    } else {
      this.fallbackActivations.set(consumer.id, shared.shareId);
    }
    const runtimeRefresh = selectSubscription
      ? this.ctx.modelGateway.useSubscriptionForUser(consumer, "default").runtimeRefresh
      : { retired: 0, deferred: 0 };
    return { share: shared, runtimeRefresh };
  }

  private consumerIds(shareIdValue: string): string[] {
    const sql = this.ctx.storage.sql;
    if (!this.ctx.storage.available || sql === null) {
      return [...this.fallbackActivations]
        .filter(([, activeShareId]) => activeShareId === shareIdValue)
        .map(([userId]) => userId);
    }
    return sql.exec<{ user_id: string }>(`
      SELECT user_id FROM do_shared_codex_activations WHERE share_id = ?
    `, shareIdValue).toArray().map((row) => row.user_id);
  }

  private restoreConsumers(shared: SharedCodexProfile): void {
    for (const userId of this.consumerIds(shared.shareId)) {
      this.restoreConsumer(shared, userId);
    }
  }

  private restoreConsumer(shared: SharedCodexProfile, userId: string): void {
    const consumer = this.ctx.userDirectory.find(userId);
    if (!consumer || hostIdentity.readActiveCodexShare(consumer.username) !== shared.shareId) {
      return;
    }
    const ownProfile = this.ctx.accountCatalog.profilesForUser(consumer)[0] ?? null;
    if (ownProfile) {
      this.ctx.accountCatalog.activateProfile(consumer, ownProfile.id);
      this.ctx.modelGateway.useSubscriptionForUser(consumer, ownProfile.id);
    } else {
      hostIdentity.clearActiveCodexAuth(consumer.username);
      this.ctx.userDirectory.setCodexAccount(consumer.id, null);
      this.ctx.modelGateway.useSubscriptionForUser(consumer, "default");
    }
  }

  private syncConsumerCredential(shared: SharedCodexProfile, consumer: HostUserRecord): void {
    try {
      hostIdentity.syncSharedCodexAuthProfile(
        consumer.username,
        shared.ownerUsername,
        shared.ownerProfileId,
      );
    } catch (error) {
      console.warn(
        `[shared-codex] refreshed credential was not committed share=${shared.shareId} ` +
        `consumer=${consumer.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private deleteActivation(userId: string): void {
    const sql = this.ctx.storage.sql;
    if (this.ctx.storage.available && sql !== null) {
      sql.exec("DELETE FROM do_shared_codex_activations WHERE user_id = ?", userId);
    } else {
      this.fallbackActivations.delete(userId);
    }
  }
}
