import { membershipRevocationRevision } from "@opencraft/access-control/membership-revocation";
import { ownedDatabasePath } from "@opencraft/opencraft-daemon/owned-database-path";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readEnvironmentCreationReservation } from "@opencraft/storage-node/server-environment-reservations";
import {
  parseGitExecutionLocator,
  type GitExecutionHandoff,
  type GitExecutionLocator,
} from "@opencraft/execution-environment/git-execution";
import type {
  EnvironmentAccountOwner,
  EnvironmentLoginBinding,
} from "@opencraft/execution-environment/environment-account";
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
  resolve(scope: GitExecutionQuery | undefined) {
    const current = this.resolvePhase(scope, "active");
    return current?.turnId ? { ...current, turnId: current.turnId } : null;
  }
  reserve(scope: GitExecutionQuery) {
    // Only the exact Codex input admitted before physical submission may stage
    // environment configuration. This does not authorize a running command.
    if (scope.hostId !== "local-codex" || !scope.inputId || scope.turnId) return null;
    const current = this.resolvePhase(scope, "pending");
    return current ? { ...current, turnId: null } : null;
  }
  private resolvePhase(
    scope: GitExecutionQuery | undefined,
    phase: "active" | "pending",
  ): {
    account: string;
    principal: { provider: string; subject: string; loginName?: string };
    authority: string;
    generation: number;
    actorGeneration?: number;
    membershipRevision?: number;
    inputId: string;
    executionId: string;
    turnId: string | null;
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
      const rows = db
        .prepare(
          `SELECT s.principal_json,s.ownership,s.admission,l.state,l.turn_id,l.engine_incarnation,l.generation,l.execution_id,l.input_id,l.ended_at_ms
      FROM execution_leases l JOIN execution_submissions s ON s.thread_id=l.thread_id AND s.input_id=l.input_id
      WHERE l.thread_id=? AND ${scope.inputId ? "l.input_id=?" : "l.turn_id=?"} ${scope.executionId ? "AND l.execution_id=?" : ""} ORDER BY l.generation DESC LIMIT 2`,
        )
        .all(...[scope.threadId, scope.inputId ?? scope.turnId!, ...(scope.executionId ? [scope.executionId] : [])]);
      if (!scope.inputId && rows.length !== 1) return null;
      const row = rows[0];
      if (
        !row ||
        row.ownership !== "human" ||
        row.admission !== "accepted" ||
        row.state !== phase ||
        row.ended_at_ms !== null ||
        (phase === "active" ? !row.turn_id : row.turn_id !== null) ||
        !row.engine_incarnation ||
        (scope.turnId && scope.turnId !== row.turn_id) ||
        (scope.incarnation && scope.incarnation !== row.engine_incarnation)
      )
        return null;
      const principal = JSON.parse(String(row.principal_json));
      this.actorDatabase();
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
        inputId: String(row.input_id),
        executionId: String(row.execution_id),
        turnId: typeof row.turn_id === "string" ? row.turn_id : null,
        incarnation: String(row.engine_incarnation),
        generation: Number(row.generation),
        authority: JSON.stringify([row.turn_id, row.engine_incarnation, row.generation]),
      };
    } catch {
      throw Error("git_authority_store_unavailable");
    }
  }

  private actorDatabase() {
    if (this.closed) throw Error("git_authority_store_unavailable");
    if (!this.actors) {
      this.actors = new DatabaseSync(join(this.directory, "opencraft-server.sqlite"), { readOnly: true });
      this.actors.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    }
    return this.actors;
  }
  /** The enabled, admitted Human Actor with its verified login bindings, read
   * with the same rules as an execution's owner; `null` otherwise. */
  environmentAccountOwner(actorId: string): EnvironmentAccountOwner | null {
    try {
      const db = this.actorDatabase();
      const actor = db
        .prepare(
          `SELECT a.id,a.kind,a.enabled,a.generation,m.enabled AS member_enabled FROM actors a LEFT JOIN actor_members m ON m.actor_id=a.id WHERE a.id=?`,
        )
        .get(actorId);
      if (!actor || actor.kind !== "human" || actor.enabled !== 1 || actor.member_enabled === 0) return null;
      if (
        db
          .prepare(
            `SELECT 1 FROM actor_bindings b JOIN members m ON m.binding=b.binding WHERE b.actor_id=? AND m.enabled=0 LIMIT 1`,
          )
          .get(actorId)
      )
        return null;
      const bindings = db
        .prepare("SELECT binding FROM actor_bindings WHERE actor_id=? ORDER BY binding")
        .all(actorId)
        .map((row) => {
          const [provider, subject] = JSON.parse(String(row.binding)) as [string, string];
          return { provider, subject };
        });
      return { actorId: String(actor.id), actorGeneration: Number(actor.generation), bindings };
    } catch {
      throw Error("git_authority_store_unavailable");
    }
  }
  /** The Actor a verified login binding belongs to. */
  environmentAccountActor(binding: EnvironmentLoginBinding): string | null {
    try {
      const row = this.actorDatabase()
        .prepare("SELECT actor_id FROM actor_bindings WHERE binding=?")
        .get(JSON.stringify([binding.provider, binding.subject]));
      return row ? String(row.actor_id) : null;
    } catch {
      throw Error("git_authority_store_unavailable");
    }
  }

  /** The current epoch of an enabled Human Actor member (generation and
   * membership revocation revision) from the same Actor projection as
   * `resolve`, or `null` when it is disabled, removed or not Human. */
  private epoch(actorId: string): { actorGeneration: number; membershipRevision: number } | null {
    try {
      const db = this.actorDatabase();
      const actor = db
        .prepare(
          `SELECT a.id,a.kind,a.enabled,a.generation AS actor_generation,m.enabled AS member_enabled FROM actors a
      LEFT JOIN actor_members m ON m.actor_id=a.id WHERE a.id=?`,
        )
        .get(actorId);
      if (!actor || actor.kind !== "human" || actor.enabled !== 1 || actor.member_enabled === 0) return null;
      if (
        db
          .prepare(
            `SELECT 1 FROM actor_bindings b JOIN members m ON m.binding=b.binding WHERE b.actor_id=? AND m.enabled=0 LIMIT 1`,
          )
          .get(actorId)
      )
        return null;
      const bindings = db
        .prepare("SELECT binding FROM actor_bindings WHERE actor_id=?")
        .all(actorId)
        .map((row) => String(row.binding));
      return {
        actorGeneration: Number(actor.actor_generation),
        membershipRevision: membershipRevocationRevision(db, actorId, bindings),
      };
    } catch {
      throw Error("git_authority_store_unavailable");
    }
  }
  /** The current epoch of an Actor account (Actor mode only). Used for terminal
   * ENV admission. */
  actor(account: string): { account: string; actorGeneration: number; membershipRevision: number } | null {
    if (this.closed) throw Error("git_authority_store_unavailable");
    if (this.accountMode !== "actor" || typeof account !== "string" || !/^actor:human:\/\/[^/]+\/[^/]+$/u.test(account))
      return null;
    const epoch = this.epoch(account.slice("actor:".length));
    return epoch ? { account, ...epoch } : null;
  }
  /** The current epoch of an Actor by id. Used for Codex creation admission. */
  actorEpoch(actorId: string): { actorGeneration: number; membershipRevision: number } | null {
    if (this.closed) throw Error("git_authority_store_unavailable");
    if (typeof actorId !== "string" || !/^human:\/\/[^/]+\/[^/]+$/u.test(actorId)) return null;
    return this.epoch(actorId);
  }
  /** The pending, unexpired creation reservation recorded by the Server owner, or
   * `null`. The Actor epoch is the one recorded at admission. */
  creationReservation(hostId: string, operationId: string, now = Date.now()) {
    if (this.closed) throw Error("git_authority_store_unavailable");
    try {
      return readEnvironmentCreationReservation(this.actorDatabase(), hostId, operationId, now);
    } catch {
      throw Error("git_authority_store_unavailable");
    }
  }
  unowned(scope: GitExecutionQuery, phase: "active" | "pending" = "active"): boolean {
    if (this.closed) throw Error("git_authority_store_unavailable");
    if (
      !scope.threadId ||
      (!scope.inputId && !scope.turnId) ||
      !["local-codex", "opencraft-server"].includes(scope.hostId)
    )
      return false;
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
    const rows = db
      .prepare(
        `SELECT s.ownership,s.admission,l.state,l.turn_id,l.engine_incarnation,l.ended_at_ms FROM execution_leases l JOIN execution_submissions s ON s.thread_id=l.thread_id AND s.input_id=l.input_id WHERE l.thread_id=? AND ${scope.inputId ? "l.input_id=?" : "l.turn_id=?"} ORDER BY l.generation DESC LIMIT 2`,
      )
      .all(scope.threadId, scope.inputId ?? scope.turnId!);
    if (!scope.inputId && rows.length !== 1) return false;
    const row = rows[0];
    return (
      !!row &&
      row.ownership === "unowned" &&
      row.admission === "accepted" &&
      row.state === phase &&
      row.ended_at_ms === null &&
      (phase === "active" ? !!row.turn_id : row.turn_id === null) &&
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

type ResolvedExecution = Omit<NonNullable<ReturnType<GitExecutionAuthority["resolve"]>>, "turnId">;
/** Scope of an admitted execution. The locator never selects a Project. */
export function executionScope(input: GitExecutionLocator, current: ResolvedExecution) {
  return {
    account: current.account,
    hostId: input.hostId,
    threadId: input.threadId,
    inputId: current.inputId,
    executionId: current.executionId,
    leaseGeneration: current.generation,
    actorGeneration: current.actorGeneration,
    membershipRevision: current.membershipRevision,
    projectId: input.projectId ?? null,
  };
}
/** The durable admission of an active Turn. `null` only for an unowned Turn;
 * any other absence (disabled Actor, ended lease, unreadable store) throws. */
export function resolveExecutionAdmission(
  authority: GitExecutionAuthority,
  raw: unknown,
): Omit<GitExecutionHandoff, "authority" | "capability"> | null {
  const input = parseGitExecutionLocator(raw),
    current = authority.resolve(input);
  if (!current) {
    if (authority.unowned(input)) return null;
    throw Error("git_execution_unavailable");
  }
  return {
    scope: executionScope(input, current),
    native: { turnId: current.turnId, incarnation: current.incarnation },
  } as Omit<GitExecutionHandoff, "authority" | "capability">;
}
