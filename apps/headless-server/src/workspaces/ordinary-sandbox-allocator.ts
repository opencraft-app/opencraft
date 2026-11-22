import {
  createSandboxPool,
  SandboxCreationFault,
  type SandboxBackend,
  type SandboxPool,
  type SandboxPoolPolicy,
} from "@opencraft/sandbox";
import type { PersistentWorkspaceProvider } from "@opencraft/sandbox/providers";
import type { SandboxInstallation } from "@opencraft/plugin-assets/server/sandbox-installations";
import {
  OrdinaryWorkspaceAdmissionRejected,
  type WorkspaceAllocation,
} from "@opencraft/local-agent-host/ordinary-workspace-compute";
import type { WorkspaceLease } from "@opencraft/local-agent-host/ordinary-workspace-store";
import type { ResolvedWorkspaceSelection } from "@opencraft/execution-environment/workspace-selection";
import { InstalledOrdinaryEnvironmentCatalog, type OrdinaryCatalogContext } from "./ordinary-environment-catalog";
import type { HeadlessSandboxProviders } from "../sandbox-providers.js";

type Admission = {
  context: OrdinaryCatalogContext;
  environment: ResolvedWorkspaceSelection["environment"];
  lease: WorkspaceLease;
  authorize(): Promise<void>;
  onLost(): void;
};
type Runtime = ReturnType<InstalledOrdinaryEnvironmentCatalog["runtime"]>;
type Entry = {
  runtime: Runtime;
  persistent: PersistentWorkspaceProvider<SandboxInstallation>;
  lease: WorkspaceLease;
  authorize(): Promise<void>;
  onLost(): void;
  providerCreateStarted: boolean;
  receipt?: { instanceId: string; privateVolumeId: string };
};
const unavailable = () => Error("ordinary_workspace_allocation_unavailable");

/** Worker-owned pool shared across ordinary templates/users. The compiled
 * provider wrapper also charges the sole installed Bot/ordinary global budget.
 * No retry, fresh workspace ID, or killing an unknown member to bypass a 409. */
