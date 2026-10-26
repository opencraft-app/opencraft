import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {WebSocketServer} from 'ws';
import {startHeadlessServer} from '../../scripts/headless-server.mjs';
import {createWorkbenchWebServer} from '../../scripts/serve-workbench-web.mjs';
import {callConversationHost} from '../../scripts/conversation-execution.mjs';
import {LOGICAL_CLIENT_FIELD} from '../../packages/app-host-protocol/src/index.js';
import {ExecutionLeaseReader} from '../../apps/opencraft-daemon/src/execution-lease-store.js';

test('real Headless assembly retains original lease through Gateway restart, steer and autonomous successors', async t=>{
  const root=await mkdtemp(join(tmpdir(),'oc-headless-execution-')),webRoot=join(root,'web'),dataDirectory=join(root,'data');
  await mkdir(webRoot);await writeFile(join(webRoot,'index.html'),'<html>fixture</html>');
  await writeFile(join(webRoot,'version.json'),JSON.stringify({schemaVersion:1,buildId:'ownership',headlessServer:true,headlessHostId:'opencraft-server'}));
  const native=new WebSocketServer({host:'127.0.0.1',port:0});await once(native,'listening');
  const turns=[];let sequence=0,app,host,owner;
  const send=(socket,message)=>socket.send(JSON.stringify(message));
  native.on('connection',socket=>socket.on('message',data=>{
    const message=JSON.parse(String(data)),params=message.params??{};let result={};
    if(message.method==='initialize')result={capabilities:{}};
    else if(message.method==='thread/read')result={thread:{id:params.threadId,turns}};
    else if(message.method==='turn/start'){
      const turn={id:`turn-${++sequence}`,status:'inProgress',items:[{type:'userMessage',clientId:params.clientUserMessageId,content:[]}]};turns.push(turn);
      send(socket,{method:'turn/started',params:{threadId:params.threadId,turn}});result={turn};
    } else if(message.method==='turn/steer')result={turnId:turns.at(-1).id};
    if(message.id!==undefined)send(socket,{id:message.id,result,...(message[LOGICAL_CLIENT_FIELD]?{[LOGICAL_CLIENT_FIELD]:message[LOGICAL_CLIENT_FIELD]}:{})});
  }));
  const start=async()=>{
    app=await startHeadlessServer({root,webRoot,dataDirectory,port:0,
      startAgentHost:async()=>({websocketUrl:`ws://127.0.0.1:${native.address().port}/rpc`,getIdentity:async()=>({enginePid:process.pid}),async close(){}}),
      createWebServer:async options=>{host=options.appHostServer;return createWorkbenchWebServer(options);}});
    owner=new DatabaseSync(join(dataDirectory,'thread-identities/opencraft-server/thread-identity.sqlite'),{readOnly:true});
  };
  t.after(async()=>{owner?.close();await app?.close();for(const socket of native.clients)socket.terminate();await new Promise(resolve=>native.close(resolve));await rm(root,{recursive:true,force:true});});
  const submit=(id,method,context)=>callConversationHost(host,{hostId:'opencraft-server',threadId:'thread'},id,method,{clientUserMessageId:id,input:[]},context,5000);
  const context=subject=>({sender:{kind:'employee',loginName:subject},executionPrincipal:{provider:'fixture',subject},validUntil:Date.now()+60000});
  const row=()=>owner.prepare('SELECT * FROM execution_leases WHERE turn_id=?').get(turns.at(-1).id);
  const wait=async check=>{const until=Date.now()+3000;while(!check()){if(Date.now()>until)throw new Error('ownership receipt timeout');await new Promise(resolve=>setTimeout(resolve,10));}};
  await start();await submit('A','turn/start',context('A'));await wait(()=>row()?.state==='active');
  const original=row(),before=new ExecutionLeaseReader(owner).resolve({threadId:'thread',executionId:original.execution_id});
  assert.equal(before.status,'active');assert.equal(before.lease.principal.subject,'A');assert.ok(before.lease.engineIncarnation);
  owner.close();owner=undefined;await app.close();app=undefined;
  await start();
  const restored=new ExecutionLeaseReader(owner).resolve({threadId:'thread',executionId:original.execution_id});
  assert.equal(restored.status,'active');assert.deepEqual(restored.lease,before.lease);
  await submit('B','turn/steer',context('B'));
  assert.equal(new ExecutionLeaseReader(owner).resolve({threadId:'thread',executionId:original.execution_id}).lease.principal.subject,'A');
  turns.at(-1).status='completed';
  for(const inputId of ['schedule:unowned','goal:unowned']){
    await submit(inputId,'turn/start',{sender:null});await wait(()=>row()?.state==='active');
    const current=new ExecutionLeaseReader(owner).resolve({threadId:'thread',executionId:row().execution_id});
    assert.equal(current.status,'unowned');assert.equal(current.lease.principal,null);turns.at(-1).status='completed';
  }
  assert.equal(new ExecutionLeaseReader(owner).resolve({threadId:'thread',executionId:original.execution_id}).status,'expired');
});
