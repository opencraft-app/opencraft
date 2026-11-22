import { membershipRevocationRevision } from "@opencraft/access-control/membership-revocation";
import { ownedDatabasePath } from "@opencraft/opencraft-daemon/owned-database-path";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
export type GitExecutionQuery = {
  hostId: string;
  threadId: string | null;
  inputId?: string;
  executionId?: string;
  turnId?: string;
  incarnation?: string;
};
/** Read-only, Worker-side projection of existing execution/Actor/member truth.
 * Opens no replacement store, runs no migration and writes no identity or lease. */
export class GitExecutionAuthority {
  private readonly leaseStores = new Map<string, DatabaseSync>();
  private actors: DatabaseSync | undefined;
  private closed = false;
  constructor(
    private readonly directory: string,
    private readonly accountMode: "principal" | "actor" = "principal",
  ) {}
  resolve(scope: GitExecutionQuery | undefined): {
    account: string;
    principal: { provider: string; subject: string; loginName?: string };
    authority: string;
    generation: number;
    actorGeneration?: number;
    membershipRevision?: number;
    executionId: string;
    turnId: string;
    incarnation: string;
  } | null {
    if (this.closed) throw Error("git_authority_store_unavailable");
    if (
      !scope?.threadId ||
      (!scope.inputId && !scope.turnId) ||
      !["local-codex", "opencraft-server"].includes(scope.hostId)
    )
      return null;
    try {
      const codex = scope.hostId === "local-codex";
      const path = codex
        ? ownedDatabasePath(join(this.directory, "codex"), "opencraft-host-state.sqlite", "codex-host-queue.sqlite")
        : join(this.directory, "thread-identities/opencraft-server/thread-identity.sqlite");
      let db = this.leaseStores.get(path);
      if (!db) {
        db = new DatabaseSync(path, { readOnly: true });
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
        this.leaseStores.set(path, db);
      }
      const row = db
        .prepare(
          `SELECT s.principal_json,s.ownership,s.admission,l.state,l.turn_id,l.engine_incarnation,l.generation,l.execution_id
      FROM execution_leases l JOIN execution_submissions s ON s.thread_id=l.thread_id AND s.input_id=l.input_id
      WHERE l.thread_id=? AND ${scope.inputId ? "l.input_id=?" : "l.turn_id=?"} ${scope.executionId ? "AND l.execution_id=?" : ""} ORDER BY l.generation DESC LIMIT 1`,
        )
        .get(...[scope.threadId, scope.inputId ?? scope.turnId!, ...(scope.executionId ? [scope.executionId] : [])]);
      if (
        !row ||
        row.ownership !== "human" ||
        row.admission !== "accepted" ||
        row.state !== "active" ||
        !row.turn_id ||
        !row.engine_incarnation ||
        (scope.turnId && scope.turnId !== row.turn_id) ||
        (scope.incarnation && scope.incarnation !== row.engine_incarnation)
      )
        return null;
      const principal = JSON.parse(String(row.principal_json));
      if (!this.actors) {
        this.actors = new DatabaseSync(join(this.directory, "opencraft-server.sqlite"), { readOnly: true });
        this.actors.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
      }
      if (
        this.accountMode === "actor" &&
        (!/^human:\/\/[^/]+\/[^/]+$/u.test(principal?.actorId ?? "") ||
          !Number.isSafeInteger(principal.actorGeneration))
      )
        return null;
      const binding = JSON.stringify([principal.provider, principal.subject]);
      const actor = this.actors!.prepare(
        `SELECT a.id,a.kind,a.enabled,${this.accountMode === "actor" ? "a.generation" : "0"} AS actor_generation,m.enabled AS member_enabled FROM actor_bindings b
      JOIN actors a ON a.id=b.actor_id LEFT JOIN actor_members m ON m.actor_id=a.id WHERE b.binding=?`,
      ).get(binding);
      if (!actor || actor.kind !== "human" || actor.enabled !== 1 || actor.member_enabled === 0) return null;
      if (
        this.actors!.prepare(
          `SELECT 1 FROM actor_bindings b JOIN members m ON m.binding=b.binding WHERE b.actor_id=? AND m.enabled=0 LIMIT 1`,
        ).get(actor.id)
      )
        return null;
      if (
        this.accountMode === "actor" &&
        (actor.id !== principal.actorId || actor.actor_generation !== principal.actorGeneration)
      )
        return null;
      const actorEpoch =
        this.accountMode === "actor"
          ? {
              actorGeneration: Number(actor.actor_generation),
              membershipRevision: membershipRevocationRevision(
                this.actors!,
                String(actor.id),
                this.actors!.prepare("SELECT binding FROM actor_bindings WHERE actor_id=?")
                  .all(actor.id)
                  .map((row) => String(row.binding)),
              ),
            }
          : {};
      return {
        ...actorEpoch,
        account: this.accountMode === "actor" ? `actor:${actor.id}` : `${principal.provider}:${principal.subject}`,
        principal,
        executionId: String(row.execution_id),
        turnId: String(row.turn_id),
        incarnation: String(row.engine_incarnation),
        generation: Number(row.generation),
        authority: JSON.stringify([row.turn_id, row.engine_incarnation, row.generation]),
      };
    } catch {
      throw Error("git_authority_store_unavailable");
    }
  }

  unowned(scope: GitExecutionQuery): boolean {
    if (this.closed) throw Error("git_authority_store_unavailable");
    if (!scope.threadId || !scope.inputId || !["local-codex", "opencraft-server"].includes(scope.hostId)) return false;
    const path =
      scope.hostId === "local-codex"
        ? ownedDatabasePath(join(this.directory, "codex"), "opencraft-host-state.sqlite", "codex-host-queue.sqlite")
        : join(this.directory, "thread-identities/opencraft-server/thread-identity.sqlite");
    let db = this.leaseStores.get(path);
    if (!db) {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
      this.leaseStores.set(path, db);
    }
    const row = db
      .prepare(
        `SELECT s.ownership,s.admission,l.state,l.turn_id,l.engine_incarnation FROM execution_leases l JOIN execution_submissions s ON s.thread_id=l.thread_id AND s.input_id=l.input_id WHERE l.thread_id=? AND l.input_id=? ORDER BY l.generation DESC LIMIT 1`,
      )
      .get(scope.threadId, scope.inputId);
    return (
      !!row &&
      row.ownership === "unowned" &&
      row.admission === "accepted" &&
      row.state === "active" &&
      !!row.turn_id &&
      !!row.engine_incarnation
    );
  }
  close() {
    this.closed = true;
    for (const db of this.leaseStores.values()) db.close();
    this.leaseStores.clear();
    this.actors?.close();
    this.actors = undefined;
  }
}
