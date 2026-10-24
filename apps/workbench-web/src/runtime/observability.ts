import { createClientId } from "@opencraft/composer-core";
import type { AppServerClient } from '@opencraft/appserver-client';
import type { TrustedExtensionDefinition } from '@opencraft/extension-runtime';
import { serverFetch, serverUrl } from './server-context';

type Event = Record<string, string | number | null>;
let enabled = false;
const recoveryContexts = new Map<string,{recoveryId:string;attemptId?:string;generation?:number}>();
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
  const size = new TextEncoder().encode(JSON.stringify(event)).length;
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
  return (outcome: 'ok' | 'failed' | 'aborted' = 'ok', extra: Event = {}) => {
    if (settled) return; settled = true;
    observeEvent({kind:'operation',operationType,operationId,outcome,durationMs:Math.max(0,performance.now()-started),measurementScope:'in_page',...fields,...extra});
  };
}
export function installClientObservation(client: AppServerClient) {
  const clientId=createClientId();
  return client.subscribeRequestLifecycle(event => {
    if (!['completed','failed','timed-out','aborted'].includes(event.type)) return;
    if (!('durationMs' in event)) return;
    observeEvent({kind:'rpc',requestId:`${clientId}:${client.connectionGeneration}:${event.id}`,generation:client.connectionGeneration,...recoveryContexts.get(event.hostId),method:methods.has(event.method)?event.method:'other',
      outcome:event.type==='completed'?'ok':event.type==='timed-out'?'timeout':event.type==='aborted'?'aborted':'failed',
      durationMs:event.durationMs,measurementScope:'rpc'});
  });
}
export function observeRecovery(event: Readonly<Record<string,string|number>>) {
  const nativeStage = String(event.stage);
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
    api.signal.addEventListener('abort',()=>{enabled=false;clearTimeout(timer);timer=undefined;pending=[];recent=[];recoveryContexts.clear();pendingBytes=recentBytes=0;document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('online',onOnline);},{once:true});
    observeEvent({kind:'producer'});
    if(enabled){
      for(const listener of enabledListeners)listener();
      const navigation=performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if(navigation)observeEvent({kind:'operation',operationType:'navigation',operationId:createClientId(),outcome:'ok',
        at:Math.round(performance.timeOrigin+startupFinishedAt),durationMs:Math.max(0,startupFinishedAt-navigation.startTime),measurementScope:'navigation',stage:'ready',cache:navigation.type==='back_forward'?'warm':'cold'});
    }
    let longTasks: PerformanceObserver | undefined;
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      longTasks = new PerformanceObserver(list => { for (const entry of list.getEntries()) observeEvent({kind:'client_signal',durationMs:entry.duration,measurementScope:'client'}); });
      longTasks.observe({type:'longtask'});
      api.signal.addEventListener('abort',()=>longTasks?.disconnect(),{once:true});
    }
    if(capability.available!==true)return;
    api.commands.register({id:'opencraft.observability.open',title},()=>{window.open(serverUrl('/__opencraft_observe/grafana/d/opencraft-overview'),'_blank','noopener,noreferrer');});
    api.navigation.register({id:'opencraft.observability.navigation',title,surface:'sidebar-footer',icon:'activity',order:40,
      platforms:['web'],target:{kind:'command',commandId:'opencraft.observability.open'}});
  }};
}
