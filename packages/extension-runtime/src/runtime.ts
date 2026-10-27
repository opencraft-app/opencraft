import type { ExtensionLocalPreferenceStore } from "@opencraft/extension-contract";
import { Context, type Fiber } from "@deepseek-ai/cordis";
import {
  parseExtensionManifestV1,
  assertExtensionCompatibility,
  type BotContribution,
  type AnnouncementContribution,
  type CommandContribution,
  type CommandHandler,
  type ExtensionActivationIdentity,
  type ExtensionDisposable,
  type ExtensionJson,
  type ExtensionManifestV1,
  type ExtensionPlatform,
  type NavigationContribution,
  type SettingsPageContribution,
  type SettingsSchemaContribution,
  type SidebarCatalogContribution,
  type ThemeContribution,
  type OpenCraftExtensionApiV1,
  type ViewContribution,
  type WorkbenchSurfaceContribution,
} from "@opencraft/extension-contract";

import { AnnouncementCenter } from "./announcement-center";
import type { ExtensionArtifact } from "./artifact";
import { extensionTimeout, withExtensionDeadline } from "./deadline";
import { createScopedExtensionStorage } from "./scoped-storage";
import type { ExtensionPersistence } from "./persistence";

import {
  ExtensionContributionStore,
  type PublicContributionBatch,
} from "./contribution-store";

export interface TrustedExtensionDefinition {
  readonly artifact?: ExtensionArtifact;
  readonly manifest: ExtensionManifestV1;
  activate(api: TrustedExtensionApiV1): void | ExtensionDisposable | Promise<void | ExtensionDisposable>;
}

export interface PreparedInternalContribution {
  /** Prepare is side-effect free; commit transfers resources through its disposer. */
  commit(): ExtensionDisposable | Promise<ExtensionDisposable>;
}

export interface InternalContributionAdapter {
  prepare(
    owner: ExtensionActivationIdentity,
    value: unknown,
  ): PreparedInternalContribution | Promise<PreparedInternalContribution>;
}

export interface TrustedExtensionApiV1 extends OpenCraftExtensionApiV1 {
  /**
   * Host-only seam for first-party extensions. It is intentionally absent
   * from extension-contract and must not be treated as a public ecosystem API.
   */
  readonly internal: {
    register(channel: string, value: unknown): ExtensionDisposable;
  };
}

export type ExtensionActivationStatus = "activating" | "active" | "deactivating" | "failed";

export interface ExtensionRuntimeDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly status: ExtensionActivationStatus;
  readonly generation: number;
  readonly activationId: string;
  readonly error?: string;
}

export interface ExtensionRuntimeSnapshot {
  readonly revision: number;
  readonly extensions: readonly ExtensionRuntimeDescriptor[];
}

export interface ExtensionSupervisorOptions {
  readonly persistence?: ExtensionPersistence;
  readonly localPreferences?: (extensionId: string, accountKey: string) => ExtensionLocalPreferenceStore;
  readonly resolveHostPersistence?: (hostId: string, signal: AbortSignal) => Promise<ExtensionPersistence>;
  readonly context?: Context;
  readonly platform: ExtensionPlatform;
  readonly internalContributions?: Readonly<Record<string, InternalContributionAdapter>>;
  readonly createActivationId?: () => string;
  readonly activationTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
}

interface ActivationToken {
  readonly controller: AbortController;
  phase: "activating" | "active" | "deactivating" | "disposed";
  readonly identity: ExtensionActivationIdentity;
}

interface PublicStageEntry {
  readonly kind:
    | "command"
    | "settings-schema"
    | "view"
    | "navigation"
    | "sidebar-catalog"
    | "settings-page"
    | "workbench-surface"
    | "theme"
    | "bot";
  readonly id: string;
  readonly contribution:
    | CommandContribution
    | SettingsSchemaContribution
    | ViewContribution
    | NavigationContribution
    | SidebarCatalogContribution
    | SettingsPageContribution
    | WorkbenchSurfaceContribution
    | ThemeContribution
    | BotContribution;
  readonly handler?: CommandHandler;
  disposed: boolean;
  committed: boolean;
}

