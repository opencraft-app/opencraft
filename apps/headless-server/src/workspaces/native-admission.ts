import type { MembershipStore, InstanceAccess } from "@opencraft/access-control";
import { ActorAdmission, type ActorAdmissionOptions } from "./actor-admission.js";

/** Workspace execution's view of the one `ActorAdmission` implementation: the
 * membership projection is the instance access store. */
export class WorkspaceNativeAdmission extends ActorAdmission {
  constructor(options: {
    actors: ActorAdmissionOptions["actors"];
    access: Pick<InstanceAccess, "admitsActor"> & {
      store: Pick<MembershipStore, "revocationRevision" | "onAuthorityChanged">;
    };
  }) {
    super({ actors: options.actors, membership: options.access.store, access: options.access });
  }
}
