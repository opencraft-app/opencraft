import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BridgeHost, attachGateway } from '../../apps/agent-bridge-host/src/index';
import { localTestBackend } from '../agent-bridge/fixtures/local-backend';
import type { CapabilitySession } from '../../packages/session-capabilities/src/index';
import { ActorStore } from '../../packages/access-control/src/actors';
import { Collaboration, type ConversationExecutionPort } from '../../packages/access-control/src/collaboration';
import { OrchestrationRuntimeWorker } from '../../packages/access-control/src/orchestration-runtime-store';
import { ThreadOrchestrationBroker, type OrchestrationExecutionPort } from '../../packages/access-control/src/thread-orchestration-broker';
import { SessionCapabilities } from '../../packages/session-capabilities/src/index';
import { executionCliSourceToken } from '../../packages/session-capabilities/src/credentials';
import { hostExecutionCli,waitForExecutionCliBinding } from '../../packages/session-capabilities/src/execution-cli';
import { SessionCapabilityMcp } from '../../packages/session-capabilities/src/mcp';
import { encodeConversationRef } from '../../packages/appserver-protocol/src/collaboration';
import type { ThreadRelation } from '../../packages/access-control/src/orchestration-ledger';

const exec=promisify(execFile),ref=(threadId:string)=>encodeConversationRef({serverId:'server',threadId});
async function fixture(t:any) {
  const root=await mkdtemp(join(tmpdir(),'oc-thread-cli-')),actors=new ActorStore(join(root,'actors.sqlite'));
  const human=(subject:string)=>actors.resolveHuman({provider:'local',subject,displayName:subject,expiresAt:Date.now()+3_600_000})!;
  const owner=human('owner'),other=human('other'),created=new Map<string,{threadId:string}>(),receipts=new Map<string,any>();
  const native:ConversationExecutionPort={serverId:'server',hostId:'host',async validate(){},async receipt(_binding,id){return receipts.get(id)??null;},
    async add(_binding,id){const receipt=receipts.get(id)??{id,state:'delivered',targetTurnId:'child-turn'};receipts.set(id,receipt);return receipt;},
    async steer(){},async cancel(){return false;},async read(){return {entries:[{turnId:'t',role:'assistant',text:'Child result'}],nextCursor:null};}};
  const execution:OrchestrationExecutionPort={async create(id){if(!created.has(id))created.set(id,{threadId:'child-'+created.size});return created.get(id)!;},
    async snapshot(threadId){return {threadId,turnId:'child-turn',rootTurnId:'child-root',state:'completed'};}};
  let resourceAllowed=true;
  let service=new Collaboration(join(root,'collaboration.sqlite'),actors,native,Date.now,()=>true,undefined,()=>resourceAllowed);
  let runtimeStorage=new OrchestrationRuntimeWorker(join(root,'collaboration.sqlite'));await runtimeStorage.start();
  let broker=new ThreadOrchestrationBroker(service,execution,Date.now,runtimeStorage);
  service.authorizeExecution(owner,'parent','human-input');service.executionStarted('parent','human-input','human-turn');
  const session={serverId:'server',threadId:'parent',execution:{inputId:'human-input',turnId:'human-turn',executionId:'execution-one'}};
  const capabilities=new SessionCapabilities(),key=randomBytes(32);
  let mcp=new SessionCapabilityMcp(capabilities,key,undefined,{descriptorPath:join(root,'capability-endpoint.json'),retainEndpoint:true,authorizeExecution:async scope=>{await service.admittedExecution(scope.threadId,scope.execution!.inputId!);},threadCli:async(scope,request)=>{await waitForExecutionCliBinding(()=>service.admittedExecution(scope.threadId,scope.execution!.inputId!));return broker.cli(scope,request);}});
  await mcp.listen();
  let gateway:Awaited<ReturnType<typeof attachGateway>>;
  const port=hostExecutionCli({directory:join(root,'cli'),endpoint:mcp.cliEndpoint,key,launcherEndpoint:()=>new URL('/thread-cli',gateway.url).href});
  const host=await BridgeHost.open({path:join(root,'host.sqlite'),backend:localTestBackend(),
    policy:{id:'cli-fixture',capacity:{cpuMillis:4000,memoryBytes:8*1024**3}},executionCli:port});
  gateway=await attachGateway(host,key.toString('hex'));
  const leases:{revoke():Promise<void>}[]=[];
  t.after(async()=>{await Promise.all(leases.map(lease=>lease.revoke()));await gateway.close();await host.close();await mcp.close();await broker.close();await runtimeStorage.close();await service.close();actors.close();await rm(root,{recursive:true,force:true});});
  const child=(threadId:string,ownerActorId=owner.actorId,driverKind='pi'):ThreadRelation=>({threadId,ownerActorId,driverKind,serverId:'server',parentThreadId:'parent',lifecycleOwnerThreadId:'parent',forkedFromId:null,visibility:'hidden',engineHostGeneration:null,nativeSessionId:threadId,runtimeStatus:'idle',rootTurnId:null,turnId:null,delegationRevision:1,autoExchangeDepth:1,hasDirectUserInput:false,userInputExcerpt:null});
  return {root,actors,owner,other,created,session,capabilities,child,key,execution,revokeResources(){resourceAllowed=false;},get broker(){return broker;},get service(){return service;},get mcp(){return mcp;},
    async open(scope:CapabilitySession=session){
      const issued=await port.issue({serverId:scope.serverId,threadId:scope.threadId,credential:executionCliSourceToken(key,scope)});
      leases.push(issued);
      const context=JSON.parse((await exec(issued.launcher,['context','--json'])).stdout);
      return {...issued,context};
    },
    async restart(){await mcp.close();await broker.close();await runtimeStorage.close();await service.close();service=new Collaboration(join(root,'collaboration.sqlite'),actors,native,Date.now,()=>true,undefined,()=>resourceAllowed);
      runtimeStorage=new OrchestrationRuntimeWorker(join(root,'collaboration.sqlite'));await runtimeStorage.start();broker=new ThreadOrchestrationBroker(service,execution,Date.now,runtimeStorage);
      mcp=new SessionCapabilityMcp(capabilities,key,undefined,{descriptorPath:join(root,'capability-endpoint.json'),retainEndpoint:true,authorizeExecution:async scope=>{await service.admittedExecution(scope.threadId,scope.execution!.inputId!);},threadCli:async(scope,request)=>{await waitForExecutionCliBinding(()=>service.admittedExecution(scope.threadId,scope.execution!.inputId!));return broker.cli(scope,request);}});await mcp.listen();},
    async run(launcher:string,...args:string[]){return JSON.parse((await exec(launcher,['thread',...args])).stdout);}};
}