interface InternalStageEntry {
  readonly channel: string;
  readonly value: unknown;
  disposed: boolean;
  committed: boolean;
  disposeCommitted?: ExtensionDisposable;
}

interface SubscriptionEntry {
  readonly disposable: ExtensionDisposable;
  disposed: boolean;
}

interface ActivationOwner {
  readonly token: ActivationToken;
  readonly transaction: ActivationTransaction;
}

interface ActiveRecord extends ActivationOwner {
  readonly definition: TrustedExtensionDefinition;
  readonly manifest: ExtensionManifestV1;
  readonly identity: ExtensionActivationIdentity;
  readonly fiber: Fiber;
}

let fallbackActivationCounter = 0;

function defaultActivationId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === "function") return randomUuid.call(globalThis.crypto);
  fallbackActivationCounter += 1;
  return `activation-${Date.now().toString(36)}-${fallbackActivationCounter.toString(36)}`;
}

async function disposeAllReverse(
  disposables: readonly ExtensionDisposable[],
  message: string,
): Promise<void> {
  const failures: unknown[] = [];
  for (const disposable of [...disposables].reverse()) {
    try {
      await disposable();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, message);
}

export class ExtensionActivationStaleError extends Error {
  readonly code = "OPENCRAFT_EXTENSION_ACTIVATION_STALE";

  constructor(identity: ExtensionActivationIdentity) {
    super(`Extension activation ${identity.activationId} is no longer accepting contributions`);
    this.name = "ExtensionActivationStaleError";
  }
}

class ActivationTransaction {
  readonly publicEntries: PublicStageEntry[] = [];
  readonly internalEntries: InternalStageEntry[] = [];
  readonly subscriptions: SubscriptionEntry[] = [];
  readonly cleanupFailures: unknown[] = [];
  private publicCommitted = false;
  private cleaned = false;
  private invocations = 0;
  private invocationDrain: Promise<void> | undefined;
  private resolveInvocationDrain: (() => void) | undefined;

  readonly api: TrustedExtensionApiV1;

  constructor(
    private readonly token: ActivationToken,
    private readonly contributions: ExtensionContributionStore,
    private readonly announcements: AnnouncementCenter,
    private readonly adapters: Readonly<Record<string, InternalContributionAdapter>>,
    persistence?: ExtensionPersistence,
    resolveHostPersistence?: ExtensionSupervisorOptions["resolveHostPersistence"],
    private readonly cleanupTimeoutMs = 5000,
    private readonly activationTimeoutMs = 15000,
    localPreferences?: ExtensionSupervisorOptions["localPreferences"],
  ) {
    const storage = persistence || resolveHostPersistence ? createScopedExtensionStorage(persistence, token.identity.extensionId,
      () => token.phase === "activating" || token.phase === "active", resolveHostPersistence) : null;
    if (storage) this.subscriptions.push({ disposable: () => storage.dispose(), disposed: false });
    this.api = Object.freeze({
      signal: token.controller.signal,
      storage: storage?.api ?? null,
      localPreferences: localPreferences ? Object.freeze({ forAccount: (accountKey: string) => {
        const assertLive = () => { if (token.phase !== "activating" && token.phase !== "active") throw new Error("Extension preferences activation is stale"); };
        assertLive();
        const store = localPreferences(token.identity.extensionId, accountKey);
        return Object.freeze({
          get: (key: string) => { assertLive(); return store.get(key); },
          set: (key: string, value: import("@opencraft/extension-contract").ExtensionJson) => { assertLive(); store.set(key, value); },
          subscribe: (listener: () => void) => {
            assertLive();
            const remove = store.subscribe(() => { if (token.phase === "activating" || token.phase === "active") listener(); });
            this.subscriptions.push({ disposable: remove, disposed: false }); return remove;
          },
        });
      } }) : null,
      identity: token.identity,
      commands: Object.freeze({
        register: (contribution: CommandContribution, handler: CommandHandler) =>
          this.stagePublic("command", contribution, handler),
      }),
      settings: Object.freeze({
        registerSchema: (contribution: SettingsSchemaContribution) =>
          this.stagePublic("settings-schema", contribution),
        registerPage: (contribution: SettingsPageContribution) =>
          this.stagePublic("settings-page", contribution),
      }),
      views: Object.freeze({
        register: (contribution: ViewContribution) => this.stagePublic("view", contribution),
      }),
      navigation: Object.freeze({
        register: (contribution: NavigationContribution) =>
          this.stagePublic("navigation", contribution),
      }),
      sidebar: Object.freeze({
        registerCatalog: (contribution: SidebarCatalogContribution) =>
          this.stagePublic("sidebar-catalog", contribution),
      }),
      workbench: Object.freeze({
        registerSurface: (contribution: WorkbenchSurfaceContribution) =>
          this.stagePublic("workbench-surface", contribution),
      }),
      themes: Object.freeze({
        register: (contribution: ThemeContribution) => this.stagePublic("theme", contribution),
      }),
      bots: Object.freeze({
        register: (contribution: BotContribution) => this.stagePublic("bot", contribution),
      }),
      window: Object.freeze({
        showAnnouncement: (contribution: AnnouncementContribution) => {
          this.assertActive();
          return this.announcements.show(this.token.identity, contribution);
        },
      }),
      subscriptions: Object.freeze({
        add: (disposable: ExtensionDisposable) => this.stageSubscription(disposable),
      }),
      internal: Object.freeze({
        register: (channel: string, value: unknown) => this.stageInternal(channel, value),
      }),
    });
  }

  async commit(): Promise<void> {
    this.assertActivating();
    const publicBatch: PublicContributionBatch = {
      commands: this.publicEntries
        .filter((entry) => !entry.disposed && entry.kind === "command")
        .map((entry) => ({
          contribution: entry.contribution as CommandContribution,
          handler: (...arguments_) => this.invokeCommand(entry.handler!, arguments_),
        })),
      settingsSchemas: this.publicEntries
        .filter((entry) => !entry.disposed && entry.kind === "settings-schema")
        .map((entry) => entry.contribution as SettingsSchemaContribution),
      views: this.publicEntries
        .filter((entry) => !entry.disposed && entry.kind === "view")
        .map((entry) => entry.contribution as ViewContribution),
      navigation: this.publicEntries
        .filter((entry) => !entry.disposed && entry.kind === "navigation")
        .map((entry) => entry.contribution as NavigationContribution),
      sidebarCatalogs: this.publicEntries
        .filter((entry) => !entry.disposed && entry.kind === "sidebar-catalog")
        .map((entry) => entry.contribution as SidebarCatalogContribution),
      settingsPages: this.publicEntries
        .filter((entry) => !entry.disposed && entry.kind === "settings-page")
        .map((entry) => entry.contribution as SettingsPageContribution),
      workbenchSurfaces: this.publicEntries
        .filter((entry) => !entry.disposed && entry.kind === "workbench-surface")
        .map((entry) => entry.contribution as WorkbenchSurfaceContribution),
      themes: this.publicEntries
        .filter((entry) => !entry.disposed && entry.kind === "theme")
        .map((entry) => entry.contribution as ThemeContribution),
      bots: this.publicEntries
        .filter((entry) => !entry.disposed && entry.kind === "bot")
        .map((entry) => entry.contribution as BotContribution),
    };
    const commitPublic = this.contributions.prepare(this.token.identity, publicBatch);
    const preparedInternal: Array<{
      readonly entry: InternalStageEntry;
      readonly prepared: PreparedInternalContribution;
    }> = [];
    for (const entry of this.internalEntries) {
      if (entry.disposed) continue;
      const adapter = this.adapters[entry.channel];
      if (adapter === undefined) throw new Error(`Unknown internal contribution channel ${entry.channel}`);
      const prepared = await withExtensionDeadline(
        Promise.resolve().then(() => adapter.prepare(this.token.identity, entry.value)),
        `${this.token.identity.extensionId} prepare ${entry.channel}`, this.activationTimeoutMs,
      );
      this.assertActivating();
      preparedInternal.push({ entry, prepared });
    }

    const committedInternal: InternalStageEntry[] = [];
    try {
      for (const { entry, prepared } of preparedInternal) {
        let abandoned = false;
        const committing = Promise.resolve().then(() => prepared.commit());
        void committing.then(async dispose => {
          if (abandoned) await dispose();
        }).catch(() => undefined);
        try {
          entry.disposeCommitted = await withExtensionDeadline(committing,
            `${this.token.identity.extensionId} commit ${entry.channel}`, this.activationTimeoutMs);
        } catch (error) {
          abandoned = true;
          throw error;
        }
        // Own the returned resource before checking a retirement across await.
        entry.committed = true;
        committedInternal.push(entry);
        this.assertActivating();
      }
      commitPublic();
      this.publicCommitted = true;
      for (const entry of this.publicEntries) {
        if (!entry.disposed) entry.committed = true;
      }
    } catch (error) {
      let rollbackError: unknown;
      try {
        await disposeAllReverse(
          committedInternal.flatMap((entry) => entry.disposeCommitted === undefined ? [] : [
            () => withExtensionDeadline(Promise.resolve().then(() => entry.disposeCommitted!()),
              `${this.token.identity.extensionId} rollback ${entry.channel}`, this.cleanupTimeoutMs),
          ]),
          `Failed to roll back internal contributions for ${this.token.identity.extensionId}`,
        );
      } catch (cause) {
        rollbackError = cause;
        this.cleanupFailures.push(cause);
      } finally {
        for (const entry of committedInternal) entry.disposed = true;
      }
      if (rollbackError !== undefined) {
        throw new AggregateError([error, rollbackError], "Extension contribution commit and rollback failed");
      }
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    const failures: unknown[] = [];
    if (this.publicCommitted) {
      try {
        this.contributions.removeOwner(this.token.identity);
      } catch (error) {
        failures.push(error);
      }
    }
    // Imperative windows must be retired before draining command handlers: a
    // handler may be awaiting the user's announcement result.
    this.announcements.dismissOwner(this.token.identity);
    if (this.invocations > 0) {
      this.invocationDrain ??= new Promise<void>((resolve) => {
        this.resolveInvocationDrain = resolve;
      });
      try {
        await withExtensionDeadline(this.invocationDrain, `${this.token.identity.extensionId} command drain`, this.cleanupTimeoutMs);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const entry of [...this.internalEntries].reverse()) {
      if (!entry.committed || entry.disposeCommitted === undefined || entry.disposed) continue;
      entry.disposed = true;
      try {
        await withExtensionDeadline(Promise.resolve().then(() => entry.disposeCommitted!()),
          `${this.token.identity.extensionId} internal cleanup`, this.cleanupTimeoutMs);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const entry of [...this.subscriptions].reverse()) {
      if (entry.disposed) continue;
      entry.disposed = true;
      try {
        await withExtensionDeadline(Promise.resolve().then(() => entry.disposable()),
          `${this.token.identity.extensionId} subscription cleanup`, this.cleanupTimeoutMs);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      this.cleanupFailures.push(...failures);
      throw new AggregateError(failures, `Failed to clean up ${this.token.identity.extensionId}`);
    }
  }

  private stagePublic(
    kind: PublicStageEntry["kind"],
    contribution: PublicStageEntry["contribution"],
    handler?: CommandHandler,
  ): ExtensionDisposable {
    this.assertActivating();
    const entry: PublicStageEntry = {
      kind,
      id: contribution.id,
      contribution,
      ...(handler === undefined ? {} : { handler }),
      disposed: false,
      committed: false,
    };
    this.publicEntries.push(entry);
    return async () => {
      if (entry.disposed) return;
      entry.disposed = true;
      if (entry.committed) this.contributions.remove(this.token.identity, entry.kind, entry.id);
    };
  }

  private stageInternal(channel: string, value: unknown): ExtensionDisposable {
    this.assertActivating();
    if (channel.trim().length === 0) throw new RangeError("Internal contribution channel must not be empty");
    const entry: InternalStageEntry = {
      channel: channel.trim(),
      value,
      disposed: false,
      committed: false,
    };
    this.internalEntries.push(entry);
    return async () => {
      if (entry.disposed) return;
      entry.disposed = true;
      if (entry.committed) await entry.disposeCommitted?.();
    };
  }

  private stageSubscription(disposable: ExtensionDisposable): ExtensionDisposable {
    if (this.token.phase !== "activating" && this.token.phase !== "active") {
      throw new ExtensionActivationStaleError(this.token.identity);
    }
    if (typeof disposable !== "function") throw new TypeError("Extension subscription must be disposable");
    const entry: SubscriptionEntry = { disposable, disposed: false };
    this.subscriptions.push(entry);
    return async () => {
      if (entry.disposed) return;
      entry.disposed = true;
      await entry.disposable();
    };
  }

  private async invokeCommand(
    handler: CommandHandler,
    arguments_: readonly ExtensionJson[],
  ) {
    if (this.token.phase !== "active" && this.token.phase !== "activating") {
      throw new ExtensionActivationStaleError(this.token.identity);
    }
    this.invocations += 1;
    try {
      const result = await handler(...arguments_);
      this.assertNotDisposed();
      return result;
    } finally {
      this.invocations -= 1;
      if (this.invocations === 0) {
        this.resolveInvocationDrain?.();
        this.resolveInvocationDrain = undefined;
        this.invocationDrain = undefined;
      }
    }
  }

  private assertActivating(): void {
    if (this.token.phase !== "activating") throw new ExtensionActivationStaleError(this.token.identity);
  }

  private assertNotDisposed(): void {
    if (this.token.phase === "disposed") throw new ExtensionActivationStaleError(this.token.identity);
  }

  private assertActive(): void {
    if (this.token.phase !== "active") throw new ExtensionActivationStaleError(this.token.identity);
  }
}

export class ExtensionSupervisor {
  readonly contributions = new ExtensionContributionStore();
  readonly announcements = new AnnouncementCenter();
  readonly context: Context;

  private readonly platform: ExtensionPlatform;
  private readonly persistence: ExtensionPersistence | undefined;
  private readonly localPreferences: ExtensionSupervisorOptions["localPreferences"];
  private readonly resolveHostPersistence: ExtensionSupervisorOptions["resolveHostPersistence"];
  private readonly adapters: Readonly<Record<string, InternalContributionAdapter>>;
  private readonly createActivationId: () => string;
  private readonly activationTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly active = new Map<string, ActiveRecord>();
  private readonly owners = new Set<ActivationOwner>();
  private readonly generations = new Map<string, number>();
  private readonly descriptors = new Map<string, ExtensionRuntimeDescriptor>();
  private readonly listeners = new Set<() => void>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private activationOrder: string[] = [];
  private revision = 0;
  private closed = false;
  private disposal: Promise<void> | undefined;
  private snapshot: ExtensionRuntimeSnapshot = { revision: 0, extensions: [] };

  constructor(options: ExtensionSupervisorOptions) {
    this.context = options.context ?? new Context();
    this.platform = options.platform;
    this.persistence = options.persistence;
    this.localPreferences = options.localPreferences;
    this.resolveHostPersistence = options.resolveHostPersistence;
    this.adapters = options.internalContributions ?? {};
    this.createActivationId = options.createActivationId ?? defaultActivationId;
    this.activationTimeoutMs = extensionTimeout(options.activationTimeoutMs, 15000);
    this.cleanupTimeoutMs = extensionTimeout(options.cleanupTimeoutMs, 5000);
  }

  getSnapshot = (): ExtensionRuntimeSnapshot => this.snapshot;

  checkCompatibility(value: unknown): ExtensionManifestV1 {
    const manifest = parseExtensionManifestV1(value);
    assertExtensionCompatibility(manifest, this.platform);
    return manifest;
  }

  async activateOptional(definition: TrustedExtensionDefinition): Promise<boolean> {
    try {
      await this.activate(definition);
      return true;
    } catch (error) {
      const manifest = parseExtensionManifestV1(definition.manifest);
      if (!this.closed && !this.descriptors.has(manifest.id)) {
        this.setDescriptor(manifest, { extensionId: manifest.id, activationId: this.createActivationId(), generation: 0 }, "failed", error);
      }
      return false;
    }
  }

  async loadOptional(extensionId: string, load: () => TrustedExtensionDefinition | Promise<TrustedExtensionDefinition>): Promise<boolean> {
    try {
      this.ensureOpen();
      const definition = await withExtensionDeadline(Promise.resolve().then(() => {
        this.ensureOpen();
        return load();
      }), `${extensionId} module load`, this.activationTimeoutMs);
      this.ensureOpen();
      if (definition.manifest.id !== extensionId) throw new Error(`Expected extension ${extensionId}, received ${definition.manifest.id}`);
      return await this.activateOptional(definition);
    } catch (error) {
      if (!this.closed && !this.active.has(extensionId)) {
        this.descriptors.set(extensionId, Object.freeze({ id: extensionId, name: extensionId, version: "unresolved",
          status: "failed", activationId: this.createActivationId(), generation: 0,
          error: error instanceof Error ? error.message : String(error),
        }));
        this.publish();
      }
      return false;
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  activate(definition: TrustedExtensionDefinition): Promise<ExtensionActivationIdentity> {
    const manifest = parseExtensionManifestV1(definition.manifest);
    return this.enqueue(manifest.id, async () => {
      this.ensureOpen();
      assertExtensionCompatibility(manifest, this.platform);
      if (this.active.has(manifest.id)) throw new Error(`Extension ${manifest.id} is already active`);
      const missingDependencies = (manifest.dependencies ?? []).filter((id) => !this.active.has(id));
      if (missingDependencies.length > 0) {
        throw new Error(
          `Extension ${manifest.id} requires active dependencies: ${missingDependencies.join(", ")}`,
        );
      }
      const generation = (this.generations.get(manifest.id) ?? 0) + 1;
      this.generations.set(manifest.id, generation);
      const identity = Object.freeze({
        extensionId: manifest.id,
        activationId: this.createActivationId(),
        generation,
      });
      const token: ActivationToken = { phase: "activating", identity, controller: new AbortController() };
      const transaction = new ActivationTransaction(token, this.contributions, this.announcements, this.adapters, this.persistence, this.resolveHostPersistence, this.cleanupTimeoutMs, this.activationTimeoutMs, this.localPreferences);
      const owner = { token, transaction };
      this.owners.add(owner);
      this.setDescriptor(manifest, identity, "activating");
      const activationTimeoutMs = this.activationTimeoutMs;

      const activationPlugin = {
        name: `extension:${manifest.id}#${generation}`,
        async apply() {
          let abandoned = false;
          try {
            const activation = Promise.resolve().then(() => {
              token.controller.signal.throwIfAborted();
              return definition.activate(transaction.api);
            });
            // A late completion cannot publish, but must release a returned resource.
            void activation.then(async returned => {
              if (abandoned && typeof returned === "function") await returned();
            }).catch(() => undefined);
            const returned = await withExtensionDeadline(activation, `${manifest.id} activation`, activationTimeoutMs);
            // The factory result belongs to rollback even if retirement revoked its API.
            if (typeof returned === "function") transaction.subscriptions.push({ disposable: returned, disposed: false });
            await transaction.commit();
            token.controller.signal.throwIfAborted();
            token.phase = "active";
            return () => transaction.cleanup();
          } catch (error) {
            abandoned = true;
            token.phase = "disposed";
            token.controller.abort(error);
            try {
              await transaction.cleanup();
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                `Extension ${manifest.id} activation and rollback failed`,
              );
            }
            throw error;
          }
        },
      };
      const fiber = this.context.plugin(activationPlugin);
      try {
        await fiber;
        token.controller.signal.throwIfAborted();
        this.active.set(manifest.id, { definition, manifest, identity, token, transaction, fiber });
        this.activationOrder = [...this.activationOrder.filter((id) => id !== manifest.id), manifest.id];
        this.setDescriptor(manifest, identity, "active");
        return identity;
      } catch (error) {
        token.phase = "disposed";
        token.controller.abort(error);
        try {
          await transaction.cleanup();
        } finally {
          await fiber.dispose().catch(() => undefined);
          this.owners.delete(owner);
          if (this.closed) {
            this.descriptors.delete(manifest.id);
            this.publish();
          } else {
            this.setDescriptor(manifest, identity, "failed", error);
          }
        }
        throw error;
      }
    });
  }

  deactivate(extensionId: string): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return this.deactivateOwned(extensionId);
  }

  private deactivateOwned(extensionId: string): Promise<boolean> {
    return this.enqueue(extensionId, async () => {
      const record = this.active.get(extensionId);
      if (record === undefined) return false;
      const dependents = [...this.active.values()]
        .filter((candidate) => candidate.manifest.dependencies?.includes(extensionId))
        .map((candidate) => candidate.manifest.id);
      if (dependents.length > 0) {
        throw new Error(`Extension ${extensionId} is required by active extensions: ${dependents.join(", ")}`);
      }
      record.token.phase = "deactivating";
      record.token.controller.abort();
      this.setDescriptor(record.manifest, record.identity, "deactivating");
      this.active.delete(extensionId);
      this.activationOrder = this.activationOrder.filter((id) => id !== extensionId);
      const failures: unknown[] = [];
      try {
        await record.transaction.cleanup();
      } catch (error) {
        failures.push(error);
      }
      try {
        await record.fiber.dispose();
      } catch (error) {
        failures.push(error);
      } finally {
        record.token.phase = "disposed";
        for (const owner of this.owners) {
          if (owner.token === record.token) this.owners.delete(owner);
        }
        this.descriptors.delete(extensionId);
        this.publish();
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to deactivate extension ${extensionId}`);
      }
      return true;
    });
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.closed = true;
    const owners = [...this.owners];
    const operations = [...this.operations.values()];
    // Install the shared barrier before abort listeners can reenter disposal.
    this.disposal = Promise.resolve().then(() => this.finishDisposal(owners, operations));
    for (const { token } of owners) {
      if (token.phase !== "activating" && token.phase !== "active") continue;
      if (this.active.get(token.identity.extensionId)?.token === token) continue;
      token.phase = "disposed";
      token.controller.abort(new ExtensionActivationStaleError(token.identity));
    }
    return this.disposal;
  }

  private async finishDisposal(owners: readonly ActivationOwner[], operations: readonly Promise<unknown>[]): Promise<void> {
    // Pending consumers must roll back while their active providers still exist.
    await Promise.allSettled(operations);
    const failures = owners.flatMap(owner => owner.transaction.cleanupFailures);
    for (const id of [...this.activationOrder].reverse()) {
      try {
        await this.deactivateOwned(id);
      } catch (error) {
        failures.push(error);
      }
    }
    this.announcements.close();
    this.contributions.close();
    this.listeners.clear();
    if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose Extension supervisor");
  }

  private enqueue<T>(extensionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(extensionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.operations.set(extensionId, next);
    void next.finally(() => {
      if (this.operations.get(extensionId) === next) this.operations.delete(extensionId);
    }).catch(() => undefined);
    return next;
  }

  private setDescriptor(
    manifest: ExtensionManifestV1,
    identity: ExtensionActivationIdentity,
    status: ExtensionActivationStatus,
    error?: unknown,
  ): void {
    this.descriptors.set(manifest.id, Object.freeze({
      id: manifest.id,
      name: manifest.name,
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      version: manifest.version,
      status,
      generation: identity.generation,
      activationId: identity.activationId,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
    }));
    this.publish();
  }

  private publish(): void {
    this.revision += 1;
    this.snapshot = Object.freeze({
      revision: this.revision,
      extensions: Object.freeze([...this.descriptors.values()]),
    });
    if (this.closed) return;
    for (const listener of this.listeners) listener();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Extension supervisor is closed");
  }
}
