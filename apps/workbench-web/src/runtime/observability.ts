import {observePendingRpcLoop} from "./rpc-loop-observation";
import {compactRequestTrace} from "@opencraft/appserver-protocol";
import { createClientId } from "@opencraft/composer-core";
import type { AppServerClient } from '@opencraft/appserver-client';
import type { TrustedExtensionDefinition } from '@opencraft/extension-runtime';
import { serverFetch, serverUrl } from './server-context';
import { observeClientLifecycle } from './client-lifecycle-observation';

type Event = Record<string, string | number | null>;
let enabled = false;
const recoveryContexts = new Map<string,{recoveryId:string;attemptId?:string;generation?:number}>();
const usableHosts = new Set<string>();
const connectionOutages = new Map<string, { id: string; started: number }>();
const historyOperations = new Map<string, string>();
export function bindHistoryObservation(scope: { hostId: string; threadId: string }, operationId: string): () => void {
  const key = JSON.stringify([scope.hostId, scope.threadId]);
  historyOperations.set(key, operationId);
  return () => { if (historyOperations.get(key) === operationId) historyOperations.delete(key); };
}
const enabledListeners = new Set<() => void>();
export function subscribeObservationEnabled(listener: () => void) {
  enabledListeners.add(listener);if(enabled)listener();
  return () => { enabledListeners.delete(listener); };
}
let buildId: string | null = null, sourceRevision: string | null = null;
const producerId = createClientId();
let pending: { event: Event; size: number }[] = [], recent: {event: Event; size: number}[] = [];
let pendingBytes = 0, recentBytes = 0, dropped = 0, timer: ReturnType<typeof setTimeout> | undefined;
let sending = false, failures = 0, lastAttempt = 0, immediateAttempted = false;
const methods = new Set(['initialize','runtime/machine/read','thread/read','thread/resume','thread/list','thread/start','thread/fork','thread/unsubscribe','thread/archive','thread/name/set','thread/items/list','thread/turns/list','thread/loaded/list','turn/start','turn/steer','turn/interrupt','turn/continue','turn/respond','model/list','config/read','config/value/write','config/batchWrite','configRequirements/read','tasks/list','tasks/read','tasks/create','tasks/update','tasks/delete','opencraft/tasks/list','opencraft/tasks/read','opencraft/tasks/create','opencraft/tasks/update','opencraft/schedules/list','opencraft/schedules/create','opencraft/schedules/update','opencraft/schedules/delete','fs/read','fs/write','fs/stat','fs/list','fuzzyFileSearch','command/exec','command/exec/write','command/exec/terminate','process/spawn','process/kill','process/writeStdin','skills/list','skills/read','bot/list','bot/read','mcpServerStatus/list']);
function schedule() {
  if (timer || sending || !pending.length || document.visibilityState === 'hidden') return;
  const delay = Math.max(0, lastAttempt + Math.min(60000,10000 * 2 ** Math.min(3,failures)) - Date.now());
  timer = setTimeout(() => { timer = undefined; void flush(); },delay);
}
async function flush() {
  if (!enabled || sending || !pending.length || document.visibilityState === 'hidden') return;
  const events: Event[] = []; let size = 13;
  while (pending.length && events.length < 32 && size + pending[0].size + 1 <= 32768) {
    const item = pending.shift()!;pendingBytes -= item.size;size += item.size + 1;events.push(item.event);
  }
  sending = true; lastAttempt = Date.now();
  try { const response = await serverFetch('/__opencraft_observe/events',{method:'POST',credentials:'same-origin',redirect:'error',
    headers:{'content-type':'application/json'},body:JSON.stringify({events}),signal:AbortSignal.timeout(4500)});
    if (!response.ok) { dropped += events.length; failures++; if ([401,403,404].includes(response.status)) enabled = false; }
    else { failures = 0; immediateAttempted = false; }
  } catch { dropped += events.length; failures++; }
  finally { sending = false; schedule(); }
}
export function observeEvent(fields: Event) {
  if (!enabled) return;
  const event: Event = { schemaVersion:1,component:'web',producerId,eventId:createClientId(),at:Date.now(),
    ...(fields.outcome==='failed'||fields.outcome==='timeout'?{incidentRef:createClientId()}:{}),
    buildId,sourceRevision,visibility:document.visibilityState==='visible'?'visible':'hidden',originClass:'interactive',dropped,...fields };
  for(const [key,value] of Object.entries(event)) if(typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value)) event[key]=Math.round(value*1000)/1000;
  const encoder=new TextEncoder();
  if(event.kind === "rpc" && (event.notificationId || event.gatewayIngressToReplyMs !== undefined)) {
    // Reserve 256 bytes for the ingress's existing identity pseudonyms.
    for(const key of ["historyProjectionMs","historyCoreMs","historyQueueMs","historyNativeRpcMs","gatewayDependencyMs","gatewayInitializeMs","storageAuthorizeMs","storageBusyRetries","storageBusyMs","storageDependencyMs","storageExecuteMs","storageQueueMs"]) {
      if(encoder.encode(JSON.stringify(event)).length<=1792)break;
      if(key in event) {delete event[key];event.diagnosticTrimmed=Number(event.diagnosticTrimmed ?? 0)+1;}
    }
  }
  const size = encoder.encode(JSON.stringify(event)).length;
  if (size > 2048 || pending.length >= 2048 || pendingBytes + size > 262144) { dropped++; return; }
  pending.push({event,size});pendingBytes += size;recent.push({event,size});recentBytes += size;
  while (recent.length > 128 || recentBytes > 131072) recentBytes -= recent.shift()!.size;
  if (['failed','timeout'].includes(String(fields.outcome)) && !immediateAttempted && !sending && document.visibilityState === 'visible') {
    immediateAttempted = true;clearTimeout(timer);timer = undefined;void flush();
  } else schedule();
}
export function beginObservedOperation(operationType: string, fields: Event = {}) {
  const started = performance.now(), operationId = createClientId();
  let settled = false;
  observeEvent({kind:'operation',operationType,operationId,outcome:'started',measurementScope:'in_page',...fields});
  return (outcome: 'ok' | 'failed' | 'aborted' | 'empty' = 'ok', extra: Event = {}) => {
    if (settled) return; settled = true;
    observeEvent({kind:'operation',operationType,operationId,outcome,durationMs:Math.max(0,performance.now()-started),measurementScope:'in_page',...fields,...extra});
  };
}
export function installClientObservation(client: AppServerClient) {
  const clientId=createClientId();
  const historyRequests = new Map<string | number, { webSentAt: number; clientQueueMs: number; historySource?: string; trace?: import("@opencraft/appserver-protocol").RequestTrace; operationId?: string; pending: number; timeoutMs: number }>();
  const loop=observePendingRpcLoop({now:()=>performance.now(),isVisible:()=>enabled && document.visibilityState === "visible",
    schedule:(run,delay)=>{const timer=setTimeout(run,delay);return()=>clearTimeout(timer);},
    onDelay:(delay,count)=>{const trace=historyRequests.values().next().value?.trace;
      observeEvent({kind:"client_signal",clientSignal:"rpc_loop_gap",hostId:clientId,...(trace ? compactRequestTrace(trace) : {}),
        clientLoopDelayMs:delay,requestPending:count,measurementScope:"client"});},
  });
  const onVisibility=()=>loop.setPending(historyRequests.size);
  document.addEventListener("visibilitychange",onVisibility);
  const stopEnabled=subscribeObservationEnabled(onVisibility);
  const unsubscribe = client.subscribeRequestLifecycle(event => {
    if (event.type === 'late-response') {
      observeEvent({kind:'client_signal',clientSignal:'late_response',hostId:clientId,count:1,measurementScope:'client'});
      return;
    }
    if (event.type === 'started') {
      const params = event.params as { threadId?: unknown } | null;
      historyRequests.set(event.id, { webSentAt: event.startedAtMs, clientQueueMs: event.queueWaitMs, pending: historyRequests.size + 1, timeoutMs: event.timeoutMs,
        historySource: event.historySource, trace: event.trace,
        operationId: typeof params?.threadId === 'string' ? historyOperations.get(JSON.stringify([event.hostId, params.threadId])) : undefined });
      loop.setPending(historyRequests.size);
      return;
    }
    if (!['completed','failed','timed-out','aborted'].includes(event.type)) return;
    if (!('durationMs' in event)) return;
    const history = historyRequests.get(event.id);
    loop.setPending(Math.max(0,historyRequests.size-(history ? 1 : 0)));
    historyRequests.delete(event.id);
    const diagnostic: Event = {};
    if (history) {
      if (history.trace) Object.assign(diagnostic, compactRequestTrace(history.trace), {traceRole:"client-rpc"});
      if (history.historySource) diagnostic.historyReadSource = history.historySource;
      const responseBytes = "responseBytes" in event ? event.responseBytes : undefined;
      if (responseBytes !== undefined) diagnostic.bytes = responseBytes;
      if ("decodeMs" in event && event.decodeMs !== undefined) diagnostic.historyDecodeMs = event.decodeMs;
      diagnostic.webSentAt = history.webSentAt; diagnostic.clientQueueMs = history.clientQueueMs;
      diagnostic.requestPending = history.pending;
      diagnostic.clientBudgetMs = history.timeoutMs;
      diagnostic.clientWallMs = Math.max(0, event.endedAtMs - history.webSentAt);
      if ("receivedAtMs" in event && event.receivedAtMs !== undefined) diagnostic.clientReceivedAt = event.receivedAtMs;
      if ("receiveToSettleMs" in event && event.receiveToSettleMs !== undefined) diagnostic.clientReceiveToSettleMs = event.receiveToSettleMs;
      if (history.operationId) diagnostic.operationId = history.operationId;
      const timing = event.type === 'completed' ? (event.result as { __opencraftHistoryTiming?: Record<string, unknown> } | null)?.__opencraftHistoryTiming : undefined;
      if (timing && typeof timing.pairId === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(timing.pairId)) {
        diagnostic.pairId = timing.pairId;
        for (const key of ['coreMs','metadataMs','queueMs','sourceMs','reconcileMs','pageMs','projectionMs','scanMs','nativeRpcMs','nativeRpcCount']) {
          const value = timing[key];
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)
            diagnostic['history' + key[0].toUpperCase() + key.slice(1)] = value;
        }
      }
    }
    const gateway = event.type === 'completed' ? (event.result as { __opencraftGatewayTiming?: Record<string, unknown> } | null)?.__opencraftGatewayTiming : event.type === 'failed' ? (event.error as { data?: { __opencraftGatewayTiming?: Record<string, unknown> } }).data?.__opencraftGatewayTiming : undefined;
    if (gateway && typeof gateway.gatewayPairId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(gateway.gatewayPairId)) {
      diagnostic.gatewayPairId = gateway.gatewayPairId;
      for (const key of ['gatewayIngressAt','gatewayIngressQueueMs','gatewayRpcAccessMs','gatewayIngressToReadMs','gatewayIngressToReplyMs','gatewayReplyAt','gatewayTimingVersion','gatewayMs','gatewayDependencyMs','gatewayStorageMs','gatewayInitializeMs','gatewaySourceMs','storageDependencyMs','storageQueueMs','storageExecuteMs','storageBusyMs','storageBusyRetries','storageAuthorizeMs','historyCoreMs','historyQueueMs','historyNativeRpcMs','historyProjectionMs']) {
        const value = gateway[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) diagnostic[key] = value;
      }
    }
    if(typeof diagnostic.gatewayIngressToReplyMs === "number") diagnostic.clientOutsideGatewayMs=Math.max(0,event.durationMs-diagnostic.gatewayIngressToReplyMs);
    // Opaque connection identity permits per-connection fanout analysis without exporting a Host recipe.
    observeEvent({kind:'rpc',hostId:clientId,...diagnostic,requestId:`${clientId}:${client.connectionGeneration}:${event.id}`,generation:client.connectionGeneration,...recoveryContexts.get(event.hostId),method:methods.has(event.method)?event.method:'other',
      ...(event.type==='failed'&&Number.isSafeInteger((event.error as Error & {code?:number}).code)?{errorCode:`rpc:${(event.error as Error & {code?:number}).code}`}:{ }),
      outcome:event.type==='completed'?'ok':event.type==='timed-out'?'timeout':event.type==='aborted'?'aborted':'failed',
      durationMs:event.durationMs,measurementScope:'rpc'});
  });
  return () => { unsubscribe();stopEnabled();document.removeEventListener("visibilitychange",onVisibility);loop.dispose();historyRequests.clear(); };
}
export function observeRecovery(event: Readonly<Record<string,string|number>>) {
  const nativeStage = String(event.stage);
  const host = typeof event.hostId === 'string' ? event.hostId : null;
  if (host) {
    if (nativeStage === 'host-ready') usableHosts.add(host);
    if (enabled && usableHosts.has(host) && ['transport-unavailable','waiting','backoff','connecting','manual-block'].includes(nativeStage) && !connectionOutages.has(host))
      connectionOutages.set(host, { id: createClientId(), started: performance.now() });
    const outage = connectionOutages.get(host);
    if (enabled && outage) {
      observeEvent({ kind: 'recovery', recoveryId: outage.id, hostId: host, measurementScope: 'connection',
        stage: nativeStage === 'settled' ? 'ready' : 'connecting', outcome: nativeStage === 'settled' ? 'ok' : 'progress',
        durationMs: Math.max(0, performance.now() - outage.started) });
      if (nativeStage === 'settled') connectionOutages.delete(host);
    }
  }
  const mapped: Record<string,string> = {'settled':'ready','host-ready':'initializing','history-started':'history','history-authoritative':'history','history-failed':'failed','history-backoff':'backoff','manual-block':'blocked'};
  const stage = mapped[nativeStage] ?? nativeStage;
  const stages = new Set(['connecting','initializing','backoff','blocked','queued','history','ready','failed']);
  if (!stages.has(stage)) return;
  const context={recoveryId:String(event.recoveryId),...(typeof event.attemptId==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/u.test(event.attemptId)?{attemptId:event.attemptId}:{}),...(typeof event.generation==='number'?{generation:event.generation}:{})};
  if(enabled&&typeof event.hostId==='string'){
    if(recoveryContexts.size>=64&&!recoveryContexts.has(event.hostId))recoveryContexts.delete(recoveryContexts.keys().next().value!);
    recoveryContexts.set(event.hostId,context);
  }
  observeEvent({kind:'recovery',...context,recoveryId:String(event.recoveryId),stage,outcome:stage==='ready'?'ok':stage==='failed'?'failed':'progress',
    ...(typeof event.attempt==='number'?{attempt:event.attempt}:{}),...(typeof event.elapsedMs==='number'?{durationMs:event.elapsedMs}:{}),measurementScope:'client'});
  if(stage==='ready'&&typeof event.hostId==='string')recoveryContexts.delete(event.hostId);
}
export function createObservabilityExtension(title = 'Platform monitoring'): TrustedExtensionDefinition {
  return {manifest:{manifestVersion:1,id:'opencraft.observability',name:'Platform monitoring',version:'1.0.0',apiVersion:1,
    trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']},async activate(api){
    const startupFinishedAt=performance.now();
    let capability: {available?:boolean;telemetry?:boolean};
    try {const response=await serverFetch('/__opencraft_observe/capabilities',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:api.signal});if(!response.ok)return;capability=await response.json();}catch{return;}
    if(api.signal.aborted)return;
    enabled=capability.telemetry===true;
    buildId=document.querySelector<HTMLMetaElement>('meta[name="opencraft-build-id"]')?.content??null;
    sourceRevision=document.querySelector<HTMLMetaElement>('meta[name="opencraft-source-revision"]')?.content||null;
    const onVisibility=()=>{if(document.visibilityState==='hidden'){clearTimeout(timer);timer=undefined;}else{observeEvent({kind:'producer'});schedule();}};
    document.addEventListener('visibilitychange',onVisibility);
    const onOnline=()=>schedule();window.addEventListener('online',onOnline);
    api.signal.addEventListener('abort',()=>{enabled=false;clearTimeout(timer);timer=undefined;pending=[];recent=[];recoveryContexts.clear();connectionOutages.clear();usableHosts.clear();pendingBytes=recentBytes=0;document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('online',onOnline);},{once:true});
    observeEvent({kind:'producer'});
    if (enabled) {
      const stopLifecycle = observeClientLifecycle(document, window, observeEvent);
      api.signal.addEventListener('abort', stopLifecycle, {once:true});
    }
    if(enabled){
      for(const listener of enabledListeners)listener();
      const navigation=performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if(navigation)observeEvent({kind:'operation',operationType:'navigation',operationId:createClientId(),outcome:'ok',
        at:Math.round(performance.timeOrigin+startupFinishedAt),durationMs:Math.max(0,startupFinishedAt-navigation.startTime),measurementScope:'navigation',stage:'ready',cache:navigation.type==='back_forward'?'warm':'cold'});
    }
    let longTasks: PerformanceObserver | undefined;
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      longTasks = new PerformanceObserver(list => { for (const entry of list.getEntries()) observeEvent({kind:'client_signal',clientSignal:'longtask',at:Math.round(performance.timeOrigin+entry.startTime),durationMs:entry.duration,measurementScope:'client'}); });
      longTasks.observe({type:'longtask'});
      api.signal.addEventListener('abort',()=>longTasks?.disconnect(),{once:true});
    }
    if(capability.available!==true)return;
    api.commands.register({id:'opencraft.observability.open',title},()=>{window.open(serverUrl('/__opencraft_observe/grafana/d/opencraft-overview'),'_blank','noopener,noreferrer');});
    api.navigation.register({id:'opencraft.observability.navigation',title,surface:'sidebar-primary',icon:'activity',order:40,
      platforms:['web'],target:{kind:'command',commandId:'opencraft.observability.open'}});
  }};
}
