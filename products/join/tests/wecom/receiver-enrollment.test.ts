import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer as httpServer} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {RelayRedis} from '../../../../apps/relay-server/src/redis.js';
import {ChannelSync} from '../../../../plugins/im/src/channel-sync.js';
import {MirrorStore} from '../../plugins/wecom/mirror/store.mjs';
import {MirrorService} from '../../plugins/wecom/mirror/service.mjs';
import {createReceiverEnrollment,receiverProof,receiverHubId,RECEIVER_LEASE_MS} from '../../plugins/wecom/mirror/receiver-enrollment.mjs';
import {createAutomaticMirrorTarget,discoverReceiverIdentities} from '../../plugins/wecom/mirror/automatic-target.mjs';

const pause=(ms=10)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until<T>(read:()=>Promise<T>|T,accept:(value:T)=>boolean) {
  for(let i=0;i<500;i++){const value=await read();if(accept(value))return value;await pause();}
  throw Error('fixture deadline');
}
async function listen(server:any){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function fixture(t:any) {
  const dir=await mkdtemp(join(tmpdir(),'receiver-enrollment-')),reserve=httpServer(),port=await listen(reserve);
  await new Promise<void>(resolve=>reserve.close(resolve));
  const password=randomBytes(32).toString('base64url');
  const child=spawn(process.env.REDIS_SERVER||'redis-server',['--bind','127.0.0.1','--port',String(port),'--requirepass',password,
    '--dir',dir,'--appendonly','yes','--appendfsync','always','--maxmemory-policy','noeviction'],{stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>reject(Error('Redis fixture exited')));child.stdout!.on('data',data=>{if(String(data).includes('Ready to accept connections'))resolve();});});
  const config={host:'127.0.0.1',port,password,mode:'standalone' as const,namespace:randomUUID(),credential:password,internalPort:port};
  const clients=[await RelayRedis.connect(config),await RelayRedis.connect(config)];
  t.after(async()=>{clients.forEach(c=>c.close());const exit=once(child,'exit');child.kill('SIGTERM');await exit;await rm(dir,{recursive:true,force:true});});
  return {dir,stores:clients.map(c=>new MirrorStore(c))};
}

test('receiver lease authenticates across replicas, renews stably, expires and follows identity revocation',async t=>{
  const f=await fixture(t);let time=Date.now();
  const route={instanceId:'server-one',name:'One',credential:randomBytes(32).toString('base64url')};
  const options={routes:[route],relayOrigin:'https://relay.example:18490',corpId:'wxfixture',signingKey:'fixture-relay-key',now:()=>time};
  const a=createReceiverEnrollment({...options,store:f.stores[0]}),b=createReceiverEnrollment({...options,store:f.stores[1]});
  const identity={serverId:route.instanceId,credential:route.credential};
  const proof=receiverProof(identity,options.relayOrigin,time),lease=await a.enroll(proof);
  assert.equal((await b.authenticate(route.instanceId,lease.credential)).name,'One');
  await assert.rejects(b.enroll(proof),/denied/);
  await assert.rejects(b.enroll(receiverProof({...identity,credential:'wrong'},options.relayOrigin,time)),/denied/);
  await assert.rejects(b.enroll(receiverProof(identity,'https://other.example',time)),/denied/);
  await assert.rejects(b.enroll({...receiverProof(identity,options.relayOrigin,time),audience:'opencraft-hub-enrollment.v1'}),/denied/);
  await assert.rejects(b.authenticate('another-server',lease.credential),/denied/);
  time+=RECEIVER_LEASE_MS+1;
  await assert.rejects(b.authenticate(route.instanceId,lease.credential),/denied/);
  const renewed=await b.enroll(receiverProof(identity,options.relayOrigin,time));
  assert.equal(renewed.credential,lease.credential,'native file identities survive renewal');
  route.credential='rotated';await assert.rejects(a.authenticate(route.instanceId,lease.credential),/denied/);
  const rotated=await a.enroll(receiverProof({serverId:route.instanceId,credential:'rotated'},options.relayOrigin,time));
  assert.notEqual(rotated.credential,lease.credential);
});

