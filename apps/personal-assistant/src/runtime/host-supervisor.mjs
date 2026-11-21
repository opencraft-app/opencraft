import {readOfflineMemory} from './memory-browser-offline.mjs';
import { assistantHostExtension } from './host-extension.mjs';
import { readWorkObservation } from './work-observation.mjs';
import { readFile, lstat, access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStdioPeer } from '../adapters/local/stdio-peer.mjs';
import lockfile from 'proper-lockfile';
import { privateDirectory } from '../adapters/local/bot-profile.mjs';
import { validateCodexConfig, readCodexKey } from '../adapters/codex/config.mjs';

const modelPurposes=new Set(['reception','context-summary','execution','memory-propose','memory-verify']);
/** Crew work the Bot holds. The Core judges every call as the Bot itself; the Host only forwards. */
const crewMethods = new Set([...['list','get','message','finish','replies','dispatch'].map(s=>'opencraft/crew/work/'+s),'opencraft/crew/phonebook/list']);
const platformMethods = new Set(['authorize','threads/command','groups/list','groups/history','groups/search','conversations/list','conversations/history'].map(s=>'opencraft/personal-assistant/'+s));
/** Installation-owned runtime handles. Assignment facts and message cursors remain durable owners.
 * No renderer, Human cookie or model-selected destination crosses this boundary. */
