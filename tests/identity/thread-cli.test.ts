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
import { ActorStore } from '../../packages/access-control/src/actors';
import { Collaboration, type ConversationExecutionPort } from '../../packages/access-control/src/collaboration';
import { ThreadOrchestrationBroker, type OrchestrationExecutionPort } from '../../packages/access-control/src/thread-orchestration-broker';
import { SessionCapabilities } from '../../packages/session-capabilities/src/index';
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
  let service=new Collaboration(join(root,'collaboration.sqlite'),actors,native),broker=new ThreadOrchestrationBroker(service,execution);
  service.authorizeExecution(owner,'parent','human-input');service.executionStarted('parent','human-input','human-turn');
  const session={serverId:'server',threadId:'parent',execution:{inputId:'human-input',turnId:'human-turn',executionId:'execution-one'}};
  const capabilities=new SessionCapabilities(),key=randomBytes(32);
  let mcp=new SessionCapabilityMcp(capabilities,key,undefined,{cliDirectory:join(root,'cli'),threadCli:(scope,request)=>broker.cli(scope,request)});
  await mcp.listen();
  t.after(async()=>{await mcp.close();await broker.close();await service.close();actors.close();await rm(root,{recursive:true,force:true});});
  const child=(threadId:string,ownerActorId=owner.actorId,driverKind='pi'):ThreadRelation=>({threadId,ownerActorId,driverKind,serverId:'server',parentThreadId:'parent',lifecycleOwnerThreadId:'parent',forkedFromId:null,visibility:'hidden',engineHostGeneration:null,nativeSessionId:threadId,runtimeStatus:'idle',rootTurnId:null,turnId:null,delegationRevision:1,autoExchangeDepth:1,hasDirectUserInput:false,userInputExcerpt:null});
  return {root,actors,owner,other,created,session,capabilities,child,get broker(){return broker;},get service(){return service;},get mcp(){return mcp;},
    async open(){
      const config=mcp.config(session) as {url:string;http_headers:Record<string,string>},client=new Client({name:'cli-agent',version:'1'});
      try{await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.http_headers}}));
        assert.ok((await client.listTools()).tools.some(tool=>tool.name==='thread_cli'));
        const reply=await client.callTool({name:'thread_cli',arguments:{}});assert.equal(reply.isError,false);
        return JSON.parse((reply.content as {text:string}[])[0]!.text);
      }finally{await client.close();}
    },
    async restart(){await mcp.close();await broker.close();await service.close();service=new Collaboration(join(root,'collaboration.sqlite'),actors,native);broker=new ThreadOrchestrationBroker(service,execution);
      mcp=new SessionCapabilityMcp(capabilities,key,undefined,{cliDirectory:join(root,'cli'),threadCli:(scope,request)=>broker.cli(scope,request)});await mcp.listen();},
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
  await assert.rejects(f.run(opened.launcher,'spawn','--prompt','Changed','--idempotency-key','one'));
  await f.restart();const reopened=await f.open();
  assert.equal((await f.run(reopened.launcher,'list','--children')).children.length,1);
  assert.equal((await f.run(reopened.launcher,...spawn)).threadId,first.threadId);assert.equal(f.created.size,1);
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

test('real Native MCP discovers the CLI provider without new Core tools or a model request', {
  skip:!process.env.OPENCRAFT_CODEX_EXECUTABLE,timeout:30_000,
},async t=>{
  const f=await fixture(t),{spawn}=await import('node:child_process'),{createInterface}=await import('node:readline');
  const home=join(f.root,'native'),{mkdir}=await import('node:fs/promises');await mkdir(home);
  const reservation=f.mcp.prepareExecution(),child=spawn(process.env.OPENCRAFT_CODEX_EXECUTABLE!,['app-server','--listen','stdio://'],{
    env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  t.after(async()=>{child.kill();await exited;});
  const pending=new Map<number,{resolve(value:any):void;reject(error:Error):void}>();let sequence=0;
  createInterface({input:child.stdout}).on('line',line=>{const reply=JSON.parse(line),p=pending.get(reply.id);if(!p)return;pending.delete(reply.id);reply.error?p.reject(Error('Native request rejected')):p.resolve(reply.result);});
  child.on('exit',()=>{for(const p of pending.values())p.reject(Error('Native exited'));pending.clear();});
  const request=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  await request('initialize',{clientInfo:{name:'thread-cli-native-fixture',version:'1'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  const {thread}=await request('thread/start',{cwd:home,sandbox:'read-only',approvalPolicy:'never',config:{'mcp_servers.opencraft_session':reservation.configuration}});
  f.service.authorizeExecution(f.owner,thread.id,'native-input');f.service.executionStarted(thread.id,'native-input','admitted-turn');
  reservation.bind({serverId:'server',threadId:thread.id,execution:{inputId:'native-input',executionId:'native-execution'}});
  const reply=await request('mcpServer/tool/call',{threadId:thread.id,server:'opencraft_session',tool:'thread_cli',arguments:{}});
  assert.equal(reply.isError,false);
  const opened=JSON.parse(reply.content[0].text);assert.equal(opened.context.reference,ref(thread.id));
  assert.deepEqual((await f.run(opened.launcher,'list','--children')).children,[]);
  assert.equal(f.created.size,0);
});