test('Hub receiver proves the enrolled machine key; unconnected, spoofed and removed peers are denied',async t=>{
  const f=await fixture(t),keys=generateKeyPairSync('ed25519');
  const publicKey=keys.publicKey.export({format:'pem',type:'spki'}).toString(),privateKey=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const id=receiverHubId(publicKey),peers=[{hubId:id,name:'Fresh deployment',connected:true}];
  const hub={snapshot:()=>({endpoint:'https://relay.example:18490',peers}),routes:()=>[{service:{hubId:id}}]};
  const a=createReceiverEnrollment({store:f.stores[0],routes:[],hub,relayOrigin:hub.snapshot().endpoint,corpId:'wxfixture',signingKey:'fixture'});
  const identity={serverId:id,publicKey,privateKey};
  const lease=await a.enroll(receiverProof(identity,hub.snapshot().endpoint));
  assert.equal((await a.authenticate(id,lease.credential)).name,'Fresh deployment');
  peers[0].connected=false;await assert.rejects(a.authenticate(id,lease.credential),/denied/);
  await assert.rejects(a.enroll(receiverProof(identity,hub.snapshot().endpoint)),/denied/);
  peers[0].connected=true;
  await assert.rejects(a.enroll(receiverProof({...identity,serverId:'hub-'+'0'.repeat(40)},hub.snapshot().endpoint)),/denied/);
  peers.length=0;await assert.rejects(a.authenticate(id,lease.credential),/denied/);
});

test('fresh Gateway enrolls over verified TLS without receiver files, registers and restores after restart',async t=>{
  const f=await fixture(t),key=join(f.dir,'tls.key'),cert=join(f.dir,'tls.pem');
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert]);
  const server=httpsServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{if(!service.ingress(req,res)){res.writeHead(404);res.end();}});
  const origin='https://127.0.0.1:'+await listen(server),credential=randomBytes(32).toString('base64url');
  const enrollment=createReceiverEnrollment({store:f.stores[0],routes:[{instanceId:'new-server',name:'New server',credential}],
    relayOrigin:origin,corpId:'wxfixture',signingKey:'fixture-signing-key'});
  const service=new MirrorService({store:f.stores[0],transport:{subscribe:()=>()=>{}},corpId:'wxfixture',receiverEnrollment:enrollment});
  const previous={data:process.env.OPENCRAFT_DATA_DIR,ws:process.env.OPENCRAFT_WORKSPACE_DIR};
  process.env.OPENCRAFT_DATA_DIR=f.dir;process.env.OPENCRAFT_WORKSPACE_DIR=join(f.dir,'workspace');
  let adapter:any;const errors:any[]=[];
  t.after(async()=>{await adapter?.close();await service.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const[k,v]of Object.entries({OPENCRAFT_DATA_DIR:previous.data,OPENCRAFT_WORKSPACE_DIR:previous.ws}))if(v===undefined)delete process.env[k];else process.env[k]=v;});
  const ca=await readFile(cert,'utf8'),identity={relayOrigin:origin,serverId:'new-server',credential,ca};
  let online=false;
  const options={discover:async()=>online?[identity]:[],retryMs:10,onError:(e:any)=>errors.push(e.message)};
  const collaboration={synchronizeChannels:async({method}:any)=>method==='mirrorDirectory'?{}:[],channels:{onChange:()=>()=>{}}};
  adapter=await createAutomaticMirrorTarget({dataDirectory:f.dir},{collaboration},options);
  adapter.subscribeWithReceipt(async()=>{throw Error('no external group messages in this test');});
  assert.equal(adapter.ready(),false);online=true;
  await until(()=>f.stores[1].recordingServers(),rows=>rows.some((row:any)=>row.id==='new-server'));
  assert.equal(adapter.ready(),true);assert.ok(errors.includes('mirror_receiver_waiting_for_relay'));
  const cache=join(f.dir,'wecom-mirror-auto.json'),first=JSON.parse(await readFile(cache,'utf8'));
  assert.equal((await stat(cache)).mode&0o077,0);
  assert.equal(first.credential.length,43);
  await adapter.close();adapter=await createAutomaticMirrorTarget({dataDirectory:f.dir},{collaboration},options);
  adapter.subscribeWithReceipt(async()=>{throw Error('no group messages');});
  await until(()=>adapter.ready(),Boolean);
  assert.equal(JSON.parse(await readFile(cache,'utf8')).credential,first.credential);
});

