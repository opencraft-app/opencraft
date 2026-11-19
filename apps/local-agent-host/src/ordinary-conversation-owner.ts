import type { SandboxBrowserOwnerTransport } from "./sandbox-browser-owner.js";
import type { WorkspaceExecutionSelection } from "@opencraft/sandbox-node/workspace-execution-channel";
import type { SandboxWorkspaceFiles } from "./sandbox-workspace-files.js";
import type { SandboxProcessService } from "./sandbox-process-service.js";
import { OrdinaryWorkspaceCompute, type WorkspaceAllocation } from "./ordinary-workspace-compute.js";
import { OrdinaryWorkspaceStore, type WorkspaceAuthority, type WorkspaceLease } from "./ordinary-workspace-store.js";
import {
  ordinaryWorkspaceCwd,
  encodeWorkspaceSelection,
  type ResolvedWorkspaceSelection,
} from "./ordinary-workspace-selection.js";
export interface OrdinaryExecutionBinding {
  /** Synchronous incarnation liveness; not a substitute for business admission. */
  isCurrent?(): boolean;
  readonly files?: Pick<SandboxWorkspaceFiles, "request">;
  readonly processes?: SandboxProcessService;
  /** Private, incarnation-owned transport; no user-supplied sandbox/socket IDs. */
  readonly browser?: {
    assertCurrent(): void;
    connect(): Promise<SandboxBrowserOwnerTransport>;
  };
  registerExecutionEnvironment?(
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void>;
  executionSelection?(): Promise<WorkspaceExecutionSelection>;
  bindThread?(threadId: string): Promise<void>;
  executionFields(): Promise<{
    cwd: string;
    runtimeWorkspaceRoots: string[];
    environments: {
      environmentId: string;
      cwd: string;
    }[];
  }>;
  close(): Promise<void>;
}
export interface OrdinaryCreationOptions {
  /** Trusted admission identities, not wire metadata. */
  authority: WorkspaceAuthority;
  intentId: string;
  selection: ResolvedWorkspaceSelection;
  /** Reauthorizes the exact immutable catalog/source snapshot. */
  authorize(selection: ResolvedWorkspaceSelection): Promise<void>;
  allocate(lease: WorkspaceLease, selection: ResolvedWorkspaceSelection): Promise<WorkspaceAllocation>;
  /** Includes source preparation; must clean partial preparation on rejection. */
  prepare(
    allocation: WorkspaceAllocation,
    authorize: () => Promise<void>,
    context: {
      workspaceId: string;
      generation: number;
      environmentId: string;
      threadId?: string;
      /** The prepared transport must signal loss to invalidate/reclaim this incarnation. */
      onLost(): void;
    },
  ): Promise<OrdinaryExecutionBinding>;
  /** Private Native route. Never implement this using a local-fallback transport. */
  nativeStart(
    fields: Awaited<ReturnType<OrdinaryExecutionBinding["executionFields"]>>,
    binding: OrdinaryExecutionBinding,
  ): Promise<unknown>;
}
export interface OrdinaryRestoreOptions
  extends Omit<OrdinaryCreationOptions, "intentId" | "selection" | "nativeStart"> {
  threadId: string;
  /** Read-only provider inspection. Never kill or adopt a live member here. */
  inspect(binding: { workspaceId: string; privateVolumeId: string }): Promise<"absent" | "present" | "unknown">;
  nativeResume(
    threadId: string,
    fields: Awaited<ReturnType<OrdinaryExecutionBinding["executionFields"]>>,
    binding: OrdinaryExecutionBinding,
  ): Promise<unknown>;
}
/** Host lifecycle composition. Product admission and the private Native route must
 * be installed by the deployment; constructing this class does not expose a UI
 * capability. Close this owner before closing its journal. No automatic replay. */
export class OrdinaryConversationOwner {
  private readonly compute: OrdinaryWorkspaceCompute;
  private closed = false;
  private closing?: Promise<void>;
  private pending = new Set<Promise<unknown>>();
  private active = new Set<() => Promise<void>>();
  private cleanupFailed = false;
  private restoring = new Set<string>();
  private bindings = new Map<
    string,
    {
      binding: OrdinaryExecutionBinding;
      authorize(): Promise<void>;
    }
  >();
  private key(authority: WorkspaceAuthority, threadId: string) {
    return JSON.stringify([authority.principalId, authority.hostId, threadId]);
  }
  /** Internal execution router only. Missing/restored bindings fail closed. */
  async bindingFor(authority: WorkspaceAuthority, threadId: string): Promise<OrdinaryExecutionBinding> {
    const key = this.key(authority, threadId),
      current = this.bindings.get(key);
    if (!current) throw Error("Ordinary execution binding unavailable");
    await current.authorize();
    if (this.bindings.get(key) !== current) throw Error("Ordinary execution binding expired");
    return current.binding;
  }
  constructor(private readonly store: OrdinaryWorkspaceStore) {
    this.compute = new OrdinaryWorkspaceCompute(store);
  }
  start(options: OrdinaryCreationOptions): Promise<{
    workspaceId: string;
    threadId: string;
  }> {
    // Copy before the first await: later mutation of a request cannot change identity.
    const authority = { ...options.authority },
      intentId = options.intentId;
    let executionLost = false;
    const snapshot = encodeWorkspaceSelection(options.selection).json;
    const selection = () => JSON.parse(snapshot) as ResolvedWorkspaceSelection;
    const authorize = async () => {
      if (this.closed) throw Error("Ordinary conversation owner closed");
      if (executionLost) throw Error("Ordinary execution transport lost");
      await options.authorize(selection());
      if (this.closed) throw Error("Ordinary conversation owner closed");
      if (executionLost) throw Error("Ordinary execution transport lost");
    };
    const operation = (async () => {
      await authorize();
      const admitted = await this.store.admitResolved(authority, intentId, selection());
      await authorize();
      // A successful duplicate returns its receipt, not another thread/start.
      // Restoring execution for that existing thread is a separate operation.
      if (admitted.threadId) return { workspaceId: admitted.workspaceId, threadId: admitted.threadId };
      let allocation: WorkspaceAllocation | undefined, binding: OrdinaryExecutionBinding | undefined;
      let cleanup: Promise<void> | undefined,
        bindingKey: string | undefined,
        published = false;
      const retire = () =>
        (cleanup ??= (async () => {
          // Bridge/process teardown precedes releasing compute, but a bridge error
          // must not prevent attempting exact-instance deletion.
          if (bindingKey) this.bindings.delete(bindingKey);
          let failed = false;
          try {
            await binding?.close();
          } catch {
            failed = true;
          }
          try {
            await allocation?.close();
          } catch {
            failed = true;
          }
          this.active.delete(retire);
          if (failed) {
            this.cleanupFailed = true;
            throw Error("Ordinary conversation cleanup unconfirmed");
          }
        })());
      try {
        let lease!: WorkspaceLease;
        allocation = await this.compute.create({
          authority,
          workspaceId: admitted.workspaceId,
          authorize,
          allocate: async (claimed) => {
            lease = claimed;
            return options.allocate(claimed, selection());
          },
        });
        binding = await options.prepare(allocation, authorize, {
          workspaceId: admitted.workspaceId,
          generation: lease.generation,
          environmentId: "workspace-" + admitted.workspaceId,
          onLost: () => {
            executionLost = true;
            if (published) void retire().catch(() => {});
          },
        });
        await authorize();
        const fields = await binding.executionFields();
        // Prevent an incorrectly wired binding from silently requesting local execution.
        const expectedCwd = ordinaryWorkspaceCwd(selection());
        if (
          fields.cwd !== expectedCwd ||
          fields.runtimeWorkspaceRoots.length !== 1 ||
          fields.runtimeWorkspaceRoots[0] !== expectedCwd ||
          fields.environments.length !== 1 ||
          fields.environments[0].environmentId !== "workspace-" + admitted.workspaceId ||
          fields.environments[0].cwd !== expectedCwd
        )
          throw Error("Invalid ordinary execution binding");
        await authorize();
        await this.store.beginThreadStart(authority, lease);
        await authorize();
        const response = await options.nativeStart(fields, binding);
        const threadId = (
          response as {
            thread?: {
              id?: unknown;
            };
          } | null
        )?.thread?.id;
        if (typeof threadId !== "string" || !threadId) throw Error("Native thread creation receipt missing");
        // Persist positive evidence even when auth/shutdown changed during the RPC.
        await this.store.confirmThreadStarted(authority, lease, threadId);
        await authorize();
        await binding.bindThread?.(threadId);
        await authorize();
        bindingKey = this.key(authority, threadId);
        this.bindings.set(bindingKey, { binding, authorize });
        this.active.add(retire);
        published = true;
        return { workspaceId: admitted.workspaceId, threadId };
      } catch (error) {
        try {
          await retire();
        } catch {
          throw new AggregateError([error], "Ordinary creation failed; cleanup unconfirmed");
        }
        throw error;
      }
    })();
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  /** Restores execution, never creates/replaces the Native thread or its volume.
   * The stored exact selection must still be authorized; no latest-template/ref
   * substitution. Native sticky environment identity is stable across generations. */
  restore(options: OrdinaryRestoreOptions): Promise<{
    workspaceId: string;
    threadId: string;
  }> {
    const authority = { ...options.authority },
      threadId = options.threadId;
    const key = this.key(authority, threadId);
    const operation = (async () => {
      if (this.closed) throw Error("Ordinary conversation owner closed");
      const row = await this.store.forThread(authority, threadId);
      if (!row) throw Error("Ordinary workspace binding not found");
      let executionLost = false;
      const snapshot = encodeWorkspaceSelection(await this.store.resolvedSelection(authority, row.workspaceId)).json;
      const selection = () => JSON.parse(snapshot) as ResolvedWorkspaceSelection;
      const authorize = async () => {
        if (this.closed) throw Error("Ordinary conversation owner closed");
        if (executionLost) throw Error("Ordinary execution transport lost");
        await options.authorize(selection());
        if (this.closed) throw Error("Ordinary conversation owner closed");
        if (executionLost) throw Error("Ordinary execution transport lost");
      };
      await authorize();
      if (this.bindings.has(key)) {
        await this.bindingFor(authority, threadId);
        return { workspaceId: row.workspaceId, threadId };
      }
      if (this.restoring.has(key)) throw Error("Ordinary workspace restore already pending");
      this.restoring.add(key);
      let allocation: WorkspaceAllocation | undefined, binding: OrdinaryExecutionBinding | undefined;
      let cleanup: Promise<void> | undefined,
        published = false;
      const retire = () =>
        (cleanup ??= (async () => {
          this.bindings.delete(key);
          let failed = false;
          try {
            await binding?.close();
          } catch {
            failed = true;
          }
          try {
            await allocation?.close();
          } catch {
            failed = true;
          }
          this.active.delete(retire);
          if (failed) {
            this.cleanupFailed = true;
            throw Error("Ordinary conversation cleanup unconfirmed");
          }
        })());
      try {
        await this.compute.reconcileRetained({
          authority,
          workspaceId: row.workspaceId,
          authorize,
          inspect: options.inspect,
        });
        let claimedLease!: WorkspaceLease;
        allocation = await this.compute.create({
          authority,
          workspaceId: row.workspaceId,
          authorize,
          allocate: (lease) => {
            claimedLease = lease;
            return options.allocate(lease, selection());
          },
        });
        binding = await options.prepare(allocation, authorize, {
          workspaceId: row.workspaceId,
          generation: claimedLease.generation,
          environmentId: "workspace-" + row.workspaceId,
          threadId,
          onLost: () => {
            executionLost = true;
            if (published) void retire().catch(() => {});
          },
        });
        await authorize();
        const fields = await binding.executionFields();
        const expectedCwd = ordinaryWorkspaceCwd(selection());
        if (
          fields.cwd !== expectedCwd ||
          fields.runtimeWorkspaceRoots.length !== 1 ||
          fields.runtimeWorkspaceRoots[0] !== expectedCwd ||
          fields.environments.length !== 1 ||
          fields.environments[0].environmentId !== "workspace-" + row.workspaceId ||
          fields.environments[0].cwd !== expectedCwd
        )
          throw Error("Invalid ordinary execution binding");
        await authorize();
        const response = await options.nativeResume(threadId, fields, binding);
        if (
          (
            response as {
              thread?: {
                id?: unknown;
              };
            } | null
          )?.thread?.id !== threadId
        )
          throw Error("Native resume receipt conflict");
        await authorize();
        await binding.bindThread?.(threadId);
        await authorize();
        this.bindings.set(key, { binding, authorize });
        this.active.add(retire);
        published = true;
        return { workspaceId: row.workspaceId, threadId };
      } catch (error) {
        try {
          await retire();
        } catch {
          throw new AggregateError([error], "Ordinary restore failed; cleanup unconfirmed");
        }
        throw error;
      } finally {
        this.restoring.delete(key);
      }
    })();
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      await Promise.allSettled([...this.pending]);
      await Promise.allSettled([...this.active].map((retire) => retire()));
      await this.compute.close();
      if (this.cleanupFailed) throw Error("Ordinary conversation cleanup unconfirmed");
    })());
  }
}
