import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Agent, fetch } from 'undici';
import { readPrivateJson } from '../../../../../packages/identity-core/src/node.ts';
import { receiverProof, receiverHubId, RECEIVER_LEASE_MS } from './receiver-enrollment.mjs';
import { createMirrorTarget } from './target.mjs';
import { mirrorFailureReporter } from './target-diagnostic.mjs';

const fingerprint = identity => createHash('sha256').update(identity.publicKey || identity.credential).digest('hex');
const optionalJson = async path => {
  try { return await readPrivateJson(path); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('invalid_automatic_receiver_identity'); }
};

/** Read existing owners afresh: enrollment/rotation after startup is observed. */
export async function discoverReceiverIdentities({dataDirectory,relayConnectFile},read=optionalJson) {
  const state = await read(join(dataDirectory,'hub-network.json'));
  const legacy = relayConnectFile ? await read(relayConnectFile) : undefined;
  const endpoints = (state?.peers || []).map(peer=>({relayOrigin:peer.endpoint,ca:peer.ca}));
  if (legacy?.relay?.startsWith('https://') && !endpoints.some(e=>e.relayOrigin===legacy.relay))
    endpoints.push({relayOrigin:legacy.relay});
  return endpoints.filter(e=>{
    const u=new URL(e.relayOrigin);
    return u.protocol==='https:' && !u.username && !u.password && u.pathname==='/' && !u.search && !u.hash;
  }).map(endpoint=>({...endpoint,...(legacy
    ? {serverId:legacy.instanceId,credential:legacy.credential}
    : {serverId:receiverHubId(state.publicKey),publicKey:state.publicKey,privateKey:state.privateKey})}));
}

async function saveLease(path, lease) {
  const temporary=path+'.'+randomBytes(8).toString('hex');
  try {
    const file=await open(temporary,'wx',0o600);
    try { await file.writeFile(JSON.stringify(lease)+'\n');await file.sync(); } finally { await file.close(); }
    await rename(temporary,path);
  } finally { await rm(temporary,{force:true}); }
}

/** Readiness of the normal Gateway does not depend on optional Relay enrollment.
 * Only the native channel owner can admit messages and produce durable receipts. */
export async function createAutomaticMirrorTarget(options,dependencies,{
  discover=()=>discoverReceiverIdentities(options),createTarget=createMirrorTarget,
  fetcher=fetch,now=Date.now,retryMs=1500,renewBeforeMs=300000,onError=mirrorFailureReporter(),
}={}) {
  const abort=new AbortController(),cachePath=join(options.dataDirectory,'wecom-mirror-auto.json');
  let stopped=false,consume,target,agent,agentCa,lease,timer,job=Promise.resolve(),delay=retryMs,closing,candidateIndex=0;
  let cached;
  try {cached=await optionalJson(cachePath);}catch(error){onError(error,{stage:'automatic-cache'});}
  const pinned=cached&&typeof cached.serverId==='string'&&typeof cached.relayOrigin==='string'?cached:undefined;
  // Restore native source activation before ChannelSync configures its outbox.
  const bindings=cached&&/^wx[a-z0-9]+$/iu.test(cached.corpId)
    ? await dependencies.collaboration.synchronizeChannels({method:'mirrorSources',params:{corpId:cached.corpId}}):[];
  const requireTarget=()=>{
    if (stopped || !target || !lease || lease.expiresAt<=now()) throw Error('mirror_receiver_not_ready');
    return target;
  };
  async function tick() {
    let next=delay;
    try {
      const identities=await discover();abort.signal.throwIfAborted();
      if (!identities.length) throw Error('mirror_receiver_waiting_for_relay');
      // Keep the selected relay through outages; never move existing groups.
      const selected=lease||pinned;
      const identity=selected ? identities.find(i=>i.relayOrigin===selected.relayOrigin && i.serverId===selected.serverId)
        : identities[candidateIndex%identities.length];
      if (!identity) throw Error('mirror_receiver_identity_changed');
      if (agent && agentCa!==identity.ca) {await target?.close();target=undefined;await agent.close();agent=undefined;}
      if (!agent) {agent=new Agent({connect:identity.ca?{ca:identity.ca}:{}});agentCa=identity.ca;}
      const request=(url,init)=>fetcher(url,{...init,dispatcher:agent});
      const response=await request(new URL('/__opencraft_wecom_mirror/enroll',identity.relayOrigin),{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(receiverProof(identity,identity.relayOrigin,now())),
        redirect:'error',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)]),
      });
      if (!response.ok) { await response.body?.cancel();throw Error('mirror_receiver_enrollment_http_'+response.status); }
      let text='';for await(const chunk of response.body){text+=Buffer.from(chunk).toString();if(text.length>16384)throw Error('invalid_receiver_lease');}
      const result=JSON.parse(text);
      if (result.relayOrigin!==identity.relayOrigin || result.serverId!==identity.serverId
        || typeof result.credential!=='string' || !/^[-_A-Za-z0-9]{43}$/u.test(result.credential)
        || typeof result.corpId!=='string' || !/^wx[a-z0-9]+$/iu.test(result.corpId)
        || !Number.isSafeInteger(result.expiresAt) || result.expiresAt<=now()
        || result.expiresAt>now()+RECEIVER_LEASE_MS+300000) throw Error('invalid_receiver_lease');
      abort.signal.throwIfAborted();
      if (lease && (result.credential!==lease.credential || result.corpId!==lease.corpId)) {
        await target?.close();target=undefined;
      }
      lease={...result,identityFingerprint:fingerprint(identity)};
      await mkdir(options.dataDirectory,{recursive:true,mode:0o700});await saveLease(cachePath,lease);
      if (!target) {
        const candidate=await createTarget(result,dependencies,request);
        if(stopped){await candidate.close();return;}
        try {candidate.subscribeWithReceipt(consume);target=candidate;}
        catch(error){await candidate.close();throw error;}
      }
      delay=retryMs;next=Math.max(retryMs,result.expiresAt-now()-renewBeforeMs);
    } catch(error) {
      if (!stopped) onError(error,{stage:'automatic-enrollment'});
      if (!lease&&!pinned)candidateIndex++;
      if (lease?.expiresAt<=now()) { await target?.close();target=undefined; }
      delay=Math.min(Math.max(retryMs,delay*2),30000);
    } finally {
      if (!stopped) { timer=setTimeout(()=>{job=tick();},next);timer.unref(); }
    }
  }
  const close=()=>closing??=(async()=>{
    stopped=true;clearTimeout(timer);abort.abort();
    await job;await target?.close();await agent?.close();target=undefined;
  })();
  const subscribe=receive=>{
    if (consume || stopped) throw Error('mirror_subscription_unavailable');
    consume=receive;job=tick();return ()=>{void close();};
  };
  return {
    bindings,files:true,subscribe,subscribeWithReceipt:subscribe,close,
    notifications:{
      targets:actorId=>{try{return requireTarget().notifications?.targets(actorId)??[];}catch{return [];}},
      send:(...args)=>requireTarget().notifications.send(...args),
    },
    ready:()=>!stopped&&!!target&&lease.expiresAt>now(),
    resolveBinding:arrival=>requireTarget().resolveBinding(arrival),
    link:context=>requireTarget().link(context),send:(...args)=>requireTarget().send(...args),
    images:Object.fromEntries(['download','upload','attribute','send'].map(name=>[name,(...args)=>requireTarget().images[name](...args)])),
  };
}