test('child discovery uses persisted Broker parentage across drivers, bounded pages and revocation without native work',async t=>{
  const f=await fixture(t);
  f.service.orchestration.createThread(f.child('private',f.other.actorId));
  f.service.orchestration.createThread(f.child('pi_child',undefined,'pi'));
  f.service.orchestration.createThread(f.child('codex_child',undefined,'codex'));
  f.service.orchestration.createThread(f.child('dsh_child',undefined,'dsh'));
  const a=await f.broker.invoke('parent','human-turn','read-one','thread_inspect',{children:true,limit:1}) as any;
  assert.deepEqual(a.children,[]);assert.ok(a.nextCursor);assert.ok(!a.nextCursor.includes('private'));
  const next=await f.broker.cli(f.session,{command:'list',arguments:{cursor:a.nextCursor,limit:2}}) as any;
  assert.deepEqual(next.children.map((c:any)=>c.driver),['pi','codex']);assert.ok(next.children.every((c:any)=>c.visibility==='hidden'));
  await f.restart();
  const last=await f.broker.cli(f.session,{command:'list',arguments:{cursor:next.nextCursor}}) as any;
  assert.deepEqual(last.children.map((c:any)=>c.threadId),['dsh_child']);assert.equal(last.nextCursor,null);
  assert.equal(f.created.size,0);
  await assert.rejects(f.broker.cli(f.session,{command:'list',arguments:{cursor:Buffer.from(JSON.stringify({parent:'other',after:0})).toString('base64url')}}),/invalid_child_cursor/);
  f.actors.setEnabled(f.owner.actorId,false,'operator');
  await assert.rejects(f.broker.cli(f.session,{command:'list'}),/revoked/);
});

