import { randomUUID, createHash } from 'node:crypto';
import { normalize } from 'node:path';
import { APP_HOST_PROTOCOL_VERSION } from '@opencraft/app-host-protocol/version';
import { projectConversationMetadata, readConversationPage } from './conversation-projections.mjs';
import { parseTurnRecoveryNotice } from '@opencraft/appserver-protocol';

/** Narrow internal logical-client lane; no client-supplied RPC method or Host is forwarded. */
export function callConversationHost(appHost, binding, requestId, method, params, submissionContext, timeoutMs = 35_000) {
  const clientId = `actor-service:${randomUUID()}`, leaseId = randomUUID();
  return new Promise((resolve, reject) => {
    let connection, receive, generation, finished = false;
    const finish = (error, result) => {
      if (finished) return; finished = true; clearTimeout(timer);
      try { connection?.close(); } catch { /* Lease cleanup cannot rewrite the engine result. */ }
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Actor execution outcome unknown')), timeoutMs); timer.unref();
    const send = (id, operation, arguments_) => receive?.({ type: 'host/send', requestId: `send-${id}`, hostId: binding.hostId, leaseId, generation,
      frame: JSON.stringify({ id, method: operation, params: arguments_ }) });
    try {
      connection = appHost.accept({
        subscribe(listener) { receive = listener; return () => { receive = undefined; }; }, start() {}, close() {},
        postMessage(message) {
          if (finished) return;
          if (message.type === 'ready') receive?.({ type: 'host/connect', requestId: 'connect', hostId: binding.hostId, leaseId });
          else if (message.type === 'response' && message.requestId === 'connect') {
            if (!message.ok || !Number.isSafeInteger(message.result?.generation)) return finish(new Error('Actor Host unavailable'));
            generation = message.result.generation;
            send('init', 'initialize', { clientInfo: { name: 'opencraft-actor-service', version: '1' }, capabilities: { experimentalApi: true } });
          } else if (message.type === 'response' && !message.ok) finish(new Error('Actor Host admission failed'));
          else if (message.type === 'host/frame' && message.hostId === binding.hostId && message.generation === generation) {
            try {
              const frame = JSON.parse(message.frame);
              if (frame.method || !['init', 'operation'].includes(frame.id)) return;
              if (frame.error) return finish(Object.assign(new Error('Actor engine request rejected'), {
                code: frame.error.code }));
              if (frame.id === 'init') send('operation', method, { ...params, ...(binding.threadId ? {threadId: binding.threadId} : {}) });
              else finish(null, frame.result);
            } catch (error) { finish(error); }
          } else if (message.type === 'fatal' || message.type === 'host/status' && ['failed', 'closed'].includes(message.status.state)) finish(new Error('Actor Host closed'));
        },
      }, clientId, submissionContext ?? { sender: null, collaborationRequestId: requestId });
      receive?.({ type: 'hello', protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: clientId });
    } catch (error) { finish(error); }
  });
}
export function createConversationExecution(getAppHost, {serverId, hostId, engine}) {
  if (typeof hostId !== 'string' || !hostId.trim() || hostId.length > 256 || /[\x00-\x1f]/u.test(hostId)) throw new Error('Conversation execution Host required');
  const invoke = (binding, id, method, params) => {
    if (binding.hostId !== hostId) throw new Error('Unsupported Actor execution Host');
    const host = getAppHost(); if (!host) throw new Error('Actor Host unavailable');
    return callConversationHost(host, binding, id, method, params);
  };
  const binding = threadId => ({hostId, threadId});
  return {
    serverId, hostId,
    async metadata(ref) {
      if (ref.serverId !== serverId) throw Object.assign(new Error('Unknown conversation server'), {status:404,code:'conversation_unavailable'});
      const { thread } = await invoke(binding(ref.threadId), 'metadata', 'thread/read', { includeTurns: false });
      if (thread?.id !== ref.threadId) throw Object.assign(new Error('Conversation unavailable'), {status:404,code:'conversation_unavailable'});
      const recovery = engine ? null : parseTurnRecoveryNotice((await invoke(binding(ref.threadId), 'metadata-recovery', 'opencraft/turn-recovery/read', {})).recovery);
      return projectConversationMetadata(serverId, thread, false, recovery);
    },
    async discoverMetadata(options) {
      const result = await invoke(binding(''), 'catalog-metadata', 'thread/list', {
        limit:30, archived:false, useStateDbOnly:true, cursor:options.cursor ?? null,
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }), ...(options.cwd === undefined ? {} : { cwd: normalize(options.cwd) }),
      });
      return { conversations: result.data.map(thread => projectConversationMetadata(serverId, thread, options.includeTitle)), nextCursor:result.nextCursor ?? null };
    },
    async discover(search, cursor) {
      const result = await invoke(binding(''), 'catalog', 'thread/list', {limit:30, searchTerm:search.trim() || null, archived:false, cursor});
      return {conversations:result.data.map(t=>({ref:{serverId,threadId:t.id},title:t.name || t.preview || t.id})),nextCursor:result.nextCursor ?? null};
    },
    async read(ref, cursor) {
      if(ref.serverId !== serverId) throw new Error('Unknown conversation server');
      const result = await invoke(binding(ref.threadId), 'history', 'thread/read', {includeTurns:true});
      const thread = result.thread;
      if(thread?.id !== ref.threadId) throw new Error('Conversation is unavailable');
      const entries=[];
      for(const turn of thread.turns ?? []) for(const item of turn.items ?? []) {
        if(!['userMessage','agentMessage'].includes(item.type)) continue;
        const content=item.type==='agentMessage' ? item.text : (item.content ?? []).filter(p=>p.type==='text').map(p=>p.text).join('\n');
        if(typeof content !== 'string') continue;
        // A bounded page also handles one very long native message without losing its tail.
        const chunks=Array.from(content); for(let offset=0;offset<chunks.length;offset+=2000)
          entries.push({turnId:turn.id,itemId:item.id,role:item.type==='userMessage'?'user':'assistant',offset,text:chunks.slice(offset,offset+2000).join('')});
      }
      const watermark=createHash('sha256').update(JSON.stringify(entries)).digest('hex');
      let offset=0;
      if(cursor) {const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')); if(c.watermark!==watermark || !Number.isSafeInteger(c.offset) || c.offset<0 || c.offset>entries.length) throw new Error('History changed; read again without cursor');offset=c.offset;}
      const page=[]; let bytes=0;
      while(offset<entries.length && page.length<30) {const entry=entries[offset], size=Buffer.byteLength(JSON.stringify(entry));if(bytes+size>24000 && page.length) break;page.push(entry);bytes+=size;offset++;}
      return {entries:page,watermark,latestTurnId:thread.turns?.at(-1)?.id ?? null,truncated:offset<entries.length,nextCursor:offset<entries.length?Buffer.from(JSON.stringify({watermark,offset})).toString('base64url'):null};
    },
    async readBounded(ref, cursor) {
      if(ref.serverId !== serverId) throw new Error('Unknown conversation server');
      return readConversationPage((method, params) => invoke(binding(ref.threadId), 'history', method, params), ref, cursor);
    },
    async validate(binding) {
      const result = await invoke(binding, 'binding-validation', 'thread/read', { includeTurns: false });
      if (result?.thread?.id !== binding.threadId || result.thread.ephemeral === true) throw new Error('Durable Thread required');
    },
    async receipt(binding, id) { return (await invoke(binding, id, 'thread/queue/collaborationReceipt', {})).receipt; },
    async add(binding, id, input) {
      const result = await invoke(binding, id, 'thread/queue/add', { clientUserMessageId: `actor-input:${id}`, input: [{ type: 'text', text: input }] });
      return { id: result.queuedSubmission.id, state: 'queued', targetTurnId: null };
    },
    async steer(binding, id, queueId, expectedTurnId) { await invoke(binding, id, 'thread/queue/steer', { queuedSubmissionId: queueId, expectedTurnId }); },
    async cancel(binding, id, queueId) { return (await invoke(binding, id, 'thread/queue/delete', { queuedSubmissionId: queueId })).deleted === true; },
  };
}

