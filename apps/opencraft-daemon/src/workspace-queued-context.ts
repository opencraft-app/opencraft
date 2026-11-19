import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { ActorStore } from "@opencraft/access-control/actors";
import type { ActorContext } from "@opencraft/identity-core/actors";
import type { ExecutionSubmission } from "./execution-lease-store";

/** Restore an existing delegation, never create one or renew its expiry. Only
 * trusted queue provenance and the authority store participate in this lookup. */
export async function restoreWorkspaceQueuedContext(
  threadId: string,
  inputId: string,
  submission: ExecutionSubmission | undefined,
  dependencies: {
    actors: Pick<ActorStore, "isCurrent" | "bindings">;
    executionContext(
      threadId: string,
      execution: { inputId: string },
    ): Promise<{ context: ActorContext; authorityId: string }>;
    authority(threadId: string, inputId: string): { authorizer: string; expiresAt: number; authorityId?: string };
  },
): Promise<TransportSubmissionContext> {
  if (submission?.ownership !== "human" || !submission.principal)
    throw Error("Workspace queued execution identity unavailable");
  const principal = Object.freeze({ ...submission.principal });
  const stored = await dependencies.executionContext(threadId, { inputId });
  const actorContext = Object.freeze({ ...stored.context });
  const authorityId = stored.authorityId;
  const assertCurrent = () => {
    const authority = dependencies.authority(threadId, inputId);
    const bindings = dependencies.actors
      .bindings(actorContext.actorId)
      .filter((b) => b.provider === principal.provider);
    if (
      !authorityId ||
      authority.authorityId !== authorityId ||
      authority.authorizer !== actorContext.actorId ||
      authority.expiresAt !== actorContext.expiresAt ||
      actorContext.expiresAt <= Date.now() ||
      !dependencies.actors.isCurrent(actorContext) ||
      bindings.length !== 1 ||
      bindings[0]!.subject !== principal.subject
    )
      throw Error("Workspace queued execution authority changed");
  };
  assertCurrent();
  return Object.freeze({
    sender: null,
    executionPrincipal: principal,
    actorContext,
    validUntil: actorContext.expiresAt,
    resourceOwner: Object.freeze({ id: actorContext.actorId, assertCurrent }),
  });
}