test('the real executable delegates once, rediscoveries survive restart, and later executions cannot forge the original source',async t=>{
  const f=await fixture(t),opened=await f.open();
  assert.equal(opened.context.reference,ref('parent'));assert.equal((await stat(opened.launcher)).mode&0o077,0);
  assert.equal((await stat(join(opened.launcher,'../connection.json'))).mode&0o077,0);
  assert.ok(!JSON.stringify(opened).includes('Bearer'));
  const spawn=['spawn','--prompt','Implement isolated work','--idempotency-key','one'] as const;
  const first=await f.run(opened.launcher,...spawn),again=await f.run(opened.launcher,...spawn);
  assert.equal(first.threadId,again.threadId);assert.equal(f.created.size,1);
  const list=await f.run(opened.launcher,'list','--children');assert.equal(list.children[0].reference,ref(first.threadId));
  const installed=await exec(process.execPath,['--import','tsx',new URL('../../apps/opencraft-cli/src/main.ts',import.meta.url).pathname,'thread','list','--children'],{
    env:{...process.env,OPENCRAFT_THREAD_CLI_CONNECTION:opened.connectionFile}});
  assert.equal(JSON.parse(installed.stdout).children[0].reference,ref(first.threadId));
  assert.equal((await f.run(opened.launcher,'show',ref(first.threadId))).entries[0].text,'Child result');
  const tell=await f.run(opened.launcher,'tell',ref(first.threadId),'--message','Bounded follow-up','--delivery','queue','--idempotency-key','follow-up');
  assert.equal(tell.delivery,'queued');
  const waited=await f.run(opened.launcher,'wait',ref(first.threadId),'--timeout','1500');assert.equal(waited.settled,true);
  const output=await f.run(opened.launcher,'output',ref(first.threadId));assert.equal(output.history.entries[0].text,'Child result');
  await assert.rejects(f.run(opened.launcher,'spawn','--prompt','Changed','--idempotency-key','one'),
    (error:any)=>JSON.parse(error.stdout).error==='orchestration_idempotency_conflict');
  await f.restart();const reopened=await f.open();
  assert.equal((await f.run(reopened.launcher,'list','--children')).children.length,1);
  assert.equal((await f.run(reopened.launcher,...spawn)).threadId,first.threadId);assert.equal(f.created.size,1);
  const descriptor=JSON.parse(await readFile(reopened.connectionFile,'utf8'));
  const conflict=await fetch(descriptor.url,{method:'POST',headers:{authorization:'Bearer '+descriptor.token,'content-type':'application/json'},
    body:JSON.stringify({command:'spawn',arguments:{prompt:'Changed again'},idempotencyKey:'one'})});
  assert.equal(conflict.status,409);assert.equal((await conflict.json() as any).error,'orchestration_idempotency_conflict');assert.equal(f.created.size,1);
  const before=f.created.size;
  await assert.rejects(f.broker.cli({...f.session,execution:{inputId:'forged'}},{command:'spawn',arguments:{prompt:'bad'},idempotencyKey:'bad'}),/delegation_required/);
  assert.equal(f.created.size,before);
  f.actors.setEnabled(f.owner.actorId,false,'operator');await assert.rejects(f.run(reopened.launcher,'list','--children'));
});

test('CLI HTTP denies ambient session tokens, cross-origin requests and source fields; missing write keys never execute',async t=>{
  const f=await fixture(t),opened=await f.open(),config=JSON.parse(await readFile(join(opened.launcher,'../connection.json'),'utf8'));
  const send=(token:string,body:unknown,extra={})=>fetch(config.url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...extra},body:JSON.stringify(body)});
  assert.equal((await send(f.mcp.token({serverId:'server',threadId:'parent'}),{command:'context'})).status,403);
  assert.equal((await send(config.token,{command:'context'},{origin:'https://foreign.example'})).status,403);
  assert.equal((await send(config.token,{command:'spawn',arguments:{prompt:'bad'},threadId:'other'})).status,400);
  assert.equal((await send(config.token,{command:'spawn',arguments:{prompt:'bad'}})).status,400);
  assert.equal((await send(f.mcp.token({...f.session,serverId:'wrong'}),{command:'context'})).status,403);
  assert.equal(f.created.size,0);
  await assert.rejects(f.run(opened.launcher,'list','--children','--cursor','x','--cursor','y'));
  assert.equal(f.created.size,0);
});


