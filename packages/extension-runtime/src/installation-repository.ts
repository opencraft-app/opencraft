import { Context, Service, type Plugin } from "@deepseek-ai/cordis";
import { parseExtensionArtifact, type ExtensionArtifact } from "./artifact";
import {
  isExtensionId,
  parseExtensionManifestV1,
  type ExtensionManifestV1,
} from "@opencraft/extension-contract";

export interface ModuleUrlExtensionSource {
  readonly kind: "module-url";
  readonly url: string;
}

export interface BuiltinExtensionSource {
  readonly kind: "builtin";
}

export type ExtensionInstallationSource = ModuleUrlExtensionSource | BuiltinExtensionSource;

/** Persisted desired state. It is deliberately not a runtime descriptor. */
export interface ExtensionInstallationRecord {
  readonly extensionId: string;
  readonly source: ExtensionInstallationSource;
  readonly enabled: boolean;
  readonly installedAt: number;
  readonly updatedAt: number;
  /** Presentation cache only; the loaded module manifest remains authoritative. */
  readonly lastResolvedManifest?: ExtensionManifestV1;
  readonly artifact?: ExtensionArtifact;
  readonly artifactRef?: string;
}

export interface ExtensionInstallationLoadError {
  readonly index: number;
  readonly message: string;
}

export interface ExtensionInstallationSnapshot {
  readonly revision: number;
  readonly records: readonly ExtensionInstallationRecord[];
  readonly loadErrors: readonly ExtensionInstallationLoadError[];
}

export interface ExtensionInstallationPersistence {
  load(): Promise<readonly unknown[]>;
  put(record: ExtensionInstallationRecord): Promise<void>;
  remove(extensionId: string): Promise<void>;
  close?(): void | Promise<void>;
  subscribe?(listener: () => void): () => void;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Extension installation must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("module-url source requires a URL");
  }
  return value.trim();
}

export function normalizeInstallation(value: unknown): ExtensionInstallationRecord {
  const input = record(value);
  if (typeof input.extensionId !== "string" || !isExtensionId(input.extensionId)) {
    throw new TypeError("Extension installation has an invalid extensionId");
  }
  const source = record(input.source);
  if (input.artifactRef !== undefined && (typeof input.artifactRef !== "string" || !/^[a-f0-9]{64}$/.test(input.artifactRef))) {
    throw new TypeError("Invalid installation artifact reference");
  }
  if (source.kind !== "module-url" && source.kind !== "builtin") throw new TypeError("Unsupported extension installation source");
  if (source.kind === "builtin" && (input.artifact !== undefined || input.artifactRef !== undefined)) {
    throw new TypeError("Built-in extensions cannot contain downloaded artifacts");
  }
  if (typeof input.enabled !== "boolean") throw new TypeError("Extension installation requires enabled");
  if (!Number.isFinite(input.installedAt) || !Number.isFinite(input.updatedAt)) {
    throw new TypeError("Extension installation has invalid timestamps");
  }
  const lastResolvedManifest = input.lastResolvedManifest === undefined
    ? undefined
    : parseExtensionManifestV1(input.lastResolvedManifest);
  if (lastResolvedManifest !== undefined && lastResolvedManifest.id !== input.extensionId) {
    throw new TypeError("Cached manifest does not match the installed extension ID");
  }
  const artifact = input.artifact === undefined ? undefined : parseExtensionArtifact(input.artifact);
  if (artifact !== undefined && input.artifactRef !== undefined && input.artifactRef !== artifact.sha256) {
    throw new TypeError("Installation artifact reference does not match its artifact");
  }
  // Publish the same identity on put and on storage notifications, including legacy inline artifacts.
  const artifactRef = artifact?.sha256 ?? input.artifactRef as string | undefined;
  return Object.freeze({
    extensionId: input.extensionId,
    source: source.kind === "builtin"
      ? Object.freeze({ kind: "builtin" as const })
      : Object.freeze({ kind: "module-url" as const, url: normalizeUrl(source.url) }),
    enabled: input.enabled,
    installedAt: input.installedAt as number,
    updatedAt: input.updatedAt as number,
    ...(lastResolvedManifest === undefined ? {} : { lastResolvedManifest }),
    ...(artifact === undefined ? {} : { artifact }),
    ...(artifactRef === undefined ? {} : { artifactRef }),
  });
}

