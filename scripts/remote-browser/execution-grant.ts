import type { ActorContext } from '@opencraft/identity-core/actors';
import type { CapabilitySession } from '@opencraft/session-capabilities';
import type { BrowserGrantResolver } from './capabilities.js';

interface Source { context: ActorContext; authorityId: string; turnId: string | null }
interface Execution { inputId?: string; turnId?: string }
export function createBrowserGrantResolver(options: {
  serverForThread(threadId: string, requestedServerId?: string): string;
  hostForServer(serverId: string): string;
  source(threadId: string, execution: Execution, serverId: string): Promise<Source>;
  authorize(context: ActorContext, serverId: string, threadId: string): void;
  owner(context: ActorContext): string;
  currentTurn(hostId: string, threadId: string, context: ActorContext): Promise<{ id: string; status: string } | null>;
}): BrowserGrantResolver {
  return async (session: CapabilitySession, invocation: boolean) => {
    const execution = session.execution;
    if (!execution || !execution.inputId && !execution.turnId || session.serverId !== options.serverForThread(session.threadId, session.serverId)) throw new Error('Browser execution admission required');
    let source = await options.source(session.threadId, execution, session.serverId);
    const hostId = options.hostForServer(session.serverId);
    options.authorize(source.context, session.serverId, session.threadId);
    if (invocation) {
      const native = await options.currentTurn(hostId, session.threadId, source.context);
      if (!native || native.status !== 'inProgress' || execution.turnId && execution.turnId !== native.id) throw new Error('Browser execution is no longer active');
      const current = await options.source(session.threadId, { ...execution, turnId: native.id }, session.serverId);
      if (current.authorityId !== source.authorityId || current.context.actorId !== source.context.actorId
        || current.context.generation !== source.context.generation) throw new Error('Browser execution authority changed');
      source = current;
    }
    const context = source.context;
    const authorize = () => options.authorize(context, session.serverId, session.threadId);
    authorize();
    return Object.freeze({ ownerId: options.owner(context), hostId, threadId: session.threadId, turnId: source.turnId, authorize });
  };
}
