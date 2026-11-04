import {parentPort,workerData} from 'node:worker_threads';
import {TranscriptCacheStorage} from './transcript-cache-storage.js';
if(!parentPort)throw new Error('Transcript cache requires a Worker');
const port=parentPort;
const storage=new TranscriptCacheStorage(workerData.directory,workerData.schema);
const methods=new Set(['drop','meta','turn','maximum','exists','batch','hydrate','append','finish','snapshot','readPage','close']);
// No transaction spans a native RPC or another request.
port.on('message',({id,method,args})=>{
  try {
    if(!methods.has(method)||!Array.isArray(args))throw new Error('Unsupported transcript storage operation');
    const result=Reflect.apply(storage[method as keyof TranscriptCacheStorage] as Function,storage,args);
    port.postMessage({id,result,outcome:storage.outcome});
    if(method==='close')port.close();
  }catch(error){const e=error as Error&{code?:unknown};port.postMessage({id,error:{message:e.message,code:e.code}});}
});
