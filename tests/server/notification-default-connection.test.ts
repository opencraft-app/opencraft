import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {TurnPushService,type PushBinding} from '@opencraft/web-push-node';
import {PushStore} from '@opencraft/web-push-node/store';
import {createWorkbenchWebServer} from '../../apps/headless-server/src/serve-workbench-web.mjs';

test('a real admitted AppServer connection enrolls defaults independently of the renderer and without delaying the wire',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'notification-connection-')),store=new PushStore(join(dir,'push.sqlite'));
 const binding:PushBinding={context:{actorId:'fixture-human',generation:1,credentialId:null,expiresAt:Date.now()+60000}},target={kind:'im' as const,channelId:'fixture.connection',senderId:'self',label:'Self',methodId:'product.method'};
 let release!:()=>void,lookup=0;const gate=new Promise<void>(r=>release=r);
 const service=new TurnPushService(store,{authenticate:()=>binding,current:()=>true,trustedOrigin:()=>null,hosts:[],read:async()=>({}),
  imTargets:async()=>{lookup++;await gate;return [target];},defaultTarget:()=>({policyId:'product.default',target}),sendIm:async()=>{throw Error('No notification should be sent during enrollment');}});
 const backend=new WebSocketServer({host:'127.0.0.1',port:0});await once(backend,'listening');backend.on('connection',socket=>socket.send('backend ready'));
 const actorService={isSessionRequest:()=>false,legacyAdmissionStatus:()=>204,authenticate:()=>binding.context,usageAuthority:()=>null,watch:()=>()=>{}};
 const web=await createWorkbenchWebServer({root:dir,appServerTarget:`ws://127.0.0.1:${(backend.address() as any).port}/rpc`,loopbackOnly:true,actorService,turnPushService:service});
 const address=await web.listen({host:'127.0.0.1',port:0}),origin=`http://127.0.0.1:${address.port}`;
 let client:WebSocket|undefined,bad:WebSocket|undefined;
 try{
  bad=new WebSocket(origin.replace('http:','ws:')+'/appserver',{origin:'https://evil.invalid'});await assert.rejects(once(bad,'open'));assert.equal(lookup,0,'cross-origin sockets cannot enroll');
  client=new WebSocket(origin.replace('http:','ws:')+'/appserver',{origin});const [message]=await once(client,'message');assert.equal(String(message),'backend ready','target lookup does not hold the execution connection');
  assert.equal(lookup,1);assert.equal(store.devices('fixture-human').length,0);release();await Promise.all([...(service as any).defaultJobs.values()]);
  assert.equal(store.devices('fixture-human').length,1,'no browser preferences/defaults POST or settings page was used');
 }finally{
  release();client?.terminate();bad?.terminate();await web.close();await service.close();for(const c of backend.clients)c.terminate();await new Promise<void>(r=>backend.close(()=>r()));await rm(dir,{recursive:true,force:true});
 }
});
