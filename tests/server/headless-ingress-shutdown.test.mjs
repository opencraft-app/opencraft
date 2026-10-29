import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import ssh2 from 'ssh2';
import { WebSocket } from 'ws';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { AssertionSigner } from '../../packages/identity-core/src/node.ts';
import { createRelayServer } from '../../apps/relay-server/src/server.ts';
import { HubNetwork } from '../../packages/hub-network/src/node.ts';
import { startHeadlessServer } from '../../scripts/headless-application.mjs';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'oc-ingress-shutdown-')),webRoot=join(root,'web');await mkdir(webRoot);
  await writeFile(join(webRoot,'index.html'),'<!doctype html><title>Ingress shutdown fixture</title>');
  await writeFile(join(webRoot,'version.json'),JSON.stringify({schemaVersion:1,buildId:'ingress-shutdown',headlessServer:true,headlessHostId:'opencraft-server'}));
  return {root,options:{root,webRoot,dataDirectory:join(root,'data'),port:0,startAgentHost:async()=>({websocketUrl:'ws://127.0.0.1:9/rpc',close:async()=>{}})}};
}
async function bounded(operation,ms,label) {let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(timer);}}
const command=(node,input)=>node.command({revision:node.store.state.revision,...input},'fixture-administrator');

test('a real admitted Hub peer cannot hold Headless HTTP shutdown open', {timeout:15000}, async()=>{
  const f=await fixture();let app,peer,server,hub;
  try {
    app=await startHeadlessServer({...f.options,createWebServer:async options=>{hub=options.hubService.node;return createWorkbenchWebServer(options);}});
    peer=new HubNetwork(join(f.root,'peer.json'));
    server=createServer((_req,res)=>res.end('{}'));server.on('upgrade',(req,socket,head)=>{if(!peer.handleUpgrade(req,socket,head))socket.destroy();});
    server.listen(0,'127.0.0.1');await once(server,'listening');peer.start(server.address().port);
    for(const [node,endpoint] of [[hub,app.url],[peer,`http://127.0.0.1:${server.address().port}`]])
      command(node,{action:'configure',name:'Fixture Hub',endpoint,origin:'',accepting:true,forwarding:true});
    const {invitation}=command(hub,{action:'invite',origins:['http://fixture.test'],allowTransit:true});
    command(peer,{action:'connect',invitation,trustIdentity:true});
    const end=Date.now()+5000;while(!hub.links.size&&Date.now()<end)await new Promise(done=>setTimeout(done,20));
    assert.equal(hub.links.size,1,'the real Hub control WebSocket is admitted');
    await bounded(app.close(),1500,'Headless shutdown waited on its own Hub peer');
  } finally {peer?.close();await app?.close();if(server)await new Promise(done=>server.close(done));await rm(f.root,{recursive:true,force:true});}
});

test('planned restart reaches a browser through the real SSH/HTTP ingress as 1012', {timeout:15000}, async()=>{
  const f=await fixture();let app,socket;
  try {
    const host=ssh2.utils.generateKeyPairSync('ed25519'),user=ssh2.utils.generateKeyPairSync('ed25519');
    const hostKeyFile=join(f.root,'host-key'),config=join(f.root,'ssh.json');
    await writeFile(hostKeyFile,host.private,{mode:0o600});await writeFile(config,JSON.stringify({hostKeyFile,authorizedKeys:{fixture:[user.public]}}),{mode:0o600});
    app=await startHeadlessServer({...f.options,sshConfig:config});
    socket=new WebSocket(app.url.replace('http','ws')+'/apphost',{origin:app.url});await once(socket,'open');
    const closed=once(socket,'close');
    await app.close({updateId:'fixture-update',buildId:'fixture-build'});
    assert.equal((await closed)[0],1012,'the carrier must outlive the browser restart close frame');
  } finally {socket?.terminate();await app?.close();await rm(f.root,{recursive:true,force:true});}
});

test('an aborted HTTP carrier does not release shutdown before its accepted handler settles', {timeout:15000}, async()=>{
  const f=await fixture();let web,release,admitted;const held=new Promise(done=>{release=done;}),entered=new Promise(done=>{admitted=done;});
  let mutationSettled=false,closed=false;
  try {
    web=await createWorkbenchWebServer({root:f.options.webRoot,identityService:{admissionStatus:()=>204,connectionContext:()=>({sender:null}),async handle(_req,res){admitted();await held;mutationSettled=true;res.end('{}');return true;}}});
    const address=await web.listen({host:'127.0.0.1',port:0}),controller=new AbortController();
    const request=fetch(`http://127.0.0.1:${address.port}/accepted`,{signal:controller.signal}).catch(()=>{});
    await entered;controller.abort();await request;
    const closing=web.close().then(()=>{closed=true;});
    await new Promise(done=>setTimeout(done,25));assert.equal(closed,false,'pending handler remains an owner after its wire closes');
    release();await closing;assert.equal(mutationSettled,true);
  } finally {release?.();if(!closed)await web?.close();await rm(f.root,{recursive:true,force:true});}
});

test('planned restart reaches a browser through the real outbound relay as 1012', {timeout:15000}, async()=>{
  const f=await fixture();let app,relay,socket;
  try {
    const pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({format:'pem',type:'spki'}).toString(),privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();
    const scope={issuer:'fixture',instanceId:'fixture',origin:'http://fixture.test'},credential=randomBytes(32).toString('base64url');
    const principal={provider:'fixture-directory',subject:'fixture-human',displayName:'Fixture',expiresAt:Date.now()+60000};
    relay=createRelayServer([{...scope,credential,signer:new AssertionSigner(scope,privateKey),identityProvider:{authenticate:()=>principal}}]);
    relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
    const url=`http://127.0.0.1:${relay.server.address().port}`,file=join(f.root,'relay.json');
    await writeFile(file,JSON.stringify({schemaVersion:1,...scope,credential,publicKey,relay:url,allowLoopbackInsecure:true}),{mode:0o600});
    app=await startHeadlessServer({...f.options,relayConnectFile:file,accessMemberProviders:['fixture-directory']});
    const end=Date.now()+5000;while(!relay.connected('fixture')&&Date.now()<end)await new Promise(done=>setTimeout(done,20));
    assert.equal(relay.connected('fixture'),true);
    socket=new WebSocket(url.replace('http','ws')+'/apphost',{origin:scope.origin,headers:{host:'fixture.test'}});await once(socket,'open');
    const closed=once(socket,'close');await app.close({updateId:'fixture-update',buildId:'fixture-build'});
    assert.equal((await closed)[0],1012);
  } finally {socket?.terminate();await app?.close();await relay?.close();await rm(f.root,{recursive:true,force:true});}
});
