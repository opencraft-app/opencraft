import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { membershipRevocationRevision } from "@opencraft/access-control/membership-revocation";

/** Private compiled admission from the original authenticated Native request.
 * Resource and request lifetime are separate: closing a View cannot revoke an
 * already published workspace, but cancelling a pending request must stop it. */
export interface WorkspaceActorAdmission {
  readonly actorId: string;
  readonly generation: number;
  readonly membershipRevision: number;
  readonly expiresAt: number;
  readonly resourcePermit: Int32Array<SharedArrayBuffer>;
  readonly requestPermit: Int32Array<SharedArrayBuffer>;
}
const permit = (value: unknown): value is Int32Array<SharedArrayBuffer> =>
  value instanceof Int32Array &&
  value.buffer instanceof SharedArrayBuffer &&
  value.length === 1 &&
  Atomics.load(value, 0) === 1;
export function workspaceAdmission(value: WorkspaceActorAdmission): WorkspaceActorAdmission {
  if (
    !value ||
    Object.keys(value).some(
      (k) =>
        !["actorId", "generation", "membershipRevision", "expiresAt", "resourcePermit", "requestPermit"].includes(k),
    ) ||
    typeof value.actorId !== "string" ||
    !/^human:\/\/[^/]+\/[^/]+$/u.test(value.actorId) ||
    value.actorId.length > 256 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !Number.isSafeInteger(value.membershipRevision) ||
    value.membershipRevision < 0 ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= Date.now() ||
    !permit(value.resourcePermit) ||
    !permit(value.requestPermit)
  )
    throw Error("Workspace admission unavailable");
  return Object.freeze({ ...value });
}
/** Read-only projection of the existing Actor/member owner, not a new identity
 * ledger. Main's resource permit additionally attests its installed access policy. */
export class WorkspaceActorAuthority {
  private db: DatabaseSync | undefined;
  private closed = false;
  constructor(private readonly directory: string) {}
  current(value: WorkspaceActorAdmission, pending: boolean): boolean {
    try {
      if (
        this.closed ||
        !permit(value.resourcePermit) ||
        (pending && (!permit(value.requestPermit) || value.expiresAt <= Date.now()))
      )
        return false;
      if (!this.db) {
        this.db = new DatabaseSync(join(this.directory, "opencraft-server.sqlite"), { readOnly: true });
        this.db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
      }
      const actor = this.db.prepare("SELECT kind,enabled,generation FROM actors WHERE id=?").get(value.actorId);
      const member = this.db.prepare("SELECT enabled FROM actor_members WHERE actor_id=?").get(value.actorId);
      if (
        !actor ||
        actor.kind !== "human" ||
        actor.enabled !== 1 ||
        actor.generation !== value.generation ||
        member?.enabled === 0
      )
        return false;
      const bindings = this.db
        .prepare("SELECT binding FROM actor_bindings WHERE actor_id=?")
        .all(value.actorId)
        .map((r) => String(r.binding));
      if (
        this.db
          .prepare(
            "SELECT 1 FROM actor_bindings b JOIN members m ON m.binding=b.binding WHERE b.actor_id=? AND m.enabled=0 LIMIT 1",
          )
          .get(value.actorId)
      )
        return false;
      return membershipRevocationRevision(this.db, value.actorId, bindings) === value.membershipRevision;
    } catch {
      return false;
    }
  }
  /** Same role projection as instance access: an Actor membership wins;
   * without one, an enabled administrator binding. Call only after `current`. */
  administrator(actorId: string): boolean {
    try {
      if (this.closed || !this.db) return false;
      const member = this.db.prepare("SELECT enabled,role FROM actor_members WHERE actor_id=?").get(actorId);
      if (member) return member.enabled === 1 && member.role === "admin";
      return !!this.db
        .prepare(
          "SELECT 1 FROM actor_bindings b JOIN members m ON m.binding=b.binding WHERE b.actor_id=? AND m.enabled=1 AND m.role='admin' LIMIT 1",
        )
        .get(actorId);
    } catch {
      return false;
    }
  }
  close() {
    this.closed = true;
    this.db?.close();
    this.db = undefined;
  }
}