test('Host issuance needs an admitted execution and leaves other MCP tools available',async t=>{
  const f=await fixture(t);
  f.capabilities.register({id:'im-fixture',tools:()=>[{name:'im_reply',description:'Reply',inputSchema:{type:'object'}}],async call(){return {sent:true};}});
  assert.deepEqual(f.capabilities.tools(f.session).map(tool=>tool.name),['im_reply']);
  assert.deepEqual((await f.capabilities.call(f.session,'im_reply',{},new AbortController().signal)).success,true);
  await assert.rejects(f.open({...f.session,execution:{inputId:'unadmitted',executionId:'other'}}));
  const opened=await f.open();
  const context=await exec(opened.launcher,['context','--json']);assert.equal(JSON.parse(context.stdout).reference,ref('parent'));
  const created=await f.run(opened.launcher,'spawn','--prompt','bounded work','--idempotency-key','status-one');
  assert.equal((await f.run(opened.launcher,'operation','show',created.operationId)).operationId,created.operationId);
  const inputStatus=await f.run(opened.launcher,'input','status',created.operationId);assert.equal(inputStatus.contextEvidence,null);assert.equal(inputStatus.delivery,'sent');
  const output=await f.run(opened.launcher,'output',ref(created.threadId));assert.equal(output.history.entries[0].text,'Child result');
  await assert.rejects(f.run(opened.launcher,'operation','show','foreign-operation'));
  await assert.rejects(f.run(opened.launcher,'tell',ref(created.threadId),'--message','test','--delivery','interrupt','--idempotency-key','unsupported'));
  for(const command of [['context'],['thread','spawn'],['thread','tell'],['thread','wait'],['thread','output'],['thread','operation','show'],['thread','input','status']]) {
    assert.match((await exec(opened.launcher,[...command,'--help'])).stdout,/opencraft/u);
  }
  await opened.revoke();await assert.rejects(exec(opened.launcher,['context']));
});

test('signed Server admission is required by the Host port and is rechecked after revocation',async t=>{
  const f=await fixture(t),issued=await f.open();
  const descriptor=JSON.parse(await readFile(issued.connectionFile,'utf8'));
  // The Host receives the shared signing authority through private composition.
  const key=f.key;
  const port=hostExecutionCli({directory:join(f.root,'host-cli'),endpoint:f.mcp.cliEndpoint,key,launcherEndpoint:()=>descriptor.url});
  const source={serverId:'server',threadId:'parent',credential:executionCliSourceToken(key,f.session)};
  const hostLease=await port.issue(source);assert.ok(hostLease.environment.OPENCRAFT_THREAD_CLI);
  const hostDescriptor=JSON.parse(await readFile(hostLease.connectionFile,'utf8'));
  assert.notEqual(hostDescriptor.token,source.credential);
  const forgedDirect=await fetch(f.mcp.cliEndpoint,{method:'POST',headers:{authorization:'Bearer '+hostDescriptor.token,'content-type':'application/json'},body:'{"command":"context"}'});
  assert.equal(forgedDirect.status,401);
  assert.equal((await port.forward(hostDescriptor.token,{command:'context'})).status,200);
  await hostLease.revoke();await assert.rejects(port.forward(hostDescriptor.token,{command:'context'}));
  await assert.rejects(port.issue({...source,credential:source.credential+'forged'}));
  await assert.rejects(port.issue({...source,threadId:'foreign'}));
  f.actors.setEnabled(f.owner.actorId,false,'operator');
  await assert.rejects(port.issue(source));
  await assert.rejects(f.open(f.session));
});

