import type { ActorStore } from "@opencraft/access-control/actors";
import type { MembershipStore, InstanceAccess } from "@opencraft/access-control";
import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { WorkspaceActorAdmission } from "./actor-authority.js";

type Resource = { actorId: string; generation: number; revision: number; permit: Int32Array<SharedArrayBuffer> };
const flag = () => {
  const value = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(value, 0, 1);
  return value;
};
/** Trusted Gateway composition; never accepts an HTTP body or Native wire actor.
 * Actor/member mutations monotonically retire resource permits. Request expiry
 * and View cancellation are deliberately not the lifetime of published compute. */
export class WorkspaceNativeAdmission {
  private readonly resources = new Map<string, Resource>();
  private readonly disposers: (() => void)[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(
    private readonly options: {
      actors: Pick<ActorStore, "get" | "isCurrent" | "bindings" | "onAuthorityChanged">;
      access: Pick<InstanceAccess, "admitsActor"> & {
        store: Pick<MembershipStore, "revocationRevision" | "onAuthorityChanged">;
      };
    },
  ) {
    this.disposers.push(
      options.actors.onAuthorityChanged(this.refresh),
      options.access.store.onAuthorityChanged(this.refresh),
    );
    // Same bounded policy observation cadence as InstanceAccess.watch. The
    // Worker independently checks committed Actor/member revocation every IO.
    this.timer = setInterval(this.refresh, 500);
    this.timer.unref();
  }
  private current(resource: Resource): boolean {
    try {
      const { actors, access } = this.options,
        actor = actors.get(resource.actorId);
      return (
        !this.closed &&
        actor?.kind === "human" &&
        actor.enabled &&
        actor.generation === resource.generation &&
        access.admitsActor(resource.actorId) &&
        access.store.revocationRevision(resource.actorId, actors.bindings(resource.actorId)) === resource.revision
      );
    } catch {
      return false;
    }
  }
  private readonly refresh = () => {
    for (const [key, resource] of this.resources)
      if (!this.current(resource)) {
        Atomics.store(resource.permit, 0, 0);
        this.resources.delete(key);
      }
  };
  readonly admit = (context: TransportSubmissionContext): WorkspaceActorAdmission => {
    this.refresh();
    const actor = context.actorContext;
    context.resourceOwner?.assertCurrent();
    if (this.closed || !actor || !this.options.actors.isCurrent(actor)) throw Error("Workspace Actor unavailable");
    const expiresAt = Math.min(actor.expiresAt, context.validUntil ?? actor.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw Error("Workspace request expired");
    return this.capture(actor.actorId, actor.generation, expiresAt);
  };
  /** Compiled durable-resource composition only. The caller must independently
   * authorize the stored page/Thread grant; this does not authenticate a login. */
  readonly admitResource = (actorId: string): WorkspaceActorAdmission => {
    this.refresh();
    const actor = this.options.actors.get(actorId);
    if (this.closed || !actor || actor.kind !== "human" || !actor.enabled)
      throw Error("Workspace resource Actor unavailable");
    return this.capture(actor.id, actor.generation, Date.now() + 30000);
  };
  private capture(actorId: string, generation: number, expiresAt: number): WorkspaceActorAdmission {
    const revision = this.options.access.store.revocationRevision(actorId, this.options.actors.bindings(actorId));
    const key = JSON.stringify([actorId, generation, revision]);
    let resource = this.resources.get(key);
    if (!resource) {
      if (this.resources.size >= 2048) throw Error("Workspace authority capacity reached");
      resource = { actorId: actorId, generation: generation, revision, permit: flag() };
      if (!this.current(resource)) throw Error("Workspace Actor unavailable");
      this.resources.set(key, resource);
    }
    return {
      actorId: actorId,
      generation: generation,
      membershipRevision: revision,
      expiresAt,
      resourcePermit: resource.permit,
      requestPermit: flag(),
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const dispose of this.disposers) dispose();
    this.refresh();
  }
}
