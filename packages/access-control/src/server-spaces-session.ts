import { SERVER_SPACES_METHOD, SERVER_SPACES_CHANGED, type ServerSpaceCommand, type ServerSpaceDirectory } from '@opencraft/appserver-protocol/server-spaces';
import type { ActorContext } from '@opencraft/identity-core/actors';
import type { ServerSpacesRuntime } from './server-spaces-runtime.js';
interface RpcSession {receive(frame:string):boolean|Promise<boolean>;project(frame:string):string|null;close():void}
/** Adapt the shared authority to one authenticated RPC lane, including Native creation receipts. */
export class ServerSpacesSession {
  private readonly pending=new Map<string,{spaceId?:string;method:string}>();
  private readonly selected=new Map<string,string>();
  private readonly unsubscribe:()=>void;
  private closed=false;
  constructor(private readonly runtime:ServerSpacesRuntime,private readonly context:ActorContext|undefined,
    private readonly server:(threadId:string)=>string,private readonly emit:(frame:string)=>void,
    private readonly base:RpcSession,private readonly readable:(serverId:string,threadId:string)=>boolean,private readonly current:()=>void=()=>{},
    private readonly historicalMetadata?:(threadId:string)=>Promise<unknown>) {
    this.unsubscribe=runtime.subscribe(()=>{if(!this.closed)this.emit(JSON.stringify({method:SERVER_SPACES_CHANGED,params:{}}));});
  }
  private lane(packet:Record<string,unknown>) {return typeof packet.__opencraftClient==='string'?packet.__opencraftClient:'';}
  private key(packet:Record<string,unknown>) {return JSON.stringify([this.lane(packet),packet.id]);}
  async receive(frame:string):Promise<boolean> {
    this.current();if(this.closed)throw new Error('Server connection closed');
    const packet=JSON.parse(frame),params=packet.params??{};
    const context=this.runtime.context(this.context);
    if(packet.method===SERVER_SPACES_METHOD) {
      const envelope={id:packet.id,...(packet.__opencraftClient===undefined?{}:{__opencraftClient:packet.__opencraftClient})};
      try {
        let result=await this.runtime.command(context,params as ServerSpaceCommand);
        const project=(directory:ServerSpaceDirectory)=>({...directory,assignments:directory.assignments.filter(a=>this.readable(a.engineServerId,a.threadId))});
        if(result&&Array.isArray(result.spaces)&&Array.isArray(result.assignments))result=project(result);
        else if(result?.directory)result={...result,directory:project(result.directory)};
        this.current();if(this.closed)return true;
        if(params.action==='select')this.selected.set(this.lane(packet),params.spaceId);
        this.emit(JSON.stringify({...envelope,result}));
      }catch(error){const e=error as {rpcCode?:number;reason?:string};this.emit(JSON.stringify({...envelope,error:{code:e.rpcCode??-32004,message:'Server action unavailable',data:{reason:e.reason??'unavailable'}}}));}
      return true;
    }
    if(['thread/read','thread/resume'].includes(packet.method)&&typeof params.threadId==='string'
      &&!this.runtime.hasAssignment(this.server(params.threadId),params.threadId)&&this.runtime.hasMember(context.actorId,'myself')&&this.historicalMetadata) {
      const result=await this.historicalMetadata(params.threadId) as {thread?:{id?:unknown;createdAt?:unknown}}|null;
      this.current();
      const thread=result?.thread;
      if(thread&&thread.id===params.threadId&&typeof thread.createdAt==='number')
        await this.runtime.adoptLegacy(context,this.server(params.threadId),[{id:params.threadId,createdAt:thread.createdAt}]);
    }
    if(['thread/start','thread/fork'].includes(packet.method)&&packet.id!==undefined) {
      const spaceId=packet.method==='thread/fork'&&typeof params.threadId==='string'
        ?this.runtime.spaceFor(this.server(params.threadId),params.threadId):params.collaborationSpaceId??this.selected.get(this.lane(packet))??'myself';
      if(!this.runtime.hasMember(context.actorId,spaceId)) {
        this.emit(JSON.stringify({id:packet.id,...(packet.__opencraftClient===undefined?{}:{__opencraftClient:packet.__opencraftClient}),error:{code:-32004,message:'Server unavailable'}}));return true;
      }
      this.pending.set(this.key(packet),{spaceId,method:packet.method});
    }
    if(['thread/list','thread/read','thread/resume'].includes(packet.method)&&packet.id!==undefined)this.pending.set(this.key(packet),{method:packet.method});
    if(this.pending.size>4096)throw new Error('Server request limit');
    return this.base.receive(frame);
  }
  rewrite(frame:string):string {
    const packet=JSON.parse(frame);
    if(packet.method==='thread/start'&&packet.params&&'collaborationSpaceId' in packet.params)delete packet.params.collaborationSpaceId;
    return JSON.stringify(packet);
  }
  async prepare(frame:string):Promise<void> {
    this.current();if(this.closed)throw new Error('Server connection closed');
    const packet=JSON.parse(frame),pending=this.pending.get(this.key(packet));
    if(!pending||packet.method!==undefined)return;
    this.pending.delete(this.key(packet));
    const id=packet.result?.thread?.id;
    if(typeof id==='string'&&!packet.error&&pending.spaceId)await this.runtime.assign(this.context,this.server(id),id,pending.spaceId);
    if(!packet.error&&!pending.spaceId) {
      const rows=Array.isArray(packet.result?.data)?packet.result.data:packet.result?.thread?[packet.result.thread]:[];
      const groups=new Map<string,{id:string;createdAt:number}[]>();
      for(const row of rows.slice(0,1000))if(typeof row.id==='string'&&typeof row.createdAt==='number') {const server=this.server(row.id);const group=groups.get(server)??[];group.push({id:row.id,createdAt:row.createdAt});groups.set(server,group);}
      for(const [server,threads]of groups)await this.runtime.adoptLegacy(this.context,server,threads);
    }
    this.current();
  }
  project(frame:string):string|null {
    this.current();if(this.closed)return null;
    const result=this.base.project(frame);if(result===null)return null;
    const packet=JSON.parse(result);
    if(packet.result?.capabilities?.extensions){const extensions=packet.result.capabilities.extensions;extensions['opencraft/server-spaces']={version:1};if(Array.isArray(extensions['opencraft/method-access']?.methods))extensions['opencraft/method-access'].methods.push(SERVER_SPACES_METHOD);}
    return JSON.stringify(packet);
  }
  close(){this.closed=true;this.unsubscribe();this.pending.clear();this.selected.clear();this.base.close();}
}
