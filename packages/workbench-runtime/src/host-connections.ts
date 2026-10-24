import { normalizeHostComposerCommands, type HostComposerCommands, type HostComposerCommand } from "./host-composer-commands";
import { parseRuntimeMachineIdentity, type RuntimeMachineIdentity } from "@opencraft/appserver-protocol";
import { Context, Service, type Fiber, type Plugin } from "@deepseek-ai/cordis";
import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import type { AppServerHostKind } from "@opencraft/appserver-session";

export type HostConnectionPlatform = "web" | "electron" | "expo";
export type HostConnectionIntervention = "authentication-required" | "configuration-required";
export type HostConnectionJson =
  | null
  | boolean
  | number
  | string
  | readonly HostConnectionJson[]
  | { readonly [key: string]: HostConnectionJson };

/**
 * A provider-owned prerequisite that requires user action rather than a retry.
 * The shell may route this to a provider-contributed intervention surface,
 * while ordinary transport failures continue through generic recovery UI.
 */
export class HostConnectionInterventionError extends Error {
  readonly code: HostConnectionIntervention;
  readonly providerId: string;

  constructor(input: {
    readonly code: HostConnectionIntervention;
    readonly providerId: string;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "HostConnectionInterventionError";
    this.code = input.code;
    this.providerId = input.providerId;
  }
}

export function isHostConnectionInterventionError(value: unknown): value is HostConnectionInterventionError {
  if (value instanceof HostConnectionInterventionError) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly name?: unknown; readonly code?: unknown; readonly providerId?: unknown };
  return candidate.name === "HostConnectionInterventionError"
    && (candidate.code === "authentication-required" || candidate.code === "configuration-required")
    && typeof candidate.providerId === "string";
}

export function findHostConnectionInterventionError(value: unknown): HostConnectionInterventionError | null {
  let current = value;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (isHostConnectionInterventionError(current)) return current;
    if (typeof current !== "object" || seen.has(current)) return null;
    seen.add(current);
    current = (current as { readonly cause?: unknown }).cause;
  }
  return null;
}

export interface HostConnectionProviderContext {
  readonly platform: HostConnectionPlatform;
  readonly hostId: string;
  readonly profileRevision: number;
}

export interface HostConnectionPreflightContext {
  /** Provisioning owns this cancellation scope; providers must not retain it. */
  readonly signal: AbortSignal;
}

/**
 * A provider contributes a physical transport and optional Composer command adapter. The caller owns
 * every returned transport and all AppServer/Session/Replica state above it.
 */
export interface HostConnectionProvider<TConfig extends HostConnectionJson = HostConnectionJson> {
  readonly id: string;
  readonly label: string;
  /**
   * Settings page contributed by the same extension for Hosts created by this
   * provider. The shell treats this as navigation metadata only; the provider
   * never owns application routing or presentation.
   */
  readonly settingsPageId?: string;
  readonly composerCommands?: HostComposerCommands;
  readonly targets: readonly HostConnectionPlatform[];
  readonly configVersion: number;
  validate(config: HostConnectionJson, context: HostConnectionProviderContext): TConfig;
  /**
   * Verifies provider-owned control-plane prerequisites before a profile is
   * committed. This must not allocate a physical Host connection that cannot
   * be transferred to the resident Host runtime created after provisioning.
   *
   * Providers without a control-plane verification path omit this hook and
   * receive the generic disposable AppServer initialize preflight.
   */
  preflight?(
    config: TConfig,
    context: HostConnectionProviderContext,
    preflight: HostConnectionPreflightContext,
  ): void | Promise<void>;
  createTransport(config: TConfig, context: HostConnectionProviderContext): DuplexTransport;
}

export interface HostConnectionProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly settingsPageId?: string;
  /** Declarations only; executable adapters remain with the leased provider. */
  readonly composerCommands?: readonly HostComposerCommand[];
  readonly ownerId: string;
  readonly targets: readonly HostConnectionPlatform[];
  readonly configVersion: number;
}

export interface HostConnectionProviderRegistrySnapshot {
  readonly revision: number;
  readonly providers: readonly HostConnectionProviderDescriptor[];
}

