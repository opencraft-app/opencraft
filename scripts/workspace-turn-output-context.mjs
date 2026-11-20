/** A trusted installation may add a principal projection, never replace the
 * native execution/Actor/resource authority or select it from request fields. */
export async function workspaceTurnOutputContext({collaboration,actors,threadId,turnId,selectIdentity}) {
  if(selectIdentity!==undefined&&typeof selectIdentity!=='function')throw Error('Invalid workspace output identity selector');
  const stored=await collaboration.executionContext(threadId,{turnId});
  const context=Object.freeze({...stored.context});
  const identity=selectIdentity?.(context,actors);
  if(selectIdentity&&(!identity||typeof identity.assertCurrent!=='function'
    ||typeof identity.principal?.provider!=='string'||!identity.principal.provider
    ||typeof identity.principal?.subject!=='string'||!identity.principal.subject))throw Error('Workspace output identity unavailable');
  const principal=identity?Object.freeze({provider:identity.principal.provider,subject:identity.principal.subject}):undefined;
  const assertCurrent=()=>{
    const current=collaboration.delegation(threadId,turnId,stored.authorityId);
    const serverId=collaboration.execution.serverForThread?.(threadId)??collaboration.execution.serverId;
    if(current.context.actorId!==context.actorId||current.context.generation!==context.generation
      ||current.context.expiresAt!==context.expiresAt||!actors.isCurrent(context)||!serverId
      ||!collaboration.conversationAllowed(context,{serverId,threadId},'execution.delegate'))throw Error('Workspace output authority revoked');
    identity?.assertCurrent();
  };
  assertCurrent();
  return Object.freeze({sender:null,actorContext:context,validUntil:context.expiresAt,
    ...(principal?{executionPrincipal:principal}:{}),resourceOwner:Object.freeze({id:context.actorId,assertCurrent})});
}
