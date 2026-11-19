import {safeDiagnostics,errorCategory,logOperation} from '../operation-diagnostics.mjs';
import {syncSnapshot,syncOperation,syncDesired,syncBaseMatches,syncHash} from '../group-sync.mjs';
const same=(a,b)=>a&&b&&a.serverId===b.serverId&&a.generation===b.generation&&a.humanKey===b.humanKey;
/** Installation-scoped facts: unlike an assistant read, this does not impersonate the departed binder. */
export async function groupSyncProvider(svc,server,input,signal){
 const binding=await svc.authorizedSource(server,input.source);
 const checkBinding=async()=>{if(!same(binding,await svc.authorizedSource(server,input.source)))throw Error('denied');};
 let diagnostics;
 const finished=async(state,snapshot)=>{
  // Optional identity lookup cannot erase an otherwise valid membership read.
  let memberEvidence;
  if(snapshot&&input.resolveMembers===true&&svc.memberEvidence)try{memberEvidence=await svc.memberEvidence(input.source,snapshot.memberIds,signal);}catch{}
  await checkBinding();return{...(state===undefined?{}:{state}),snapshot,binding,...(snapshot===null?{snapshotUnavailable:true}:{}),...(diagnostics?{diagnostics:safeDiagnostics({...diagnostics,state})}:{}),...(memberEvidence?{memberEvidence}:{})};
 };
 const read=async()=>{const snapshot=syncSnapshot(await svc.transport.syncSnapshot(input.source,signal),input.source);await checkBinding();return snapshot;};
 if(input.action==='read')return finished(undefined,await read());
 if(!['apply','verify'].includes(input.action)||!same(input.binding,binding)||typeof input.id!=='string'||!/^[a-f0-9]{64}$/u.test(input.id)||typeof input.sourceEpoch!=='string'||!input.sourceEpoch)throw Error('denied');
 const change=syncOperation(input.change),key=svc.store.prefix+'sync:v1:operation:'+syncHash([input.source,binding.generation,input.sourceEpoch,input.id,input.writeDeadline]),digest=syncHash([change,input.base,input.ownerUserId,input.writeDeadline]),snapshot=await read();
 const raw=await svc.store.command('GET',key),prior=raw?JSON.parse(raw):null;
 diagnostics=prior?.diagnostics;
 if(prior&&prior.digest!==digest)throw Error('idempotency_conflict');
 await checkBinding();
 if(syncDesired(snapshot,change)){if(diagnostics)diagnostics={...diagnostics,state:'confirmed',readback:{stage:'readback',apiPath:'/cgi-bin/tencent/chat/get',confirmation:'matched'}};return finished('confirmed',snapshot);}
 if(prior&&['rejected','conflict','confirmed'].includes(prior.state))return finished(prior.state==='confirmed'?'conflict':prior.state,snapshot);
 if(input.action==='verify'){
  // No receipt within its guaranteed retention window, and the old write grant has expired:
  // delayed old handlers must stop before I/O, so a fresh attempt is safe. After retention, absence proves nothing.
  const neverStarted=!prior&&Number.isSafeInteger(input.writeDeadline)&&Date.now()>input.writeDeadline&&Date.now()<input.writeDeadline+6*86400000;
  return finished(neverStarted?'not_started':'unknown',snapshot);
 }
 if(prior)return finished('unknown',snapshot);
 if(!Number.isSafeInteger(input.writeDeadline)||input.writeDeadline<Date.now()||input.writeDeadline>Date.now()+60000)return finished('unknown',snapshot);
 if(!snapshot.memberIds.includes(input.ownerUserId))return finished('rejected',snapshot);
 if(!syncBaseMatches(snapshot,{...change,base:input.base}))return finished('conflict',snapshot);
 const frozen={digest,state:'unknown'};
 // The provider has no operation key. Freeze *before* calling it, so an uncertain outcome is read-only on recovery.
 if(await svc.store.command('SET',key,JSON.stringify(frozen),'NX','PX',7*86400000)!=='OK')return finished('unknown',snapshot);
 await checkBinding();
 const started=Date.now();
 diagnostics={operationId:input.id,action:change.kind==='name'?'rename':change.present?'add':'remove'};
 const persist=async(state,actual)=>{
  diagnostics={...diagnostics,state,elapsedMs:Date.now()-started};
  await svc.store.command('SET',key,JSON.stringify({digest,state,diagnostics:safeDiagnostics(diagnostics)}),'PX',7*86400000);
  logOperation(diagnostics);return finished(state,actual);
 };
 try{
  if(signal.aborted||input.writeDeadline<Date.now()){
   diagnostics.write={stage:'write',category:'expired_or_aborted'};return persist('unknown',snapshot);
  }
  const patch=change.kind==='name'?{name:change.name}:{add:change.present?[change.userId]:[],remove:change.present?[]:[change.userId]};
  let status;
  try {
   if(svc.transport.updateChatDetailed){const result=await svc.transport.updateChatDetailed(input.source,patch,signal);status=result.status;diagnostics.write=safeDiagnostics(result.diagnostics);}
   else {status=await svc.transport.updateChat(input.source,patch,signal);diagnostics.write={stage:'write',category:status==='rejected'?'provider_rejected':status==='delivered'?'accepted':'unavailable'};}
  }catch(error){status='unknown';diagnostics.write={stage:'write',category:errorCategory(error)};}
  // Persist write evidence before the read: a timeout/crash must retain error evidence without deciding the business outcome.
  await svc.store.command('SET',key,JSON.stringify({digest,state:'unknown',diagnostics:safeDiagnostics(diagnostics)}),'PX',7*86400000);
  const readStarted=Date.now();
  try {
   const actual=await read(),matches=syncDesired(actual,change),state=matches?'confirmed':status==='rejected'?'rejected':'unknown';
   diagnostics.readback={stage:'readback',apiPath:'/cgi-bin/tencent/chat/get',confirmation:matches?'matched':'not_matched',elapsedMs:Date.now()-readStarted};
   return persist(state,actual);
  }catch(error){
   await checkBinding();diagnostics.readback={...safeDiagnostics(error?.diagnostics),stage:'readback',apiPath:'/cgi-bin/tencent/chat/get',category:error?.diagnostics?.category??errorCategory(error),confirmation:'unavailable',elapsedMs:Date.now()-readStarted};
   return persist('unknown',null);
  }
 }catch{await checkBinding();return finished('unknown',null);}
}