export class InstalledOrdinarySandboxAllocator {
  private pool?: Promise<SandboxPool>;
  private capacity?: string;
  private policy?: SandboxPoolPolicy;
  private stopped = false;
  private closing?: Promise<void>;
  private entries = new Map<string, Entry>();
  private backends = new Set<SandboxBackend>();
  constructor(
    private readonly catalog: InstalledOrdinaryEnvironmentCatalog,
    private readonly dependencies: {
      /** Deployment-registered providers; the installation's backend selects one. */
      providers: HeadlessSandboxProviders;
      /** Composition wrapper around each provider backend (for example the global budget). */
      wrap?: (backend: SandboxBackend) => SandboxBackend;
    },
  ) {}
  private ready(runtime: Runtime) {
    const backendId = runtime.installation.backend;
    // One pool per Worker: a different provider or budget fails closed rather than sharing it.
    const key = JSON.stringify([runtime.policy.capacity.cpuMillis, runtime.policy.capacity.memoryBytes, backendId]);
    if (this.stopped || (this.capacity && this.capacity !== key)) throw unavailable();
    if (!this.pool) {
      this.capacity = key;
      this.policy = {
        id: "ordinary-" + backendId,
        capacity: runtime.policy.capacity,
        defaults: runtime.template.resources,
        queueLimit: 0,
      };
      const backend: SandboxBackend = {
        id: backendId,
        initialize: async () => {},
        create: async (identity, resources, signal) => {
          const entry = this.entries.get(identity.owner);
          if (!entry || this.stopped) throw new SandboxCreationFault("not-created");
          const { runtime } = entry;
          const created = this.dependencies.providers.resolve(runtime.installation).createBackend({
            installation: runtime.installation,
            readSecret: runtime.readSecret,
            templateId: runtime.templateId,
            ...(runtime.template.python === undefined ? {} : { python: runtime.template.python }),
            readWorkspaceId: async () => {
              await entry.authorize();
              return entry.lease.workspaceId;
            },
            timeoutMs: runtime.policy.lease.timeoutMs,
            requestTimeoutMs: 15000,
            onCreated: async (receipt) => {
              if (receipt.workspaceId !== entry.lease.workspaceId || receipt.identity.owner !== identity.owner)
                throw unavailable();
              entry.receipt = await entry.persistent.receipt({
                installation: runtime.installation,
                readSecret: runtime.readSecret,
                authorize: entry.authorize,
                workspaceId: entry.lease.workspaceId,
                instanceId: receipt.instanceId,
              });
            },
            lease: { ...runtime.policy.lease, authorize: entry.authorize, onLost: entry.onLost },
          });
          const provider = this.dependencies.wrap?.(created) ?? created;
          this.backends.add(provider);
          let submitted = false;
          try {
            await entry.authorize();
            await provider.initialize(this.policy!, signal);
            submitted = true;
            entry.providerCreateStarted = true;
            const environment = await provider.create(identity, resources, signal);
            let closing: Promise<void> | undefined;
            return {
              ...environment,
              close: () =>
                (closing ??= (async () => {
                  await environment.close();
                  await provider.close();
                  this.backends.delete(provider);
                })()),
            };
          } catch (error) {
            await provider.close();
            this.backends.delete(provider);
            if (!submitted) throw new SandboxCreationFault("not-created");
            throw error;
          }
        },
        close: async () => {
          const results = await Promise.allSettled([...this.backends].map((b) => b.close()));
          if (results.some((r) => r.status === "rejected")) throw unavailable();
          this.backends.clear();
        },
      };
      this.pool = createSandboxPool(this.policy, backend);
    }
    return this.pool;
  }
  async allocate(input: Admission): Promise<WorkspaceAllocation> {
    const lease = { ...input.lease };
    if (
      !/^ws-[a-f0-9]{32}$/.test(lease.workspaceId) ||
      !/^ordinary-[a-f0-9]{64}$/.test(lease.owner) ||
      !Number.isSafeInteger(lease.generation) ||
      lease.generation < 1 ||
      this.entries.has(lease.owner)
    )
      throw unavailable();
    let runtime: Runtime, persistent: PersistentWorkspaceProvider<SandboxInstallation>;
    try {
      runtime = this.catalog.runtime(input.context, input.environment);
      // A provider without the persistent-workspace capability is never selected here.
      persistent = this.dependencies.providers.persistent(runtime.installation);
    } catch {
      throw new OrdinaryWorkspaceAdmissionRejected(lease);
    }
    let lost = false;
    const authorize = async () => {
      if (this.stopped || lost) throw unavailable();
      await input.authorize();
      await runtime.authorize();
      if (this.stopped || lost) throw unavailable();
    };
    const entry: Entry = {
      runtime,
      persistent,
      lease,
      authorize,
      providerCreateStarted: false,
      onLost: () => {
        lost = true;
        input.onLost();
      },
    };
    // Reserve synchronously before the first await, including shutdown/duplicates.
    this.entries.set(lease.owner, entry);
    let retain = false;
    try {
      await authorize();
      const pool = await this.ready(runtime);
      const sandbox = await pool.createSandbox({ owner: lease.owner, resources: runtime.template.resources });
      try {
        await authorize();
        if (!entry.receipt) throw unavailable();
        retain = true;
        return {
          ...entry.receipt,
          environment: sandbox,
          close: async () => {
            await sandbox.close();
            this.entries.delete(lease.owner);
          },
        };
      } catch (error) {
        try {
          await sandbox.close();
        } catch (cleanup) {
          retain = true;
          throw cleanup;
        }
        throw error;
      }
    } catch (error) {
      if (!entry.providerCreateStarted) throw new OrdinaryWorkspaceAdmissionRejected(lease);
      if (error instanceof SandboxCreationFault && error.outcome === "unknown") retain = true;
      throw error;
    } finally {
      if (!retain) this.entries.delete(lease.owner);
    }
  }
  async inspect(
    context: OrdinaryCatalogContext,
    environment: ResolvedWorkspaceSelection["environment"],
    binding: { workspaceId: string; privateVolumeId: string },
    authorize: () => Promise<void>,
  ) {
    const runtime = this.catalog.runtime(context, environment);
    return this.dependencies.providers.persistent(runtime.installation).inspect({
      installation: runtime.installation,
      readSecret: runtime.readSecret,
      binding: { ...binding },
      authorize: async () => {
        if (this.stopped) throw unavailable();
        await authorize();
        await runtime.authorize();
      },
    });
  }
  /** The selected provider verifies its own volume mounts in the live environment. */
  async verifyMounts(
    context: OrdinaryCatalogContext,
    environment: ResolvedWorkspaceSelection["environment"],
    input: Omit<Parameters<PersistentWorkspaceProvider<SandboxInstallation>["verifyMounts"]>[0], "installation" | "readSecret">,
  ) {
    const runtime = this.catalog.runtime(context, environment);
    return this.dependencies.providers.persistent(runtime.installation).verifyMounts({
      ...input,
      installation: runtime.installation,
      readSecret: runtime.readSecret,
    });
  }
  close() {
    return (this.closing ??= (async () => {
      this.stopped = true;
      await (await this.pool)?.close();
    })());
  }
}
