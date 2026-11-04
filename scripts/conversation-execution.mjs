import {projectContext} from '@opencraft/appserver-protocol/collaboration';
import {THREAD_COUNT_CAPABILITY,THREAD_COUNT_METHOD,THREAD_COUNT_MODE} from '@opencraft/appserver-protocol/collaboration';
import {PUBLIC_TEXT_SEARCH_CAPABILITY,PUBLIC_TEXT_SEARCH_METHOD,PUBLIC_TEXT_SEARCH_MODE} from '@opencraft/appserver-protocol/collaboration';
import {THREAD_SEARCH_CAPABILITY,THREAD_SEARCH_METHOD,THREAD_SEARCH_MODE} from '@opencraft/appserver-protocol/collaboration';
import { readProjects, readModels, readOptions, readOptionCatalog } from './conversation-discovery.mjs';
import {nativeConfiguration,unobservedTurnConfiguration} from '@opencraft/appserver-protocol/collaboration';
import { randomUUID, createHash } from 'node:crypto';
import { normalize, relative, isAbsolute } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { APP_HOST_PROTOCOL_VERSION } from '@opencraft/app-host-protocol/version';
import { projectConversationMetadata, readConversationPage, readConversationTail } from './conversation-projections.mjs';
import { THREAD_DEFAULTS_CAPABILITY,THREAD_DEFAULTS_WRITE,THREAD_DEFAULTS_READ,THREAD_DEFAULTS_SCOPE, CONVERSATION_QUEUE_CANCEL_CAPABILITY, CONVERSATION_STOP_CAPABILITY, CONVERSATION_STOP_METHOD, CONVERSATION_STOP_OBSERVE_METHOD } from '@opencraft/appserver-protocol/collaboration';
import { controlDiagnostic, parseTurnRecoveryNotice } from '@opencraft/appserver-protocol';

