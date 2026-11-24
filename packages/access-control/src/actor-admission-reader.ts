import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlDatabase } from "@opencraft/sqlite-node";
import { WorkspaceActorProjection } from "./workspace-actor-projection.js";

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
/** Node reader for the Actor/member projection (`WorkspaceActorProjection`).
 * Main's resource permit additionally attests its installed access policy.
 * Synchronous SQLite over the data directory's `opencraft-server.sqlite`,
 * opened read-only and never migrated: open it only inside a Worker (a vault
 * or execution owner), never a network thread. */
export class WorkspaceActorAuthority {
  private connection: DatabaseSync | undefined;
  private projection: WorkspaceActorProjection | undefined;
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
      if (!this.projection) {
        const connection = new DatabaseSync(join(this.directory, "opencraft-server.sqlite"), { readOnly: true });
        try {
          connection.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
        } catch (error) {
          connection.close();
          throw error;
        }
        this.connection = connection;
        this.projection = new WorkspaceActorProjection(nodeSqlDatabase(connection));
      }
      return this.projection.current(value);
    } catch {
      return false;
    }
  }
  /** See `WorkspaceActorProjection.role`. Call only after `current`. */
  role(actorId: string): "admin" | "member" | null {
    if (this.closed || !this.projection) return null;
    return this.projection.role(actorId);
  }
  /** Whether `role` is `admin`. Call only after `current`. */
  administrator(actorId: string): boolean {
    return this.role(actorId) === "admin";
  }
  close() {
    this.closed = true;
    this.projection = undefined;
    this.connection?.close();
    this.connection = undefined;
  }
}
