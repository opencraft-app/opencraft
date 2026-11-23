import type { DatabaseSync } from "node:sqlite";

/**
 * A durable creation reservation for execution ENV delivery. The Actor epoch is the
 * one the creation was admitted under; the Project comes from the request (a new
 * Thread) or the source Thread's binding (a fork). It names no variable value.
 */
export interface EnvironmentCreationReservation {
  readonly hostId: "local-codex" | "opencraft-server";
  readonly operationId: string;
  /** Human Actor id (`human://…`), never a login binding. */
  readonly actorId: string;
  readonly actorGeneration: number;
  readonly membershipRevision: number;
  /** The Thread being forked, or `null` for a new Thread. */
  readonly source: string | null;
  /** The execution owner incarnation that will launch it. */
  readonly incarnation: string;
  /** Host-local Project the launch takes Project values from, or `null`. */
  readonly project: string | null;
}
export type EnvironmentCreationOutcome = "launched" | "abandoned";

export interface EnvironmentCreationReservationMethods {
  /** Records a pending reservation. An existing operation is never replaced. */
  reserveEnvironmentCreation(reservation: EnvironmentCreationReservation, ttlMs?: number): void;
  /** Leaves the pending state once; a settled or missing reservation stays as it is. */
  settleEnvironmentCreation(
    hostId: EnvironmentCreationReservation["hostId"],
    operationId: string,
    outcome: EnvironmentCreationOutcome,
  ): boolean;
}

/** At most this long between the reservation and its launch. */
export const ENVIRONMENT_CREATION_TTL_MS = 5 * 60_000;
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(v);
const host = (v: unknown): v is EnvironmentCreationReservation["hostId"] =>
  v === "local-codex" || v === "opencraft-server";

function validReservation(value: EnvironmentCreationReservation): EnvironmentCreationReservation {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 8 ||
    !host(value.hostId) ||
    !text(value.operationId) ||
    !text(value.actorId) ||
    !/^human:\/\/[^/]+\/[^/]+$/u.test(value.actorId) ||
    !Number.isSafeInteger(value.actorGeneration) ||
    value.actorGeneration < 1 ||
    !Number.isSafeInteger(value.membershipRevision) ||
    value.membershipRevision < 0 ||
    !(value.source === null || text(value.source)) ||
    !text(value.incarnation) ||
    !(value.project === null || text(value.project))
  )
    throw new Error("Invalid environment creation reservation");
  return value;
}

/**
 * The pending, unexpired reservation for one creation operation, or `null`. Execution
 * owners read it through their own read-only connection; the Actor epoch it returns is
 * the one recorded at admission, which the caller must compare with the current one.
 */
export function readEnvironmentCreationReservation(
  db: Pick<DatabaseSync, "prepare">,
  hostId: string,
  operationId: string,
  now = Date.now(),
): EnvironmentCreationReservation | null {
  if (!host(hostId) || !text(operationId)) return null;
  const row = db
    .prepare(
      `SELECT actor_id,actor_generation,membership_revision,source,incarnation,project,state,expires_at
       FROM environment_creation_reservations WHERE host_id=? AND operation_id=?`,
    )
    .get(hostId, operationId);
  if (!row || row.state !== "pending" || !(Number(row.expires_at) > now)) return null;
  return validReservation({
    hostId,
    operationId,
    actorId: row.actor_id as string,
    actorGeneration: Number(row.actor_generation),
    membershipRevision: Number(row.membership_revision),
    source: row.source as string | null,
    incarnation: row.incarnation as string,
    project: row.project as string | null,
  });
}

/** Invoked only in the Server owner Worker; the network thread reaches it through async calls. */
export function environmentCreationReservationMethods(db: DatabaseSync): EnvironmentCreationReservationMethods {
  const insert = db.prepare(`INSERT INTO environment_creation_reservations
    (host_id,operation_id,actor_id,actor_generation,membership_revision,source,incarnation,project,state,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`);
  const settle = db.prepare(`UPDATE environment_creation_reservations SET state=?
    WHERE host_id=? AND operation_id=? AND state='pending'`);
  // Settled and long-expired reservations admit nothing; keep the table bounded.
  const prune = db.prepare("DELETE FROM environment_creation_reservations WHERE expires_at<?");
  return {
    reserveEnvironmentCreation(raw, ttlMs = ENVIRONMENT_CREATION_TTL_MS) {
      const value = validReservation(raw);
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > ENVIRONMENT_CREATION_TTL_MS)
        throw new Error("Invalid environment creation reservation");
      const now = Date.now();
      prune.run(now - 24 * 60 * 60_000);
      insert.run(
        value.hostId,
        value.operationId,
        value.actorId,
        value.actorGeneration,
        value.membershipRevision,
        value.source,
        value.incarnation,
        value.project,
        now,
        now + ttlMs,
      );
    },
    settleEnvironmentCreation(hostId, operationId, outcome) {
      if (!host(hostId) || !text(operationId) || !["launched", "abandoned"].includes(outcome))
        throw new Error("Invalid environment creation outcome");
      return Number(settle.run(outcome, hostId, operationId).changes) === 1;
    },
  };
}
