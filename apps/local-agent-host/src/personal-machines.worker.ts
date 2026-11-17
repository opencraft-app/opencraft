import {parentPort,workerData} from 'node:worker_threads';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseRuntimeMachineIdentity} from '@opencraft/appserver-protocol';
export interface MachineRecord {id:string;pairHash:string;credentialHash:string|null;expiresAt:number;machine:ReturnType<typeof parseRuntimeMachineIdentity>|null}
const {directory,ownerActorId}=workerData;
const path=join(directory,'personal-machines.json');
let state!:{schemaVersion:1;hubId:string;ownerActorId:string;machines:MachineRecord[]};
const save=async(next:typeof state)=>{const temp=path+'.tmp';await writeFile(temp,JSON.stringify(next),{mode:0o600});await rename(temp,path);state=next;return state;};
await mkdir(directory,{recursive:true,mode:0o700});
try {
  state=JSON.parse(await readFile(path,'utf8'));
  if(state.schemaVersion!==1||state.ownerActorId!==ownerActorId||!Array.isArray(state.machines)||typeof state.hubId!=='string')throw new Error('Invalid personal machine authority');
  for(const row of state.machines){if(!/^[a-f0-9-]{36}$/.test(row.id)||!/^[a-f0-9]{64}$/.test(row.pairHash)||!Number.isFinite(row.expiresAt)||row.credentialHash!==null&&!/^[a-f0-9]{64}$/.test(row.credentialHash))throw new Error('Invalid machine record');if(row.machine)parseRuntimeMachineIdentity(row.machine);}
}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await save({schemaVersion:1,hubId:randomUUID(),ownerActorId,machines:[]});}
parentPort!.postMessage({state});
let queue=Promise.resolve();
parentPort!.on('message',packet=>{queue=queue.then(async()=>{
  try{
    const p=packet.params;let result=state;
    if(packet.method==='create'){
      const rows=state.machines.filter(r=>r.credentialHash||r.expiresAt>Date.now());
      if(rows.length>=64)throw new Error('Personal machine limit');
      if(typeof p.pairHash!=='string'||!/^[a-f0-9]{64}$/.test(p.pairHash))throw new Error('Invalid pairing');
      result=await save({...state,machines:[...rows,{id:randomUUID(),pairHash:p.pairHash,credentialHash:null,expiresAt:Date.now()+15*60_000,machine:null}]});
    }else if(packet.method==='claim'){
      const row=state.machines.find(r=>r.id===p.id&&r.pairHash===p.pairHash);
      if(!row||!row.credentialHash&&row.expiresAt<=Date.now()||!/^[a-f0-9]{64}$/.test(p.credentialHash))throw new Error('Pairing unavailable');
      const machine=parseRuntimeMachineIdentity(p.machine);
      if(row.credentialHash){if(row.credentialHash!==p.credentialHash||row.machine?.machineId!==machine.machineId)throw new Error('Machine already claimed');}
      else result=await save({...state,machines:state.machines.map(r=>r.id===row.id?{...r,credentialHash:p.credentialHash,machine}:r)});
    }else if(packet.method==='revoke')result=await save({...state,machines:state.machines.filter(r=>r.id!==p.id)});
    else if(packet.method!=='close')throw new Error('Invalid machine operation');
    parentPort!.postMessage({id:packet.id,state:result});
  }catch{parentPort!.postMessage({id:packet.id,error:true});}
});});
