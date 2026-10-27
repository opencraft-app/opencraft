// Isolated real-CLI drill process. Every identity and upstream is synthetic.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ActorStore } from '../../packages/access-control/src/actors';
import { Collaboration } from '../../packages/access-control/src/collaboration';
import { ThreadOrchestrationBroker } from '../../packages/access-control/src/thread-orchestration-broker';
import { CodexEngineAdapter } from '../../apps/opencraft-daemon/src/codex-engine-adapter';
import {TokenUsageQueryService} from '../../apps/opencraft-daemon/src/token-usage-query-service';
import { AppHostServer } from '../../packages/app-host-server/src/index';
import { callConversationHost,createConversationExecution } from '../../scripts/conversation-execution.mjs';
import { createThreadOrchestrationExecution } from '../../scripts/thread-orchestration-execution.mjs';
const config=JSON.parse(await readFile(process.argv[2]!, 'utf8'));
const actors=new ActorStore(join(config.gatewayDirectory,'actors.sqlite'));
const human=actors.resolveHuman({provider:'local',subject:'drill-user',displayName:'Synthetic user',expiresAt:Date.now()+3_600_000})!;
let host!:AppHostServer,service!:Collaboration,broker!:ThreadOrchestrationBroker;
let crashArmed=!!config.crashTool;
const usageQueries=new TokenUsageQueryService({entry:new URL('../../apps/opencraft-daemon/src/token-usage-query-worker.ts',import.meta.url).pathname,
  databasePath:join(config.gatewayDirectory,'codex/token-usage.sqlite'),serverId:'server',rollout:{nativeHome:config.nativeHome??join(config.dataDirectory,'runtime')}});
let engine:CodexEngineAdapter;
const createEngine=()=>engine=new CodexEngineAdapter({executable:config.executable,runtimeDirectory:config.root,dataDirectory:join(config.gatewayDirectory,'codex'),
  nativeCodexHomeDirectory:join(config.gatewayDirectory,'unused-native'),coreEndpoint:config.endpoint,coreAuthToken:config.authToken,coreHostOverlays:true,
  logDiagnostic:value=>{if(value.event!=='thread-read-cache')process.stderr.write(JSON.stringify(value)+'\n');},
  decorateNativeTransport:native=>({get status(){return native.status;},connect:signal=>native.connect(signal),close:()=>native.close(),subscribeMessage:listener=>native.subscribeMessage(listener),subscribeStatus:listener=>native.subscribeStatus(status=>{process.stderr.write('native-status '+JSON.stringify(status)+'\n');listener(status);}),send:frame=>native.send(frame)}),
  tokenUsage:{derivedQueries:usageQueries,queryWorkerEntry:new URL('../../apps/opencraft-daemon/src/token-usage-query-worker.ts',import.meta.url).pathname,serverId:'server',actor:context=>actors.get(context.actorId),person:id=>actors.get(id),submission:(thread,input)=>service.usageSubmission(thread,input)},
  collaboration:{
    topology: threadId => service.threadTopology(threadId),
    queuedContext:(thread,id,input)=>service.queuedReferenceContext(thread,id,input),continued:(thread,previous,turn)=>service.executionContinued(thread,previous,turn),
    continuing:(thread,previous,input)=>service.executionContinuing(thread,previous,input),inputDelegation:(thread,input,expected)=>service.inputDelegation(thread,input,expected),
    prepare:(context,input)=>service.referenceContext(context,input),command:(context,body)=>service.command(context,body),
    authorize:(context,thread,input,parts)=>service.authorizeExecution(context,thread,input,parts),started:(thread,input,turn)=>service.executionStarted(thread,input,turn),
    tool:(thread,turn,name,args)=>service.tool(thread,turn,name,args),orchestration:{available:()=>broker.available,observed:snapshot=>broker.observe(snapshot),
      async tool(thread,turn,key,name,args,delegation,callbackIncarnation){
        const result=await broker.invoke(thread,turn,key,name,args,delegation,callbackIncarnation);
        if(crashArmed&&name===config.crashTool&&service.orchestration.relation(thread)?.parentThreadId){
          crashArmed=false;await writeFile(config.crashMarker,JSON.stringify({thread,turn,key,name,result}));
          await new Promise(()=>{});
        }
        return result;
      }},
  },collaborationInput:{available:()=>service.available,mode:id=>service.inputMode(id),authorize:(thread,id,mode,turn)=>service.authorizeInput(thread,id,mode,turn)},
});
host=new AppHostServer({physicalHostLifetime:'server',logicalClientRouting:true,createTransport:createEngine});
service=new Collaboration(join(config.gatewayDirectory,'actor-collaboration.sqlite'),actors,createConversationExecution(()=>host,{serverId:'server',hostId:'local-codex'}));
const execution=createThreadOrchestrationExecution(()=>host),create=execution.create;
execution.create=async(operationId,sourceThreadId,settings,admit)=>{
 const result=await create(operationId,sourceThreadId,settings,admit),source=service.orchestration.relation(sourceThreadId);
 if(crashArmed&&config.crashTool==='thread_spawn'&&source?.parentThreadId){
  crashArmed=false;const operation=service.orchestration.operationById(operationId)!;
  await writeFile(config.crashMarker,JSON.stringify({thread:sourceThreadId,turn:source.turnId,key:operation.toolCallKey,name:'thread_spawn',result:{operationId,threadId:result.threadId},beforeBrokerCommit:true}));await new Promise(()=>{});
 }
 return result;
};
broker=new ThreadOrchestrationBroker(service,execution);service.start();broker.start();
await host.ensureHostConnected('local-codex');
const context={sender:null,actorContext:human,tokenUsageAuthority:()=>({actorId:human.actorId,administrator:true})};
let sequence=0;
process.on('message',async(raw:any)=>{
  const {id,command,params={}}=raw;
  try{
    let result:unknown;
    if(command==='rpc')result=await callConversationHost(host,{hostId:'local-codex',threadId:params.arguments?.threadId??''},String(++sequence),params.method,params.arguments??{},context);
    else if(command==='native')result=await (engine as any).requestPhysical(params.method,params.arguments??{},5000);
    else if(command==='state')result={status:engine.status,threads:service.orchestration.threads(),operations:service.database.prepare('SELECT operation_id,kind,target_thread_id,client_message_id,result_json FROM opencraft_orchestration_operations').all(),inputs:service.database.prepare('SELECT thread_id,input_id,origin_json FROM opencraft_input_origins').all(),requests:service.database.prepare('SELECT id,state,thread_id,turn_id,queue_id FROM actor_execution_requests').all()};
    else if(command==='agentTell'){
      const sent=await broker.invoke(params.sourceThreadId,params.sourceTurnId,'fixture-agent:'+Date.now(),'thread_tell',{threadId:params.threadId,message:'QUEUED-DURING-RECOVERY'}) as {operationId:string};
      result={requestId:service.orchestration.operationById(sent.operationId)!.clientMessageId!.slice('actor-input:'.length)};
    }
    else if(command==='request')result=service.getRequest(human,params.requestId);
    else if(command==='cancelAgent')result=await service.cancel(human,params.requestId,()=>{});
    else if(command==='inspect')result=await createThreadOrchestrationExecution(()=>host).snapshot(params.threadId);
    else throw Error('Unknown drill command');
    process.send?.({id,result});
  }catch(error){process.send?.({id,error:{message:String(error),code:(error as any)?.code}});}
});
async function close(){broker.stop();await host.close();await broker.close();await service.close();usageQueries.close();actors.close();process.exit(0);}
process.on('SIGTERM',()=>void close());
process.send?.({ready:true});