export interface HostConnectionProviderLease {
  readonly provider: HostConnectionProvider;
  release(): void;
}

interface ProviderRecord {
  readonly provider: HostConnectionProvider;
  readonly ownerId: string;
  leases: number;
  retiring: boolean;
  retirement: Promise<void> | null;
  resolveRetirement: (() => void) | null;
}

/**
 * Owner-aware contribution registry. Unregistration is published immediately,
 * but the contributing activation is not considered retired until every Host
 * runtime created through it has released its lease.
 */
export class HostConnectionProviderRegistry {
  private readonly records = new Map<string, ProviderRecord>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private closed = false;
  private snapshot: HostConnectionProviderRegistrySnapshot = { revision: 0, providers: [] };

  getSnapshot = (): HostConnectionProviderRegistrySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  register(ownerId: string, provider: HostConnectionProvider): () => Promise<void> {
    this.ensureOpen();
    const normalizedOwner = ownerId.trim();
    const providerId = provider.id.trim();
    const settingsPageId = provider.settingsPageId?.trim();
    if (normalizedOwner.length === 0) throw new RangeError("Connection provider owner ID must not be empty");
    if (providerId.length === 0) throw new RangeError("Connection provider ID must not be empty");
    if (provider.label.trim().length === 0) throw new RangeError(`Connection provider ${providerId} has no label`);
    if (provider.settingsPageId !== undefined && settingsPageId?.length === 0) {
      throw new RangeError(`Connection provider ${providerId} has an empty settings page ID`);
    }
    if (provider.targets.length === 0) throw new RangeError(`Connection provider ${providerId} has no target`);
    if (!Number.isSafeInteger(provider.configVersion) || provider.configVersion < 1) {
      throw new RangeError(`Connection provider ${providerId} has an invalid config version`);
    }
    if (this.records.has(providerId)) throw new Error(`Connection provider ${providerId} is already registered`);
    const composerCommands = provider.composerCommands === undefined
      ? undefined : normalizeHostComposerCommands(provider.composerCommands);
    const record: ProviderRecord = {
      provider: {
        ...provider,
        id: providerId,
        ...(composerCommands === undefined ? {} : { composerCommands }),
        ...(settingsPageId === undefined ? {} : { settingsPageId }),
      },
      ownerId: normalizedOwner,
      leases: 0,
      retiring: false,
      retirement: null,
      resolveRetirement: null,
    };
    this.records.set(providerId, record);
    this.publish();
    return () => this.retire(record);
  }

