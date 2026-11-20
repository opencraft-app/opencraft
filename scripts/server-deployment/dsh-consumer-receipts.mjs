import {createHash,randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Provider custody remains durable until exact consumer acknowledgement.
 * Network callbacks see only the Worker's last committed count. */
export class DshConsumerReceipts {
  #worker; #pending=new Map(); #sequence=0; #count=0; #failure; #closing; #closeAcknowledged=false; #ready=false;
  constructor(directory) {
    this.#worker=new Worker(new URL('./dsh-consumer-receipts-worker.mjs',import.meta.url),{workerData:{directory},execArgv:[]});
    this.ready=new Promise((resolve,reject)=>this.#pending.set(0,{resolve,reject}));
    this.#worker.on('error',error=>this.#fail(error));
    this.#worker.on('exit',()=>{if(!this.#closeAcknowledged)this.#fail(Error('DSH consumer storage worker exited'));});
    this.#worker.on('message',reply=>{
      const pending=this.#pending.get(reply.id);if(!pending)return;
      this.#pending.delete(reply.id);
      if(reply.error){const error=Error(reply.error.message);pending.reject(error);if(!reply.error.recoverable)this.#fail(error);return;}
      if(reply.activeCount!==undefined)this.#count=reply.activeCount;
      if(reply.outcome)this.outcome=reply.outcome;
      if(reply.id===0)this.#ready=true;
      pending.resolve(reply.result);
    });
  }
  static async open(directory){const store=new DshConsumerReceipts(directory);try{await store.ready;return store;}catch(error){await store.#worker.terminate();throw error;}}
  #fail(error){this.#failure??=error;for(const pending of this.#pending.values())pending.reject(this.#failure);this.#pending.clear();}
  #request(method,args){
    if(this.#failure)return Promise.reject(this.#failure);
    if(this.#closing&&method!=='close')return Promise.reject(Error('DSH consumer storage closing'));
    if(this.#pending.size>=128&&method!=='close')return Promise.reject(Error('DSH consumer storage queue full'));
    const id=++this.#sequence;
    return new Promise((resolve,reject)=>{this.#pending.set(id,{resolve,reject});try{this.#worker.postMessage({id,method,args});}catch(error){this.#fail(error);}});
  }
  async begin(request){
    await this.ready;
    const id=randomUUID();await this.#request('begin',[id,hash(request)]);
    return packet=>this.#request('finish',[id,packet]);
  }
  acknowledge(input){return this.#request('acknowledge',[input]);}
  observation(){const complete=this.#ready&&!this.#failure;return{coverage:complete?'complete':'unknown',activeCount:complete?this.#count+this.#pending.size:null};}
  close(){return this.#closing??=(async()=>{try{await this.ready;await this.#request('close',[]);this.#closeAcknowledged=true;}finally{await this.#worker.terminate();}})();}
}
