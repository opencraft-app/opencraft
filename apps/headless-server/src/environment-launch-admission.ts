import {
  environmentLaunchAdmission,
  type EnvironmentCreationAdmission,
  type EnvironmentTurnAdmission,
} from "@opencraft/execution-environment/environment-delivery";
import type { EnvironmentRecordAdmission } from "@opencraft/execution-environment/environment-launch-owner";
import type { GitExecutionAuthority } from "./git-execution-authority.js";

const unavailable = (): never => {
  throw Error("environment_launch_unavailable");
};

/** v2 Turn admission of a pending Codex input: Codex stages its Thread
 * configuration before it submits the input, so no native Turn exists yet.
 * `null` only for a pending input without a Human owner. */
export function codexTurnAdmission(
  authority: GitExecutionAuthority,
  locator: { hostId: "local-codex"; threadId: string; inputId: string },
): EnvironmentTurnAdmission | null {
  const input = { hostId: "local-codex" as const, threadId: locator.threadId, inputId: locator.inputId };
  const current = authority.reserve(input);
  if (!current) return authority.unowned(input, "pending") ? null : unavailable();
  return environmentLaunchAdmission({
    kind: "turn",
    account: current.account,
    actorGeneration: current.actorGeneration,
    membershipRevision: current.membershipRevision,
    hostId: "local-codex",
    threadId: locator.threadId,
    inputId: current.inputId,
    executionId: current.executionId,
    leaseGeneration: current.generation,
    turnId: null,
    incarnation: current.incarnation,
  }) as EnvironmentTurnAdmission;
}

/** v2 creation admission from the Server owner's pending reservation, only while
 * the Actor still holds the epoch it was admitted under. */
export function creationAdmission(
  authority: GitExecutionAuthority,
  locator: { hostId: "local-codex" | "opencraft-server"; operationId: string },
  now = Date.now(),
): EnvironmentRecordAdmission<EnvironmentCreationAdmission> | null {
  const reservation = authority.creationReservation(locator.hostId, locator.operationId, now);
  if (!reservation) return null;
  const epoch = authority.actorEpoch(reservation.actorId);
  if (
    !epoch ||
    epoch.actorGeneration !== reservation.actorGeneration ||
    epoch.membershipRevision !== reservation.membershipRevision
  )
    return null;
  return {
    admission: environmentLaunchAdmission({
      kind: "creation",
      account: `actor:${reservation.actorId}`,
      actorGeneration: reservation.actorGeneration,
      membershipRevision: reservation.membershipRevision,
      hostId: reservation.hostId,
      operationId: reservation.operationId,
      source: reservation.source,
      incarnation: reservation.incarnation,
    }) as EnvironmentCreationAdmission,
    project: reservation.project,
  };
}
