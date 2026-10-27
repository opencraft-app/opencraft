import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import WebSocket from 'ws';
import { releaseFixture } from '../support/web-deployment-fixture.mjs';
import { createManagedWebServer } from '../../scripts/web-deployment/server.mjs';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';
import { createRelayServer } from '../../apps/relay-server/src/server';
import { connectRelay } from '../../plugins/relay-connect/src/server';
import { AssertionSigner, AssertionProvider } from '../../packages/identity-core/src/node';
import { MembershipStore, InstanceAccess } from '../../packages/access-control/src';
import { loadLocalMachineAccess } from '../../scripts/local-machine-access.mjs';
import { createProtocolIngress } from '../../scripts/web-deployment/protocol-ingress.mjs';

for (const admission of ['explicit', 'verified-provider', 'local-machine'] as const) test(`managed ${admission} ingress protects private entry and updater authority`,async t=>{
  const cleanup:(()=>unknown)[]=[];t.after(async()=>{for(const close of cleanup.reverse())await close();});
  const dir=await mkdtemp(join(tmpdir(),'managed-relay-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({format:'pem',type:'spki'}).toString(),privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const scope={issuer:'managed-test',instanceId:'team',origin:'http://team.test'},principal={provider:'enterprise-identity',subject:'person',displayName:'Person',expiresAt:Date.now()+60_000};
  const store=new MembershipStore(join(dir,'members.sqlite'));cleanup.push(()=>store.close());if(admission!=='verified-provider')store.set(principal,'member',true,'test-admin');
  const localAccessFile=admission==='local-machine'?join(dir,'local-access'):null;
  if(localAccessFile)await writeFile(localAccessFile,randomBytes(32).toString('hex'),{mode:0o600});
  const root=join(dir,'web');await mkdir(root);await writeFile(join(root,'index.html'),'Protected workbench');
  const core=await createWorkbenchWebServer({root,appServerTarget:null,loopbackOnly:true,localAccess:await loadLocalMachineAccess(localAccessFile),accessService:new InstanceAccess(store,[new AssertionProvider(scope,publicKey)],undefined,admission==='verified-provider'?['enterprise-identity']:[]),desktopService:{accept(ws:WebSocket){ws.send('ready');},close(){}}});cleanup.push(()=>core.close());
  const coreAddress=await core.listen({host:'127.0.0.1',port:0});
  const credential=randomBytes(32).toString('base64url');
  const relay=createRelayServer([{...scope,credential,signer:new AssertionSigner(scope,privateKey),identityProvider:{authenticate:req=>req.headers['x-test-auth']==='yes'?principal:null}}]);cleanup.push(()=>relay.close());relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const fixture=await releaseFixture(dir);cleanup.push(()=>fixture.close());
  const managed=await createManagedWebServer({initialRelease:fixture.releases.get('1.0.0').packageRoot,stateDirectory:join(dir,'state'),
    headlessBackendTarget:`http://127.0.0.1:${coreAddress.port}`,relayIngressTarget:`http://127.0.0.1:${(relay.server.address() as any).port}`,relayInternalPort:0,localAccessFile});cleanup.push(()=>managed.close());
  const address=await managed.listen({port:0});
  const ingress=localAccessFile?createProtocolIngress({httpPort:address.port,httpServer:managed.server,sshTarget:`http://127.0.0.1:${coreAddress.port}`}):null;
  if(ingress)cleanup.push(()=>ingress.close());
  const entry=ingress?await ingress.listen({port:0}):address,base=`http://127.0.0.1:${entry.port}`;
  const client=connectRelay({relay:base,credential,targetPort:managed.internalAddress().port,allowLoopbackInsecure:true});cleanup.push(()=>client.close());
  const deadline=Date.now()+5000;while(!relay.connected('team')){if(Date.now()>deadline)throw new Error('Managed tunnel timeout');await new Promise(r=>setTimeout(r,25));}
  const read=(path:string,auth=false,target=base,accept='text/html',method='GET')=>new Promise<{status:number;body:string}>((resolve,reject)=>{
    const req=request(target+path,{method,headers:{host:'team.test',accept,...(auth?{'x-test-auth':'yes'}:{})}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode!,body}));});req.on('error',reject);req.end();
  });
  assert.equal((await read('/')).status,401,'public business request cannot reach static worker directly');
  const allowed=await read('/',true);assert.equal(allowed.status,200);assert.match(allowed.body,/1\.0\.0/u);
  assert.equal((await read('/__opencraft_access/session',true)).status,200);
  assert.equal((await read('/__opencraft_access/members',true)).status,403,'relay enrollment does not grant business administration');
  assert.equal((await read('/__opencraft_updates')).status,200,'deployment metadata stays at managed entry');
  assert.equal((await read('/version.json')).status,200,'CI version probe stays available');
  assert.equal((await fetch(base+'/__opencraft_health')).status,200);
  const privateEntry=`http://127.0.0.1:${managed.internalAddress().port}`;
  assert.ok([401,403].includes((await read('/',false,privateEntry)).status),'private entry still requires core identity, even on loopback');
  assert.ok([401,403].includes((await read('/',false,privateEntry,'*/*')).status),'Accept cannot bypass private document admission');
  assert.ok([401,403].includes((await read('/assets/private.js',false,privateEntry,'*/*')).status),'all private static requests require verified admission');
  assert.ok([401,403].includes((await read('/',false,privateEntry,'*/*','HEAD')).status),'private HEAD requests cannot bypass admission');
  assert.equal((await read('/',true,base,'*/*','HEAD')).status,200,'authorized HEAD preserves the original signed method through the probe');
  if(localAccessFile){
    assert.equal((await fetch(base)).status,200,'local browser navigation reaches the real worker');
    assert.equal((await fetch(base,{method:'HEAD'})).status,200);
    assert.equal((await fetch(base+'/assets/lazy-100abcdef.js')).status,200,'local lazy modules retain admission');
    assert.equal((await fetch(base+'/__opencraft_access/members')).status,403,'local anonymous workspace is not a member administrator');
    for(const headers of [{'sec-fetch-site':'cross-site'},{origin:'https://evil.test'},{'x-forwarded-for':'127.0.0.1'}, {'x-forwarded-host':'127.0.0.1'}]){
      assert.equal((await fetch(base,{headers:{...headers,'x-opencraft-local-machine-proof':'spoofed'}})).status,403);
    }
    const localSocket=new WebSocket(base.replace('http:','ws:')+'/desktop/connect',{origin:base}),ready=once(localSocket,'message');
    await once(localSocket,'open');assert.equal((await ready)[0].toString(),'ready');localSocket.close();await once(localSocket,'close');
  }else assert.equal((await fetch(base)).status,403,'local mode is opt-in');
  const ws=new WebSocket(base.replace('http:','ws:')+'/desktop/connect',{origin:scope.origin,headers:{host:'team.test','x-test-auth':'yes'}}),message=once(ws,'message');await once(ws,'open');assert.equal((await message)[0].toString(),'ready');if(admission==='verified-provider'){
    const closed=once(ws,'close');store.set(principal,'member',false,'test-admin');await closed;
    assert.equal((await read('/',true)).status,403,'revoked employee loses document access');
  }else{ws.close();await once(ws,'close');}
});
