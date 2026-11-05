import { ThreadNoteStore } from "../../plugins/thread-summary/src/note-store";
import * as Y from "yjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket,WebSocketServer } from 'ws';
import { AppHostServer } from '../../packages/app-host-server/src/index';
import { ActorStore } from '../../packages/access-control/src/actors';
import { ActorAccess } from '../../packages/access-control/src/actor-access';
import { ThreadAccessStore,ThreadAccessSession } from '../../packages/access-control/src/thread-access';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';

test('real AppHost and direct AppServer sockets enforce the same creator, directory and revocation policy', {timeout:20000}, async t => {
  const root=await mkdtemp(join(tmpdir(),'thread-access-gateway-'));
  await writeFile(join(root,'index.html'),'<!doctype html><title>Fixture</title>');
  const actors=new ActorStore(join(root,'actors.sqlite')),store=new ThreadAccessStore(join(root,'policy.sqlite'),actors);
  const access=new ActorAccess(actors,{authenticateHuman:request=>({provider:'fixture',subject:String(request.headers['x-fixture-user']??'anonymous'),displayName:'Fixture',expiresAt:Date.now()+60000}),admitted:()=>true,administrator:()=>false});
  const threads=new Map<string,any>(),calls:string[]=[],nativeListeners=new Set<(frame:string)=>void>();
  let created=0;
  const respond=(packet:any)=>{
    calls.push(packet.method);
    if(packet.method==='initialize')return {capabilities:{extensions:{'opencraft/method-access':{version:1,methods:['thread/read','thread/list']}}}};
    if(packet.method==='thread/start'){const thread={id:`thread-${++created}`,name:'SECRET TITLE',turns:[]};threads.set(thread.id,thread);return {thread};}
    if(packet.method==='thread/list')return {data:[...threads.values()],nextCursor:null};
    if(packet.method==='thread/read')return {thread:threads.get(packet.params.threadId)};
    return {};
  };
  const notes = new ThreadNoteStore(join(root,'notes.sqlite'));
  const session=(_host:string,context:any,emit:(frame:string)=>void)=>new ThreadAccessSession(store,()=> 'server',context.actorContext,emit,undefined,()=>{},notes);
  const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createRpcAccessSession:session,createTransport:()=>({
    status:{state:'open' as const},connect:async()=>{},subscribeStatus:()=>()=>{},close:async()=>{},
    subscribeMessage(listener){nativeListeners.add(listener);return()=>nativeListeners.delete(listener);},
    async send(frame){const packet=JSON.parse(frame);if(packet.id!==undefined)for(const listener of nativeListeners)listener(JSON.stringify({id:packet.id,__opencraftClient:packet.__opencraftClient,result:respond(packet)}));},
  })});
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await once(upstream,'listening');
  upstream.on('connection',socket=>socket.on('message',raw=>{const packet=JSON.parse(String(raw));socket.send(JSON.stringify({id:packet.id,result:respond(packet)}));}));
  const gateway=await createWorkbenchWebServer({root,loopbackOnly:true,actorService:access,appHostServer:host,
    appServerTarget:`ws://127.0.0.1:${(upstream.address() as any).port}/rpc`,createAppServerAccessSession:(context:any,emit:any)=>session('local',context,emit),onAppHostDiagnostic:()=>{}});
  const address=await gateway.listen({host:'127.0.0.1',port:0}),origin=`http://127.0.0.1:${address.port}`;
  const sockets:WebSocket[]=[];let sequence=0;
  t.after(async()=>{for(const socket of sockets)socket.terminate();await gateway.close();await host.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));notes.close();store.close();actors.close();await rm(root,{recursive:true,force:true});});
  async function page(user:string,direct=false){
    const socket=new WebSocket(`${origin.replace('http:','ws:')}/${direct?'appserver':'apphost'}`,{origin,headers:{'x-fixture-user':user}});sockets.push(socket);
    const frames:any[]=[];socket.on('message',raw=>frames.push(JSON.parse(String(raw))));await once(socket,'open');
    const wait=async(predicate:(frame:any)=>boolean)=>{const until=Date.now()+5000;while(Date.now()<until){const found=frames.find(predicate);if(found)return found;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Gateway response timed out');};
    let generation=0;
    if(!direct){socket.send(JSON.stringify({type:'hello',protocolVersion:2,rendererId:user}));await wait(row=>row.type==='ready');socket.send(JSON.stringify({type:'host/connect',requestId:'connect',hostId:'local-codex',leaseId:'lease'}));generation=(await wait(row=>row.type==='response'&&row.requestId==='connect')).result.generation;}
    const rpc=async(method:string,params:any={},extra:any={})=>{
      const id=++sequence,frame=JSON.stringify({id,method,params,...extra});
      socket.send(direct?frame:JSON.stringify({type:'host/send',requestId:`send-${id}`,hostId:'local-codex',leaseId:'lease',generation,frame}));
      const result=await wait(row=>direct?row.id===id:row.type==='host/frame'&&JSON.parse(row.frame).id===id);
      return direct?result:JSON.parse(result.frame);
    };
    await rpc('initialize',{});return {rpc,frames};
  }
  const alice=await page('alice'),bob=await page('bob'),bobDirect=await page('bob',true);
  const threadId=(await alice.rpc('thread/start')).result.thread.id;
  assert.equal((await bob.rpc('thread/list')).result.data[0].name,'SECRET TITLE');
  assert.equal((await bobDirect.rpc('thread/read',{threadId})).result.thread.name,'SECRET TITLE');
  const note = new Y.Doc(); note.getText('markdown').insert(0,'# Shared decision');
  const noteParams = {threadId,update:Buffer.from(Y.encodeStateAsUpdate(note)).toString('base64'),vector:'AA=='};
  assert.equal(typeof (await alice.rpc('opencraft/thread-note/exchange',noteParams)).result.update,'string');
  const read = await bobDirect.rpc('opencraft/thread-note/exchange',{threadId,update:'',vector:'AA=='});
  const replica = new Y.Doc(); Y.applyUpdate(replica,Buffer.from(read.result.update,'base64'));
  assert.equal(replica.getText('markdown').toString(),'# Shared decision'); note.destroy(); replica.destroy();
  assert.equal((await bob.rpc('opencraft/thread-access/read',{threadId})).result.canChangeAccess,false);
  assert.equal((await bob.rpc('opencraft/thread-access/set',{threadId,accessMode:'private',expectedRevision:1})).error.code,-32004);
  assert.equal((await alice.rpc('opencraft/thread-access/set',{threadId,accessMode:'private',expectedRevision:1})).result.accessMode,'private');
  assert.equal((await bob.rpc('opencraft/thread-note/exchange',{threadId,update:'',vector:'AA=='})).error.code,-32004);
  assert.equal((await bobDirect.rpc('opencraft/thread-note/exchange',{threadId,update:'',vector:'AA=='})).error.code,-32004);
  assert.deepEqual((await bob.rpc('thread/list')).result.data,[]);
  assert.deepEqual((await bob.rpc('thread/list',{}, {__opencraftClient:'forged'})).result.data,[]);
  assert.deepEqual((await bobDirect.rpc('thread/list')).result.data,[]);
  const before=calls.filter(method=>method==='thread/read').length;
  assert.equal((await bob.rpc('thread/read',{threadId})).error.code,-32004);
  assert.equal((await bobDirect.rpc('thread/read',{threadId})).error.code,-32004);
  assert.equal(calls.filter(method=>method==='thread/read').length,before,'denied requests never reach native');
  assert.equal(bob.frames.some(row=>row.type==='host/frame'&&JSON.parse(row.frame).method==='opencraft/thread-access/revoked'),true);
  assert.equal(bobDirect.frames.some(row=>row.method==='opencraft/thread-access/revoked'),true);
  assert.equal((await alice.rpc('thread/read',{threadId})).result.thread.name,'SECRET TITLE');
  await alice.rpc('opencraft/thread-access/set',{threadId,accessMode:'shared',expectedRevision:2});
  assert.equal((await bobDirect.rpc('thread/read',{threadId})).result.thread.id,threadId);
});