test('automatic discovery reuses legacy routes and pinned Hub CA, and signs Hub-only deployments',async()=>{
  const keys=generateKeyPairSync('ed25519'),state={publicKey:keys.publicKey.export({format:'pem',type:'spki'}).toString(),privateKey:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),peers:[{endpoint:'https://relay.example:18490',ca:'fixture-ca'}]};
  const read=async(path:string)=>path.endsWith('hub-network.json')?state:{instanceId:'existing',credential:'existing-secret',relay:'http://127.0.0.1:18090'};
  const [legacy]=await discoverReceiverIdentities({dataDirectory:'/fixture',relayConnectFile:'/fixture/relay-connect.json'},read);
  assert.equal(legacy.serverId,'existing');assert.equal(legacy.ca,'fixture-ca');assert.equal(legacy.credential,'existing-secret');
  const [hub]=await discoverReceiverIdentities({dataDirectory:'/fixture'},read);
  assert.equal(hub.serverId,receiverHubId(state.publicKey));assert.equal(hub.publicKey,state.publicKey);
});

test('automatic lease renewal retries a lost response without duplicating the receiver',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'receiver-renew-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let requests=0,created=0,closed=0;const credential='a'.repeat(43),errors:string[]=[];
  const adapter=await createAutomaticMirrorTarget({dataDirectory:dir},{collaboration:{synchronizeChannels:async()=>[]}}, {
    discover:async()=>[{relayOrigin:'https://relay.example',serverId:'fixture',credential:'route-identity'}],
    retryMs:5,renewBeforeMs:RECEIVER_LEASE_MS-20,onError:(e:any)=>errors.push(e.message),
    fetcher:async()=>{requests++;if(requests===2)throw Error('fixture response lost');return Response.json({relayOrigin:'https://relay.example',serverId:'fixture',corpId:'wxfixture',credential,expiresAt:Date.now()+RECEIVER_LEASE_MS});},
    createTarget:async()=>{created++;return {subscribeWithReceipt:()=>()=>{},close:async()=>{closed++;}};},
  });
  t.after(()=>adapter.close());adapter.subscribeWithReceipt(async()=>({messageId:'unused'}));
  await until(()=>requests,n=>n>=3);assert.equal(adapter.ready(),true);assert.equal(created,1);
  assert.deepEqual(errors,['fixture response lost']);await adapter.close();assert.equal(closed,1);
});

test('closing during enrollment does not install a late target or restart its timer',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'receiver-close-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let finish:any,requested=false,created=0;
  const adapter=await createAutomaticMirrorTarget({dataDirectory:dir},{collaboration:{synchronizeChannels:async()=>[]}}, {
    discover:async()=>[{relayOrigin:'https://relay.example',serverId:'fixture',credential:'route-identity'}],onError:()=>{},
    fetcher:async()=>{requested=true;return new Promise(resolve=>{finish=resolve;});},
    createTarget:async()=>{created++;return {close:async()=>{}};},
  });
  adapter.subscribeWithReceipt(async()=>({messageId:'unused'}));await until(()=>requested,Boolean);
  const closing=adapter.close();finish(Response.json({relayOrigin:'https://relay.example',serverId:'fixture',corpId:'wxfixture',credential:'a'.repeat(43),expiresAt:Date.now()+RECEIVER_LEASE_MS}));
  await closing;assert.equal(created,0);assert.equal(adapter.ready(),false);
});

test('unready transport leaves queued sends and image downloads unclaimed',async t=>{
  let ready=false,claims=0,downloads=0;const calls:string[]=[];
  const transport={bindings:[],ready:()=>ready,subscribe:()=>()=>{},send:async()=>{throw Error('must not send');},images:{download:async()=>new Uint8Array(),upload:async()=>null,attribute:async()=> 'rejected' as const,send:async()=> 'rejected' as const}};
  const port={synchronizeChannels:async({method}:any)=>{calls.push(method);if(method==='claim')claims++;if(method==='pendingImage')downloads++;return null;},channels:{onChange:()=>()=>{}}};
  const sync=await ChannelSync.open(transport,port);t.after(()=>sync.close());
  await pause(30);assert.equal(claims,0);assert.equal(downloads,0);
  ready=true;await until(()=>claims,value=>value>0);assert.ok(downloads>0);
});
