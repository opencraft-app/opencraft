import { parentPort, workerData } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ThreadOrchestrationLedger } from './orchestration-ledger.js';
import { AutomationLedger } from './automation-ledger.js';
import { updateExecutionRequest } from './execution-request-state.js';

// This handle is lent by the installation owner after migration. No create,
// migration, recovery, or ownership takeover is permitted in the child.
if(!parentPort||!isAbsolute(workerData.path)||!existsSync(workerData.path))throw new Error('Managed Server database is unavailable');
const port=parentPort;
const db=new DatabaseSync(workerData.path);
db.exec('PRAGMA busy_timeout=0');
if(db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='wal')throw new Error('Orchestration worker requires managed WAL storage');
db.prepare('SELECT version FROM schema_migrations LIMIT 1').get();
const busy=(error:unknown)=>{const code=(error as {errcode?:number})?.errcode;return typeof code==='number'&&[5,6].includes(code&255);};
let tail=Promise.resolve();
let closed=false;
async function execute({id,method,payload}: {id:number;method:string;payload:any}) {
  try {
    if(closed)throw new Error('Orchestration storage is closed');
    const started=performance.now();let result:unknown;
    for(;;){
      try{
        const ledger=new ThreadOrchestrationLedger(db,()=>payload.now??Date.now());
        switch(method){
          case 'automation': {
            const automation=new AutomationLedger(db,payload.now);
            const input=payload.input;
            switch(payload.operation){
              case 'command': result=automation.command(input.caller,input.command,input.body,input.key);break;
              case 'grantReplay': result=automation.grantReplay(input.caller,input.command,input.body,input.key);break;
              case 'grant': result=automation.grantCommand(input.caller,input.command,input.body,input.key);break;
              case 'eligible': result=automation.eligible();break;
              case 'recover': automation.recover();break;
              case 'claim': result=automation.claim(input.id,input.revision,input.occurrenceId);break;
              case 'settle': result=automation.settle(input.key,input.state,input.result,input.proof);break;
              case 'delegation': result=automation.delegation(input.key,input.sourceThreadId);break;
              case 'enqueue': result=automation.enqueue(input.key,input.id,input.threadId);break;
              case 'projection': result=automation.projection();break;
              case 'unknownRuns': result=automation.unknownRuns();break;
              case 'runGrant': result=automation.runGrant(input.key);break;
              case 'checkRunGrant': result=automation.checkRunGrant(input.key);break;
              case 'checkDelegation': result=automation.checkDelegation(input.id);break;
              default: throw Error('Unknown automation operation');
            }
            break;
          }
          case 'observe':ledger.observeSnapshot(payload.snapshot);break;
          case 'admission':result=db.prepare(`SELECT a.* FROM conversation_authorities a WHERE a.thread_id=? AND a.input_id=?
            UNION ALL SELECT a.* FROM conversation_authorities a JOIN opencraft_input_authorities i ON i.authority_id=a.id
            WHERE i.thread_id=? AND i.input_id=? LIMIT 1`).get(payload.threadId,payload.inputId,payload.threadId,payload.inputId)??null;break;
          case 'updateExecution':updateExecutionRequest(db,payload);break;
          case 'targets':result=[...new Set([...ledger.observedRuntimeThreads(payload.includeTerminal),
            ...ledger.threads().filter(thread=>payload.includeTerminal||!['idle','error'].includes(thread.runtimeStatus)).map(thread=>thread.threadId),
            ...ledger.activeWaits().flatMap(ticket=>ticket.targetThreadIds)])];break;
          case 'work':result={waits:ledger.activeWaits(),notifications:ledger.dueNotifications()};break;
          case 'pendingAcks':result=db.prepare('SELECT operation_id FROM opencraft_orchestration_acks LIMIT 16').all().map(row=>String(row.operation_id));break;
          case 'acknowledge':db.prepare('DELETE FROM opencraft_orchestration_acks WHERE operation_id=?').run(payload.operationId);break;
          case 'close':db.close();closed=true;break;
          default:throw new Error('Unsupported orchestration storage operation');
        }
        break;
      }catch(error){
        // Each observation rolls its transaction back before the asynchronous
        // retry. Never block or ask the gateway for work while holding a lock.
        if(!busy(error)||performance.now()-started>=5000)throw error;
        await new Promise(resolve=>setTimeout(resolve,5));
      }
    }
    port.postMessage({id,result});if(closed)port.close();
  }catch(error){const e=error as Error&{code?:unknown;status?:number};port.postMessage({id,error:{message:e.message,code:e.code,status:e.status}});}
}
port.on('message',request=>{tail=tail.then(()=>execute(request));});
port.postMessage({type:'ready'});
