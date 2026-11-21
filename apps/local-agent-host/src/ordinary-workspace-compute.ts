import type { SandboxEnvironment } from "@opencraft/sandbox";
import { OrdinaryWorkspaceStore, type WorkspaceAuthority, type WorkspaceLease } from "./ordinary-workspace-store.js";

/** Private in-process proof that this exact lease never entered provider create.
 * Do not construct from RPC errors, HTTP statuses or SDK "not-created": a 409
 * may still mean another live member. Only the admission allocator may emit it. */
export class OrdinaryWorkspaceAdmissionRejected extends Error {
  private readonly lease: WorkspaceLease;
  constructor(lease: WorkspaceLease) { super("Workspace admission rejected before provider create"); this.lease = { ...lease }; }
  matches(lease: WorkspaceLease) { return this.lease.workspaceId === lease.workspaceId
    && this.lease.generation === lease.generation && this.lease.owner === lease.owner; }
}

export interface WorkspaceAllocation {
  /** Private provider receipt, never accepted from a renderer. */
  instanceId: string;
  /** Verified retained storage identity; never learned from a recovery lookup. */
  privateVolumeId?: string;
  environment: SandboxEnvironment;
  /** Resolves only when compute deletion and its admission-budget release are confirmed. */
  close(): Promise<void>;
}
/** Controller above the provider, below authenticated ordinary-thread admission.
 * No automatic retry/replay, workspace replacement, or ownership-based kill on restart. */
