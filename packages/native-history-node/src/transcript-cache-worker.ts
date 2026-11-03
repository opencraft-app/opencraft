import { Worker } from 'node:worker_threads';
import type { TranscriptCacheStorage } from './transcript-cache-storage.js';
import type { DatabaseOutcome } from '@opencraft/sqlite-node';
type Method = 'drop'|'meta'|'turn'|'maximum'|'exists'|'batch'|'hydrate'|'append'|'finish'|'snapshot'|'readPage'|'close';
/** Owns index migration, recovery and all projection file IO off the network
 * thread. Lazy startup means exact source reads never open a cache index. */
export class TranscriptCacheWorker {
  private worker?: Worker;
  private readonly pending=new Map<number,{resolve(value:any):void;reject(error:Error):void}>();
  private nextId=0;
  private failure?: Error;
  private closing?: Promise<void>;
  private stopping=false;
  outcome: DatabaseOutcome|null=null;
  constructor(private readonly dataDirectory:string,private readonly schema:number) {}
  private fail(error:Error) {
    this.failure??=error;
    for(const request of this.pending.values())request.reject(error);
    this.pending.clear();
  }
  private request<K extends Method>(method:K,...args:Parameters<TranscriptCacheStorage[K]>):Promise<ReturnType<TranscriptCacheStorage[K]>> {
    if(this.failure)return Promise.reject(this.failure);
    if(this.stopping&&method!=='close')return Promise.reject(new Error('Transcript cache is closing'));
    if(this.pending.size>=128&&method!=='close')return Promise.reject(new Error('Transcript cache storage queue is full'));
    if(!this.worker) {
      try {
        this.worker=new Worker(new URL('./transcript-cache-storage-worker.mjs',import.meta.url),{workerData:{directory:this.dataDirectory,schema:this.schema},execArgv:[]});
        this.worker.on('error',error=>this.fail(error));
        this.worker.on('exit',code=>{if(!this.stopping||code!==0||this.pending.size)this.fail(new Error('Transcript cache storage worker exited'));});
        this.worker.on('message',packet=>{
          const request=this.pending.get(packet.id);if(!request)return;
          this.pending.delete(packet.id);this.outcome=packet.outcome??this.outcome;
          if(packet.error)request.reject(Object.assign(new Error(packet.error.message),{code:packet.error.code}));
          else request.resolve(packet.result);
        });
      } catch(error) {this.fail(error as Error);return Promise.reject(error);}
    }
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      try{this.worker!.postMessage({id,method,args});}catch(error){this.pending.delete(id);reject(error);}
    });
  }
  drop(...args:Parameters<TranscriptCacheStorage['drop']>) {return this.request('drop',...args);}
  meta(...args:Parameters<TranscriptCacheStorage['meta']>) {return this.request('meta',...args);}
  turn(...args:Parameters<TranscriptCacheStorage['turn']>) {return this.request('turn',...args);}
  maximum(...args:Parameters<TranscriptCacheStorage['maximum']>) {return this.request('maximum',...args);}
  exists(...args:Parameters<TranscriptCacheStorage['exists']>) {return this.request('exists',...args);}
  batch(...args:Parameters<TranscriptCacheStorage['batch']>) {return this.request('batch',...args);}
  hydrate(...args:Parameters<TranscriptCacheStorage['hydrate']>) {return this.request('hydrate',...args);}
  append(...args:Parameters<TranscriptCacheStorage['append']>) {return this.request('append',...args);}
  finish(...args:Parameters<TranscriptCacheStorage['finish']>) {return this.request('finish',...args);}
  snapshot(...args:Parameters<TranscriptCacheStorage['snapshot']>) {return this.request('snapshot',...args);}
  readPage(...args:Parameters<TranscriptCacheStorage['readPage']>) {return this.request('readPage',...args);}
  close():Promise<void> {
    if(this.closing)return this.closing;
    if(!this.worker){this.stopping=true;return this.closing=Promise.resolve();}
    this.stopping=true;
    return this.closing=(async()=>{try{await this.request('close');}finally{await this.worker!.terminate();}})();
  }
}
