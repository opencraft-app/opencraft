import { ExtensionCompatibilityError } from "@opencraft/extension-contract";
import type { ExtensionArtifact } from "./artifact";
import {
  type ExtensionInstallationRecord,
  type ExtensionInstallationRepository,
  type ExtensionInstallationSource,
  type ModuleUrlExtensionSource,
} from "./installation-repository";
import { ExtensionSupervisor, type TrustedExtensionDefinition } from "./runtime";
import { extensionTimeout, withExtensionDeadline } from "./deadline";

export interface ExtensionModuleLoader {
  load(
    source: ExtensionInstallationSource,
    options?: { readonly fresh?: boolean; readonly artifact?: ExtensionArtifact },
  ): Promise<TrustedExtensionDefinition>;
}

export type ManagedExtensionStatus = "disabled" | "loading" | "active" | "failed" | "incompatible";

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
  readonly loadTimeoutMs?: number;
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
  private readonly loadTimeoutMs: number;
  private readonly statuses = new Map<string, ManagedExtensionStatus>();
  private readonly errors = new Map<string, string>();
  private readonly managed = new Set<string>();
  private readonly activeDefinitions = new Map<string, TrustedExtensionDefinition>();
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
    this.loadTimeoutMs = extensionTimeout(options.loadTimeoutMs, 15000);
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
        if (!installation.enabled) {
          this.setState(installation.extensionId, "disabled");
          continue;
        }
        this.setState(installation.extensionId, "loading");
        try {
          const definition = await this.loadAndCheck(installation);
          this.assertAvailable(installation.extensionId);
          this.managed.add(installation.extensionId);
          await this.supervisor.activate(definition);
          this.activeDefinitions.set(installation.extensionId, definition);
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
      const definition = await this.load(source, true);
      const extensionId = definition.manifest.id;
      const previous = this.installations.getSnapshot().records.find((item) => item.extensionId === extensionId);
      if (previous !== undefined) {
        return this.replace(previous, definition, source);
      }
      this.assertAvailable(extensionId);
      const timestamp = this.now();
      const disabled = await this.installations.put(Object.freeze({
        extensionId,
        source,
        enabled: false,
        installedAt: timestamp,
        updatedAt: timestamp,
        lastResolvedManifest: definition.manifest,
        ...(definition.artifact === undefined ? {} : { artifact: definition.artifact }),
      }));
      this.managed.add(extensionId);
      this.setState(extensionId, "loading");
      try {
        await this.supervisor.activate(definition);
        const enabled = await this.installations.put(Object.freeze({ ...disabled, enabled: true }));
        this.activeDefinitions.set(extensionId, definition);
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
      this.assertAvailable(extensionId);
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
            ...(definition.artifact === undefined ? {} : { artifact: definition.artifact }),
          }));
          this.activeDefinitions.set(extensionId, definition);
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
        await this.retire(extensionId);
        this.activeDefinitions.delete(extensionId);
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
      await this.replace(installation, definition, installation.source);
    });
  }

  private async replace(
    previous: ExtensionInstallationRecord,
    definition: TrustedExtensionDefinition,
    source: ExtensionInstallationSource,
  ): Promise<ExtensionInstallationRecord> {
    this.supervisor.checkCompatibility(definition.manifest);
    const id = previous.extensionId;
    this.assertAvailable(id);
    const candidate = Object.freeze({
      ...previous, source, updatedAt: this.now(), lastResolvedManifest: definition.manifest,
      artifact: definition.artifact,
      artifactRef: definition.artifact?.sha256,
    });
    if (!previous.enabled) {
      const saved = await this.installations.put(candidate);
      this.setState(id, "disabled");
      return saved;
    }
    const fallback = this.activeDefinitions.get(id);
    // A dependency can refuse retirement. Keep its current instance untouched.
    await this.retire(id);
    this.activeDefinitions.delete(id);
    this.setState(id, "loading");
    try {
      await this.supervisor.activate(definition);
      const saved = await this.installations.put(candidate);
      this.activeDefinitions.set(id, definition);
      this.setState(id, "active");
      return saved;
    } catch (error) {
      try {
        await this.supervisor.deactivate(id);
        if (fallback !== undefined) {
          await this.supervisor.activate(fallback);
          this.activeDefinitions.set(id, fallback);
          this.setState(id, "active", error);
        } else {
          this.setState(id, "failed", error);
        }
      } catch (recoveryError) {
        const failure = new AggregateError([error, recoveryError], `Extension ${id} update and recovery failed`);
        this.setState(id, "failed", failure);
        throw failure;
      }
      throw error;
    }
  }

  remove(extensionId: string): Promise<void> {
    return this.enqueue(async () => {
      this.assertAvailable(extensionId);
      const installation = this.requireInstallation(extensionId);
      if (installation.enabled) {
        await this.installations.put(Object.freeze({ ...installation, enabled: false, updatedAt: this.now() }));
      }
      await this.retire(extensionId);
      await this.installations.remove(extensionId);
      this.activeDefinitions.delete(extensionId);
      this.managed.delete(extensionId);
      this.statuses.delete(extensionId);
      this.errors.delete(extensionId);
      this.publish();
    });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    await this.operation.catch(() => undefined);
    for (const extensionId of [...this.activeDefinitions.keys()].reverse()) {
      await this.supervisor.deactivate(extensionId).catch(() => false);
    }
    this.closed = true;
    this.activeDefinitions.clear();
    this.unsubscribeInstallations();
    this.listeners.clear();
  }

  private async retire(extensionId: string): Promise<void> {
    try {
      await this.supervisor.deactivate(extensionId);
    } catch (error) {
      const remainsActive = this.supervisor.getSnapshot().extensions.some(item => item.id === extensionId && item.status === "active");
      if (!remainsActive) this.activeDefinitions.delete(extensionId);
      this.setState(extensionId, remainsActive ? "active" : "failed", error);
      throw error;
    }
  }

  private loadAndCheck(
    installation: ExtensionInstallationRecord,
    fresh = false,
  ): Promise<TrustedExtensionDefinition> {
    if (!fresh && installation.artifactRef !== undefined && installation.artifact === undefined) {
      return Promise.reject(new Error("Installed extension artifact is missing; explicitly reload to repair"));
    }
    return this.load(installation.source, fresh, fresh ? undefined : installation.artifact).then((definition) => {
      if (definition.manifest.id !== installation.extensionId) {
        throw new Error(
          `Extension source resolved ${definition.manifest.id}, expected ${installation.extensionId}`,
        );
      }
      return definition;
    });
  }

  private load(source: ExtensionInstallationSource, fresh: boolean, artifact?: ExtensionArtifact): Promise<TrustedExtensionDefinition> {
    return withExtensionDeadline(
      Promise.resolve().then(() => this.loader.load(source, { fresh, artifact })), "module load", this.loadTimeoutMs,
    );
  }

  private assertAvailable(extensionId: string): void {
    const active = this.supervisor.getSnapshot().extensions.find(
      (candidate) => candidate.id === extensionId && candidate.status === "active",
    );
    if (active !== undefined && !this.activeDefinitions.has(extensionId)) {
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
    this.statuses.set(extensionId, status === "failed" && error instanceof ExtensionCompatibilityError
      ? "incompatible" : status);
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
