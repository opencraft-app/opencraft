import type { SqlDatabase } from "@opencraft/sql";
import { membershipRevocationRevision } from "./membership-revocation.js";

/** The Actor and membership state a workspace admission was compiled against. */
export interface WorkspaceActorClaim {
  readonly actorId: string;
  readonly generation: number;
  readonly membershipRevision: number;
}

/**
 * Read-only projection of the existing Actor/member owner, not a new identity
 * ledger, over any SQL port that sees the Server core tables: a Node reader's
 * read-only file connection or the owner's own connection. It only reads.
 */
export class WorkspaceActorProjection {
  constructor(private readonly db: Pick<SqlDatabase, "prepare">) {}

  /** Whether the Actor is still the enabled human, generation and membership revision the claim names. */
  current(claim: WorkspaceActorClaim): boolean {
    try {
      const actor = this.db.prepare("SELECT kind,enabled,generation FROM actors WHERE id=?").get(claim.actorId);
      const member = this.db.prepare("SELECT enabled FROM actor_members WHERE actor_id=?").get(claim.actorId);
      if (
        !actor ||
        actor.kind !== "human" ||
        actor.enabled !== 1 ||
        actor.generation !== claim.generation ||
        member?.enabled === 0
      )
        return false;
      const bindings = this.db
        .prepare("SELECT binding FROM actor_bindings WHERE actor_id=?")
        .all(claim.actorId)
        .map((r) => String(r.binding));
      if (
        this.db
          .prepare(
            "SELECT 1 FROM actor_bindings b JOIN members m ON m.binding=b.binding WHERE b.actor_id=? AND m.enabled=0 LIMIT 1",
          )
          .get(claim.actorId)
      )
        return false;
      return membershipRevocationRevision(this.db, claim.actorId, bindings) === claim.membershipRevision;
    } catch {
      return false;
    }
  }

  /** Same role projection as instance access: an Actor membership wins;
   * without one, an enabled administrator binding. Any other admitted Actor
   * (an ordinary or a policy-admitted member) is a `member`. A role never
   * admits by itself: call it only after `current` returned true. */
  role(actorId: string): "admin" | "member" | null {
    try {
      const member = this.db.prepare("SELECT enabled,role FROM actor_members WHERE actor_id=?").get(actorId);
      if (member) return member.enabled !== 1 ? null : member.role === "admin" ? "admin" : "member";
      return this.db
        .prepare(
          "SELECT 1 FROM actor_bindings b JOIN members m ON m.binding=b.binding WHERE b.actor_id=? AND m.enabled=1 AND m.role='admin' LIMIT 1",
        )
        .get(actorId)
        ? "admin"
        : "member";
    } catch {
      return null;
    }
  }
}