// Same diagnostic stream as the execution owner; observation cannot settle a request.
function observeControl(context, phase, outcome, error, method) {
  try { const event=controlDiagnostic(context?.controlObservation,phase,outcome,error,method);
    if(event)console.info('[codex-engine-diagnostic]',JSON.stringify(event));
  } catch { /* Diagnostic sinks never change control behavior. */ }
}
/** Narrow internal logical-client lane; no client-supplied RPC method or Host is forwarded. */
export function callConversationHost(appHost, binding, requestId, method, params, submissionContext, timeoutMs = 35_000, signal, requiredCapability, requireSettings = false) {
  const note=(phase,outcome,error)=>observeControl(submissionContext,phase,outcome,error,phase==='initialize'?'initialize':method);
  const interaction = method === 'opencraft/interactions/read' || method === 'opencraft/interactions/respond';
  const clientId = `actor-service:${randomUUID()}`, leaseId = randomUUID();
  return new Promise((resolve, reject) => {
    let connection, receive, generation, finished = false, phase = 'connect';
    note(phase,'started');
    const abort = () => finish(signal.reason ?? new Error('Conversation read cancelled'));
    const finish = (error, result) => {
      if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error && method.startsWith('opencraft/orchestration/')) {
        console.error('[thread-orchestration]', JSON.stringify({event:'host-request-failed',method,operationId:requestId,
          status:error.status ?? 503,rpcCode:typeof error.code==='number'?error.code:null,
          outcome:error.status===undefined?'unknown':'rejected'}));
      }
      note(phase,error?'failed':'succeeded',error);
      try { connection?.close(); } catch { /* Lease cleanup cannot rewrite the engine result. */ }
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => { note(phase,'timeout'); finish(['opencraft/thread-context/read','opencraft/turn-result/read','opencraft/turn-configuration/read'].includes(method)
      ? Object.assign(new Error('history_read_unavailable'),{status:503,code:'history_read_unavailable'})
      : new Error('Actor execution outcome unknown')); }, timeoutMs); timer.unref();
    const send = (id, operation, arguments_) => { phase=id==='init'?'initialize':'dispatch';note(phase,'started');return receive?.({ type: 'host/send', requestId: `send-${id}`, hostId: binding.hostId, leaseId, generation,
      frame: JSON.stringify({ id, method: operation, params: arguments_ }) }); };
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) { abort(); return; }
    try {
      connection = appHost.accept({
        subscribe(listener) { receive = listener; return () => { receive = undefined; }; }, start() {},
        // AppHost detaches Ports on shutdown without publishing a status frame.
        // Retire this request immediately; a submitted mutation remains uncertain
        // and its durable receipt must be reconciled rather than resubmitted.
        close() { if(!finished)note(phase,'disconnected');finish(new Error('Actor Host closed')); },
        postMessage(message) {
          if (finished) return;
          if (message.type === 'ready') receive?.({ type: 'host/connect', requestId: 'connect', hostId: binding.hostId, leaseId });
          else if (message.type === 'response' && message.requestId === 'connect') {
            if (!message.ok || !Number.isSafeInteger(message.result?.generation)) return finish(new Error('Actor Host unavailable'));
            generation = message.result.generation;
            send('init', 'initialize', { clientInfo: { name: 'opencraft-actor-service', version: '1' }, capabilities: { experimentalApi: true, ...(interaction ? {extensions:{'opencraft/shared-interactions':{version:1}}} : {}) } });
          } else if (message.type === 'response' && !message.ok) finish(new Error('Actor Host admission failed'));
          else if (message.type === 'host/frame' && message.hostId === binding.hostId && message.generation === generation) {
            try {
              const frame = JSON.parse(message.frame);
              if (frame.method || !['init', 'operation'].includes(frame.id)) return;
              phase=frame.id==='init'?'initialize':'response';
              if(frame.error)note(phase,'failed',frame.error);

              if(method===THREAD_COUNT_METHOD&&frame.error)return finish(Object.assign(new Error('Recorded thread count unavailable'),{status:[401,403].includes(frame.error.data?.status)?frame.error.data.status:frame.error.data?.code==='unsupported_capability'?409:503,code:[401,403].includes(frame.error.data?.status)?'actor_authentication_required':frame.error.code===-32601?'unsupported_capability':(['thread_count_unknown','unsupported_capability'].includes(frame.error.data?.code)?frame.error.data.code:'thread_count_unavailable')}));
              if(frame.id==='init'&&method===THREAD_COUNT_METHOD){const cap=frame.result?.capabilities?.extensions?.[THREAD_COUNT_CAPABILITY];if(cap?.version!==1||cap.mode!==THREAD_COUNT_MODE)return finish(Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'}));}
              if(method===PUBLIC_TEXT_SEARCH_METHOD&&frame.error)return finish(Object.assign(new Error('Public text read unavailable'),{status:['text_search_changed','unsupported_capability'].includes(frame.error.data?.code)?409:503,code:frame.error.code===-32601?'unsupported_capability':(['text_search_changed','text_search_unknown','unsupported_capability'].includes(frame.error.data?.code)?frame.error.data.code:'text_search_unavailable')}));
              if(frame.id==='init'&&method===PUBLIC_TEXT_SEARCH_METHOD){const cap=frame.result?.capabilities?.extensions?.[PUBLIC_TEXT_SEARCH_CAPABILITY];if(cap?.version!==1||cap.mode!==PUBLIC_TEXT_SEARCH_MODE)return finish(Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'}));}
              if(method===THREAD_SEARCH_METHOD&&frame.error)return finish(Object.assign(new Error('Directory read unavailable'),{status:frame.error.data?.code==='unsupported_capability'?409:frame.error.data?.code==='thread_search_changed'?409:503,code:frame.error.code===-32601?'unsupported_capability':(['thread_search_changed','unsupported_capability'].includes(frame.error.data?.code)?frame.error.data.code:'thread_search_unavailable')}));
              if(frame.id==='init'&&method===THREAD_SEARCH_METHOD){const cap=frame.result?.capabilities?.extensions?.[THREAD_SEARCH_CAPABILITY];if(cap?.version!==1||cap.mode!==THREAD_SEARCH_MODE)return finish(Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'}));}
              if (frame.error?.data?.code === 'UNSUPPORTED_CAPABILITY' || [THREAD_DEFAULTS_WRITE,THREAD_DEFAULTS_READ].includes(method)&&frame.error?.data?.code==='unsupported_capability' || [CONVERSATION_STOP_METHOD,CONVERSATION_STOP_OBSERVE_METHOD].includes(method) && frame.error?.data?.code === 'unsupported_capability' || (params.sourceRead === true || ['opencraft/thread-context/read','opencraft/turn-result/read','opencraft/turn-configuration/read'].includes(method)) && frame.error?.code === -32601) return finish(Object.assign(new Error('unsupported_capability'), {status:409,code:'unsupported_capability'}));
              if (['opencraft/thread-context/read','opencraft/turn-result/read','opencraft/turn-configuration/read'].includes(method) && frame.error?.data?.code === 'HISTORY_READ_UNAVAILABLE') return finish(Object.assign(new Error('history_read_unavailable'),{status:503,code:'history_read_unavailable'}));
              if (frame.error?.data?.code === 'history_changed') return finish(Object.assign(new Error('history_changed'),{status:409,code:'history_changed'}));
              if (interaction && frame.error?.data?.code) return finish(Object.assign(new Error(frame.error.data.code),{status:frame.error.data.code==='INVALID_RESPONSE'?400:409,code:frame.error.data.code.toLowerCase()}));
              if (frame.error) return finish(Object.assign(new Error('Actor engine request rejected'), {
                code: frame.error.code,
                // Creation may already have happened (for example a lost stable ID
                // or a replaced Host). Only the Broker's committed rejection
                // receipt can declare that mutation rejected.
                ...(method!=='thread/start' && method!=='opencraft/orchestration/create' && frame.error.data?.resultUnknown!==true
                  ? (typeof frame.error.code==='number' && frame.error.code>=400 && frame.error.code<=599)
                    ? {status:frame.error.code}
                    : [-32600,-32601,-32602].includes(frame.error.code) ? {status:400} : {}
                  : {}),
                ...(method==='thread/start' && frame.id==='operation' && frame.error.data?.resultUnknown===true
                  && typeof frame.error.data.threadId==='string' && frame.error.data.threadId.length>0
                  && frame.error.data.threadId.length<=512 && !/[\x00-\x20]/u.test(frame.error.data.threadId)
                  ? {threadId:frame.error.data.threadId} : {}) }));
              if(frame.id==='init'&&[THREAD_DEFAULTS_WRITE,THREAD_DEFAULTS_READ].includes(method)){
                const cap=frame.result?.capabilities?.extensions?.[THREAD_DEFAULTS_CAPABILITY];
                if(cap?.version!==1||cap.scope!==THREAD_DEFAULTS_SCOPE||cap.finalAdmission!==true||cap[method===THREAD_DEFAULTS_WRITE?'write':'read']!==true)
                  return finish(Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'}));
              }
              if (frame.id === 'init' && params.sourceRead === true && frame.result?.capabilities?.extensions?.['opencraft/read-history']?.sourceRead !== true) return finish(Object.assign(new Error('unsupported_capability'), {status:409,code:'unsupported_capability'}));
              if (frame.id === 'init' && ['opencraft/thread-context/read','opencraft/turn-result/read','opencraft/turn-configuration/read'].includes(method) && frame.result?.capabilities?.extensions?.['opencraft/read-history']?.[method==='opencraft/thread-context/read'?'contextUsage':method==='opencraft/turn-configuration/read'?'turnConfigurationObservation':'exactResult'] !== true) return finish(Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'}));
              if (frame.id === 'init' && [CONVERSATION_STOP_METHOD,CONVERSATION_STOP_OBSERVE_METHOD].includes(method)
                && (frame.result?.capabilities?.extensions?.[CONVERSATION_STOP_CAPABILITY]?.version !== 1
                  || frame.result.capabilities.extensions[CONVERSATION_STOP_CAPABILITY].exactTurn !== true
                  || frame.result.capabilities.extensions[CONVERSATION_STOP_CAPABILITY].observe !== true))
                return finish(Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'}));
              if (frame.id === 'init' && requiredCapability
                && (frame.result?.capabilities?.extensions?.[requiredCapability]?.version !== 1
                  || frame.result.capabilities.extensions[requiredCapability].finalAdmission !== true))
                return finish(Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'}));
              if(frame.id==='init' && requireSettings && frame.result?.capabilities?.extensions?.['opencraft/thread-queue']?.modelSettings!==true)return finish(Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'}));
              if (frame.id === 'init' && interaction) {
                if(frame.result?.capabilities?.extensions?.['opencraft/shared-interactions']?.structuredResponses !== true) return finish(Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'}));

              }
              submissionContext?.resourceOwner?.assertCurrent();
              if (frame.id === 'init') send('operation', method, { ...params, ...(binding.threadId ? {threadId: binding.threadId} : {}) });
              else finish(null, frame.result);
            } catch (error) { finish(error); }
          } else if (message.type === 'fatal' || message.type === 'host/status' && ['failed', 'closed'].includes(message.status.state)) { note(phase,'disconnected');finish(new Error('Actor Host closed')); }
        },
      }, clientId, submissionContext ?? { sender: null, collaborationRequestId: requestId }, submissionContext === undefined);
      receive?.({ type: 'hello', protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: clientId });
    } catch (error) { finish(error); }
  });
}
/** Same Server catalog used by the composer. Roots describe workspace scope,
 * never Actor permissions. No project creation or parent-thread inheritance. */
export async function prepareConversationCreation(invoke, target) {
  let cursor = null, project;
  do {
    const page = await invoke('project/list',{limit:1000,cursor});
    project = page.data.find(row=>row.id===target.projectId);
    cursor = page.nextCursor ?? null;
  } while (!project && cursor);
  if (!project) throw Object.assign(new Error('Project unavailable'),{status:404,code:'conversation_unavailable'});
  let cwd, roots;
  try {
    cwd = await realpath(target.cwd);
    roots = await Promise.all(project.roots.map(async root=> {
      const path = await realpath(root.path);
      if (!(await stat(path)).isDirectory()) throw new Error('Invalid root');
      return path;
    }));
    if (!(await stat(cwd)).isDirectory()) throw new Error('Invalid cwd');
  } catch { throw Object.assign(new Error('Workspace unavailable'),{status:400,code:'invalid_cwd'}); }
  // Keep the explicitly chosen project/cwd relationship; symlinks cannot select
  // a different workspace. This does not establish an Actor-to-project ACL.
  if (!roots.some(root=> { const path=relative(root,cwd); return path==='' || path!=='..' && !path.startsWith('../') && !isAbsolute(path); }))
    throw Object.assign(new Error('Cwd outside project'),{status:400,code:'invalid_cwd'});
  return {cwd,runtimeWorkspaceRoots:[...new Set(roots)]};
}
export function createConversationExecution(getAppHost, {serverId, hostId, engine, projectHostId = hostId, getMessageAttachments}) {
  if (typeof hostId !== 'string' || !hostId.trim() || hostId.length > 256 || /[\x00-\x1f]/u.test(hostId)) throw new Error('Conversation execution Host required');
  const invoke = (binding, id, method, params, timeoutMs, signal) => {
    if (binding.hostId !== hostId) throw new Error('Unsupported Actor execution Host');
    const host = getAppHost(); if (!host) throw new Error('Actor Host unavailable');
    return callConversationHost(host, binding, id, method, params, undefined, timeoutMs, signal);
  };
  const binding = threadId => ({hostId, threadId});
  const initialPermission=async(cwd,initialOptions,context)=> {
    context.resourceOwner.assertCurrent();
    const directory=await readOptionCatalog((method,params)=>callConversationHost(getAppHost(),binding(''),'initial-options',method,params,context,5_000),cwd,null,{permissionsOnly:true});
    context.resourceOwner.assertCurrent();
    const selected=directory.permissionModes.values?.find(row=>row.mode===initialOptions.permissionMode);
    if (!directory.requirements.supported || !directory.permissionModes.supported || !selected)
      throw Object.assign(new Error('unsupported_permission_mode'),{status:409,code:'unsupported_permission_mode'});
    if (!selected.allowed) throw Object.assign(new Error('permission_mode_disallowed'),{status:403,code:'permission_mode_disallowed'});
    return selected;
  };
  return {
    serverId, hostId,
    async threadDefaults(ref,bundle,context){
      if(engine||ref.serverId!==serverId)throw Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'});
      const observedContext=bundle?{...context,controlObservation:{traceId:randomUUID(),control:'thread-defaults'}}:context;
      return callConversationHost(getAppHost(),binding(ref.threadId),'thread-defaults',bundle?THREAD_DEFAULTS_WRITE:THREAD_DEFAULTS_READ,bundle?{scope:THREAD_DEFAULTS_SCOPE,bundle}:{},observedContext,22000);
    },
    async projects(requestedServer, cursor) {
      if (engine || requestedServer !== serverId) throw Object.assign(new Error('unsupported_capability'), {status:409,code:'unsupported_capability'});
      return readProjects((method,params)=>callConversationHost(getAppHost(),{hostId:projectHostId,threadId:''},'project-discovery',method,params,undefined,10_000),serverId,cursor);
    },
    async models(requestedServer, cursor) {
      if (engine || requestedServer !== serverId) throw Object.assign(new Error('unsupported_capability'), {status:409,code:'unsupported_capability'});
      return readModels((method,params)=>invoke(binding(''),'model-discovery',method,params,10_000),serverId,cursor);
    },
    async context(ref,context) {
      if(engine||ref.serverId!==serverId)throw Object.assign(Error('unsupported_capability'),{status:409,code:'unsupported_capability'});
      const result=await callConversationHost(getAppHost(),binding(ref.threadId),'thread-context','opencraft/thread-context/read',{},context,10000);
      return {...projectContext(result),ref};
    },
    async options(ref) {
      if (engine || ref.serverId !== serverId) throw Object.assign(new Error('unsupported_capability'), {status:409,code:'unsupported_capability'});
      const result=await readOptions((method,params)=>invoke(binding(method==='thread/read'?ref.threadId:''),'options-discovery',method,params,5_000),ref);
      if (!result.supported) return result;
      if(result.optionCatalog) result.optionCatalog.initialWrite.permissionMode=result.optionCatalog.requirements.supported && result.optionCatalog.permissionModes.supported && result.optionCatalog.permissionModes.values.some(row=>row.allowed);
      return {...result,modelCatalog:await readModels((method,params)=>invoke(binding(''),'options-models',method,params,5_000),serverId,null)};
    },
    async stop(ref,expectedTurnId,context,observeOnly=false) {
      if (engine || ref.serverId!==serverId) throw Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'});
      return callConversationHost(getAppHost(),binding(ref.threadId),'conversation-stop',observeOnly?CONVERSATION_STOP_OBSERVE_METHOD:CONVERSATION_STOP_METHOD,
        {expectedTurnId},context,12_000);
    },
    observeStop(ref,expectedTurnId,context) { return this.stop(ref,expectedTurnId,context,true); },
    async messageAttachments(ref,query,context,signal){
      const port=getMessageAttachments?.();if(engine||ref.serverId!==serverId||!port)throw Object.assign(Error('unsupported_capability'),{status:409,code:'unsupported_capability'});
      return port.read(ref,query,context,signal);
    },
    async prepareSettings(serverIdValue,settings,context) {
      if(engine || serverIdValue!==serverId)throw Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'});
      let cursor=null,model;
      do {
        const result=await callConversationHost(getAppHost(),{hostId,threadId:''},'model-settings','model/list',{cursor,limit:100},context,15000,undefined,undefined,true);
        model=settings.model ? result.data?.find(m=>m.model===settings.model||m.id===settings.model) : null;
        cursor=result.nextCursor??null;
      }while(settings.model && !model && cursor);
      if(settings.model && !model)throw Object.assign(new Error('model_unavailable'),{status:409,code:'model_unavailable'});
      if(settings.reasoningEffort && model && !model.supportedReasoningEfforts?.some(e=>e.reasoningEffort===settings.reasoningEffort))
        throw Object.assign(new Error('reasoning_effort_unavailable'),{status:409,code:'reasoning_effort_unavailable'});
    },
    async prepareCreate(target, context) {
      if (engine || target.serverId!==serverId) throw Object.assign(new Error('unsupported_capability'),{status:409});
      observeControl(context,'prepare','started');
      try {
      const settings=await prepareConversationCreation((method,params)=>callConversationHost(getAppHost(),{hostId:projectHostId,threadId:''},'create-prepare',method,params,context),target);
      await initialPermission(settings.cwd,target.initialOptions ?? {permissionMode:'read-only'},context);
      if(target.initialOptions)settings.initialOptions=target.initialOptions;
      observeControl(context,'prepare','succeeded');return settings;
      } catch(error) {observeControl(context,'prepare','failed',error);throw error;}
    },
    async create(target, settings, context) {
      if (engine || target.serverId!==serverId) throw Object.assign(new Error('unsupported_capability'),{status:409});
      let createPhase='revalidate';
      observeControl(context,createPhase,'started');
      try {
      context.resourceOwner.assertCurrent();
      const {initialOptions}=settings;
      {
        const current=await prepareConversationCreation((method,params)=>callConversationHost(getAppHost(),{hostId:projectHostId,threadId:''},'create-revalidate',method,params,context),target);
        context.resourceOwner.assertCurrent();
        if(current.cwd!==settings.cwd || JSON.stringify(current.runtimeWorkspaceRoots)!==JSON.stringify(settings.runtimeWorkspaceRoots))
          throw Object.assign(new Error('creation_target_changed'),{status:409,code:'creation_target_changed'});
      }
      // Bind the existing named read-only profile even without an explicit
      // option. A raw sandbox override alone may resume under ambient config.
      createPhase='permission';observeControl(context,createPhase,'started');
      const selected=await initialPermission(settings.cwd,initialOptions ?? {permissionMode:'read-only'},context);
      context.resourceOwner.assertCurrent();
      createPhase='dispatch';
      const result = await callConversationHost(getAppHost(),binding(''),'create','thread/start',
        // Host-only settings and project IDs never become Native parameters.
        {cwd:settings.cwd,runtimeWorkspaceRoots:settings.runtimeWorkspaceRoots,
          permissions:selected.nativeProfileId,approvalPolicy:selected.approvalPolicy,
          ...(settings.inputSettings?.model?{model:settings.inputSettings.model,allowProviderModelFallback:false}:{}),
          ...(settings.inputSettings?.reasoningEffort?{config:{model_reasoning_effort:settings.inputSettings.reasoningEffort}}:{})},context,35000,undefined,undefined,Boolean(settings.inputSettings));
      createPhase='settlement';observeControl(context,createPhase,'started');
      if (typeof result?.thread?.id!=='string' || result.thread.ephemeral===true) throw new Error('Creation outcome unknown');
      return {threadId:result.thread.id,nativeConfirmedConfiguration:nativeConfiguration(result,'native/thread/start','creation'),
        ...(initialOptions ? {nativeInitialObservation:{source:'native/thread/start',observedAt:Date.now(),scope:'new-thread-subsequent',
          permissionProfileId:typeof result.activePermissionProfile?.id==='string'?result.activePermissionProfile.id:null,
          approvalPolicy:['on-request','never'].includes(result.approvalPolicy)?result.approvalPolicy:null}} : {})};
      } catch(error) {observeControl(context,createPhase,'failed',error);throw error;}
    },
    async metadata(ref) {
      if (ref.serverId !== serverId) throw Object.assign(new Error('Unknown conversation server'), {status:404,code:'conversation_unavailable'});
      let result, nativeObserved=false;
      if(!engine){
        try{result=await invoke(binding(ref.threadId),'metadata-configuration','thread/read',{includeTurns:false,sourceRead:true});nativeObserved=true;}
        catch{/* History-only/old owners retain metadata, with no configuration claim. */}
      }
      result??=await invoke(binding(ref.threadId),'metadata','thread/read',{includeTurns:false});
      const {thread}=result;
      if (thread?.id !== ref.threadId) throw Object.assign(new Error('Conversation unavailable'), {status:404,code:'conversation_unavailable'});
      let recovery = null;
      if (!engine) {
        try { recovery = parseTurnRecoveryNotice((await invoke(binding(ref.threadId), 'metadata-recovery', 'opencraft/turn-recovery/read', {}, 1000)).recovery); }
        catch { /* Missing or unavailable recovery metadata does not invalidate native thread metadata. */ }
      }
      return {...projectConversationMetadata(serverId, thread, false, recovery),...(!engine?{nativeConfirmedConfiguration:nativeObserved?nativeConfiguration(thread,'native/thread/read',thread.status?.type==='notLoaded'?'thread-last-persisted':'thread-current'):null,actualTurnSettings:null}:{})};
    },
    threadCount(target,request,context,signal) {
      if(target!==serverId||engine)throw Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'});
      return callConversationHost(getAppHost(),{hostId,threadId:''},'thread-count',THREAD_COUNT_METHOD,request,context,9000,signal);
    },
    publicTextSearch(target,request,context,signal) {
      if(target!==serverId||engine)throw Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'});
      return callConversationHost(getAppHost(),{hostId,threadId:''},'thread-text-search',PUBLIC_TEXT_SEARCH_METHOD,request,context,9000,signal);
    },
    threadSearch(target,request,context,signal) {
      if(target!==serverId||engine)throw Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'});
      return callConversationHost(getAppHost(),{hostId,threadId:''},'thread-name-search',THREAD_SEARCH_METHOD,request,context,9000,signal);
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
    async interactions(ref,context) {
      if (engine || ref.serverId!==serverId) throw Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'});
      return callConversationHost(getAppHost(),binding(ref.threadId),'interactions','opencraft/interactions/read',{},context,10_000);
    },
    async respondInteraction(ref,submission,context) {
      if (engine || ref.serverId!==serverId) throw Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'});
      return callConversationHost(getAppHost(),binding(ref.threadId),'interaction-response','opencraft/interactions/respond',submission,context,10_000);
    },
    async turnConfigurationObservation(ref,turnId) {
      if(engine||ref.serverId!==serverId)return unobservedTurnConfiguration(turnId,'unsupported');
      const deadline=AbortSignal.timeout(9000);
      try {
        const result=await invoke(binding(ref.threadId),'turn-configuration','opencraft/turn-configuration/read',{turnId},9000,deadline);
        if(result.turnId!==turnId)return unobservedTurnConfiguration(turnId);
        return result;
      } catch(error) { return unobservedTurnConfiguration(turnId,error.code==='unsupported_capability'?'unsupported':deadline.aborted||error.code==='history_read_unavailable'?'unknown':'unavailable'); }
    },
    async exactResult(ref,turnId,output,cursor) {
      if (engine || ref.serverId!==serverId) throw Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'});
      let nativeCursor = null;
      if (cursor !== null) {
        try {
          const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
          if(c.v!==1 || JSON.stringify(c.ref)!==JSON.stringify(ref) || c.turnId!==turnId || typeof c.cursor!=='string'
            || Object.keys(c).some(k=>!['v','ref','turnId','cursor'].includes(k))) throw Error();
          nativeCursor=c.cursor;
        } catch { throw Object.assign(new Error('history_changed'),{status:409,code:'history_changed'}); }
      }
      const result=await invoke(binding(ref.threadId),'exact-result','opencraft/turn-result/read',{turnId,output,cursor:nativeCursor},10_000,AbortSignal.timeout(10_000));
      if(result.turnId!==turnId) throw new Error('Invalid exact result target');
      return {...result,nextCursor:result.nextCursor===null?null:Buffer.from(JSON.stringify({v:1,ref,turnId,cursor:result.nextCursor})).toString('base64url')};
    },
    async readTail(ref, limit) {
      if(ref.serverId !== serverId) throw new Error('Unknown conversation server');
      const signal = AbortSignal.timeout(10_000);
      return readConversationTail((method, params) => invoke(binding(ref.threadId), 'history-tail', method, params, 10_000, signal), ref, limit, signal);
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
    async cancel(binding, id, queueId,assertAdmission) {
      if (binding.hostId!==hostId) throw new Error('Unsupported Actor execution Host');
      const context=assertAdmission?{sender:null,collaborationRequestId:id,resourceOwner:{id:'hub-cancel',assertCurrent:assertAdmission}}:undefined;
      return (await callConversationHost(getAppHost(),binding,id,'thread/queue/delete',{queuedSubmissionId:queueId},context,undefined,undefined,assertAdmission?CONVERSATION_QUEUE_CANCEL_CAPABILITY:undefined)).deleted===true;
    },
  };
}

/** Full conversation identity selects the native engine. Actor run bindings and
 * delegation stay on the default Codex authority until explicitly extended. */
export function createRoutedConversationExecution(getAppHost, { machineId, engines, getInputs, getMessageAttachments, getCodexReadiness }) {
  const agentEngine = threadId => threadId.startsWith('dsh_acp_') ? 'dsh-acp' : threadId.startsWith('pi_') ? 'pi'
    : threadId.startsWith('claude_') ? 'claude-code' : threadId.startsWith('acp_') ? 'acp' : 'dsh';
  const descriptors = [{ serverId: `server:${machineId}:codex`, hostId: 'local-codex', projectHostId:'opencraft-server', label:'Codex' },
    ...engines.map(engine => ({ serverId: `server:${machineId}:${engine}`, hostId: 'opencraft-server', engine, label:engine==='pi'?'Pi':'DSH' }))];
  const ports = new Map(descriptors.map(server => [server.serverId, createConversationExecution(getAppHost, {...server,...(!server.engine?{getMessageAttachments}:{})})]));
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
      engine:server.engine ?? 'codex', connectionState: !server.engine && getCodexReadiness ? (getCodexReadiness() === 'ready' ? 'ready' : getCodexReadiness() === 'unavailable' ? 'unavailable' : 'unknown') : getAppHost()?.hostState(server.hostId) === 'open' ? 'ready' : 'unknown',
      capabilities:{contextUsage:!server.engine,threadCommands:false,messageAttachments:!server.engine&&Boolean(getMessageAttachments?.()),threadCount:!server.engine,metadata:true,read:!server.engine,boundedRead:!server.engine,tailRead:!server.engine,queue:true,steer:!server.engine,discoverFilters:!server.engine,create:!server.engine,projectDiscovery:!server.engine,modelDiscovery:!server.engine,executionOptions:!server.engine,optionCatalog:!server.engine,initialPermissionMode:!server.engine,exactResult:!server.engine,turnConfigurationObservation:!server.engine,threadDefaults:!server.engine,threadDefaultsObserve:!server.engine,stop:!server.engine,stopObserve:!server.engine,queueCancel:!server.engine,queueRequests:true,publicTextSearch:!server.engine,threadSearch:!server.engine,interactions:!server.engine,interactionRespond:!server.engine,modelSettings:!server.engine}}))}),
    projects(serverId,cursor) { return (ports.get(serverId) ?? reject()).projects(serverId,cursor); },
    models(serverId,cursor) { return (ports.get(serverId) ?? reject()).models(serverId,cursor); },
    context(ref,context) { return (ports.get(ref.serverId) ?? reject()).context(ref,context); },
    options(ref) { return (ports.get(ref.serverId) ?? reject()).options(ref); },
    threadDefaults(ref,bundle,context){return (ports.get(ref.serverId)??reject()).threadDefaults(ref,bundle,context);},
    stop(ref,expected,context,observeOnly) { return (ports.get(ref.serverId) ?? reject()).stop(ref,expected,context,observeOnly); },
    observeStop(ref,expected,context) { return (ports.get(ref.serverId) ?? reject()).observeStop(ref,expected,context); },
    metadata(ref) { const hostId = ports.get(ref.serverId)?.hostId ?? reject(); return select({...ref,hostId}).port.metadata(ref); },
    threadCount(serverId,request,context,signal) {return (ports.get(serverId)??reject()).threadCount(serverId,request,context,signal);},
    publicTextSearch(serverId,request,context,signal) {return (ports.get(serverId)??reject()).publicTextSearch(serverId,request,context,signal);},
    threadSearch(serverId,request,context,signal) {return (ports.get(serverId)??reject()).threadSearch(serverId,request,context,signal);},
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
    interactions(ref,context) {
      const selected=select({...ref,hostId:ports.get(ref.serverId)?.hostId ?? reject()});
      return selected.port.interactions(ref,context);
    },
    respondInteraction(ref,...args) {
      const selected=select({...ref,hostId:ports.get(ref.serverId)?.hostId ?? reject()});
      return selected.port.respondInteraction(ref,...args);
    },
    messageAttachments(ref,...args){const selected=select({...ref,hostId:ports.get(ref.serverId)?.hostId??reject()});return selected.port.messageAttachments(ref,...args);},
    turnConfigurationObservation(ref,...args) {
      const hostId=ports.get(ref.serverId)?.hostId ?? reject(),selected=select({...ref,hostId});
      return selected.port.turnConfigurationObservation(ref,...args);
    },
    exactResult(ref,...args) {
      const hostId=ports.get(ref.serverId)?.hostId ?? reject(),selected=select({...ref,hostId});
      if(selected.engine) throw Object.assign(new Error('unsupported_capability'),{status:409,code:'unsupported_capability'});
      return selected.port.exactResult(ref,...args);
    },
    readTail(ref,limit) {
      const hostId=ports.get(ref.serverId)?.hostId ?? reject(), selected=select({...ref,hostId});
      if(selected.engine) throw Object.assign(new Error('unsupported_capability'), {status:409,code:'unsupported_capability'});
      return selected.port.readTail(ref,limit);
    },
    validate(binding) { return select(binding).port.validate(binding); },
    receipt:(binding,id)=>native(binding,id,'receipt'),
    add:(binding,id,input,canAdmit)=>native(binding,id,'add',input,canAdmit),
    steer(binding,...args) { const {port,engine}=select(binding); if(engine) return reject(); return port.steer(binding,...args); },
    cancel(binding,...args) { const {port,engine}=select(binding); return engine?Promise.resolve(false):port.cancel(binding,...args); },
  };
}
