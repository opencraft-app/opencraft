import { lstat,readFile } from 'node:fs/promises';
import { CodexProviderBridge } from './codex-provider-bridge.js';
import type { BridgeGatewayOptions } from '@opencraft/agent-bridge-host/gateway';
import { createHash } from 'node:crypto';
import type { DuplexTransport, TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import type { CapabilitySession } from '@opencraft/session-capabilities';

export async function readCodexBridgeConfiguration(path:string|undefined):Promise<BridgeGatewayOptions|undefined> {
  if(!path)return undefined;
  try {
    const metadata=await lstat(path);
    if(!metadata.isFile()||metadata.size>65536||metadata.mode&0o077||process.getuid&&metadata.uid!==process.getuid())throw Error();
    const value:unknown=JSON.parse(await readFile(path,'utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)||!['url','token','serverId','inboxPath'].every(key=>typeof (value as Record<string,unknown>)[key]==='string'))throw Error();
    return value as BridgeGatewayOptions;
  }catch{throw Error('Invalid private Codex bridge configuration');}
}

export interface PreparedBridgeMcp {configuration:Record<string,unknown>|null;settle?(outcome:'accepted'|'rejected'|'unknown'):void}
export interface BridgeExecutionAdmissionPort {
  admit(threadId:string,inputId:string,input:unknown[],context:TransportSubmissionContext):Promise<CapabilitySession>;
  sign(session:CapabilitySession):string;
  prepareSessionMcp?(threadId:string):Promise<PreparedBridgeMcp>;
  completed?(threadId:string):void;
  close?():void;
  rejectedBeforeStart?(threadId:string,inputId:string):void;
  sessionMcp?(session:CapabilitySession):Promise<Record<string,unknown>|null>;
  started(threadId:string,inputId:string,turnId:string):void;
}
/** Keep signing and the bridge consumer adjacent; legacy traffic stays untouched. */
export function createServerCodexBridge(legacy:DuplexTransport,options:BridgeGatewayOptions|undefined,admission:BridgeExecutionAdmissionPort):DuplexTransport {
  return options?new BridgeExecutionAdmissionTransport(new CodexProviderBridge(legacy,options),admission):legacy;
}

/** Server-side admission only for opt-in bridge Threads. Legacy frames pass intact. */
export class BridgeExecutionAdmissionTransport implements DuplexTransport {
  private closed=false;
  private readonly listeners=new Set<(frame:string)=>void>();
  private readonly inputs=new Map<string,{inputId:string;turnId?:string}>();
  private readonly preparingCreations=new Set<string>();
  private readonly creations=new Map<string,PreparedBridgeMcp>();
  private readonly requests=new Map<string,{threadId:string;inputId:string}>();
  constructor(private readonly inner:DuplexTransport,private readonly port:BridgeExecutionAdmissionPort) {
    inner.subscribeMessage(raw=>{
      const frame=JSON.parse(raw),p=frame.params??{};
      const creationKey=JSON.stringify([frame[LOGICAL_CLIENT_FIELD]??null,frame.id]);
      const created=this.creations.get(creationKey);
      if(created&&frame.id!==undefined){this.creations.delete(creationKey);created.settle?.(frame.error?frame.error.data?.submissionOutcome==='rejected'?'rejected':'unknown':'accepted');}
      const request=this.requests.get(JSON.stringify([frame[LOGICAL_CLIENT_FIELD]??null,frame.id]));
      if(frame.id!==undefined&&request) {
        this.requests.delete(JSON.stringify([frame[LOGICAL_CLIENT_FIELD]??null,frame.id]));
        const input=this.inputs.get(request.threadId);
        if(frame.error?.data?.submissionOutcome==='rejected'&&input?.inputId===request.inputId&&!input.turnId){
          this.port.rejectedBeforeStart?.(request.threadId,request.inputId);
          this.inputs.delete(request.threadId);
        }
      }
      const input=this.inputs.get(p.threadId);
      if(frame.method==='turn/started'&&input) {
        input.turnId=p.turn.id;
        this.port.started(p.threadId,input.inputId,p.turn.id);
      }
      if(frame.method==='turn/completed'&&input?.turnId===p.turn?.id){this.inputs.delete(p.threadId);this.port.completed?.(p.threadId);}
      for(const listener of this.listeners)listener(raw);
    });
  }
  get status(){return this.inner.status;}
  connect(signal?:AbortSignal){return this.inner.connect(signal);}
  subscribeStatus(listener:Parameters<DuplexTransport['subscribeStatus']>[0]){return this.inner.subscribeStatus(listener);}
  subscribeMessage(listener:(frame:string)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  async close(){this.closed=true;for(const creation of this.creations.values())creation.settle?.('unknown');this.creations.clear();this.inputs.clear();this.requests.clear();this.port.close?.();await this.inner.close();}
  send(raw:string,signal?:AbortSignal){return this.sendWithContext(raw,{sender:null},signal);}
  async sendWithContext(raw:string,context:TransportSubmissionContext,signal?:AbortSignal){
    if(this.closed)throw Error('Bridge admission owner is closed');
    const frame=JSON.parse(raw),p=frame.params??{};
    if(frame.method==='thread/start'&&p.agentBridge&&this.port.prepareSessionMcp) {
      const seed=p.agentBridge.threadId;
      if(typeof seed==='string'&&seed) {
        const threadId=seed.startsWith('bridge:codex:')?seed:'bridge:codex:'+seed;
        const creationKey=JSON.stringify([frame[LOGICAL_CLIENT_FIELD]??null,frame.id]);
        let preparing=false;
        let prepared:PreparedBridgeMcp|undefined;
        try {
          signal?.throwIfAborted();context.resourceOwner?.assertCurrent();
          if(this.creations.has(creationKey)||this.preparingCreations.has(creationKey))throw Error('Creation request already pending');
          this.preparingCreations.add(creationKey);preparing=true;
          if(p.config!=null&&(typeof p.config!=='object'||Array.isArray(p.config)))throw Error('Invalid native configuration');
          prepared=await this.port.prepareSessionMcp(threadId);
          if(this.closed)throw Error('Bridge admission owner is closed');
          const mcp=prepared.configuration;
          signal?.throwIfAborted();context.resourceOwner?.assertCurrent();
          p.config={...p.config,'mcp_servers.opencraft_session':mcp??{enabled:false,url:'http://127.0.0.1:1/mcp'}};
          this.creations.set(JSON.stringify([frame[LOGICAL_CLIENT_FIELD]??null,frame.id]),prepared);
          raw=JSON.stringify(frame);
        } catch {
          prepared?.settle?.('rejected');
          for(const listener of this.listeners)listener(JSON.stringify({id:frame.id,error:{code:-32001,message:'cliUnavailable'},
            ...(frame[LOGICAL_CLIENT_FIELD]?{[LOGICAL_CLIENT_FIELD]:frame[LOGICAL_CLIENT_FIELD]}:{})}));
          return;
        } finally {if(preparing)this.preparingCreations.delete(creationKey);}
      }
    }
    if(frame.method==='turn/start'&&typeof p.threadId==='string'&&p.threadId.startsWith('bridge:codex:')) {
      try {
        signal?.throwIfAborted();
        if(typeof p.clientUserMessageId!=='string'||!p.clientUserMessageId)throw Error('Stable execution input required');
        const prior=this.inputs.get(p.threadId);
        if(prior&&prior.inputId!==p.clientUserMessageId)throw Error('Execution already pending');
        // Reserve before the asynchronous authority lookup so concurrent intents cannot replace the source.
        if(!prior)this.inputs.set(p.threadId,{inputId:p.clientUserMessageId});
        const session=await this.port.admit(p.threadId,p.clientUserMessageId,p.input??[],context);
        signal?.throwIfAborted();
        p.opencraftExecutionAdmission=this.port.sign(session);
        delete p.opencraftSessionMcp;
        if(this.port.sessionMcp)p.opencraftSessionMcp=await this.port.sessionMcp(session);
        signal?.throwIfAborted();context.resourceOwner?.assertCurrent();
        this.requests.set(JSON.stringify([frame[LOGICAL_CLIENT_FIELD]??null,frame.id]),{threadId:p.threadId,inputId:p.clientUserMessageId});
        raw=JSON.stringify(frame);
      }catch {
        const input=this.inputs.get(p.threadId);
        if(input&&input.inputId===p.clientUserMessageId&&!input.turnId){this.port.rejectedBeforeStart?.(p.threadId,p.clientUserMessageId);this.inputs.delete(p.threadId);}
        const reply=JSON.stringify({id:frame.id,error:{code:-32001,message:'cliUnavailable'},
          ...(frame[LOGICAL_CLIENT_FIELD]?{[LOGICAL_CLIENT_FIELD]:frame[LOGICAL_CLIENT_FIELD]}:{})});
        for(const listener of this.listeners)listener(reply);return;
      }
    }
    try {
      if(this.inner.sendWithContext)await this.inner.sendWithContext(raw,context,signal);
      else await this.inner.send(raw,signal);
    } catch(error) {
      // CodexProviderBridge emits a response for dispatched commands. Thrown
      // validation failures have not reached its command dispatcher.
      const key=JSON.stringify([frame[LOGICAL_CLIENT_FIELD]??null,frame.id]);
      const creation=this.creations.get(key);
      if(creation){this.creations.delete(key);creation.settle?.('rejected');}
      const request=this.requests.get(key);
      if(request){this.requests.delete(key);const input=this.inputs.get(request.threadId);if(input?.inputId===request.inputId&&!input.turnId){this.port.rejectedBeforeStart?.(request.threadId,request.inputId);this.inputs.delete(request.threadId);}}
      throw error;
    }
  }
}

/** Reuse the existing unbound MCP reservation; it never grants execution admission. */
export function createBridgeSessionMcp(
  mcp: Pick<import('@opencraft/session-capabilities/mcp').SessionCapabilityMcp,'prepareExecution'|'config'>,
  scope:(threadId:string)=>CapabilitySession,
  refresh:(session:CapabilitySession)=>Promise<void>,
) {
  type Reservation=ReturnType<typeof mcp.prepareExecution>;
  const pending=new Map<string,{reservation:Reservation;claims:number;retained:boolean}>();
  const boundInputs=new Map<string,string>();
  return {
    async prepareSessionMcp(threadId:string):Promise<PreparedBridgeMcp> {
      await refresh(scope(threadId));
      let entry=pending.get(threadId);
      if(!entry) {
        const reservation=mcp.prepareExecution({memoryOnly:true,scope:scope(threadId)});
        try{reservation.bindThread(scope(threadId));}catch(error){reservation.cancel();throw error;}
        entry={reservation,claims:0,retained:false};pending.set(threadId,entry);
      }
      entry.claims++;const claimed=entry;let settled=false;
      return {configuration:entry.reservation.configuration,settle(outcome){
        if(settled)return;settled=true;
        if(pending.get(threadId)!==claimed)return;
        claimed.claims--;
        if(outcome!=='rejected')claimed.retained=true;
        if(!claimed.claims&&!claimed.retained){pending.delete(threadId);claimed.reservation.cancel();}
      }};
    },
    async sessionMcp(session:CapabilitySession) {
      await refresh(session);
      const reservation=pending.get(session.threadId)?.reservation;
      if(!reservation)return mcp.config(session);
      reservation.bind(session);boundInputs.set(session.threadId,session.execution?.inputId??'');
      // Use current approval declarations with the reserved credential. The owner
      // rejects an uninstalled configuration change instead of losing approvals.
      const tools=mcp.config(session)?.tools;
      return {...reservation.configuration,...(tools?{tools}:{} )};
    },
    rejectedBeforeStart(threadId:string,inputId:string){
      if(boundInputs.get(threadId)!==inputId)return;
      pending.get(threadId)?.reservation.resetBeforeStart();boundInputs.delete(threadId);
    },
    close(){for(const entry of pending.values())entry.reservation.cancel();pending.clear();boundInputs.clear();},
    completed(threadId:string){
      const entry=pending.get(threadId);
      pending.delete(threadId);boundInputs.delete(threadId);entry?.reservation.cancel();
    },
  };
}
