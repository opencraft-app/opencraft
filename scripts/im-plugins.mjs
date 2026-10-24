import { setTimeout as delay } from 'node:timers/promises';
import { readPrivateJson } from '../packages/identity-core/src/node.ts';
import { IM_REPLY_TOOL } from '../plugins/im/src/reply-tool.ts';
import { IM_READ_TOOLS } from '../plugins/im/src/read-tools.ts';
import { ImFault } from '../plugins/im/src/server.ts';
import { conversationRef, encodeConversationRef } from '../packages/appserver-protocol/src/collaboration.ts';
import { callConversationHost } from './conversation-execution.mjs';

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Invalid IM configuration');
}
function identifier(value) { if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('Invalid IM identifier'); return value; }
export async function readImConfiguration(path) {
  if (!path) return null;
  let config;
  try { config = await readPrivateJson(path); }
  catch { throw new Error('Unable to read private IM configuration'); }
  fields(config,['schemaVersion','endpoints']);
  if (config.schemaVersion !== 1 || !Array.isArray(config.endpoints) || config.endpoints.length > 32) throw new Error('Invalid IM configuration');
  const ids = new Set(), bots = new Set();
  return config.endpoints.map(endpoint => {
    fields(endpoint,['id','provider','ownerId','senders','groupScope','botId','secret']);
    for (const key of ['id','ownerId','botId','secret']) identifier(endpoint[key]);
    if (endpoint.provider !== 'wecom' || ids.has(endpoint.id) || bots.has(endpoint.botId) || !['chat','sender'].includes(endpoint.groupScope)) throw new Error('Invalid IM endpoint');
    ids.add(endpoint.id); bots.add(endpoint.botId);
    if (!endpoint.senders || typeof endpoint.senders !== 'object' || Array.isArray(endpoint.senders) || Object.keys(endpoint.senders).length < 1 || Object.keys(endpoint.senders).length > 256) throw new Error('Explicit IM sender bindings required');
    for (const [sender,actor] of Object.entries(endpoint.senders)) { identifier(sender); identifier(actor); }
    return Object.freeze({...endpoint,senders:Object.freeze({...endpoint.senders})});
  });
}

/** Trusted composition maps verified external identities; wire sender IDs confer no authority. */
export function createImExecution({actors,collaboration,getAppHost,prepareCapabilities,admittedActor = () => true}) {
  const serverId = collaboration.execution.serverId, hostId = collaboration.execution.hostId;
  const human = actorId => {
    const actor = actors.get(actorId);
    if (!actor?.enabled || actor.kind !== 'human' || !admittedActor(actorId)) throw new ImFault('denied');
    return Object.freeze({actorId,generation:actor.generation,credentialId:null,expiresAt:Date.now()+86_400_000});
  };
  const authorize = (context, ref) => {
    if (!actors.isCurrent(context) || !admittedActor(context.actorId) || actors.get(context.actorId)?.kind !== 'human') throw new ImFault('denied');
    if (ref && !['conversation.read','message.send','execution.queue'].every(action => collaboration.conversationAllowed(context,ref,action))) throw new ImFault('denied');
  };
  const invoke = async (context,ref,method,params,signal) => {
    signal?.throwIfAborted(); authorize(context,ref);
    const host = getAppHost(); if (!host) throw new Error('IM execution unavailable');
    const targetHost = ref ? collaboration.execution.hostForServer?.(ref.serverId) ?? hostId : hostId;
    if (ref && collaboration.execution.serverForHost && collaboration.execution.serverForHost(targetHost,ref.threadId) !== ref.serverId) throw new ImFault('denied');
    const result = await callConversationHost(host,{hostId:targetHost,threadId:ref?.threadId ?? ''},'im',method,params,{sender:null,actorContext:context});
    signal?.throwIfAborted(); authorize(context,ref);
    return result;
  };
  return {
    human, authorize,
    async create(context,signal) {
      const reservation = prepareCapabilities?.([IM_REPLY_TOOL, ...IM_READ_TOOLS]);
      try {
        const result = await invoke(context,null,'thread/start',{experimentalRawEvents:false,
          ...(reservation ? {config:{'mcp_servers.opencraft_session':reservation.configuration}} : {})},signal);
        const ref = conversationRef({serverId,threadId:result.thread.id});
        reservation?.bind(ref);
        return ref;
      } catch (error) { reservation?.cancel(); throw error; }
    },
    async validate(context,ref,signal) {
      const result = await invoke(context,ref,'thread/read',{includeTurns:false},signal);
      if (result.thread?.id !== ref.threadId || result.thread.ephemeral === true) throw new Error('IM requires a durable conversation');
    },
    async submit(context,ref,messageId,text) {
      authorize(context,ref);
      const receipt = collaboration.sendConversation(context,{reference:encodeConversationRef(ref),content:text,idempotencyKey:'im:'+messageId});
      void collaboration.pump().catch(() => {});
      return receipt.requestId;
    },
    async result(context,ref,requestId,signal) {
      const deadline = Date.now()+300_000;
      while (Date.now() < deadline) {
        signal.throwIfAborted(); authorize(context,ref);
        await collaboration.pump();
        const request = collaboration.getRequest(context,requestId);
        if (request.thread_id !== ref.threadId || request.server_id !== ref.serverId) throw new ImFault('denied');
        if (['rejected','cancelled'].includes(request.state)) throw new Error('IM input was not executed');
        if (request.turn_id) {
          const result = await invoke(context,ref,'thread/read',{includeTurns:true},signal);
          const turn = result.thread?.turns?.find(turn => turn.id === request.turn_id);
          if (turn && ['completed','failed','interrupted'].includes(turn.status)) {
            const answer = (turn.items ?? []).filter(item => item.type === 'agentMessage' && typeof item.text === 'string').map(item => item.text).join('\n\n');
            if (!answer.trim()) return turn.status === 'completed' ? '本轮已完成。' : '本轮未完成，请打开会话查看。';
            // Keep a conservative byte budget for transports with bounded text responses.
            const suffix = `\n\n完整会话：${encodeConversationRef(ref)}`;
            let bounded = answer;
            if (Buffer.byteLength(bounded,'utf8') > 18_000) {
              const chars = Array.from(answer); let count = 0, end = 0;
              while (end < chars.length && count + Buffer.byteLength(chars[end],'utf8') <= 18_000) count += Buffer.byteLength(chars[end++],'utf8');
              bounded = chars.slice(0,end).join('') + suffix;
            }
            return bounded;
          }
        }
        await delay(1000,undefined,{signal});
      }
      throw new Error('IM reply timed out; execution may continue');
    },
  };
}

export async function startImPlugins(endpoints, dependencies) {
  const { ImChannelService } = await import('./im-channel-service.mjs');
  return ImChannelService.open(endpoints??[],dependencies);
}
