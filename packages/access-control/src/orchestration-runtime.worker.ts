import { installCommunicationExtension } from './communication-extension.js';
import { parentPort, workerData } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nodeSqlDatabase } from '@opencraft/sqlite-node';
import { orchestrationRuntimeDomain } from './orchestration-runtime-domain.js';

// Standalone orchestration storage for compositions without a Server core
// owner Worker (tests, smoke fixtures, file-backed Collaboration). Headless
// serves the same domain on its owner connection instead.
// This handle is lent by the installation owner after migration. No create,
// migration, recovery, or ownership takeover is permitted in the child.
if(!parentPort||!isAbsolute(workerData.path)||!existsSync(workerData.path))throw new Error('Managed Server database is unavailable');
if(workerData.extensionModule) {
  const extension=await import(workerData.extensionModule);
  installCommunicationExtension(extension.communicationExtension);
}
const port=parentPort;
const connection=new DatabaseSync(workerData.path);
const db=nodeSqlDatabase(connection);
// This connection is one of several writers: it never waits for a lock inside
// SQLite and retries asynchronously instead.
db.exec('PRAGMA busy_timeout=0');
if(db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='wal')throw new Error('Orchestration worker requires managed WAL storage');
db.prepare('SELECT version FROM schema_migrations LIMIT 1').get();
const busy=(error:unknown)=>{const code=(error as {errcode?:number})?.errcode;return typeof code==='number'&&[5,6].includes(code&255);};
const domain=orchestrationRuntimeDomain({database:db,location:workerData.path as string,outcome:{status:'up-to-date' as const,appliedVersion:Number(db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()!.n),movedAsidePaths:[]}});
let tail=Promise.resolve();
let closed=false;
async function execute({id,method,payload}: {id:number;method:string;payload:any}) {
  try {
    if(closed)throw new Error('Orchestration storage is closed');
    const started=performance.now();let result:unknown;
    if(method==='close'){try{await domain.close();}finally{connection.close();closed=true;}}
    else for(;;){
      try{result=await domain.execute(method,payload);break;}
      catch(error){
        // Each observation rolls its transaction back before the asynchronous
        // retry. Never block or ask the gateway for work while holding a lock.
        if(!busy(error)||performance.now()-started>=5000)throw error;
        await new Promise(resolve=>setTimeout(resolve,5));
      }
    }
    port.postMessage({id,result});if(closed)port.close();
  }catch(error){const e=error as Error&{code?:unknown;status?:unknown};port.postMessage({id,error:{message:e.message,code:e.code,status:e.status}});}
}
port.on('message',request=>{tail=tail.then(()=>execute(request));});
port.postMessage({type:'ready'});