export class ExtensionInstallationRepository extends Service {
  static readonly inject = [];
  private readonly records = new Map<string, ExtensionInstallationRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly loadErrors: ExtensionInstallationLoadError[] = [];
  private mutations: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private closed = false;
  private unsubscribeStorage: (() => void) | undefined;
  private snapshot: ExtensionInstallationSnapshot = { revision: 0, records: [], loadErrors: [] };

  constructor(context: Context, private readonly persistence: ExtensionInstallationPersistence) {
    super(context, "extensionInstallations");
    context.effect(() => () => this.close());
  }

  async [Service.init](): Promise<void> {
    const values = await this.persistence.load();
    values.forEach((value, index) => {
      try {
        const normalized = normalizeInstallation(value);
        if (this.records.has(normalized.extensionId)) {
          throw new TypeError(`Duplicate extension installation ${normalized.extensionId}`);
        }
        this.records.set(normalized.extensionId, normalized);
      } catch (error) {
        this.loadErrors.push({ index, message: error instanceof Error ? error.message : String(error) });
      }
    });
    this.publish();
    this.unsubscribeStorage = this.persistence.subscribe?.(() => {
      if (this.closed) return;
      void this.enqueue(async () => {
        const values = await this.persistence.load();
        if (this.closed) return;
        const records = values.map(normalizeInstallation);
        this.records.clear();
        for (const record of records) this.records.set(record.extensionId, record);
        this.publish();
      }).catch(() => { /* Keep last good state; subsequent mutations report failures. */ });
    });
  }

  getSnapshot = (): ExtensionInstallationSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  put(value: ExtensionInstallationRecord): Promise<ExtensionInstallationRecord> {
    const normalized = normalizeInstallation(value);
    return this.enqueue(async () => {
      this.ensureOpen();
      await this.persistence.put(normalized);
      this.records.set(normalized.extensionId, normalized);
      this.publish();
      return normalized;
    });
  }

  remove(extensionId: string): Promise<boolean> {
    return this.enqueue(async () => {
      this.ensureOpen();
      if (!this.records.has(extensionId)) return false;
      await this.persistence.remove(extensionId);
      this.records.delete(extensionId);
      this.publish();
      return true;
    });
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.unsubscribeStorage?.();
    await this.mutations.catch(() => undefined);
    this.closed = true;
    this.listeners.clear();
    await this.persistence.close?.();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.catch(() => undefined).then(operation);
    this.mutations = next;
    return next;
  }

  private publish(): void {
    this.revision += 1;
    this.snapshot = Object.freeze({
      revision: this.revision,
      records: Object.freeze([...this.records.values()].sort((a, b) => a.extensionId.localeCompare(b.extensionId))),
      loadErrors: Object.freeze([...this.loadErrors]),
    });
    if (!this.closed) for (const listener of this.listeners) listener();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Extension installation repository is closed");
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    extensionInstallations: ExtensionInstallationRepository;
  }
}

/** Internal application bootstrap provider, not a user-installable extension. */
export function provideExtensionInstallationRepository(
  persistence: ExtensionInstallationPersistence,
): Plugin {
  return class ProvidedExtensionInstallationRepository extends ExtensionInstallationRepository {
    static readonly displayName = "opencraft.extension-installation-repository";

    constructor(context: Context) {
      super(context, persistence);
    }
  };
}

export class MemoryExtensionInstallationPersistence implements ExtensionInstallationPersistence {
  private values: unknown[];

  constructor(seed: readonly unknown[] = []) {
    this.values = structuredClone([...seed]);
  }

  async load(): Promise<readonly unknown[]> {
    return structuredClone(this.values);
  }

  async put(value: ExtensionInstallationRecord): Promise<void> {
    this.values = [
      ...this.values.filter((candidate) => {
        if (typeof candidate !== "object" || candidate === null) return true;
        return (candidate as { extensionId?: unknown }).extensionId !== value.extensionId;
      }),
      structuredClone(value),
    ];
  }

  async remove(extensionId: string): Promise<void> {
    this.values = this.values.filter((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return true;
      return (candidate as { extensionId?: unknown }).extensionId !== extensionId;
    });
  }
}
