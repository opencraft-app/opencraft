import { Context, type Fiber } from "@deepseek-ai/cordis";
import {
  parseExtensionManifestV1,
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

import {
  ExtensionContributionStore,
  type PublicContributionBatch,
} from "./contribution-store";

export interface TrustedExtensionDefinition {
  readonly manifest: ExtensionManifestV1;
  activate(api: TrustedExtensionApiV1): void | ExtensionDisposable | Promise<void | ExtensionDisposable>;
}

export interface PreparedInternalContribution {
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
  readonly context?: Context;
  readonly platform: ExtensionPlatform;
  readonly internalContributions?: Readonly<Record<string, InternalContributionAdapter>>;
  readonly createActivationId?: () => string;
}

interface ActivationToken {
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

interface ActiveRecord {
  readonly definition: TrustedExtensionDefinition;
  readonly manifest: ExtensionManifestV1;
  readonly identity: ExtensionActivationIdentity;
  readonly token: ActivationToken;
  readonly transaction: ActivationTransaction;
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
  ) {
    this.api = Object.freeze({
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
      preparedInternal.push({ entry, prepared: await adapter.prepare(this.token.identity, entry.value) });
    }

    const committedInternal: InternalStageEntry[] = [];
    try {
      for (const { entry, prepared } of preparedInternal) {
        entry.disposeCommitted = await prepared.commit();
        entry.committed = true;
        committedInternal.push(entry);
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
          committedInternal.flatMap((entry) => entry.disposeCommitted === undefined ? [] : [entry.disposeCommitted]),
          `Failed to roll back internal contributions for ${this.token.identity.extensionId}`,
        );
      } catch (cause) {
        rollbackError = cause;
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
      await this.invocationDrain;
    }
    for (const entry of [...this.internalEntries].reverse()) {
      if (!entry.committed || entry.disposeCommitted === undefined || entry.disposed) continue;
      entry.disposed = true;
      try {
        await entry.disposeCommitted();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const entry of [...this.subscriptions].reverse()) {
      if (entry.disposed) continue;
      entry.disposed = true;
      try {
        await entry.disposable();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
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
    this.assertActivating();
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
      return await handler(...arguments_);
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

  private assertActive(): void {
    if (this.token.phase !== "active") throw new ExtensionActivationStaleError(this.token.identity);
  }
}

export class ExtensionSupervisor {
  readonly contributions = new ExtensionContributionStore();
  readonly announcements = new AnnouncementCenter();
  readonly context: Context;

  private readonly platform: ExtensionPlatform;
  private readonly adapters: Readonly<Record<string, InternalContributionAdapter>>;
  private readonly createActivationId: () => string;
  private readonly active = new Map<string, ActiveRecord>();
  private readonly generations = new Map<string, number>();
  private readonly descriptors = new Map<string, ExtensionRuntimeDescriptor>();
  private readonly listeners = new Set<() => void>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private activationOrder: string[] = [];
  private revision = 0;
  private closed = false;
  private snapshot: ExtensionRuntimeSnapshot = { revision: 0, extensions: [] };

  constructor(options: ExtensionSupervisorOptions) {
    this.context = options.context ?? new Context();
    this.platform = options.platform;
    this.adapters = options.internalContributions ?? {};
    this.createActivationId = options.createActivationId ?? defaultActivationId;
  }

  getSnapshot = (): ExtensionRuntimeSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  activate(definition: TrustedExtensionDefinition): Promise<ExtensionActivationIdentity> {
    const manifest = parseExtensionManifestV1(definition.manifest);
    return this.enqueue(manifest.id, async () => {
      this.ensureOpen();
      if (!manifest.platforms.includes(this.platform)) {
        throw new Error(`Extension ${manifest.id} does not target ${this.platform}`);
      }
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
      const token: ActivationToken = { phase: "activating", identity };
      const transaction = new ActivationTransaction(token, this.contributions, this.announcements, this.adapters);
      this.setDescriptor(manifest, identity, "activating");

      const activationPlugin = {
        name: `extension:${manifest.id}#${generation}`,
        async apply() {
          try {
            const returned = await definition.activate(transaction.api);
            if (typeof returned === "function") transaction.api.subscriptions.add(returned);
            await transaction.commit();
            token.phase = "active";
            return () => transaction.cleanup();
          } catch (error) {
            token.phase = "disposed";
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
      } catch (error) {
        await fiber.dispose().catch(() => undefined);
        this.setDescriptor(manifest, identity, "failed", error);
        throw error;
      }
      this.active.set(manifest.id, { definition, manifest, identity, token, transaction, fiber });
      this.activationOrder = [...this.activationOrder.filter((id) => id !== manifest.id), manifest.id];
      this.setDescriptor(manifest, identity, "active");
      return identity;
    });
  }

  deactivate(extensionId: string): Promise<boolean> {
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
        this.descriptors.delete(extensionId);
        this.publish();
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to deactivate extension ${extensionId}`);
      }
      return true;
    });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    const ids = [...this.activationOrder].reverse();
    const failures: unknown[] = [];
    for (const id of ids) {
      try {
        await this.deactivate(id);
      } catch (error) {
        failures.push(error);
      }
    }
    this.closed = true;
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
