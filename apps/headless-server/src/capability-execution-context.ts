import type { ActorContext } from "@opencraft/identity-core/actors";
import type {
  CapabilityActor,
  CapabilityContextResolver,
  CapabilityExecutionContext,
  CapabilityLease,
} from "@opencraft/session-capabilities";
import type { GitExecutionHandoff, GitExecutionLocator } from "@opencraft/execution-environment/git-execution";

interface Execution {
  inputId?: string;
  turnId?: string;
}
/** Existing core owners only. Every lookup is asynchronous (owner Worker) or a
 * memory projection; this module runs no SQL and opens no store. */
export interface CapabilityContextOwners {
  /** Host and engine that core routes this server/thread to, or undefined. */
  route(serverId: string, threadId: string): { hostId: string; engine: string } | undefined;
  /** Admitted Actor authority for the run; rejects when none is admitted. */
  source(serverId: string, threadId: string, execution: Execution): Promise<{ context: ActorContext }>;
  /** Current-standing check: enabled human, same generation, still admitted. */
  current(context: ActorContext, serverId: string, threadId: string): boolean;
  bindings(actorId: string): readonly { provider: string; subject: string }[];
  /** Active lease owner; absent in installations without one. */
  lease?(locator: GitExecutionLocator): Promise<GitExecutionHandoff | null>;
}

const leaseHosts = new Set<string>(["local-codex", "opencraft-server"]);

/** Resolves `CapabilitySession.context` for trusted Host composition. A part
 * that core cannot verify is omitted rather than defaulted or guessed. */
export function createCapabilityContextResolver(owners: CapabilityContextOwners): CapabilityContextResolver {
  return async (session) => {
    const route = owners.route(session.serverId, session.threadId);
    if (!route) return undefined;
    const host = { id: route.hostId, engine: route.engine };
    const execution = session.execution;
    if (!execution || (!execution.inputId && !execution.turnId)) return { host };
    const selector = execution.inputId ? { inputId: execution.inputId } : { turnId: execution.turnId! };
    let context: ActorContext;
    try {
      context = (await owners.source(session.serverId, session.threadId, selector)).context;
    } catch {
      return { host };
    }
    if (!owners.current(context, session.serverId, session.threadId)) return { host };
    const actor: CapabilityActor = {
      id: context.actorId,
      generation: context.generation,
      bindings: owners.bindings(context.actorId).map(({ provider, subject }) => ({ provider, subject })),
    };
    const lease = await activeLease(owners, route.hostId, session.threadId, selector, actor, execution);
    // Authority may be revoked while the lease owner answers.
    if (!owners.current(context, session.serverId, session.threadId)) return { host };
    return { host, actor, ...(lease ? { lease } : {}) } satisfies CapabilityExecutionContext;
  };
}

async function activeLease(
  owners: CapabilityContextOwners,
  hostId: string,
  threadId: string,
  selector: Execution,
  actor: CapabilityActor,
  execution: { executionId?: string; turnId?: string; incarnation?: string },
): Promise<CapabilityLease | undefined> {
  if (!owners.lease || !leaseHosts.has(hostId)) return undefined;
  let handoff: GitExecutionHandoff | null;
  try {
    handoff = await owners.lease({ hostId: hostId as GitExecutionLocator["hostId"], threadId, ...selector });
  } catch {
    return undefined;
  }
  const scope = handoff?.scope;
  if (
    !handoff ||
    !scope ||
    scope.threadId !== threadId ||
    scope.account !== `actor:${actor.id}` ||
    scope.actorGeneration !== actor.generation ||
    (execution.executionId !== undefined && execution.executionId !== scope.executionId) ||
    (execution.turnId !== undefined && execution.turnId !== handoff.native.turnId) ||
    (execution.incarnation !== undefined && execution.incarnation !== handoff.native.incarnation)
  )
    return undefined;
  return {
    inputId: scope.inputId,
    executionId: scope.executionId,
    generation: scope.leaseGeneration,
    turnId: handoff.native.turnId,
    incarnation: handoff.native.incarnation,
  };
}