export async function createPersonalAssistantHost({ directory, service, spawn = spawnAssistant, readConfig = readHostConfig, modelSource, codexBinary, intervalMs = 2000, now = Date.now, environmentProviders = {}, environmentProvidersFor }) {
  const root = privateDirectory(await realpath(directory)), entries = new Map();
  let stopping = false, busy, release, detach, timer, closing;
  const providersFor = async context => ({...environmentProviders,...(await environmentProvidersFor?.(context) ?? {})});
  const validateEnvironment = async (environment, context) => {
    if(!environment||typeof environment!=='object'||Array.isArray(environment))throw Error('assistant_environment_unavailable');
    if(environment.kind==='local'&&Object.keys(environment).length===1)return;
    if(environment.kind!=='sandbox'||Object.keys(environment).some(k=>!['kind','backendId','templateId'].includes(k))||typeof environment.backendId!=='string'||typeof environment.templateId!=='string')throw Error('assistant_environment_unavailable');
    const providers=await providersFor(context);
    const provider=Object.hasOwn(providers,environment.backendId)?providers[environment.backendId]:null;
    if(!provider?.spawn)throw Error('assistant_environment_unavailable');
    const templates=await provider.templates();
    if(!templates.some(t=>t.id===environment.templateId))throw Error('assistant_environment_unavailable');
    await provider.validate?.(environment);
  };
  const host = {
    async environments(context){
      const templates=[];
      for(const [backendId,provider] of Object.entries(await providersFor(context))){
        if(provider?.spawn)for(const t of await provider.templates())templates.push({backendId,id:t.id,name:t.name});
      }
      return {local:true,templates};
    },
    validateEnvironment,
    async memory(botId,epoch,params,binding) {
      const e=entries.get(botId),handle=e?.handle;
      if(stopping)throw Object.assign(Error('assistant_memory_unavailable'),{status:503});
      if(!e||e.epoch!==epoch||!handle?.memory||handle.failed())return readOfflineMemory(root,binding,params);
      await handle.ready;
      if(stopping||entries.get(botId)!==e||e.handle!==handle)throw Error('Assistant retired');
      const result=await handle.memory(params);
      if(stopping||entries.get(botId)!==e||e.handle!==handle||e.epoch!==epoch)throw Error('Assistant retired');
      return result;
    },
    async models() {
      if(!modelSource || !codexBinary)return {models:[],available:false};
      try {await access(codexBinary,1);} catch {return {models:[],available:false};}
      return modelSource.catalog();
    },
    async validateModel(model) {
      if(!modelSource || !codexBinary)throw Error('assistant_models_unavailable');
      await access(codexBinary,1);await modelSource.resolve(model);
    },
    state(id) {
      const e=entries.get(id), state=e?.state ?? {phase:release?'starting':'unavailable'};
      const reception=state.phase==='running' && !e.handle?.failed() ? e.handle?.activity?.() : undefined;
      const modelWait=e?modelSource?.activity?.(id+":"+e.epoch+":"+e.assignment.assistant.modelRevision):undefined;
      const works=state.phase==='running' && !e.handle?.failed() ? e.handle?.works?.() : undefined;
      return {...state,...(reception?{reception}:{}),...(works?{works}:{}),...(modelWait?{modelWait}:{})};
    },
    wake(id) { const e=entries.get(id);if(e&&!e.handle)e.retryAt=0;void tick(); },
    close() { return closing??=(async()=>{
      stopping=true;clearInterval(timer);detach?.();
      await busy;
      await Promise.allSettled([...entries.values()].map(stop));entries.clear();
      const providers=await Promise.allSettled(Object.values(environmentProviders).map(provider=>provider.close?.()));
      await release?.();release=undefined;
      // The supplied source is owned by this Host for its lifetime (e.g. its loopback model gateway).
      await modelSource?.close?.();
      if(providers.some(result=>result.status==='rejected'))throw Error('Assistant environment cleanup is unconfirmed');
    })(); },
  };
  async function stop(e) { const handle=e.handle;e.handle=undefined;await handle?.close(); }
  async function reconcile() {
    if(!release) {
      try { release=await lockfile.lock(root,{lockfilePath:join(root,'.personal-assistant-host.lock'),realpath:false,stale:15000,update:5000,retries:0,onCompromised:()=>{void host.close().catch(()=>{});}}); }
      catch { return; }
      if(stopping)return;
    }
    const assignments = new Map();let after='';
    do {
      const page=await service.personalAssistantAssignments(after);
      for(const item of page.items)assignments.set(item.assistant.binding.botId,item);
      after=page.next;
    } while(after&&!stopping);
    if(stopping)return;
    for(const [id,e] of entries)if(!assignments.has(id)||assignments.get(id).epoch!==e.epoch){await stop(e);entries.delete(id);}
    let config;
    try { config=await readConfig(root); } catch { config=null; }
    for(const [id,a] of assignments) {
      if(stopping)break;
      let e=entries.get(id);
      if(!e){e={epoch:a.epoch,state:{phase:'starting'},failures:0,retryAt:0};entries.set(id,e);}
      e.assignment=a;
      let selected=config;
      if(a.assistant.model) {
        try {
          await host.validateModel(a.assistant.model);
          selected={maxRuntimes:config?.maxRuntimes??8,profileOptions:{mode:'model',...(config?.profileOptions.timeZone?{timeZone:config.profileOptions.timeZone}:{}),harnesses:{assistant:'codex',execution:'codex',codex:{binary:codexBinary,managed:true,...a.assistant.model}}}};
        } catch { selected=null; }
      }
      if(!selected){await stop(e);e.state={phase:'config_required'};continue;}
      if(e.handle && e.modelRevision!==a.assistant.modelRevision)await stop(e);
      if(e.handle) {
        if(e.handle.failed()) {
          await stop(e);e.failures++;e.retryAt=now()+Math.min(60000,1000*2**Math.min(e.failures,6));e.state={phase:'retrying',retryAt:e.retryAt};
        } else if(now()-e.startedAt>60000)e.failures=0;
        continue;
      }
      if(e.retryAt>now())continue;
      if([...entries.values()].filter(v=>v.handle).length>=selected.maxRuntimes){e.state={phase:'queued'};continue;}
      e.state={phase:'starting'};
      try {
        let credential=(await service.provisionPersonalAssistant(a.context,id)).credential;
        let renewing;
        const request = async (method,params) => {
          if(stopping||entries.get(id)!==e)throw Error('Assistant retired');
          if(credential.expiresAt-now()<60000) {
            renewing ??= service.provisionPersonalAssistant(e.assignment.context,id).then(v=>{credential=v.credential;}).finally(()=>{renewing=undefined;});
            await renewing;
          }
          const context=service.actors.authenticateSession(credential.token);
          if(!context)throw Error('Assistant credential expired');
          // Each RPC rechecks claim, generation and admission in the storage owner.
          if(method==='resolve-model'||method==='model-failure') {
            if(!a.assistant.model || !modelSource || !params || Object.keys(params).some(k=>!['providerId','modelId','purpose'].includes(k)) || (params.purpose!==undefined&&!modelPurposes.has(params.purpose)))throw Error('Assistant model unavailable');
            await service.personalAssistant(context,'opencraft/personal-assistant/authorize',{});
            const purpose=params.purpose??'execution',scope=id+":"+e.epoch+":"+a.assistant.modelRevision;
            if(method==='model-failure')return modelSource.failure?.(scope,purpose);
            const selected=a.assistant.model,revision=a.assistant.modelRevision;
            // Durable executions retain their original configured model; reception/background use the current selection.
            if(purpose!=='execution'&&(params.providerId!==selected.providerId||params.modelId!==selected.modelId))throw Error('Assistant model selection changed');
            const authorize=async()=>{
              if(stopping||entries.get(id)!==e||!e.handle||e.assignment.assistant.modelRevision!==revision)throw Error('Assistant retired');
              const grant=service.actors.authenticateSession(credential.token);
              if(!grant)throw Error('Assistant credential expired');
              await service.personalAssistant(grant,'opencraft/personal-assistant/authorize',{});
            };
            const value=await modelSource.resolve(params,{scope,purpose,authorize,humanActorId:e.assignment.context.actorId});
            await service.personalAssistant(context,'opencraft/personal-assistant/authorize',{});
            if(stopping || entries.get(id)!==e)throw Error('Assistant retired');
            return value;
          }
          const extension=assistantHostExtension()?.request?.(service,context,method,params);
          if(extension)return extension.result;
          if(platformMethods.has(method))return service.personalAssistant(context,method,params);
          if(method==='own-messages'||method==='reply'||method==='attachment')return service.communicate(context,'personal-assistant/'+method,params);
          if(crewMethods.has(method))return service.communicate(context,method,params);
          throw Error('Unsupported assistant Host operation');
        };
        const environment=a.assistant.environment??{kind:'local'};
        await validateEnvironment(environment,a.context);
        const options={directory:root,profileOptions:{...selected.profileOptions,botPresentation:{name:a.assistant.name??'Assistant',duties:a.assistant.duties??''}},request};
        // The selected provider owns execution placement. Never silently run a remote selection locally.
        e.handle=environment.kind==='local'?spawn(options):await (await providersFor(a.context))[environment.backendId].spawn(environment,options);
        await e.handle.ready;
        await request('opencraft/personal-assistant/authorize',{});
        if(stopping){await stop(e);break;}
        e.modelRevision=a.assistant.modelRevision;e.startedAt=now();e.state={phase:'running'};
      } catch (error) {
        try{assistantHostExtension()?.reportFailure?.(error);}catch{}
        await stop(e);e.failures++;e.retryAt=now()+Math.min(60000,1000*2**Math.min(e.failures,6));e.state={phase:'retrying',retryAt:e.retryAt};
      }
    }
  }
  function tick() {
    if(stopping||busy)return busy;
    busy=reconcile().catch(async()=>{
      // Failed inventory is not evidence of continued authority. Stop readers until restored.
      await Promise.allSettled([...entries.values()].map(async e=>{await stop(e);e.state={phase:'unavailable'};}));
    }).finally(()=>{busy=undefined;});return busy;
  }
  detach=service.attachPersonalAssistantHost(host);
  timer=setInterval(()=>void tick(),intervalMs);timer.unref();void tick();
  return host;
}

