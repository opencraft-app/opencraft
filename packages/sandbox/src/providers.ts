import { SandboxFault, type SandboxBackend, type SandboxEnvironment, type SandboxIdentity } from "./contract.js";
import type { SandboxEnvironmentAddress } from "./uri.js";

/** Trusted, secret-free installation record for one provider. `backend` is the
 * registered provider ID; the remaining fields belong to that provider. */
export interface SandboxProviderInstallation {
  readonly backend: string;
}
/** Host-owned inputs for one backend instance. Never accepted from Bot/task input. */
export interface SandboxProviderRequest<I extends SandboxProviderInstallation> {
  readonly installation: I;
  /** Installation-owned secret reader; the secret is never persisted in Bot settings. */
  readSecret(): Promise<string>;
  /** The provider target of the environment URI (`<provider>://<target>`): image,
   * template, Compose service or container class, as the provider defines it. */
  readonly templateId: string;
  /** Absolute interpreter path in the template for providers using the shared broker. */
  readonly python?: string;
  readonly timeoutMs: number;
  readonly requestTimeoutMs: number;
  /** Trusted provider resolves this from an authorized persistent binding. */
  readWorkspaceId?(identity: SandboxIdentity): Promise<string | undefined>;
  /** Private Host lifecycle receipt after remote identity verification. */
  onCreated?(receipt: { identity: SandboxIdentity; workspaceId?: string; instanceId: string }): Promise<void>;
  /** Bounded Host-owned renewal; never resumes or recreates a lost instance. */
  readonly lease?: {
    readonly renewEveryMs: number;
    readonly maxLifetimeMs: number;
    authorize(identity: SandboxIdentity): Promise<void>;
    onLost(identity: SandboxIdentity): void;
  };
}
export type PersistentWorkspaceState = "absent" | "present" | "unknown";
export interface PersistentWorkspaceBinding {
  readonly workspaceId: string;
  /** Stable private volume identity from a previously verified receipt. */
  readonly privateVolumeId: string;
}
interface PersistentWorkspaceAccess<I extends SandboxProviderInstallation> {
  readonly installation: I;
  readSecret(): Promise<string>;
  /** Re-checks current owner/installation authority; rejects when revoked. */
  authorize(): Promise<void>;
}
/** Optional capability: a durable private `/workspace` volume reused by
 * successive compute instances of one workspace. Without it a provider cannot
 * be selected for persistent workspaces. Observations are not allocation locks. */
export interface PersistentWorkspaceProvider<I extends SandboxProviderInstallation> {
  /** After create: confirm the instance is the sole member and read the stable volume ID. */
  receipt(
    input: PersistentWorkspaceAccess<I> & { readonly workspaceId: string; readonly instanceId: string },
  ): Promise<{ instanceId: string; privateVolumeId: string }>;
  /** Point-in-time inspection of an existing binding; any doubt is `unknown`. */
  inspect(input: PersistentWorkspaceAccess<I> & { readonly binding: PersistentWorkspaceBinding }): Promise<PersistentWorkspaceState>;
  /** Verify the live environment actually mounts the declared volumes. Never mounts. */
  verifyMounts(
    input: PersistentWorkspaceAccess<I> & {
      readonly sandbox: Pick<SandboxEnvironment, "spawn">;
      readonly workspaceId: string;
      readonly instanceId: string;
      readonly privateVolumeId: string;
      readonly library?: { readonly volumeId: string; readonly relativePath: string };
      onCleanupUnconfirmed(): void;
    },
  ): Promise<{ cwd: "/workspace"; libraryPath?: string }>;
}
export interface SandboxProviderDefinition<I extends SandboxProviderInstallation> {
  readonly id: I["backend"];
  createBackend(request: SandboxProviderRequest<I>): SandboxBackend;
  /** The provider's own target grammar, checked after the shared URI grammar. */
  acceptsTarget?(target: string): boolean;
  readonly persistentWorkspaces?: PersistentWorkspaceProvider<I>;
}
/** One definition per installation variant, keyed by its discriminant. */
export type SandboxProviderDefinitions<I extends SandboxProviderInstallation> = {
  readonly [K in I["backend"]]?: SandboxProviderDefinition<Extract<I, { backend: K }>>;
};
export interface SandboxProviderRegistry<I extends SandboxProviderInstallation> {
  /** Registered provider IDs, in registration order. */
  ids(): readonly string[];
  /** Whether a backend is registered, optionally with the persistent-workspace capability. */
  supports(backend: string, capability?: "persistentWorkspaces"): boolean;
  /** Fails closed for an unknown or unregistered backend; never falls back. */
  resolve<V extends I>(installation: V): SandboxProviderDefinition<V>;
  /** As resolve(), but also requires the persistent-workspace capability. */
  persistent<V extends I>(installation: V): PersistentWorkspaceProvider<V>;
  /** Selects the provider for an environment URI: the installation must be that
   * provider's and the provider must accept the target. Never falls back. */
  environment<V extends I>(installation: V, address: SandboxEnvironmentAddress): { definition: SandboxProviderDefinition<V>; templateId: string };
}

const unavailable = () => new SandboxFault("SANDBOX_UNAVAILABLE", "Selected execution provider is not registered");

/** Deployment assembly registers providers explicitly; consumers resolve by the
 * configured backend ID. Workspace owners never import a vendor adapter. */
export function createSandboxProviderRegistry<I extends SandboxProviderInstallation>(
  definitions: SandboxProviderDefinitions<I>,
): SandboxProviderRegistry<I> {
  const entries = new Map<string, SandboxProviderDefinition<I>>();
  for (const [id, definition] of Object.entries(definitions) as [string, SandboxProviderDefinition<I> | undefined][]) {
    if (!definition) continue;
    // Short enough to name a per-provider pool (`ordinary-<id>`, 32 characters).
    if (!/^[a-z0-9][a-z0-9-]{0,22}$/u.test(id) || definition.id !== id || typeof definition.createBackend !== "function")
      throw new SandboxFault("SANDBOX_POLICY", "Invalid sandbox provider registration");
    entries.set(id, Object.freeze({ ...definition }));
  }
  const resolve = (installation: I) => {
    const backend = installation?.backend;
    const definition = typeof backend === "string" ? entries.get(backend) : undefined;
    if (!definition) throw unavailable();
    return definition;
  };
  return {
    ids: () => [...entries.keys()],
    supports: (backend, capability) => {
      const definition = entries.get(backend);
      return !!definition && (capability === undefined || !!definition[capability]);
    },
    resolve: <V extends I>(installation: V) => resolve(installation) as unknown as SandboxProviderDefinition<V>,
    environment: <V extends I>(installation: V, address: SandboxEnvironmentAddress) => {
      const definition = resolve(installation);
      if (address?.provider !== installation.backend || typeof address.target !== "string"
        || definition.acceptsTarget && !definition.acceptsTarget(address.target))
        throw new SandboxFault("SANDBOX_POLICY", "Sandbox environment URI does not match its provider installation");
      return { definition: definition as unknown as SandboxProviderDefinition<V>, templateId: address.target };
    },
    persistent: <V extends I>(installation: V) => {
      const capability = resolve(installation).persistentWorkspaces;
      if (!capability) throw unavailable();
      return capability as unknown as PersistentWorkspaceProvider<V>;
    },
  };
}
