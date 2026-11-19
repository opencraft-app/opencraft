import type { DuplexTransport } from '@opencraft/appserver-client/transport';
import type { createWorkspaceExecutionAuthority, WorkspaceExecutionSelection } from '@opencraft/sandbox-node/workspace-execution-channel';
import { workspaceExecutionTransport } from '../../../apps/opencraft-daemon/src/workspace-execution-transport';
import type { CodexNativeRequestAdmission } from '../../../apps/opencraft-daemon/src/codex-engine-adapter';
import type { OrdinaryNativeCreation, OrdinaryNativeRestoration } from './ordinary-native-creation';

/** Physical attachment composition. Business admission stays with creation and
 * prepareExecution; this module neither trusts wire identities nor picks a local
 * fallback. Gateway owns the shared authority/runtime beyond attachment close. */
export function ordinaryNativeAttachment(options: {
 native: DuplexTransport;
 authority: Awaited<ReturnType<typeof createWorkspaceExecutionAuthority>>;
 creation: OrdinaryNativeCreation;
 restoration?: {operation:OrdinaryNativeRestoration;isWorkspaceResume(params:Readonly<Record<string,unknown>>):boolean};
 lookup(id: string | number): CodexNativeRequestAdmission | null;
 /** Classification only, NOT authorization. Reject malformed placement here. */
 isWorkspaceStart(params: Readonly<Record<string, unknown>>): boolean;
 /** Must classify existing/ordinary local requests from durable placement. */
 prepareExecution(request: CodexNativeRequestAdmission, params: Readonly<Record<string, unknown>>): Promise<() => Promise<WorkspaceExecutionSelection>>;
 onCleanupUnconfirmed(): void;
}) {
 const {native,creation}=options;
 const owned=new Map<string, {operation:OrdinaryNativeCreation|OrdinaryNativeRestoration;removeAbort():void}>();
 const key=(id:string|number)=>JSON.stringify([typeof id,id]);
 let stopped=false,closing:Promise<void>|undefined,wasOpen=native.status.state==='open';
 const cleanup=new Set<Promise<void>>();
 let uncertain=false;
 const notify=()=>{try{options.onCleanupUnconfirmed();}catch{/* Observer cannot prevent cleanup. */}};
 const track=(work:Promise<void>)=>{
  const pending=work.catch(()=>{uncertain=true;notify();});
  cleanup.add(pending);void pending.finally(()=>cleanup.delete(pending));
 };
 const unsubscribe=native.subscribeStatus(status=>{
  if(status.state==='open'){wasOpen=true;return;}
  if(wasOpen){wasOpen=false;track(Promise.all([creation.interrupt(),options.restoration?.operation.interrupt()]).then(()=>{}));}
 });
 const prepared=workspaceExecutionTransport(native,options.authority,async(method,params,physical)=>{
  if(stopped)throw Error('Ordinary attachment closed');
  const request=options.lookup(physical.id);
  if(!request||request.method!==method)throw Error('Ordinary request admission unavailable');
  request.context();
  const record=owned.get(key(physical.id));
  if(record){
   const ready=await record.operation.prepare(physical.id,request,params);
   if(ready.kind==='existing') {
    // Never repeat Native creation to reconstruct a previous reply. Caller must
    // read/resume the already committed thread through its normal authorized API.
    throw Error('Ordinary workspace already created; resume its existing thread');
   }
   return ready.resolve;
  }
  return options.prepareExecution(request,params);
 });
 const transport:DuplexTransport={
  ...prepared,
  get status(){return native.status;},
  async send(frame,signal,progress){
   if(stopped)throw Error('Ordinary attachment closed');
   signal?.throwIfAborted();
   const message=JSON.parse(frame);
   const operation=message?.method==='thread/start'&&message.params&&options.isWorkspaceStart(message.params)?creation
    :message?.method==='thread/resume'&&message.params&&options.restoration?.isWorkspaceResume(message.params)?options.restoration.operation:undefined;
   let id:string|number|undefined;
   if(operation){
    if(typeof message.id!=='string'&&typeof message.id!=='number')throw Error('Invalid creation request');
    id=message.id;
    if(owned.size>=256||owned.has(key(id!)))throw Error('Ordinary creation capacity unavailable');
    const abort=()=>track(operation.abort(id!));
    signal?.addEventListener('abort',abort,{once:true});
    owned.set(key(id!),{operation,removeAbort:()=>signal?.removeEventListener('abort',abort)});
   }
   try{await prepared.send(frame,signal,progress);}
   catch(error){
    if(id!==undefined){
     owned.get(key(id))?.removeAbort();
     // Keep a bounded tombstone: a late positive reply must not bypass the
     // durable finalizer simply because send/cancellation failed.
     try{await operation!.abort(id);}catch(cleanupError){uncertain=true;notify();throw cleanupError;}
    }
    throw error;
   }
  },
  close(){return closing??=(async()=>{
   stopped=true;unsubscribe();
   for(const entry of owned.values())entry.removeAbort();
   let failed=false;
   try{await creation.close();}catch{failed=true;}
   try{await options.restoration?.operation.close();}catch{failed=true;}
   try{await native.close();}catch{failed=true;}
   while(cleanup.size)await Promise.all([...cleanup]);
   owned.clear();
   if(failed||uncertain){notify();throw Error('Ordinary attachment cleanup unconfirmed');}
  })();},
 };
 return {transport,async finalize(input:Parameters<OrdinaryNativeCreation['finalize']>[0]){
  if(stopped)throw Error('Ordinary attachment closed');
  const id=key(input.requestId),entry=owned.get(id);
  if(!entry)return;
  try{await entry.operation.finalize(input);}
  finally{entry.removeAbort();owned.delete(id);}
 }};
}
