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

export interface BridgeExecutionAdmissionPort {
  admit(threadId:string,inputId:string,input:unknown[],context:TransportSubmissionContext):Promise<CapabilitySession>;
  sign(session:CapabilitySession):string;
  sessionMcp?(session:CapabilitySession):Promise<Record<string,unknown>|null>;
  started(threadId:string,inputId:string,turnId:string):void;
}
/** Keep signing and the bridge consumer adjacent; legacy traffic stays untouched. */
export function createServerCodexBridge(legacy:DuplexTransport,options:BridgeGatewayOptions|undefined,admission:BridgeExecutionAdmissionPort):DuplexTransport {
  return options?new BridgeExecutionAdmissionTransport(new CodexProviderBridge(legacy,options),admission):legacy;
}

/** Server-side admission only for opt-in bridge Threads. Legacy frames pass intact. */
export class BridgeExecutionAdmissionTransport implements DuplexTransport {
  private readonly listeners=new Set<(frame:string)=>void>();
  private readonly inputs=new Map<string,{inputId:string;turnId?:string}>();
  private readonly requests=new Map<string,{threadId:string;inputId:string}>();
  constructor(private readonly inner:DuplexTransport,private readonly port:BridgeExecutionAdmissionPort) {
    inner.subscribeMessage(raw=>{
      const frame=JSON.parse(raw),p=frame.params??{};
      const request=this.requests.get(JSON.stringify([frame[LOGICAL_CLIENT_FIELD]??null,frame.id]));
      if(frame.id!==undefined&&request) {
        this.requests.delete(JSON.stringify([frame[LOGICAL_CLIENT_FIELD]??null,frame.id]));
        const input=this.inputs.get(request.threadId);
        if(frame.error&&input?.inputId===request.inputId&&!input.turnId)this.inputs.delete(request.threadId);
      }
      const input=this.inputs.get(p.threadId);
      if(frame.method==='turn/started'&&input) {
        input.turnId=p.turn.id;
        this.port.started(p.threadId,input.inputId,p.turn.id);
      }
      if(frame.method==='turn/completed'&&input?.turnId===p.turn?.id)this.inputs.delete(p.threadId);
      for(const listener of this.listeners)listener(raw);
    });
  }
  get status(){return this.inner.status;}
  connect(signal?:AbortSignal){return this.inner.connect(signal);}
  subscribeStatus(listener:Parameters<DuplexTransport['subscribeStatus']>[0]){return this.inner.subscribeStatus(listener);}
  subscribeMessage(listener:(frame:string)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  async close(){this.inputs.clear();this.requests.clear();await this.inner.close();}
  send(raw:string,signal?:AbortSignal){return this.sendWithContext(raw,{sender:null},signal);}
  async sendWithContext(raw:string,context:TransportSubmissionContext,signal?:AbortSignal){
    const frame=JSON.parse(raw),p=frame.params??{};
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
        if(input&&input.inputId===p.clientUserMessageId&&!input.turnId)this.inputs.delete(p.threadId);
        const reply=JSON.stringify({id:frame.id,error:{code:-32001,message:'cliUnavailable'},
          ...(frame[LOGICAL_CLIENT_FIELD]?{[LOGICAL_CLIENT_FIELD]:frame[LOGICAL_CLIENT_FIELD]}:{})});
        for(const listener of this.listeners)listener(reply);return;
      }
    }
    if(this.inner.sendWithContext)return this.inner.sendWithContext(raw,context,signal);
    return this.inner.send(raw,signal);
  }
}