/** Explicit installation operator configuration; no fallback to a signed-in Human's model. */
export async function readHostConfig(directory) {
  const file=join(directory,'personal-assistant.json'),stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384||stat.mode&0o077)throw Error('Private assistant configuration required');
  const value=JSON.parse(await readFile(file,'utf8'));
  if(!value||Object.keys(value).some(k=>!['codex','backgroundCodex','maxRuntimes','timeZone'].includes(k)))throw Error('Invalid assistant Host configuration');
  validateCodexConfig(value.codex);if(value.backgroundCodex)validateCodexConfig(value.backgroundCodex);
  for(const config of [value.codex,value.backgroundCodex].filter(Boolean)){await access(config.binary,1);readCodexKey(config);}
  const maxRuntimes=value.maxRuntimes??8;
  if(!Number.isSafeInteger(maxRuntimes)||maxRuntimes<1||maxRuntimes>64)throw Error('Invalid assistant capacity');
  return {maxRuntimes,profileOptions:{mode:'model',harnesses:{assistant:'codex',execution:'codex',codex:value.codex,...(value.backgroundCodex?{backgroundCodex:value.backgroundCodex}:{})},...(value.timeZone?{timeZone:value.timeZone}:{})}};
}

export function spawnAssistant({directory,profileOptions,request,executionEnvironment}) {
 const child=spawn(process.execPath,[fileURLToPath(assistantHostExtension()?.entryURL??new URL('./assistant-server.mjs',import.meta.url))],{
  stdio:['pipe','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,
 });
 // Never forward raw model/child diagnostics into user messages or shared logs.
 child.stderr.resume();
 let initializing=true,failure,closing,activity,exited=false;
 const exit=new Promise(resolve=>child.once('close',()=>{exited=true;resolve();}));
 const fail=error=>{failure??=error;};
 const observe=params=>{
  const v=params?.value;
  activity=v&&[v.queued,v.running].every(n=>Number.isSafeInteger(n)&&n>=0)
   ?{value:{queued:v.queued,running:v.running},works:readWorkObservation(params.works),at:Date.now()}:undefined;
 };
 const peer=createStdioPeer({input:child.stdout,output:child.stdin,
  handle:async(method,params)=>{
   if(closing||!method.startsWith('platform/'))throw Error('Method unavailable');
   // Publish current durable reception observation before native reply delivery.
   // A failed observation must never retry or suppress an accepted reply.
   if(method==='platform/reply'){
    try{observe(await peer.request('observe',{}, {timeoutMs:1000}));}catch{activity=undefined;}
   }
   try{return await request(method.slice(9),params);}catch(error){if(initializing){try{assistantHostExtension()?.reportFailure?.(error);}catch{}}throw error;}
  },
  onClose:()=>{if(!closing)fail(Error('Assistant disconnected'));},
  onNotification:(method,params)=>{
   if(method==='startup-failure'&&typeof params?.reason==='string'&&params.reason.length<=200){try{assistantHostExtension()?.reportFailure?.(Error(params.reason));}catch{}}
   if(method==='failed')fail(Error('Assistant runtime failed'));
   if(method==='activity-unavailable')activity=undefined;
   if(method==='activity')observe(params);
  }
 });
 child.on('error',error=>{fail(error);peer.close();});
 child.once('close',()=>{if(!closing)fail(Error('Assistant exited'));peer.close();});
 const ready=peer.request('initialize',{protocolVersion:1,directory,profileOptions,...(executionEnvironment?{executionEnvironment}:{})},{timeoutMs:30000}).then(result=>{
  if(result?.protocolVersion!==1)throw Error('Assistant protocol mismatch');initializing=false;
 }).catch(error=>{fail(error);child.kill();throw error;});void ready.catch(()=>{});
 return {ready,pid:child.pid,memory:params=>{if(failure||closing)throw Error('Assistant retired');return peer.request('memory',params,{timeoutMs:15000});},works:()=>!failure&&!closing&&activity&&Date.now()-activity.at<5000?activity.works:undefined,
 activity:()=>!failure&&!closing&&activity&&Date.now()-activity.at<5000?{...activity.value}:undefined,failed:()=>!!failure,
 close:()=>closing??=(async()=>{
  if(!exited){
   void peer.request('shutdown',{}, {timeoutMs:1000}).catch(()=>{});
   let timeout;
   try{await Promise.race([exit,new Promise(resolve=>{timeout=setTimeout(resolve,5000);})]);}finally{clearTimeout(timeout);}
   if(!exited){child.kill('SIGKILL');await exit;}
  }
  peer.close();
 })()};
}
