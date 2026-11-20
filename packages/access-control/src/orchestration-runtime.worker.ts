import { installCommunicationExtension } from './communication-extension.js';
import { sqliteTransaction } from '@opencraft/sqlite-node';
import { AssistantThreadStore } from './assistant-thread-store.js';
import { ThreadAccessStore } from './thread-access.js';
import { PersonalAssistants } from './personal-assistants.js';
import { channelSyncCommand } from "./native-channel-sync.js";
import { ActorStore } from './actors.js';
import { Collaboration } from './collaboration.js';
import { communicationCommand } from './communication-command.js';
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
if(workerData.extensionModule) {
  const extension=await import(workerData.extensionModule);
  installCommunicationExtension(extension.communicationExtension);
}
const port=parentPort;
const db=new DatabaseSync(workerData.path);
db.exec('PRAGMA busy_timeout=0');
if(db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='wal')throw new Error('Orchestration worker requires managed WAL storage');
db.prepare('SELECT version FROM schema_migrations LIMIT 1').get();
const busy=(error:unknown)=>{const code=(error as {errcode?:number})?.errcode;return typeof code==='number'&&[5,6].includes(code&255);};
const source={database:db,outcome:{status:'up-to-date' as const,appliedVersion:Number(db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()!.n),movedAsidePaths:[]}};
let communication: Collaboration | undefined;
let actors: ActorStore | undefined;
function communicationService() {
  return communication ??= new Collaboration(source,actors ??= new ActorStore(source,Date.now,{permissionProjection:false}),undefined,Date.now,
    actorId=>db.prepare('SELECT enabled FROM actor_members WHERE actor_id=?').get(actorId)?.enabled!==0);
}
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
          case 'personalAssistantAssignments':result=new PersonalAssistants(communicationService(),db).assignments(payload.after);break;
          case 'channelSync':result=channelSyncCommand(communicationService(),db,payload);break;
          case 'assistantAllocation':result=sqliteTransaction(db,()=>new AssistantThreadStore(communicationService(),db).recordAllocation(payload));break;
          case 'assistantAdmissions': {
            const service=communicationService(),store=new AssistantThreadStore(service,db);
            result=db.prepare("SELECT o.thread_id,o.origin_json FROM opencraft_input_origins o JOIN actor_execution_requests r ON o.input_id='actor-input:'||r.id AND o.thread_id=r.thread_id WHERE r.state IN ('accepted','transferring','queued','unknown') LIMIT 10000").all().flatMap(row=>{
              const grant=JSON.parse(String(row.origin_json)).assistantGrant;if(!grant)return [];
              try{return [{threadId:String(row.thread_id),grant,authority:store.guard(grant.actor,grant.profile,grant.revision,grant.epoch),takenOver:service.orchestration.relation(String(row.thread_id))?.hasDirectUserInput??false}];}catch{return [];}
            });break;
          }
          case 'communication': {
            if(!payload.executionScope){result=communicationCommand(communicationService(),db,payload);break;}
            const scope=payload.executionScope,actorStore=actors??=new ActorStore(source,Date.now,{permissionProjection:false});
            const access=new ThreadAccessStore(source,actorStore,{projection:false});
            const unsupported=async()=>{throw Error('Storage cannot call an engine');};
            const scoped=new Collaboration(source,actorStore,{serverId:scope.serverId,hostId:scope.hostId,serverForThread:()=>scope.serverId,hostForServer:id=>id===scope.serverId?scope.hostId:null,validate:unsupported,receipt:unsupported,add:unsupported,steer:unsupported,cancel:unsupported},Date.now,id=>db.prepare('SELECT enabled FROM actor_members WHERE actor_id=?').get(id)?.enabled!==0,undefined,(c,r)=>access.allows(r.serverId,r.threadId,c));
            try{result=communicationCommand(scoped,db,payload);}finally{await scoped.close();access.close();}break;
          }
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
          case 'executionAuthority': {
            const {inputId,turnId}=payload.execution;
            const row=inputId ? db.prepare(`SELECT a.* FROM conversation_authorities a WHERE a.thread_id=? AND a.input_id=?
              UNION ALL SELECT a.* FROM conversation_authorities a JOIN opencraft_input_authorities i ON i.authority_id=a.id
              WHERE i.thread_id=? AND i.input_id=? LIMIT 1`).get(payload.threadId,inputId,payload.threadId,inputId)
              : turnId ? db.prepare(`SELECT a.* FROM conversation_authorities a JOIN conversation_turn_authorities t ON t.authority_id=a.id
                WHERE t.thread_id=? AND t.turn_id=? UNION ALL SELECT * FROM conversation_authorities WHERE thread_id=? AND turn_id=? LIMIT 1`)
                .get(payload.threadId,turnId,payload.threadId,turnId) : null;
            result=row && (!turnId || row.thread_id===payload.threadId && row.turn_id===turnId || db.prepare('SELECT 1 FROM conversation_turn_authorities WHERE thread_id=? AND turn_id=? AND authority_id=?').get(payload.threadId,turnId,row.id))
              ? {...row,turn_id:turnId??row.turn_id,execution_relation:ledger.relation(payload.threadId)} : null;
            break;
          }
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
  }catch(error){const e=error as Error&{code?:unknown;status?:unknown};port.postMessage({id,error:{message:e.message,code:e.code,status:e.status}});}
}
port.on('message',request=>{tail=tail.then(()=>execute(request));});
port.postMessage({type:'ready'});