test('Host forwarding loss after a write remains unknown and never retries',async t=>{
  const f=await fixture(t),{createServer}=await import('node:http');let writes=0;
  const server=createServer((request,response)=>{
    if(request.url==='/execution-admission'){response.writeHead(200).end('{}');return;}
    writes++;request.socket.destroy();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}/thread-cli`;
  const port=hostExecutionCli({directory:join(f.root,'proxy'),endpoint,key:f.key,launcherEndpoint:()=>endpoint});
  const lease=await port.issue({serverId:'server',threadId:'parent',credential:executionCliSourceToken(f.key,f.session)});
  const descriptor=JSON.parse(await readFile(lease.connectionFile,'utf8'));
  const result=await port.forward(descriptor.token,{command:'spawn',arguments:{prompt:'bounded'},idempotencyKey:'one'});
  assert.deepEqual(result,{status:503,body:{error:'thread_cli_outcome_unknown'}});assert.equal(writes,1);
  await lease.revoke();
});

test('real Host launcher waits for Server Turn binding and rejects a revoked pending scope',async t=>{
  const f=await fixture(t);
  f.service.authorizeExecution(f.owner,'pending','input');
  const scope={serverId:'server',threadId:'pending',execution:{inputId:'input',executionId:'pending-execution'}};
  const opened=f.open(scope);
  const timer=setTimeout(()=>f.service.executionStarted('pending','input','native-turn'),50);
  t.after(()=>clearTimeout(timer));
  assert.equal((await opened).context.reference,ref('pending'));
  let checks=0;
  await assert.rejects(waitForExecutionCliBinding(async()=>{checks++;return {turnId:null};},0),/cliUnavailable/);
  assert.equal(checks,1);
  f.actors.setEnabled(f.owner.actorId,false,'operator');
  await assert.rejects(f.open(scope));
});

test('concurrent CLI retries with reordered parameters share one immutable operation',async t=>{
  const f=await fixture(t),opened=await f.open();
  let release!:()=>void,secondEntered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const receivedBoth=new Promise<void>(resolve=>{secondEntered=resolve;});
  t.after(()=>release());
  const create=f.execution.create;f.execution.create=async(...args)=>{await gate;return create(...args);};
  const cli=f.broker.cli.bind(f.broker);let calls=0;
  f.broker.cli=async(...args)=>{const result=cli(...args);if(++calls===2)secondEntered();return result;};
  const descriptor=JSON.parse(await readFile(opened.connectionFile,'utf8'));
  const send=(args:Record<string,string>)=>fetch(descriptor.url,{method:'POST',headers:{authorization:'Bearer '+descriptor.token,'content-type':'application/json'},
    body:JSON.stringify({command:'spawn',arguments:args,idempotencyKey:'concurrent'})});
  const first=send({prompt:'bounded',title:'same'}),second=send({title:'same',prompt:'bounded'});
  await receivedBoth;release();
  const replies=await Promise.all([first,second]);assert.ok(replies.every(reply=>reply.status===200));
  const [a,b]=await Promise.all(replies.map(reply=>reply.json())) as any[];
  assert.equal(a.result.operationId,b.result.operationId);assert.equal(f.created.size,1);
});

test('MCP credentials keep their tools and cannot bypass the Host CLI audience',async t=>{
  const f=await fixture(t);
  f.capabilities.register({id:'mcp-audience',tools:()=>[{name:'im_reply',description:'Reply',inputSchema:{type:'object'}}],async call(){return {sent:true};}});
  const configuration=f.mcp.config(f.session) as {url:string;http_headers:Record<string,string>};
  const client=new Client({name:'mcp-regression',version:'1'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(configuration.url),{requestInit:{headers:configuration.http_headers}}));
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['im_reply']);
  assert.equal((await client.callTool({name:'im_reply',arguments:{}})).isError,false);
  const wrongAudience=await fetch(f.mcp.cliEndpoint,{method:'POST',headers:{...configuration.http_headers,'content-type':'application/json'},body:'{"command":"context"}'});
  assert.equal(wrongAudience.status,401);
  const cliSource=executionCliSourceToken(f.key,f.session);
  const wrongMcp=await fetch(configuration.url,{method:'POST',headers:{authorization:'Bearer '+cliSource,'content-type':'application/json'},body:'{}'});
  assert.equal(wrongMcp.status,401);
  const opened=await f.open();assert.equal(opened.context.reference,ref('parent'));
  await opened.revoke();assert.equal((await client.callTool({name:'im_reply',arguments:{}})).isError,false);
});

test('Host issuance rechecks resource grants for an otherwise current Actor',async t=>{
  const f=await fixture(t),opened=await f.open();f.revokeResources();
  assert.equal(f.actors.isCurrent(f.owner),true);
  await assert.rejects(f.open());
  await assert.rejects(f.run(opened.launcher,'context'));
  assert.equal(f.created.size,0);
});