/** Full conversation identity selects the native engine. Actor run bindings and
 * delegation stay on the default Codex authority until explicitly extended. */
export function createRoutedConversationExecution(getAppHost, { machineId, engines, getInputs }) {
  const agentEngine = threadId => threadId.startsWith('dsh_acp_') ? 'dsh-acp' : threadId.startsWith('pi_') ? 'pi'
    : threadId.startsWith('claude_') ? 'claude-code' : threadId.startsWith('acp_') ? 'acp' : 'dsh';
  const descriptors = [{ serverId: `server:${machineId}:codex`, hostId: 'local-codex', label:'Codex' },
    ...engines.map(engine => ({ serverId: `server:${machineId}:${engine}`, hostId: 'opencraft-server', engine, label:engine==='pi'?'Pi':'DSH' }))];
  const ports = new Map(descriptors.map(server => [server.serverId, createConversationExecution(getAppHost, server)]));
  const primary = ports.get(descriptors[0].serverId);
  const reject = () => { throw Object.assign(new Error('Unsupported conversation execution'), {code:-32602}); };
  const serverForHost = (hostId, threadId) => {
    if (hostId === 'local-codex') return descriptors[0].serverId;
    if (hostId !== 'opencraft-server') return reject();
    return descriptors.find(server => server.engine === agentEngine(threadId))?.serverId ?? reject();
  };
  const select = binding => {
    const serverId = binding.serverId ?? primary.serverId, port = ports.get(serverId);
    if (!port || binding.hostId !== port.hostId || serverForHost(port.hostId, binding.threadId) !== serverId) return reject();
    return {port, engine: descriptors.find(server=>server.serverId===serverId).engine};
  };
  const native = async (binding,id,operation,input,canAdmit) => {
    const {port,engine} = select(binding);
    if (!engine) return port[operation](binding,id,input,canAdmit);
    if (operation === 'add' && binding.mode === 'steer') return reject();
    const inputs = await getInputs(engine);
    if (!inputs) throw new Error('Native Host input unavailable');
    const inputId = `actor-input:${id}`;
    const receipt = operation === 'receipt' ? await inputs.receipt(binding.threadId,inputId)
      : await inputs.submit(binding.threadId,inputId,input,canAdmit ?? (()=>false));
    return receipt ? { id: inputId, state:receipt.state, targetTurnId:receipt.turnId } : null;
  };
  return { ...primary, servers:descriptors, owns:serverId=>ports.has(serverId), serverForHost,
    directory: () => ({instanceId:machineId, servers:descriptors.map(server => ({serverId:server.serverId,label:server.label,
      engine:server.engine ?? 'codex', connectionState: getAppHost()?.hostState(server.hostId) === 'open' ? 'ready' : 'unknown',
      capabilities:{metadata:true,read:!server.engine,boundedRead:!server.engine,queue:true,steer:!server.engine,discoverFilters:!server.engine}}))}),
    metadata(ref) { const hostId = ports.get(ref.serverId)?.hostId ?? reject(); return select({...ref,hostId}).port.metadata(ref); },
    async discoverMetadata(options) {
      const port = ports.get(options.serverId); if (!port) return reject();
      if (descriptors.find(row => row.serverId === options.serverId)?.engine && (options.projectId !== undefined || options.cwd !== undefined))
        throw Object.assign(new Error('unsupported_capability'), {status:409,code:'unsupported_capability'});
      const result = await port.discoverMetadata(options);
      return {...result,conversations:result.conversations.filter(row => serverForHost(port.hostId,row.ref.threadId) === options.serverId)};
    },
    serverForThread: threadId => /^(?:pi_|dsh_acp_|claude_|acp_)/u.test(threadId) ? serverForHost('opencraft-server', threadId) : primary.serverId,
    hostForServer: serverId => ports.get(serverId)?.hostId ?? reject(),
    async discover(search,cursor) {
      const positions = cursor ? JSON.parse(Buffer.from(cursor,'base64url').toString()) : { codex:null, agent:engines.length ? null : false };
      if (!positions || typeof positions !== 'object' || Array.isArray(positions)
        || Object.keys(positions).some(key=>!['codex','agent'].includes(key))
        || !['codex','agent'].every(key=>positions[key]===null || positions[key]===false || typeof positions[key]==='string')
        || !engines.length && positions.agent!==false) throw new Error('Invalid conversation cursor');
      // Both catalogs contribute to the first page; Pi/DSH must not be hidden
      // behind every page of a large Codex history.
      const [codex,agent] = await Promise.all([
        positions.codex===false ? null : primary.discover(search,positions.codex),
        positions.agent===false ? null : callConversationHost(getAppHost(),{hostId:'opencraft-server',threadId:''},'catalog','thread/list',
          {limit:30,searchTerm:search.trim()||null,archived:false,cursor:positions.agent}),
      ]);
      const conversations = [...(codex?.conversations ?? []), ...(agent?.data ?? []).map(thread=>({
        ref:{serverId:serverForHost('opencraft-server',thread.id),threadId:thread.id},title:thread.name||thread.preview||thread.id,
      }))];
      const following={codex:codex?.nextCursor ?? false,agent:agent?.nextCursor ?? false};
      return {conversations,nextCursor:Object.values(following).some(value=>value!==false)?Buffer.from(JSON.stringify(following)).toString('base64url'):null};
    },
    read(ref,cursor) { const hostId=ports.get(ref.serverId)?.hostId ?? reject(); return select({...ref,hostId}).port.read(ref,cursor); },
    readBounded(ref,cursor) {
      const hostId=ports.get(ref.serverId)?.hostId ?? reject(), selected=select({...ref,hostId});
      if(selected.engine) throw Object.assign(new Error('unsupported_capability'), {status:409,code:'unsupported_capability'});
      return selected.port.readBounded(ref,cursor);
    },
    validate(binding) { return select(binding).port.validate(binding); },
    receipt:(binding,id)=>native(binding,id,'receipt'),
    add:(binding,id,input,canAdmit)=>native(binding,id,'add',input,canAdmit),
    steer(binding,...args) { const {port,engine}=select(binding); if(engine) return reject(); return port.steer(binding,...args); },
    cancel(binding,...args) { const {port,engine}=select(binding); return engine?Promise.resolve(false):port.cancel(binding,...args); },
  };
}
