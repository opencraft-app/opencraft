import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionCapabilities } from '../../packages/session-capabilities/src/index.js';
import { SessionCapabilityMcp, capabilitySigningKey } from '../../packages/session-capabilities/src/mcp.js';
import { RemoteSessionCapabilities } from '../../packages/session-capabilities/src/remote.js';
import { DshCapabilityBroker } from '../../apps/local-agent-host/src/dsh-capability-broker.js';
import { DshExecutionAuthority } from '../../apps/local-agent-host/src/dsh-execution-authority.js';
import { DshAppServerAdapter } from '../../apps/local-agent-host/src/dsh-appserver-adapter.js';
import { dshHostInputs } from '../../apps/local-agent-host/src/dsh-host-inputs.js';
import { handleHostInput } from '../../apps/local-agent-host/src/host-input-http.js';
import { attachDshHost } from '../../scripts/server-deployment/dsh-host-client.mjs';

const hostOwner={connectionId:'host-input',identity:{id:'host-input',username:'Host input'}};
const browser={connectionId:'browser',identity:{id:'human',username:'Human'}};
const signal=()=>new AbortController().signal;

test('independent DSH consumes signed session tools, preserves browser owner and reconnects to successor MCP',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dsh-host-input-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const capabilities=new SessionCapabilities();let allowed=true,calls=0;
 const tool={name:'im_reply',description:'Reply',inputSchema:{type:'object',properties:{}}};
 capabilities.register({id:'im.reply',tools:session=>allowed&&session.serverId==='server:fixture:dsh'&&session.threadId==='same'?[tool]:[],async call(){calls++;return {delivered:true};}});
 const key=capabilitySigningKey(join(directory,'session-capabilities.key'));
 const options={descriptorPath:join(directory,'session-capabilities.json'),authorizeInput:(session:any,id:string)=>allowed&&session.serverId==='server:fixture:dsh'&&session.threadId==='same'&&id==='actor-input:one'};
 let mcp=new SessionCapabilityMcp(capabilities,key,undefined,options);await mcp.listen();t.after(()=>mcp.close());
 const remote=new RemoteSessionCapabilities(directory,'server:fixture:dsh');await remote.refresh('same');assert.equal(remote.tools('same')[0]?.name,'im_reply');
 const broker=new DshCapabilityBroker(undefined,remote);t.after(()=>broker.close());broker.allowHostExecution(hostOwner);
 let request:any;broker.register('same',browser,[{type:'function',name:'browser_probe',description:'Probe',inputSchema:{type:'object'}}],frame=>{request=frame;});
 assert.deepEqual(broker.list('same').map(tool=>tool.name),['im_reply','browser_probe']);
 const pending=broker.invoke('same','turn','browser_probe',{},signal(),hostOwner);
 assert.equal(broker.respond(hostOwner,request.id,{}),false);broker.respond(browser,request.id,{success:true});assert.deepEqual(await pending,{success:true});
 await assert.rejects(broker.invoke('same','turn','browser_probe',{},signal(),{...hostOwner}),/owner/);
 broker.disconnect(browser);assert.equal((await broker.invoke('same','turn','im_reply',{},signal(),hostOwner) as any).success,true);assert.equal(calls,1);
 const foreign=new RemoteSessionCapabilities(directory,'server:fixture:pi');await foreign.refresh('same');assert.deepEqual(foreign.tools('same'),[]);
 assert.equal(await foreign.authorizeInput('same','actor-input:one'),false);assert.equal(await remote.authorizeInput('same','actor-input:one'),true);
 allowed=false;assert.equal(await remote.authorizeInput('same','actor-input:one'),false);assert.equal((await remote.call('same','im_reply',{},signal())).success,false);assert.equal(calls,1);
 await mcp.close();await remote.refresh('same');assert.deepEqual(remote.tools('same'),[]);assert.equal(await remote.authorizeInput('same','actor-input:one'),false);
 allowed=true;mcp=new SessionCapabilityMcp(capabilities,key,undefined,options);await mcp.listen();await remote.refresh('same');
 assert.equal((await remote.call('same','im_reply',{},signal())).success,true);assert.equal(calls,2);
});

