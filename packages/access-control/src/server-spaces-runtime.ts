import type { DatabaseOutcome } from '@opencraft/sqlite-node';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ActorContext } from '@opencraft/identity-core/actors';
import type { ServerSpaceCommand, ServerSpaceDirectory } from '@opencraft/appserver-protocol/server-spaces';
import type { SpaceProjection } from './server-spaces-ledger.js';

/** One serial storage owner; network hot paths only read its committed projection. */
export class ServerSpacesRuntime {
  private projection: SpaceProjection = {spaces:[],members:[],assignments:[]};
  private assignments=new Map<string,string>();
  private members=new Set<string>();
  private publish(projection:SpaceProjection){
    this.assignments=new Map(projection.assignments.map(a=>[JSON.stringify([a.engineServerId,a.threadId]),a.spaceId]));
    this.members=new Set(projection.members.map(m=>JSON.stringify([m.spaceId,m.actorId])));
    this.projection=projection;
  }
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  private sequence = 0;
  private failed = false;
  private closing = false;
  private localContext?: ActorContext;
  private closeOperation?:Promise<void>;
  outcome:DatabaseOutcome|null=null;
  readonly ready: Promise<void>;
  private readonly worker: Worker;
  constructor(options: {directory?:string;path?:string;ownerActorId?:string;members?:readonly string[];bootstrapInstance?:boolean}) {
    this.worker = new Worker(new URL('server-spaces-worker.mjs',typeof __dirname==='string'?pathToFileURL(__dirname+'/'):new URL('.',import.meta.url)),{workerData:options});
    this.ready = new Promise((resolve,reject) => {
      this.worker.on('message', message => {
        if (message.type === 'ready') {this.publish(message.projection);this.localContext=message.localContext;this.outcome=message.outcome??null;resolve();return;}
        const request=this.pending.get(message.id);if(!request)return;this.pending.delete(message.id);
        if(message.error){request.reject(Object.assign(new Error('Server action unavailable'),message.error));return;}
        if(message.projection) {
          this.publish(message.projection);
          for(const listener of this.listeners) {try{listener();}catch{/* Observers cannot undo a committed mutation. */}}
        }
        request.resolve(message.result);
      });
      const failure = (cause?:unknown) => {
        this.failed=true; const error=new Error('Server storage unavailable',{cause});reject(error);
        for(const request of this.pending.values())request.reject(error);this.pending.clear();
        for(const listener of this.listeners){try{listener();}catch{/* Retired observers do not own the authority. */}}
      };
      this.worker.on('error',failure);
      this.worker.on('exit',()=>{if(!this.closing||this.pending.size)failure();});
    });
    void this.ready.catch(()=>{});
  }
  private async call(payload: Record<string,unknown>): Promise<any> {
    await this.ready;
    if(this.failed || this.closing && payload.method !== 'close')throw new Error('Server storage unavailable');
    if(this.pending.size>=256)throw new Error('Server storage busy');
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;this.pending.set(id,{resolve,reject});try{this.worker.postMessage({id,...payload});}catch(error){this.pending.delete(id);reject(error); }
    });
  }
  async bootstrap(ownerActorId:string,members:readonly string[]=[]):Promise<void> {await this.call({method:'bootstrap',ownerActorId,members});}
  context(context?: ActorContext): ActorContext {
    const value=context ?? this.localContext;
    if(!value || value.expiresAt<=Date.now())throw Object.assign(new Error('Sign in to use Servers'),{rpcCode:-32001});
    return value;
  }
  get initialized():boolean{return this.projection.spaces.some(space=>space.id==='myself');}
  command(context: ActorContext|undefined,command: ServerSpaceCommand): Promise<any> {if(command?.action==='list'){if(Object.keys(command).length!==1)return Promise.reject(Object.assign(new Error('Invalid Server request'),{rpcCode:-32602}));return this.ready.then(()=>this.directory(context));}return this.call({method:'command',context:this.context(context),command});}
  assign(context: ActorContext|undefined,engineServerId:string,threadId:string,spaceId:string): Promise<void> {
    return this.call({method:'assign',context:this.context(context),engineServerId,threadId,spaceId});
  }
  inherit(parent:{serverId:string;threadId:string},child:{serverId:string;threadId:string}):Promise<void>{return this.call({method:"inherit",parent,child});}
  adoptLegacy(context:ActorContext|undefined,engineServerId:string,threads:readonly {id:string;createdAt:number}[]):Promise<void> {return this.call({method:'legacy',context:this.context(context),engineServerId,threads});}
  hasAssignment(engineServerId:string,threadId:string):boolean{return this.assignments.has(JSON.stringify([engineServerId,threadId]));}
  spaceFor(engineServerId:string,threadId:string):string {
    return this.assignments.get(JSON.stringify([engineServerId,threadId])) ?? 'myself';
  }
  allows(actorId:string|undefined,engineServerId:string,threadId:string):boolean {
    if(this.failed)return false;
    const spaceId=this.assignments.get(JSON.stringify([engineServerId,threadId]));
    if(!spaceId)return false;
    return !!actorId && this.members.has(JSON.stringify([spaceId,actorId]));
  }
  hasMember(actorId:string,spaceId:string):boolean {return !this.failed&&this.members.has(JSON.stringify([spaceId,actorId]));}
  directory(context?:ActorContext):ServerSpaceDirectory {
    const {actorId}=this.context(context);
    const memberships=new Map(this.projection.members.filter(m=>m.actorId===actorId).map(m=>[m.spaceId,m.role]));
    if(this.failed)throw new Error('Server storage unavailable');
    return {actorId,spaces:this.projection.spaces.filter(s=>memberships.has(s.id)).map(s=>({id:s.id,name:s.name,role:memberships.get(s.id)!,memberCount:this.projection.members.filter(m=>m.spaceId===s.id).length})),
      assignments:this.projection.assignments.filter(a=>memberships.has(a.spaceId))};
  }
  subscribe(listener:()=>void):()=>void {this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  close():Promise<void> {
    return this.closeOperation??=(async()=>{
      this.closing=true;
      try {if(!this.failed)await this.call({method:'close'});}finally{await this.worker.terminate();this.listeners.clear();}
    })();
  }
}
