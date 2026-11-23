import type { ActorStore } from "./actors.js";
import type { MembershipStore, InstanceAccess } from "./index.js";
import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { Principal } from "@opencraft/identity-core";
import type { WorkspaceActorAdmission } from "./actor-admission-reader.js";

type Resource = { actorId: string; generation: number; revision: number; permit: Int32Array<SharedArrayBuffer> };
type Access = Pick<InstanceAccess, "admitsActor">;
export type ActorAdmissionOptions = {
  /** The Gateway's in-memory Actor projection. */
  actors: Pick<ActorStore, "get" | "isCurrent" | "bindings" | "onAuthorityChanged">;
  membership: Pick<MembershipStore, "revocationRevision" | "onAuthorityChanged">;
  /** Instance policy; a function when it is created after the identity. While
   * it returns nothing, no proof is issued and issued resource permits retire. */
  access: Access | (() => Access | undefined);
};
const flag = () => {
  const value = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(value, 0, 1);
  return value;
};
const PRINCIPAL_LIFETIME = 120_000,
  RESOURCE_LIFETIME = 30_000;

/** Trusted Gateway composition; never accepts an HTTP body or Native wire actor.
 * Actor/member mutations monotonically retire resource permits. Request expiry
 * and View cancellation are deliberately not the lifetime of published compute. */
export class ActorAdmission {
  private readonly resources = new Map<string, Resource>();
  private readonly disposers: (() => void)[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(protected readonly options: ActorAdmissionOptions) {
    this.disposers.push(
      options.actors.onAuthorityChanged(this.refresh),
      options.membership.onAuthorityChanged(this.refresh),
    );
    // Same bounded policy observation cadence as InstanceAccess.watch. The
    // Worker independently checks committed Actor/member revocation every IO.
    this.timer = setInterval(this.refresh, 500);
    this.timer.unref();
  }
  private access(): Access | undefined {
    const { access } = this.options;
    return typeof access === "function" ? access() : access;
  }
  private current(resource: Resource): boolean {
    try {
      const { actors, membership } = this.options,
        actor = actors.get(resource.actorId);
      return (
        !this.closed &&
        actor?.kind === "human" &&
        actor.enabled &&
        actor.generation === resource.generation &&
        this.access()?.admitsActor(resource.actorId) === true &&
        membership.revocationRevision(resource.actorId, actors.bindings(resource.actorId)) === resource.revision
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
  /** The authenticated transport request context; its request permit is per call. */
  readonly admit = (context: TransportSubmissionContext): WorkspaceActorAdmission => {
    this.refresh();
    const actor = context.actorContext;
    context.resourceOwner?.assertCurrent();
    if (this.closed || !actor || !this.options.actors.isCurrent(actor)) throw Error("Workspace Actor unavailable");
    const expiresAt = Math.min(actor.expiresAt, context.validUntil ?? actor.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw Error("Workspace request expired");
    return this.capture(actor.actorId, actor.generation, expiresAt);
  };
  /** Compiled durable-resource composition only, valid for 30 seconds. The caller
   * must independently authorize the stored grant; this does not authenticate a
   * login. With `generation` the proof is pinned to that recorded Actor epoch. */
  readonly admitResource = (actorId: string, generation?: number): WorkspaceActorAdmission =>
    this.admitHuman(actorId, generation, Date.now() + RESOURCE_LIFETIME);
  protected admitHuman(actorId: string, generation: number | undefined, expiresAt: number): WorkspaceActorAdmission {
    this.refresh();
    const actor = this.options.actors.get(actorId);
    if (
      this.closed ||
      !actor ||
      actor.kind !== "human" ||
      !actor.enabled ||
      (generation !== undefined && actor.generation !== generation)
    )
      throw Error("Workspace resource Actor unavailable");
    return this.capture(actor.id, actor.generation, expiresAt);
  }
  private capture(actorId: string, generation: number, expiresAt: number): WorkspaceActorAdmission {
    const revision = this.options.membership.revocationRevision(actorId, this.options.actors.bindings(actorId));
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
  readonly close = () => {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const dispose of this.disposers) dispose();
    this.refresh();
  };
}

export type OpenActorAdmissionOptions = Omit<ActorAdmissionOptions, "actors"> & {
  actors: ActorAdmissionOptions["actors"] & Pick<ActorStore, "findHuman">;
};
export type LoginPrincipal = Pick<Principal, "provider" | "subject" | "expiresAt">;

class PrincipalActorAdmission extends ActorAdmission {
  constructor(private readonly principals: OpenActorAdmissionOptions) {
    super(principals);
  }
  /** One authenticated login principal, resolved through its identity binding;
   * valid until the login expires, at most 120 seconds. The request permit is
   * the caller's to retire when the request ends. */
  readonly admitPrincipal = (
    principal: LoginPrincipal | null | undefined,
    options: { provider?: string } = {},
  ): WorkspaceActorAdmission => {
    const now = Date.now();
    if (
      !principal ||
      (options.provider !== undefined && principal.provider !== options.provider) ||
      !Number.isSafeInteger(principal.expiresAt) ||
      principal.expiresAt <= now
    )
      throw Error("Workspace Actor unavailable");
    const actor = this.principals.actors.findHuman(principal);
    if (!actor) throw Error("Workspace Actor unavailable");
    return this.admitHuman(actor.id, actor.generation, Math.min(principal.expiresAt, now + PRINCIPAL_LIFETIME));
  };
}
export type OpenedActorAdmission = Pick<
  PrincipalActorAdmission,
  "admit" | "admitPrincipal" | "admitResource" | "close"
>;

/** The Human proof (`WorkspaceActorAdmission`) an Assets vault Worker rechecks,
 * for a trusted composition that owns its vault Worker with or without
 * workspace execution. Gateway main thread only. */
export function openActorAdmission(options: OpenActorAdmissionOptions): OpenedActorAdmission {
  const admission = new PrincipalActorAdmission(options);
  return {
    admit: admission.admit,
    admitPrincipal: admission.admitPrincipal,
    admitResource: admission.admitResource,
    close: admission.close,
  };
}
