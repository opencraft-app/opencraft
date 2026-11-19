/** One asynchronous coordinator for all group fields. SQLite Worker owns intents/permissions; Relay owns provider I/O. */
export function createGroupSyncPump({call,request,corpId,onError=()=>{},linkMembers,resolveNativeMembers,now=Date.now}){
 const due=new Map(),identityDue=new Map(),attachmentDue=new Map(),channelJobs=new Map(),hints=new Set(),seen=new Map(),wakeJobs=new Map();let running,stopped=false;
 const command=(verb,p={})=>call('join/wecom-sync/'+verb,p);
 // The fast lane is independent of unrelated maintenance reads, but shares one
 // per-channel owner with the fallback poller. Provider writes never overlap.
 function serial(channelId,job){
  const prior=channelJobs.get(channelId)??Promise.resolve();
  const next=prior.catch(()=>{}).then(()=>{if(!stopped)return job();});channelJobs.set(channelId,next);
  void next.finally(()=>{if(channelJobs.get(channelId)===next)channelJobs.delete(channelId);}).catch(()=>{});
  return next;
 }
 async function fast(work){
  if(stopped)return;
  if(work.kind==='create'){await identities(work.channelId);await creations(work.channelId);return;}
  if(work.kind==='identity'){await identities(work.channelId);return;}
  if(work.kind==='attach'){await serial(work.channelId,()=>attach(work));return;}
  due.set(work.source,now()+work.pollMs);await serial(work.channelId,()=>group(work));
 }
 function notify(channelId){
  if(stopped||typeof channelId!=='string')return Promise.resolve();
  hints.add(channelId);
  if(wakeJobs.has(channelId))return wakeJobs.get(channelId);
  const job=(async()=>{
   while(hints.has(channelId)&&!stopped){
    hints.delete(channelId);
    const next=await command('immediate-work',{channelId,corpId});
    if(stopped)break;
    if(next&&seen.get(channelId)!==next.token){seen.set(channelId,next.token);await fast(next);}
   }
  })().catch(error=>{if(!stopped)onError(error,{stage:'group-sync-wake'});}).finally(()=>{
   if(wakeJobs.get(channelId)===job)wakeJobs.delete(channelId);
   if(hints.has(channelId)&&!stopped)void notify(channelId);
  });
  wakeJobs.set(channelId,job);return job;
 }
 async function group(r){
  let refreshId=null;
  try{
   const initial=await command('read',r);if(initial.paused)return;
   ({refreshId}=await command('begin',r));
   const presentation=async snapshot=>{
    if(snapshot?.name!==''||initial.observationOnly||!['inbound','both'].includes(initial.config?.name))return undefined;
    // Reuse the existing authorized provider read. Label failure cannot fail permission replication.
    try{return await request('provider-query',{source:r.source,owner:initial.ownerUserId,query:{kind:'chat'}});}catch{return undefined;}
   };
   const resolveMembers=!!linkMembers&&!initial.observationOnly&&['inbound','both'].includes(initial.config?.members);
   const associate=async result=>{
    if(!resolveMembers||!result.memberEvidence)return;
    // A provider read can outlive a local policy change. Recheck before creating identity bindings.
    const current=await command('read',r);
    if(current.paused||current.observationOnly||!['inbound','both'].includes(current.config?.members))return;
    await linkMembers(r.source,result.snapshot,result.memberEvidence);
   };
   const op=await command('claim',r);
   if(op){
    const change=op.kind==='name'?{kind:'name',name:op.name}:{kind:'member',userId:op.userId,present:op.present};
    const result=await request('group-sync',{action:op.readOnly?'verify':'apply',source:r.source,sourceEpoch:r.sourceEpoch,id:op.id,writeDeadline:op.writeDeadline,ownerUserId:op.ownerUserId,base:op.base,change,binding:initial.providerBinding,resolveMembers});
    await associate(result);
    await command('settle',{...r,refreshId,id:op.id,attempt:op.attempt,state:result.state,diagnostics:result.diagnostics,snapshotUnavailable:result.snapshotUnavailable,snapshot:result.snapshot,presentation:await presentation(result.snapshot),binding:result.binding});
   }else{
    const ticket=await command('observe',r);if(!ticket)return;
    const result=await request('group-sync',{action:'read',source:r.source,resolveMembers});
    await associate(result);
    await command('snapshot',{...r,refreshId,observation:ticket.observation,sequence:ticket.sequence,snapshot:result.snapshot,presentation:await presentation(result.snapshot),binding:result.binding});
   }
  }catch(error){onError(error,{stage:'group-sync'});await command('error',{...r,refreshId,code:error?.code??error?.message??'unavailable'}).catch(()=>{});}
 }
 async function creations(channelId){
  if(!corpId)return;
  const pending=await command('create-list',{corpId});if(!Array.isArray(pending))return;
  for(const c of pending.filter(c=>!channelId||c.channelId===channelId).slice(0,4)){
   if(stopped)return;
   let attempt;
   try{
    const claimed=await command('create-claim',{channelId:c.channelId});if(!claimed)continue;
    attempt=claimed.attempt;
    const result=await request('native-chat-create',{channelId:claimed.channelId,title:claimed.title,owner:claimed.owner,members:claimed.members});
    if(!result?.binding)throw Error(result?.error??'wecom_create_unavailable');
    await command('create-settle',{channelId:c.channelId,attempt,binding:result.binding});
   }catch(error){
    onError(error,{stage:'group-create'});
    const code=String(error?.message??'unavailable');
    await command('create-settle',{channelId:c.channelId,attempt,code,deferred:/http_40[34]$/u.test(code),retryable:!/denied|invalid|identity/u.test(code)}).catch(()=>{});
   }
  }
 }
 async function attach(group){
  const result=await request('group-sync',{action:'read',source:group.source});
  await command('adopt-linked',{...group,corpId,binding:result.binding,snapshot:result.snapshot});
 }
 async function attachments(){
  if(!corpId)return;
  const groups=await command('adoption-list',{corpId});if(!Array.isArray(groups))return;
  const live=new Set(groups.map(g=>g.source));for(const source of attachmentDue.keys())if(!live.has(source))attachmentDue.delete(source);
  const ready=groups.filter(g=>(attachmentDue.get(g.source)??0)<=now()).slice(0,4);
  for(const group of ready){
   if(stopped)return;attachmentDue.set(group.source,now()+30000);
   try{
    await serial(group.channelId,()=>attach(group));
   }catch(error){onError(error,{stage:'group-attach'});}
  }
 }
 async function identities(channelId){
  if(!corpId||!resolveNativeMembers)return;
  const groups=await command('member-identity-list',{corpId});
  const live=new Set(groups.map(g=>g.channelId));for(const id of identityDue.keys())if(!live.has(id))identityDue.delete(id);
  for(const group of groups.filter(g=>!channelId||g.channelId===channelId)){
   if(stopped)return;
   if(!channelId&&(identityDue.get(group.channelId)??0)>now())continue;
   identityDue.set(group.channelId,now()+30000);
   try{await serial(group.channelId,async()=>{await resolveNativeMembers(group);if(!stopped)await command('member-identity-settle',{channelId:group.channelId,corpId});});}
   catch(error){onError(error,{stage:'group-member-identity'});}
  }
 }
 async function tick(){
  await attachments();
  await identities();
  await creations();
  const rows=await command('list',corpId?{corpId}:{});if(!Array.isArray(rows))throw Error('wecom_sync_invalid_registry');
  const live=new Set(rows.map(r=>r.source));for(const source of due.keys())if(!live.has(source))due.delete(source);
  const ready=rows.filter(r=>!r.paused&&(r.refreshPending||(due.get(r.source)??0)<=now()));
  for(let i=0;i<ready.length&&!stopped;i+=4)await Promise.all(ready.slice(i,i+4).map(r=>{due.set(r.source,now()+r.pollMs);return serial(r.channelId??r.source,()=>group(r));}));
 }
 return {notify,poll(){if(stopped)return Promise.resolve();return running??=(tick().catch(e=>onError(e,{stage:'group-sync'})).finally(()=>running=undefined));},async close(){stopped=true;hints.clear();await Promise.allSettled([running,...wakeJobs.values(),...channelJobs.values()].filter(Boolean));}};
}
