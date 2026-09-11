import {
  type ExtensionInstallationRecord,
  type ExtensionInstallationRepository,
  type ExtensionInstallationSource,
  type ModuleUrlExtensionSource,
} from "./installation-repository";
import { ExtensionSupervisor, type TrustedExtensionDefinition } from "./runtime";

export interface ExtensionModuleLoader {
  load(
    source: ExtensionInstallationSource,
    options?: { readonly fresh?: boolean },
  ): Promise<TrustedExtensionDefinition>;
}

export type ManagedExtensionStatus = "disabled" | "loading" | "active" | "failed";

export interface ManagedExtensionDescriptor {
  readonly installation: ExtensionInstallationRecord;
  readonly status: ManagedExtensionStatus;
  readonly error?: string;
}

export interface ExtensionManagerSnapshot {
  readonly revision: number;
  readonly extensions: readonly ManagedExtensionDescriptor[];
  readonly installationLoadErrors: readonly { readonly index: number; readonly message: string }[];
}

export interface ExtensionManagerOptions {
  readonly installations: ExtensionInstallationRepository;
  readonly loader: ExtensionModuleLoader;
  readonly supervisor: ExtensionSupervisor;
  readonly now?: () => number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sole lifecycle coordinator for externally installed extensions.
 * The repository owns desired state; the supervisor owns live generations.
 */
export class ExtensionManager {
  private readonly installations: ExtensionInstallationRepository;
  private readonly loader: ExtensionModuleLoader;
  private readonly supervisor: ExtensionSupervisor;
  private readonly now: () => number;
  private readonly statuses = new Map<string, ManagedExtensionStatus>();
  private readonly errors = new Map<string, string>();
  private readonly managed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private operation: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private closed = false;
  private snapshot: ExtensionManagerSnapshot = {
    revision: 0,
    extensions: [],
    installationLoadErrors: [],
  };
  private readonly unsubscribeInstallations: () => void;

  constructor(options: ExtensionManagerOptions) {
    this.installations = options.installations;
    this.loader = options.loader;
    this.supervisor = options.supervisor;
    this.now = options.now ?? Date.now;
    this.unsubscribeInstallations = this.installations.subscribe(() => this.publish());
    this.publish();
  }

  getSnapshot = (): ExtensionManagerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  restore(): Promise<void> {
    return this.enqueue(async () => {
      for (const installation of this.installations.getSnapshot().records) {
        this.managed.add(installation.extensionId);
        if (!installation.enabled) {
          this.setState(installation.extensionId, "disabled");
          continue;
        }
        this.setState(installation.extensionId, "loading");
        try {
          const definition = await this.loadAndCheck(installation);
          this.assertAvailable(installation.extensionId);
          await this.supervisor.activate(definition);
          this.setState(installation.extensionId, "active");
        } catch (error) {
          this.setState(installation.extensionId, "failed", error);
        }
      }
    });
  }

  installModuleUrl(url: string): Promise<ExtensionInstallationRecord> {
    return this.enqueue(async () => {
      const source = Object.freeze({ kind: "module-url" as const, url: url.trim() });
      const definition = await this.loader.load(source, { fresh: true });
      const extensionId = definition.manifest.id;
      const previous = this.installations.getSnapshot().records.find((item) => item.extensionId === extensionId);
      if (previous === undefined) this.assertAvailable(extensionId);
      const timestamp = this.now();
      const disabled = await this.installations.put(Object.freeze({
        extensionId,
        source,
        enabled: false,
        installedAt: previous?.installedAt ?? timestamp,
        updatedAt: timestamp,
        lastResolvedManifest: definition.manifest,
      }));
      this.managed.add(extensionId);
      this.setState(extensionId, "loading");
      if (previous?.enabled) await this.supervisor.deactivate(extensionId);
      try {
        await this.supervisor.activate(definition);
        const enabled = await this.installations.put(Object.freeze({ ...disabled, enabled: true }));
        this.setState(extensionId, "active");
        return enabled;
      } catch (error) {
        await this.supervisor.deactivate(extensionId).catch(() => false);
        this.setState(extensionId, "failed", error);
        throw error;
      }
    });
  }