  acquire(providerId: string, platform: HostConnectionPlatform): HostConnectionProviderLease {
    this.ensureOpen();
    const record = this.records.get(providerId);
    if (record === undefined || record.retiring) {
      throw new Error(`Connection provider ${providerId} is unavailable`);
    }
    if (!record.provider.targets.includes(platform)) {
      throw new Error(`Connection provider ${providerId} does not support ${platform}`);
    }
    record.leases += 1;
    let released = false;
    return {
      provider: record.provider,
      release: () => {
        if (released) return;
        released = true;
        record.leases -= 1;
        if (record.leases < 0) throw new Error(`Connection provider ${providerId} lease underflow`);
        if (record.retiring && record.leases === 0) {
          record.resolveRetirement?.();
          record.resolveRetirement = null;
        }
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const records = [...this.records.values()];
    this.records.clear();
    this.publish(true);
    await Promise.all(records.map((record) => this.retireDetached(record)));
    this.listeners.clear();
  }

  private retire(record: ProviderRecord): Promise<void> {
    if (record.retiring) return record.retirement ?? Promise.resolve();
    if (this.records.get(record.provider.id) === record) {
      this.records.delete(record.provider.id);
      this.publish();
    }
    return this.retireDetached(record);
  }

  private retireDetached(record: ProviderRecord): Promise<void> {
    if (record.retiring) return record.retirement ?? Promise.resolve();
    record.retiring = true;
    if (record.leases === 0) return Promise.resolve();
    record.retirement = new Promise<void>((resolve) => {
      record.resolveRetirement = resolve;
    });
    return record.retirement;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Connection provider registry is closed");
  }

  private publish(whileClosing = false): void {
    this.revision += 1;
    this.snapshot = {
      revision: this.revision,
      providers: [...this.records.values()].map((record) => Object.freeze({
        id: record.provider.id,
        label: record.provider.label,
        ...(record.provider.settingsPageId === undefined
          ? {}
          : { settingsPageId: record.provider.settingsPageId }),
        ownerId: record.ownerId,
        targets: [...record.provider.targets],
        configVersion: record.provider.configVersion,
        ...(record.provider.composerCommands === undefined ? {} : { composerCommands: record.provider.composerCommands.commands }),
      })),
    };
    if (this.closed && !whileClosing) return;
    for (const listener of this.listeners) listener();
  }
}

export interface HostConnectionProfile {
  readonly machineIdentity?: RuntimeMachineIdentity | null;
  readonly agent?: "OpenCraft" | "Codex" | null;
  readonly hostId: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly providerConfig: HostConnectionJson;
  readonly providerConfigVersion: number;
  readonly hostKind: AppServerHostKind;
  readonly enabled: boolean;
  readonly autoConnect: boolean;
  readonly includeInSidebar: boolean;
  readonly credentialRef: string | null;
  readonly transportEndpoint: string | null;
  readonly executionLocation: string | null;
  readonly workspaceBrowseRoots: readonly string[];
  readonly revision: number;
}

/** Trusted extension channel for an ephemeral, activation-owned startup Host. */
export const HOST_PROFILE_CONTRIBUTION_CHANNEL = "hostConnectionProfile";

export interface HostConnectionProfileContribution {
  readonly profile: HostConnectionProfile;
}

/** Declarative, provider-neutral Host creation request used by trusted views. */
export interface ProvisionHostInput {
  readonly hostId?: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly providerConfig: HostConnectionJson;
  readonly hostKind?: AppServerHostKind;
  readonly autoConnect?: boolean;
  readonly includeInSidebar?: boolean;
  readonly credentialRef?: string | null;
  readonly transportEndpoint?: string | null;
  readonly executionLocation?: string | null;
  readonly workspaceBrowseRoots?: readonly string[];
}

export interface HostConnectionProfileSnapshot {
  readonly revision: number;
  readonly profiles: readonly HostConnectionProfile[];
}

export interface HostConnectionProfileStore {
  getSnapshot(): HostConnectionProfileSnapshot;
  subscribe(listener: () => void): () => void;
  put(profile: HostConnectionProfile): Promise<void>;
  recordMachineIdentity?(hostId: string, identity: RuntimeMachineIdentity | null, agent?: "OpenCraft" | "Codex" | null): Promise<void>;
  remove(hostId: string): Promise<boolean>;
  close(): void;
}

const appServerHostKinds = new Set<AppServerHostKind>([
  "local",
  "remote-ssh",
  "durable",
  "remote-control",
  "wsl",
]);

function assertJson(value: unknown, path = "providerConfig"): asserts value is HostConnectionJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${path} contains a non-finite number`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJson(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) assertJson(entry, `${path}.${key}`);
    return;
  }
  throw new TypeError(`${path} is not JSON data`);
}

/** Runtime boundary for IndexedDB, manifest, and extension-supplied profiles. */
export function normalizeHostConnectionProfile(value: unknown): HostConnectionProfile {
  if (typeof value !== "object" || value === null) throw new TypeError("Host connection profile must be an object");
  const candidate = value as Record<string, unknown>;
  const requiredString = (key: string): string => {
    const entry = candidate[key];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError(`Host connection profile requires ${key}`);
    }
    return entry.trim();
  };
  const optionalString = (key: string): string | null => {
    const entry = candidate[key];
    if (entry === null || entry === undefined) return null;
    if (typeof entry !== "string") throw new TypeError(`Host connection profile ${key} must be a string or null`);
    const normalized = entry.trim();
    return normalized.length === 0 ? null : normalized;
  };
  const requiredBoolean = (key: string): boolean => {
    const entry = candidate[key];
    if (typeof entry !== "boolean") throw new TypeError(`Host connection profile ${key} must be boolean`);
    return entry;
  };
  const requiredVersion = (key: string, minimum: number): number => {
    const entry = candidate[key];
    if (!Number.isSafeInteger(entry) || (entry as number) < minimum) {
      throw new TypeError(`Host connection profile ${key} must be an integer >= ${minimum}`);
    }
    return entry as number;
  };
  const providerConfig = candidate.providerConfig;
  assertJson(providerConfig);
  const hostKind = candidate.hostKind;
  if (typeof hostKind !== "string" || !appServerHostKinds.has(hostKind as AppServerHostKind)) {
    throw new TypeError("Host connection profile has an unsupported hostKind");
  }
  if (!Array.isArray(candidate.workspaceBrowseRoots)) {
    throw new TypeError("Host connection profile workspaceBrowseRoots must be an array");
  }
  const workspaceBrowseRoots = [...new Set(candidate.workspaceBrowseRoots.map((root) => {
    if (typeof root !== "string" || root.trim().length === 0) {
      throw new TypeError("Host connection profile contains an invalid workspace root");
    }
    return root.trim();
  }))];
  return Object.freeze({
    agent: candidate.agent === "OpenCraft" || candidate.agent === "Codex" ? candidate.agent : null,
    machineIdentity: candidate.machineIdentity == null ? null : parseRuntimeMachineIdentity(candidate.machineIdentity),
    hostId: requiredString("hostId"),
    displayName: requiredString("displayName"),
    providerId: requiredString("providerId"),
    providerConfig: structuredClone(providerConfig),
    providerConfigVersion: requiredVersion("providerConfigVersion", 1),
    hostKind: hostKind as AppServerHostKind,
    enabled: requiredBoolean("enabled"),
    autoConnect: requiredBoolean("autoConnect"),
    includeInSidebar: requiredBoolean("includeInSidebar"),
    credentialRef: optionalString("credentialRef"),
    transportEndpoint: optionalString("transportEndpoint"),
    executionLocation: optionalString("executionLocation"),
    workspaceBrowseRoots: Object.freeze(workspaceBrowseRoots),
    revision: requiredVersion("revision", 0),
  });
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    hostConnectionProviders: HostConnectionProviderRegistryService;
  }
}

export class HostConnectionProviderRegistryService extends Service {
  private readonly registry = new HostConnectionProviderRegistry();

  constructor(ctx: Context) {
    super(ctx, "hostConnectionProviders");
    ctx.effect(() => () => this.registry.close());
  }

  getSnapshot = (): HostConnectionProviderRegistrySnapshot => this.registry.getSnapshot();
  subscribe = (listener: () => void): (() => void) => this.registry.subscribe(listener);
  register(ownerId: string, provider: HostConnectionProvider): () => Promise<void> {
    return this.registry.register(ownerId, provider);
  }
  acquire(providerId: string, platform: HostConnectionPlatform): HostConnectionProviderLease {
    return this.registry.acquire(providerId, platform);
  }
}

export interface CordisHostConnectionProviderRuntime {
  readonly context: Context;
  readonly providers: HostConnectionProviderRegistryService;
  install(plugin: Plugin, config?: unknown): Promise<Fiber>;
  dispose(): Promise<void>;
}

export async function createCordisHostConnectionProviderRuntime(
  context: Context = new Context(),
): Promise<CordisHostConnectionProviderRuntime> {
  const fibers: Fiber[] = [];
  const install = async (plugin: Plugin, config?: unknown): Promise<Fiber> => {
    const fiber = config === undefined ? context.plugin(plugin) : context.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
    return fiber;
  };
  await install(HostConnectionProviderRegistryService);
  return {
    context,
    providers: context.hostConnectionProviders,
    install,
    async dispose() {
      const failures: unknown[] = [];
      for (const fiber of fibers.splice(0).reverse()) {
        try {
          await fiber.dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to dispose Host connection providers");
      }
    },
  };
}
