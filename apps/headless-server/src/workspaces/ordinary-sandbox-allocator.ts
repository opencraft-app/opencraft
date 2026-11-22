import {
  createSandboxPool,
  SandboxCreationFault,
  type SandboxBackend,
  type SandboxPool,
  type SandboxPoolPolicy,
} from "@opencraft/sandbox";
import {
  e2bSandboxBackend,
  createE2BPersistentWorkspaceInspector,
  type E2BSandboxOptions,
} from "@opencraft/sandbox-e2b";
import {
  OrdinaryWorkspaceAdmissionRejected,
  type WorkspaceAllocation,
} from "@opencraft/local-agent-host/ordinary-workspace-compute";
import type { WorkspaceLease } from "@opencraft/local-agent-host/ordinary-workspace-store";
import type { ResolvedWorkspaceSelection } from "@opencraft/execution-environment/workspace-selection";
import { InstalledOrdinaryEnvironmentCatalog, type OrdinaryCatalogContext } from "./ordinary-environment-catalog";

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
      backend?: (options: E2BSandboxOptions) => SandboxBackend;
      request?: typeof fetch;
    } = {},
  ) {}
  private async metadata(entry: Entry, instanceId: string) {
    await entry.authorize();
    const key = await entry.runtime.readApiKey();
    const response = await (this.dependencies.request ?? fetch)(
      entry.runtime.apiUrl + "/workspaces/" + entry.lease.workspaceId,
      { headers: { "X-API-Key": key }, redirect: "error", signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw unavailable();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let decoded: unknown;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 65536) throw unavailable();
        chunks.push(part.value);
      }
      decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw unavailable();
    const value = decoded as Record<string, unknown>;
    if (
      value.schemaVersion !== 2 ||
      value.workspaceID !== entry.lease.workspaceId ||
      typeof value.privateVolumeID !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.privateVolumeID) ||
      !Array.isArray(value.members) ||
      value.members.length !== 1 ||
      !value.members[0] ||
      typeof value.members[0] !== "object" ||
      value.members[0].sandboxID !== instanceId
    )
      throw unavailable();
    await entry.authorize();
    return { instanceId, privateVolumeId: value.privateVolumeID };
  }
  private ready(runtime: Runtime) {
    const key = JSON.stringify([runtime.policy.capacity.cpuMillis, runtime.policy.capacity.memoryBytes]);
    if (this.stopped || (this.capacity && this.capacity !== key)) throw unavailable();
    if (!this.pool) {
      this.capacity = key;
      this.policy = {
        id: "ordinary-e2b",
        capacity: runtime.policy.capacity,
        defaults: runtime.template.resources,
        queueLimit: 0,
      };
      const backend: SandboxBackend = {
        id: "e2b",
        initialize: async () => {},
        create: async (identity, resources, signal) => {
          const entry = this.entries.get(identity.owner);
          if (!entry || this.stopped) throw new SandboxCreationFault("not-created");
          const { runtime } = entry;
          const provider = (this.dependencies.backend ?? e2bSandboxBackend)({
            apiUrl: runtime.apiUrl,
            sandboxUrl: runtime.sandboxUrl,
            templateId: runtime.templateId,
            python: runtime.template.python,
            readApiKey: runtime.readApiKey,
            readWorkspaceId: async () => {
              await entry.authorize();
              return entry.lease.workspaceId;
            },
            timeoutMs: runtime.policy.lease.timeoutMs,
            requestTimeoutMs: 15000,
            onCreated: async (receipt) => {
              if (receipt.workspaceId !== entry.lease.workspaceId || receipt.identity.owner !== identity.owner)
                throw unavailable();
              entry.receipt = await this.metadata(entry, receipt.instanceId);
            },
            lease: { ...runtime.policy.lease, authorize: entry.authorize, onLost: entry.onLost },
          });
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
    let runtime: Runtime;
    try {
      runtime = this.catalog.runtime(input.context, input.environment);
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
    const inspect = createE2BPersistentWorkspaceInspector(
      {
        apiUrl: runtime.apiUrl,
        readApiKey: runtime.readApiKey,
        authorize: async (workspaceId) => {
          if (this.stopped || workspaceId !== binding.workspaceId) throw unavailable();
          await authorize();
          await runtime.authorize();
        },
      },
      this.dependencies.request ?? fetch,
    );
    return inspect({ ...binding });
  }
  close() {
    return (this.closing ??= (async () => {
      this.stopped = true;
      await (await this.pool)?.close();
    })());
  }
}
