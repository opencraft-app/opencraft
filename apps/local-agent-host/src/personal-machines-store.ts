import {Worker} from 'node:worker_threads';
import type {MachineRecord} from './personal-machines.worker';
type State={hubId:string;ownerActorId:string;machines:MachineRecord[]};
export class PersonalMachineStore {
  state!:State;
  private worker:Worker;private sequence=0;private closed=false;
  private pending=new Map<number,{resolve(value:State):void;reject(error:Error):void}>();
  readonly ready:Promise<void>;
  constructor(directory:string,ownerActorId:string,onFailure?:()=>void){
    this.worker=new Worker(new URL('./personal-machines-worker.mjs',import.meta.url),{execArgv:[],workerData:{directory,ownerActorId}});
    this.ready=new Promise((resolve,reject)=>{
      this.worker.on('message',p=>{if(p.state){this.state=p.state;resolve();}if(p.id){const call=this.pending.get(p.id);this.pending.delete(p.id);p.error?call?.reject(new Error('Machine operation unavailable')):call?.resolve(this.state);}});
      const fail=()=>{this.closed=true;reject(new Error('Machine storage unavailable'));for(const p of this.pending.values())p.reject(new Error('Machine storage unavailable'));this.pending.clear();onFailure?.();};
      this.worker.on('error',fail);this.worker.on('exit',()=>{if(!this.closed)fail();});
    });
  }
  get available(){return !this.closed&&!!this.state;}
  async command(method:'create'|'claim'|'revoke'|'close',params:Record<string,unknown>={}){
    await this.ready;if(this.closed)throw new Error('Machine storage closed');const id=++this.sequence;
    return new Promise<typeof this.state>((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker.postMessage({id,method,params});});
  }
  async close(){if(this.closed)return;try{await this.command('close');}finally{this.closed=true;await this.worker.terminate();}}
}