test('private DSH Host input uses real native admission and journal; revocation at final async boundary prevents native effect',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dsh-input-http-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const authority=new DshExecutionAuthority(join(directory,'execution.sqlite'));t.after(()=>authority.close());
 let adapter!:DshAppServerAdapter,seq=0,sent=0,authorized=true,slow:Promise<void>|undefined;
 const feed=(type:string,data:any)=>(adapter as any).onMuxFrame({type:'session/event',sessionId:'same',event:{type,data,seq:++seq,time:Date.now()}});
 const client:any={async call(method:string,_params:any,_signal:any,rpcId:string){
   if(method==='session.models'){await slow;return {};}
   if(method==='session.prompt'){sent++;queueMicrotask(()=>{feed('turn/start',{turn:sent});feed('user/message',{source:{kind:'user',rpcId},content:[{type:'text',text:'input'}]});});}
   return {};
 }};
 adapter=new DshAppServerAdapter(client,undefined,authority);t.after(()=>adapter.close());
 const native=adapter.dispatchOwned.bind(adapter);
 const facade:any={dispatch:async(method:string)=>method==='thread/goal/get'?{goal:null}:{thread:{id:'same',status:{type:'idle'}}},dispatchOwned:native};
 const lifecycle:any={enqueue:(_id:string,run:()=>any)=>run(),assertOpen(){},acceptedTurn(){},catalog:{get(){return {};},isArchived(){return false;}}};
 const inputs=dshHostInputs(facade,authority,lifecycle,async()=>{},hostOwner);
 const server=createServer((request,response)=>{
   if(request.url==='/health'){response.end(JSON.stringify({ok:true,engine:'dsh',pid:process.pid,enginePid:process.pid,hostInputs:1,storage:[]}));return;}
   void handleHostInput(request,response,'fixture-private-token',inputs,()=>authorized);
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const url=`http://127.0.0.1:${(server.address() as any).port}`;
 const descriptor=join(directory,'connection.json');await writeFile(descriptor,JSON.stringify({schemaVersion:1,pid:process.pid,machineId:'fixture',dataDirectory:directory,websocketUrl:url.replace('http:','ws:')+'/rpc?token=fixture-private-token'}),{mode:0o600});
 const attached=await attachDshHost(descriptor,directory,'fixture');
 assert.equal((await fetch(url+'/host-inputs',{method:'POST',body:'{}'})).status,403);
 assert.equal((await fetch(url+'/host-inputs',{method:'POST',headers:{Authorization:'Bearer fixture-private-token',Origin:'https://untrusted.example'},body:'{}'})).status,403);
 const receipt=await attached.inputs.submit('same','actor-input:one','hello',()=>true);assert.equal(receipt.state,'delivered');assert.equal(sent,1);
 assert.deepEqual(await attached.inputs.submit('same','actor-input:one','duplicate',()=>true),receipt);assert.equal(sent,1);
 feed('turn/end',{turn:1,reason:{kind:'completed'}});
 let release!:()=>void;slow=new Promise<void>(resolve=>{release=resolve;});
 const pending=attached.inputs.submit('same','actor-input:revoked','must not run',()=>true);
 // Wait for the actual adapter to cross native model preparation with a claimed journal.
 for(let n=0;n<100&&!authority.scheduleInput('same','actor-input:revoked');n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.ok(authority.scheduleInput('same','actor-input:revoked'));authorized=false;release();
 assert.equal((await pending).state,'unknown');assert.equal(sent,1);
 assert.equal((await attached.inputs.receipt('same','actor-input:revoked')).state,'unknown');
 authorized=true;await attached.inputs.submit('same','actor-input:revoked','never replay',()=>true);assert.equal(sent,1);
});

test('fenced HTTP input is rejected before a consumer lease is created',async t=>{
 let leases=0,submissions=0,open=false;
 const receipts={run:async(run:()=>Promise<void>)=>{if(!open)throw Error('fenced');return run();},beginReceipt:()=>{leases++;return()=>({id:'one',receipt:'exact'});},acknowledgeReceipt:()=>{}};
 const inputs:any={receipt:async()=>null,submit:async()=>{submissions++;return null;}};
 const server=createServer((request,response)=>void handleHostInput(request,response,'fixture',inputs,()=>true,receipts));
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())));
 const submit=()=>fetch(`http://127.0.0.1:${(server.address() as any).port}/host-inputs`,{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify({action:'submit',threadId:'thread',inputId:'actor-input:one',text:'fixture'})});
 assert.equal((await submit()).status,503);assert.equal(leases,0);assert.equal(submissions,0);
 open=true;assert.equal((await submit()).status,200);assert.equal(leases,1);assert.equal(submissions,1);
});