export class OrdinaryWorkspaceCompute {
  private closed = false;
  private closing?: Promise<void>;
  private pending = new Set<Promise<unknown>>();
  private active = new Map<string, WorkspaceAllocation>();
  private uncertain = new Set<string>();
  constructor(private readonly store: OrdinaryWorkspaceStore) {}
  async create(options: {
    authority: WorkspaceAuthority;
    workspaceId: string;
    authorize(): Promise<void>;
    allocate(lease: WorkspaceLease): Promise<WorkspaceAllocation>;
  }): Promise<WorkspaceAllocation> {
    const authorize = async () => {
      if (this.closed) throw Error("Workspace compute owner closed");
      await options.authorize();
      if (this.closed) throw Error("Workspace compute owner closed");
    };
    await authorize();
    // Synchronous durable claim before calling the remote API.
    const lease = this.store.beginCreate(options.authority, options.workspaceId);
    const launch = (async () => {
      let allocation: WorkspaceAllocation | undefined;
      try {
        allocation = await options.allocate(lease);
        if (allocation.privateVolumeId !== undefined) this.store.recordProviderReceipt(options.authority, lease, {
          instanceId: allocation.instanceId, privateVolumeId: allocation.privateVolumeId,
        });
        await authorize();
        this.store.confirmCreated(options.authority, lease, allocation.instanceId);
        let retiring = false, cleanup: Promise<void> | undefined;
        const raw = allocation;
        const owned: WorkspaceAllocation = {
          instanceId: raw.instanceId,
          ...(raw.privateVolumeId !== undefined ? { privateVolumeId: raw.privateVolumeId } : {}),
          environment: { resources: raw.environment.resources, capabilities: raw.environment.capabilities,
            ...(raw.environment.processLimits ? { processLimits: raw.environment.processLimits } : {}),
            // Forward a weaker guarantee; dropping it would upgrade the environment to full enforcement.
            ...(raw.environment.enforcement ? { enforcement: raw.environment.enforcement } : {}),
            spawn: async (command, output) => {
              await authorize();
              const current = this.store.read(options.authority, lease.workspaceId);
              if (retiring || current.phase !== "live" || current.generation !== lease.generation) throw Error("Workspace compute is closing");
              const child = await raw.environment.spawn(command, output);
              try {
                await authorize();
                const current = this.store.read(options.authority, lease.workspaceId);
                if (retiring || current.phase !== "live" || current.generation !== lease.generation) throw Error("Workspace compute is closing");
              }
              catch (error) { try { await child.terminate(); } finally { throw error; } }
              return child;
            }, close: () => owned.close() },
          close: () => cleanup ??= (async () => {
            retiring = true;
            // Even if journal writes fail, still attempt cleanup of this exact
            // allocation; do not leave remote compute because its DB is unavailable.
            let journalError: unknown;
            try { this.store.beginRelease(options.authority, lease); } catch (error) { journalError = error; }
            try { await raw.close(); }
            catch (error) {
              this.uncertain.add(lease.owner);
              try { this.store.markUncertain(options.authority, lease); } catch {}
              throw error;
            }
            this.active.delete(lease.owner);
            this.uncertain.delete(lease.owner);
            if (journalError) throw journalError;
            this.store.confirmComputeAbsent(options.authority, lease);
          })(),
        };
        this.active.set(lease.owner, owned); return owned;
      } catch (error) {
        if (!allocation && error instanceof OrdinaryWorkspaceAdmissionRejected && error.matches(lease)) {
          let cancelled = false;
          try { this.store.cancelUnsubmittedCreate(options.authority, lease); cancelled = true; } catch {}
          if (cancelled) throw error;
        }
        // Includes auth loss after create and failure to persist the provider ID.
        // A create rejection (including 409) alone is NOT workspace absence.
        let absent = false;
        if (allocation) try { await allocation.close(); absent = true; } catch {}
        if (!absent) this.uncertain.add(lease.owner);
        try {
          this.store.markUncertain(options.authority, lease);
          if (absent) this.store.confirmComputeAbsent(options.authority, lease);
        } catch {} // Durable creating/live fence remains if the journal is unavailable.
        throw error;
      }
    })();
    this.pending.add(launch);
    try { return await launch; } finally { this.pending.delete(launch); }
  }
  /** Read-only recovery: an existing member, even matching the old owner, is not
   * proof that another Host process is dead. Stop/reclaim requires separate owner
   * lifecycle authorization. A provider inspector must validate the workspace and
   * retained-volume state; a generic HTTP 404 is insufficient proof. */
  async reconcileAbsent(options: {
    authority: WorkspaceAuthority;
    workspaceId: string;
    authorize(): Promise<void>;
    inspect(lease: WorkspaceLease, instanceId: string | null): Promise<"absent" | "present" | "unknown">;
  }): Promise<void> {
    if (this.closed) throw Error("Workspace compute owner closed");
    await options.authorize();
    const row = this.store.read(options.authority, options.workspaceId);
    if (row.phase === "idle") return;
    const lease = { workspaceId: row.workspaceId, generation: row.generation, owner: row.leaseOwner! };
    const result = await options.inspect(lease, row.instanceId);
    await options.authorize();
    if (this.closed) throw Error("Workspace compute owner closed");
    if (result !== "absent") throw Error("Workspace compute still requires reconciliation");
    this.store.markUncertain(options.authority, lease);
    this.store.confirmComputeAbsent(options.authority, lease);
    this.uncertain.delete(lease.owner);
    this.active.delete(lease.owner);
  }
  /** Startup recovery for persistent providers. Legacy rows without a verified
   * volume receipt stay blocked; never adopt a replacement found during lookup. */
  async reconcileRetained(options: {
    authority: WorkspaceAuthority;
    workspaceId: string;
    authorize(): Promise<void>;
    inspect(binding: { workspaceId: string; privateVolumeId: string }): Promise<"absent" | "present" | "unknown">;
  }): Promise<void> {
    return this.reconcileAbsent({ ...options, inspect: async lease => {
      const row = this.store.read(options.authority, lease.workspaceId);
      if (row.generation !== lease.generation || row.leaseOwner !== lease.owner || !row.privateVolumeId) return "unknown";
      return options.inspect({ workspaceId: row.workspaceId, privateVolumeId: row.privateVolumeId });
    } });
  }
  /** Service shutdown must await this before closing the journal. Unknown cleanup
   * rejects shutdown and keeps the durable fence instead of pretending to pause. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      await Promise.allSettled([...this.pending]);
      const outcomes = await Promise.allSettled([...this.active.values()].map(allocation => allocation.close()));
      if (this.uncertain.size || outcomes.some(outcome => outcome.status === "rejected")) throw Error("Workspace compute cleanup unconfirmed");
    })();
  }
}