  setEnabled(extensionId: string, enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      const installation = this.requireInstallation(extensionId);
      this.managed.add(extensionId);
      if (enabled) {
        if (installation.enabled && this.statuses.get(extensionId) === "active") return;
        this.setState(extensionId, "loading");
        try {
          this.assertAvailable(extensionId);
          const definition = await this.loadAndCheck(installation);
          await this.supervisor.activate(definition);
          await this.installations.put(Object.freeze({
            ...installation,
            enabled: true,
            updatedAt: this.now(),
            lastResolvedManifest: definition.manifest,
          }));
          this.setState(extensionId, "active");
        } catch (error) {
          await this.supervisor.deactivate(extensionId).catch(() => false);
          this.setState(extensionId, "failed", error);
          throw error;
        }
        return;
      }

      // Obsidian-style asymmetric transaction: disabled intent survives unload failure.
      await this.installations.put(Object.freeze({ ...installation, enabled: false, updatedAt: this.now() }));
      try {
        await this.supervisor.deactivate(extensionId);
        this.setState(extensionId, "disabled");
      } catch (error) {
        this.setState(extensionId, "failed", error);
        throw error;
      }
    });
  }

  reload(extensionId: string): Promise<void> {
    return this.enqueue(async () => {
      const installation = this.requireInstallation(extensionId);
      const definition = await this.loadAndCheck(installation, true);
      if (!installation.enabled) {
        await this.installations.put(Object.freeze({
          ...installation,
          updatedAt: this.now(),
          lastResolvedManifest: definition.manifest,
        }));
        this.setState(extensionId, "disabled");
        return;
      }
      await this.installations.put(Object.freeze({ ...installation, enabled: false, updatedAt: this.now() }));
      await this.supervisor.deactivate(extensionId);
      this.setState(extensionId, "loading");
      try {
        await this.supervisor.activate(definition);
        await this.installations.put(Object.freeze({
          ...installation,
          enabled: true,
          updatedAt: this.now(),
          lastResolvedManifest: definition.manifest,
        }));
        this.setState(extensionId, "active");
      } catch (error) {
        await this.supervisor.deactivate(extensionId).catch(() => false);
        this.setState(extensionId, "failed", error);
        throw error;
      }
    });
  }

  remove(extensionId: string): Promise<void> {
    return this.enqueue(async () => {
      const installation = this.requireInstallation(extensionId);
      if (installation.enabled) {
        await this.installations.put(Object.freeze({ ...installation, enabled: false, updatedAt: this.now() }));
      }
      await this.supervisor.deactivate(extensionId);
      await this.installations.remove(extensionId);
      this.managed.delete(extensionId);
      this.statuses.delete(extensionId);
      this.errors.delete(extensionId);
      this.publish();
    });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    await this.operation.catch(() => undefined);
    for (const extensionId of [...this.managed].reverse()) {
      await this.supervisor.deactivate(extensionId).catch(() => false);
    }
    this.closed = true;
    this.unsubscribeInstallations();
    this.listeners.clear();
  }

  private loadAndCheck(
    installation: ExtensionInstallationRecord,
    fresh = false,
  ): Promise<TrustedExtensionDefinition> {
    return this.loader.load(installation.source, { fresh }).then((definition) => {
      if (definition.manifest.id !== installation.extensionId) {
        throw new Error(
          `Extension source resolved ${definition.manifest.id}, expected ${installation.extensionId}`,
        );
      }
      return definition;
    });
  }

  private assertAvailable(extensionId: string): void {
    const active = this.supervisor.getSnapshot().extensions.find(
      (candidate) => candidate.id === extensionId && candidate.status === "active",
    );
    if (active !== undefined && !this.managed.has(extensionId)) {
      throw new Error(`Extension ID ${extensionId} is owned by a built-in extension`);
    }
  }

  private requireInstallation(extensionId: string): ExtensionInstallationRecord {
    const installation = this.installations.getSnapshot().records.find((item) => item.extensionId === extensionId);
    if (installation === undefined) throw new Error(`Extension ${extensionId} is not installed`);
    return installation;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.catch(() => undefined).then(() => {
      this.ensureOpen();
      return operation();
    });
    this.operation = next;
    return next;
  }

  private setState(extensionId: string, status: ManagedExtensionStatus, error?: unknown): void {
    this.statuses.set(extensionId, status);
    if (error === undefined) this.errors.delete(extensionId);
    else this.errors.set(extensionId, message(error));
    this.publish();
  }

  private publish(): void {
    const installationSnapshot = this.installations.getSnapshot();
    this.revision += 1;
    this.snapshot = Object.freeze({
      revision: this.revision,
      extensions: Object.freeze(installationSnapshot.records.map((installation) => Object.freeze({
        installation,
        status: this.statuses.get(installation.extensionId) ?? (installation.enabled ? "loading" : "disabled"),
        ...(this.errors.has(installation.extensionId)
          ? { error: this.errors.get(installation.extensionId)! }
          : {}),
      }))),
      installationLoadErrors: installationSnapshot.loadErrors,
    });
    if (!this.closed) for (const listener of this.listeners) listener();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Extension manager is closed");
  }
}

export function moduleUrlSource(url: string): ModuleUrlExtensionSource {
  return Object.freeze({ kind: "module-url", url });
}
