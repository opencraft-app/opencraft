import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createCipheriv, createHash, randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { request as httpRequest, createServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { RelayRedis } from '../../apps/relay-server/src/redis.js';
import { openServerDatabase } from '@opencraft/storage-node/server';
import { ActorStore } from '../../packages/access-control/src/actors.js';
import { Collaboration } from '../../packages/access-control/src/collaboration.js';
import { ChannelSync } from '../../plugins/im/src/channel-sync.js';
import { MirrorStore, humanKey } from '../../products/join/plugins/wecom/mirror/store.mjs';
import { createGroupSelection } from '../../products/join/plugins/wecom/mirror/selection.mjs';
import { MirrorService, MIRROR_PATH } from '../../products/join/plugins/wecom/mirror/service.mjs';
import { createMirrorTarget, withWeComDirectory } from '../../products/join/plugins/wecom/mirror/target.mjs';
import { createForwardingIngress } from '../../products/join/plugins/wecom/mirror/main.mjs';
import { createWeComCallbackIngress } from '../wecom-callback.js';
import { connect as connectSocket } from 'node:net';
import { mentionCommand, commandReply } from '../../products/join/plugins/wecom/commands.mjs';
import { createAutomaticDirectory } from '../../products/join/plugins/wecom/automatic-directory.mjs';
import { createWeComChannelTransport } from '../../products/join/plugins/wecom/channel-transport.mjs';
import { startRelayApplication } from '../../apps/relay-server/src/application.js';
import { joinRelayConfiguration } from '../relay-composition.js';
import { HubNetwork } from '../../packages/hub-network/src/node.js';

async function listen(server:Server) {server.listen(0,'127.0.0.1');await once(server,'listening');return (server.address() as {port:number}).port;}
const close=(server:Server)=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
async function until(check:()=>Promise<unknown>,timeout=15000) {
  const end=Date.now()+timeout;while(!await check()){if(Date.now()>end)throw Error('condition not reached');await sleep(20);}
}
function isolatedTargetPaths(t:test.TestContext,dir:string) {
  const prior={data:process.env.OPENCRAFT_DATA_DIR,workspace:process.env.OPENCRAFT_WORKSPACE_DIR};
  process.env.OPENCRAFT_DATA_DIR=dir;process.env.OPENCRAFT_WORKSPACE_DIR=join(dir,'workspace');
  t.after(()=>{for(const[key,value]of [['OPENCRAFT_DATA_DIR',prior.data],['OPENCRAFT_WORKSPACE_DIR',prior.workspace]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
}
async function redisFixture(t:test.TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'wecom-mirror-')),reserve=createServer(),port=await listen(reserve);await close(reserve);
  let child:ChildProcess;const clients:RelayRedis[]=[];
  const config={host:'127.0.0.1',port,mode:'standalone' as const,password:'synthetic-fixture',namespace:randomUUID(),credential:randomBytes(32).toString('base64url'),internalPort:port};
  const start=async()=>{
    child=spawn(process.env.REDIS_SERVER??'redis-server',['--bind','127.0.0.1','--port',String(port),'--requirepass',config.password,'--dir',dir,'--appendonly','yes','--appendfsync','always','--maxmemory-policy','noeviction'],{stdio:['ignore','pipe','pipe']});
    await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>reject(Error('Redis fixture exited')));child.stdout!.on('data',data=>{if(String(data).includes('Ready to accept connections'))resolve();});});
  };
  const stop=async()=>{const exited=once(child,'exit');child.kill('SIGTERM');await exited;};
  const connect=async()=>{const client=await RelayRedis.connect(config);clients.push(client);return client;};
  t.after(async()=>{clients.forEach(c=>c.close());if(child?.exitCode===null)await stop();await rm(dir,{recursive:true,force:true});});
  await start();return {connect,stop,start,clients,config};
}

for (const dedicated of [false,true]) test(`Join composition uses ${dedicated?'dedicated recording':'shared'} Redis, authenticated TLS and closes cleanly`, {timeout:15000},async t=>{
  const f=await redisFixture(t),dir=await mkdtemp(join(tmpdir(),'mirror-composition-'));
  const queue=dedicated?await redisFixture(t):f;
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const free=async()=>{const server=createServer(),port=await listen(server);await close(server);return port;};
  const port=await free(),tlsPort=await free(),internalPort=await free();
  const cert=join(dir,'cert.pem'),key=join(dir,'key.pem'),clusterFile=join(dir,'cluster.json'),operator=join(dir,'operator.json'),mirror=join(dir,'mirror.json');
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-keyout',key,'-out',cert]);
  const credential=randomBytes(32).toString('base64url');
  await writeFile(clusterFile,JSON.stringify({...f.config,internalPort}),{mode:0o600});
  const queueFile=join(dir,'recording-redis.json');await writeFile(queueFile,JSON.stringify(queue.config),{mode:0o600});
  await writeFile(operator,JSON.stringify({credential:randomBytes(32).toString('base64url')}),{mode:0o600});
  await writeFile(mirror,JSON.stringify({wecom:provider,servers:[{id:'one',name:'One',credential}]}),{mode:0o600});
  new HubNetwork(join(dir,'hub.json'),{localService:false}).close();
  const tokenFile=join(dir,'ioa-token');await writeFile(tokenFile,'0'.repeat(32),{mode:0o600});
  const signing=generateKeyPairSync('ed25519'),entryOrigin='http://127.0.0.1:'+port;
  const {configuration,composition}=joinRelayConfiguration({schemaVersion:1,host:'127.0.0.1',port,
    issuer:'fixture',privateKey:signing.privateKey.export({format:'pem',type:'pkcs8'}).toString(),tencentOaTokenFile:tokenFile,authenticationOrigin:entryOrigin,
    routes:[{instanceId:'entry',origin:entryOrigin,credential}],clusterFile,hubNetwork:{stateFile:join(dir,'hub.json'),operatorCredentialFile:operator,port:tlsPort,tlsCertFile:cert,tlsKeyFile:key}},undefined,undefined,mirror,undefined,false,dedicated?queueFile:undefined);
  const createIngress=composition.createIngress!;
  composition.createIngress=async context=>{
    const original=await createIngress(context);
    const handle=(req:any,res:any)=>{
      if(req.url!=='/fixture/login-evidence')return original(req,res);
      void context.authenticateEntryRequest!(req).then(identity=>{res.writeHead(identity?200:401,{'content-type':'application/json'});res.end(JSON.stringify(identity?.principal??null));});return true;
    };
    handle.close=()=>original.close?.();return handle;
  };
  const env={OPENCRAFT_RELAY_NODE_ID:process.env.OPENCRAFT_RELAY_NODE_ID,OPENCRAFT_RELAY_ADVERTISE_HOST:process.env.OPENCRAFT_RELAY_ADVERTISE_HOST};
  process.env.OPENCRAFT_RELAY_NODE_ID='mirror-fixture';process.env.OPENCRAFT_RELAY_ADVERTISE_HOST='127.0.0.1';
  const originalFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url:any,options:any)=>{
    const path=String(url);
    if(path.includes('/cgi-bin/gettoken'))return Response.json({errcode:0,access_token:'fixture',expires_in:7200});
    if(path.includes('/cgi-bin/tencent/chat/get'))return Response.json({errcode:0,chat_info:{chatid:'room',name:'Provider',userlist:['T03370011A']}});
    if(path.includes('/cgi-bin/tencent/user/convert_to_name'))return Response.json({errcode:0,user_list:[{userid:'T03370011A',name:'ruippan'}]});
    if(path.includes('/cgi-bin/tencent/user/convert_to_userid'))return Response.json({errcode:0,user_list:[{userid:'T03370011A',name:'ruippan'}]});
    return originalFetch(url,options);
  });
  let app:Awaited<ReturnType<typeof startRelayApplication>>;
  try{app=await startRelayApplication(configuration,composition);}finally{for(const [key,value]of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  t.after(()=>app.close());
  const headers={authorization:'Bearer '+credential,'x-opencraft-mirror-server':'one','content-type':'application/json'};
  const ca=await readFile(cert);
  const response=await new Promise<{status:number;body:any}>((resolve,reject)=>{
    const req=httpsRequest({hostname:'127.0.0.1',port:tlsPort,path:MIRROR_PATH+'/register',method:'POST',headers,ca},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(body)}));
    });req.on('error',reject);req.end(JSON.stringify({humans:{}}));
  });
  assert.deepEqual(response,{status:200,body:{ok:true,turnNotifications:true}});
  const recording=new MirrorStore(await queue.connect());assert.ok(await recording.command('GET',recording.prefix+'server:one'));
  if(dedicated){const shared=new MirrorStore(await f.connect());assert.equal(await shared.command('GET',shared.prefix+'server:one'),null);}
  // Only shared authentication Redis contains claims, even with a dedicated mirror queue.
  const authentication=await f.connect(),expiresAt=Date.now()+60000;
  await authentication.put('sessions','e'.repeat(64),{principal:{provider:'tencentoa',subject:'110337',displayName:'Not RTX',attributes:{loginName:'ruippan'},aliases:['login:ruippan'],expiresAt},expiresAt},expiresAt,100);
  const source=JSON.stringify(['wecom-customer-service',provider.corpId,provider.serviceId,'room']);
  const human=humanKey(provider.corpId,'T03370011A');
  await recording.register('one','One',{[human]:'existing-actor'},true);
  await recording.bind(source,human,'one','Provider',true);
  const evidence=await new Promise<any>((resolve,reject)=>{
    const req=httpsRequest({hostname:'127.0.0.1',port:tlsPort,path:MIRROR_PATH+'/group-sync',method:'POST',headers,ca},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
    });req.on('error',reject);req.end(JSON.stringify({action:'read',source,resolveMembers:true}));
  });
  assert.equal(evidence.status,200);
  assert.equal(evidence.body.memberEvidence.members[0].subject,'110337');
  assert.equal(evidence.body.memberEvidence.members[0].rtx,'ruippan');
  const directoryKey='wecom-directory:v1:identity:'+createHash('sha256').update(JSON.stringify(['wecom',provider.corpId,'ruippan'])).digest('hex');
  assert.equal(JSON.parse((await (await queue.connect()).read(directoryKey))!).subject,'110337');

  const sessionToken='s'.repeat(43),principal={provider:'tencentoa',subject:'110337',displayName:'Not RTX',attributes:{loginName:'ruippan'},aliases:['login:ruippan'],expiresAt};
  await authentication.put('sessions',createHash('sha256').update(sessionToken).digest('hex'),{principal,route:{instanceId:'entry',origin:entryOrigin},expiresAt},expiresAt,100);
  const login=await fetch(entryOrigin+'/fixture/login-evidence',{headers:{cookie:'opencraft-relay-session='+sessionToken}});
  assert.equal(login.status,200);const prepared=await login.json() as any;
  assert.equal(prepared.subject,'110337');assert.equal(prepared.attributes.wecomCorpId,'wxfixture');
  assert.equal(prepared.attributes.wecomUserId,'T03370011A');assert.ok(Number(prepared.attributes.wecomVerifiedUntil)>Date.now());

  const plain=await fetch('http://127.0.0.1:'+port+MIRROR_PATH+'/poll',{method:'POST',headers,body:'{}'});assert.equal(plain.status,403);await plain.text();
  const {value,query}=encrypted('assembly-challenge');query.set('echostr',value);
  assert.equal(await (await fetch('http://127.0.0.1:'+port+'/wecom_callback?'+query)).text(),'assembly-challenge');
  const closing=app.close();assert.equal(closing,app.close());await closing;
  await assert.rejects(fetch('http://127.0.0.1:'+port+'/__opencraft_relay/health'));
});

test('five replicas atomically keep first 200 distinct arrivals, fence leases and survive an AOF restart', {timeout:20000},async t=>{
  const f=await redisFixture(t),stores=await Promise.all(Array.from({length:5},async()=>new MirrorStore(await f.connect())));
  await stores[0].verifyDurability();
  await stores[0].command('CONFIG','SET','appendonly','no');
  await assert.rejects(stores[0].verifyDurability(),/requires healthy AOF/);
  await stores[0].command('CONFIG','SET','appendonly','yes');
  await until(async()=>{try{await stores[0].verifyDurability();return true;}catch{return false;}});
  const source='fixture-room',event=(id:string)=>({source,id,author:'Wei',text:'fixture '+id,at:1000});
  for(let i=0;i<200;i++) {
    const results=await Promise.all(stores.map(store=>store.ingest(event(String(i)))));
    assert.equal(results.filter(r=>r==='stored').length,1);
  }
  for(let i=200;i<250;i++) {
    const results=await Promise.all(stores.map(store=>store.ingest(event(String(i)))));
    assert.equal(results.filter(r=>r==='discarded').length,1);
  }
  assert.deepEqual(await stores[0].snapshot(source),{binding:null,count:200,dropped:50,lastDeliveredAt:0,channelId:null});
  await assert.rejects(stores[0].ingest({...event('0'),text:'mutated'}),/conflict/);
  const notices=await stores[0].claim(source,true);assert.equal((await stores[1].head(source,notices,true)).kind,'warning');
  await stores[0].release(source,notices,true);
  const human=humanKey('wxfixture','Wei');await stores[0].register('one','One',{[human]:'human-fixture'});
  await assert.rejects(stores[1].bind(source,humanKey('wxfixture','stranger'),'one','Group'),/identity_denied/);
  const binding=await stores[0].bind(source,human,'one','Group');assert.equal(binding.serverId,'one');
  await assert.rejects(stores[1].bind(source,human,'two','Group'),/already_bound/);
  const old=await stores[0].claim(source);assert.equal(await stores[1].claim(source),null);
  await stores[0].command('PEXPIRE',stores[0].keys(source).lock,1);await sleep(5);
  const fresh=await stores[1].claim(source);assert.ok(fresh);assert.equal(await stores[0].ack(source,old,'0'),false);
  assert.equal((await stores[1].head(source,fresh)).id,'0');await stores[1].release(source,fresh);
  f.clients.forEach(c=>c.close());await f.stop();await f.start();
  const recovered=new MirrorStore(await f.connect());assert.equal((await recovered.snapshot(source)).count,200);
  const token=await recovered.claim(source);assert.equal((await recovered.head(source,token)).id,'0');
  assert.equal(await recovered.ack(source,token,'1'),false);assert.equal(await recovered.ack(source,token,'0'),true);
  assert.equal((await recovered.snapshot(source)).count,199);await recovered.release(source,token);
});

const provider={corpId:'wxfixture',serviceId:'fwfixture',corpSecret:'synthetic-fixture',token:'fixturetoken',aesKey:Buffer.alloc(32,7).toString('base64').replace(/=$/u,'')};
const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
function encrypted(payload:string,recipient=provider.serviceId) {
  const key=Buffer.from(provider.aesKey,'base64'),size=Buffer.alloc(4);size.writeUInt32BE(Buffer.byteLength(payload));
  const data=Buffer.concat([randomBytes(16),size,Buffer.from(payload),Buffer.from(recipient)]),pad=32-data.length%32;
  const cipher=createCipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false);
  const value=Buffer.concat([cipher.update(Buffer.concat([data,Buffer.alloc(pad,pad)])),cipher.final()]).toString('base64');
  const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID();
  const signature=createHash('sha1').update([provider.token,timestamp,nonce,value].sort().join('')).digest('hex');
  return {value,query:new URLSearchParams({timestamp,nonce,msg_signature:signature})};
}
async function serviceFixture(t:test.TestContext,forwardingOnly=false,legacyRecording=false) {
  const redis=await redisFixture(t),store=new MirrorStore(await redis.connect()),sends:any[]=[];
  const transport=createWeComChannelTransport({...provider,relayIngress:true,enableImages:true,fetcher:async(url:any,options:any)=>{
    if(String(url).includes('/media/get'))return new Response(png);
    if(options?.body&&typeof options.body==='string')sends.push(JSON.parse(options.body));
    return Response.json({errcode:0,access_token:'fixture-access',expires_in:7200,media_id:'fixture-upload'});
  }});
  const credential=randomBytes(32).toString('base64url');
  const service=new MirrorService({store,transport,corpId:provider.corpId,allowLoopbackInsecure:true,forwardingOnly,servers:[{id:'one',name:'One',credential,legacyRecording},{id:'two',name:'Two',credential:randomBytes(32).toString('base64url')}]});
  const server=createServer((req,res)=>{if(!service.ingress(req,res)){res.writeHead(404);res.end();}}),port=await listen(server),origin='http://127.0.0.1:'+port;
  t.after(async()=>{await service.close();await close(server);});
  const source=JSON.stringify(['wecom-customer-service',provider.corpId,provider.serviceId,'room']);
  async function callback(id:string,text='fixture',options:{image?:boolean;mentioned?:boolean;invalidSignature?:boolean;recipient?:string}={}) {
    const body=`<xml><ToUserName>${provider.corpId}</ToUserName><ServiceId>${provider.serviceId}</ServiceId><AgentType>chat</AgentType><Msg><From><Type>group</Type><Id>room</Id><Sender>Wei</Sender></From><MsgId>${id}</MsgId><CreateTime>1700000000</CreateTime><MsgType>${options.image?'image':'text'}</MsgType><MentionedType>${options.mentioned?'1':'0'}</MentionedType>${options.image?'<MediaId>fixture-media</MediaId>':'<Content>'+text+'</Content>'}</Msg></xml>`;
    const {value,query}=encrypted(body,options.recipient);if(options.invalidSignature)query.set('msg_signature','0'.repeat(40));
    const response=await fetch(origin+'/wecom_callback?'+query,{method:'POST',body:'<xml><Encrypt><![CDATA['+value+']]></Encrypt></xml>'});await response.text();return response.status;
  }
  return {redis,store,service,credential,origin,source,callback,sends};
}

test('legacy recording is explicitly pinned and cannot override directory-only or forwarding mode',async t=>{
  for(const [forwardingOnly,legacyRecording]of [[false,false],[false,true],[true,true]]){
    const f=await serviceFixture(t,forwardingOnly,legacyRecording);
    const register=async(recording?:boolean)=>{
      const response=await fetch(f.origin+MIRROR_PATH+'/register',{method:'POST',headers:{authorization:'Bearer '+f.credential,'x-opencraft-mirror-server':'one','content-type':'application/json'},body:JSON.stringify({humans:{},...(recording===undefined?{}:{recording})})});
      assert.equal(response.status,200);await response.text();return (await f.store.recordingServers()).length;
    };
    assert.equal(await register(),legacyRecording&&!forwardingOnly?1:0);
    assert.equal(await register(false),0);
    assert.equal(await register(true),forwardingOnly?0:1);
  }
});

test('signed public callbacks, durable notices and link proof fail closed and survive retry',async t=>{
  const f=await serviceFixture(t);
  assert.equal(await f.callback('invalid','x',{invalidSignature:true}),401);
  assert.equal(await f.callback('wrong','x',{recipient:'wrong'}),400);
  assert.equal((await f.store.snapshot(f.source)).count,0);
  const echo=encrypted('fixture-challenge');echo.query.set('echostr',echo.value);
  assert.equal(await (await fetch(f.origin+'/wecom_callback?'+echo.query)).text(),'fixture-challenge');
  for(let i=0;i<10;i++)assert.equal(await f.callback(String(i)),200);
  const send=f.service.transport.send;f.service.transport.send=async()=>{throw Error('provider offline');};
  await f.service.tick();const token=await f.store.claim(f.source,true);assert.equal((await f.store.head(f.source,token,true)).kind,'reply');await f.store.release(f.source,token,true);
  f.service.transport.send=send;await f.service.tick();assert.equal(f.sends.length,1);
  const challenge=await f.store.beginLink('one','human-fixture',1);
  assert.equal(await f.store.attachLink(challenge.code,f.source,'Wei'),true);
  assert.equal(await f.store.attachLink(challenge.code,f.source,'Wei'),true);
  assert.equal(await f.store.attachLink(challenge.code,f.source,'Mallory'),false);
  assert.equal((await f.store.links('two')).length,0);const [link]=await f.store.links('one');assert.equal(link.actorId,'human-fixture');
  await assert.rejects(f.store.completeLink('two',link.id,true),/denied/);
  await f.store.completeLink('one',link.id,true);await f.store.completeLink('one',link.id,true);assert.equal((await f.store.links('one')).length,0);
  assert.equal((await fetch(f.origin+MIRROR_PATH+'/poll',{method:'POST',body:'{}'})).status,403);
  f.service.allowLoopbackInsecure=false;
  assert.equal((await fetch(f.origin+MIRROR_PATH+'/poll',{method:'POST',headers:{authorization:'Bearer '+f.credential,'x-opencraft-mirror-server':'one'},body:'{}'})).status,403,'machine credentials require TLS');
});

test('mirror delivery resolves directory labels without mutating queued identity, and retries lookup failures',async t=>{
  const f=await serviceFixture(t),author='T40930008A';
  const original={source:f.source,id:'named-message',author,sender:{id:author,displayName:author},text:'hello',at:1700000000000};
  await f.store.ingest(original);
  const human=humanKey(provider.corpId,'Wei');
  await f.store.register('one','One',{[human]:'human-fixture'});
  await f.store.bind(f.source,human,'one','Group');
  const poll=async()=>{
    const response=await fetch(f.origin+MIRROR_PATH+'/poll',{method:'POST',headers:{authorization:'Bearer '+f.credential,'x-opencraft-mirror-server':'one'},body:'{}'});
    assert.equal(response.status,200);return response.json();
  };
  f.service.transport.senderNames=async()=>new Map();
  assert.deepEqual((await poll()).deliveries,[]);
  assert.equal((await f.store.snapshot(f.source)).count,1);
  f.service.transport.senderNames=async(source:string,ids:string[])=>{
    assert.equal(source,f.source);assert.deepEqual(ids,[author]);return new Map([[author,'skipzhang']]);
  };
  const [delivery]=(await poll()).deliveries;
  assert.equal(delivery.event.author,author);
  assert.deepEqual(delivery.event.sender,{id:author,displayName:'skipzhang'});
  assert.deepEqual(await f.store.head(f.source,delivery.token),original,'queue payload and deduplication fingerprint stay unchanged');
  await f.store.release(f.source,delivery.token);
  assert.deepEqual((await poll()).deliveries[0].event,delivery.event,'lost delivery can replay the same resolved identity');
});

test('200 offline callbacks drain into native SQLite once, including images, lost ACK and target restart', {timeout:30000},async t=>{
  const f=await serviceFixture(t),dir=await mkdtemp(join(tmpdir(),'mirror-native-')),storage=await openServerDatabase(dir),actors=new ActorStore(storage),collaboration=new Collaboration(storage,actors);
  isolatedTargetPaths(t,dir);
  const human=actors.resolveHuman({provider:'local',subject:'Alice',displayName:'Alice',expiresAt:Date.now()+60000});
  let sync:ChannelSync|undefined;
  t.after(async()=>{await sync?.close();await collaboration.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});});
  await collaboration.synchronizeChannels({method:'mirrorLink',params:{actorId:human.actorId,generation:human.generation,corpId:provider.corpId,userId:'Wei'}});
  assert.equal(actors.findHuman({provider:'wecom.'+provider.corpId,subject:'Wei'})?.id,human.actorId);
  for(let i=0;i<200;i++)assert.equal(await f.callback(String(i),'fixture '+i,{image:i===9}),200);
  const download=f.service.transport.images.download;
  f.service.transport.images.download=async()=>{throw Error('expired provider media');};
  assert.equal(await f.callback('9','fixture 9',{image:true}),200,'retained retry needs no provider media');
  assert.equal(await f.callback('overflow-image','',{image:true}),200,'full unbound room discards without media fetch');
  f.service.transport.images.download=download;
  assert.equal(await f.callback('overflow'),200);assert.equal((await f.store.snapshot(f.source)).count,200);
  const directory=await collaboration.synchronizeChannels({method:'mirrorDirectory',params:{corpId:provider.corpId}});
  await f.store.register('one','One',directory);
  assert.equal(await f.callback('select','保存 one',{mentioned:true}),200);
  await f.service.tick();await f.service.tick();assert.equal((await f.store.snapshot(f.source)).binding?.serverId,'one');
  let lostAck=true,deliveries=0;
  const target=()=>createMirrorTarget({relayOrigin:f.origin,allowLoopbackInsecure:true,serverId:'one',credential:f.credential,corpId:provider.corpId},{collaboration},async(url:any,options:any)=>{
    if(String(url).endsWith('/ack')&&lostAck){lostAck=false;throw Error('Lost ACK after native commit');}
    if(String(url).endsWith('/ack'))deliveries++;
    return fetch(url,options);
  });
  sync=await ChannelSync.open(await target(),collaboration);
  await until(async()=>Number(storage.database.prepare('SELECT COUNT(*) AS n FROM actor_channel_external_messages').get()!.n)>=1);
  await sync.close();sync=undefined;assert.ok((await f.store.snapshot(f.source)).count>0);
  sync=await ChannelSync.open(await target(),collaboration);
  await until(async()=>(await f.store.snapshot(f.source)).count===0,25000);
  assert.equal(storage.database.prepare('SELECT COUNT(*) AS n FROM actor_channel_external_messages').get()!.n,200);
  assert.equal(deliveries,200);
  const image=storage.database.prepare("SELECT bytes,state FROM actor_channel_images WHERE source=?").get(f.source)!;
  assert.equal(image.state,'ready');assert.deepEqual(Buffer.from(image.bytes as Uint8Array),png);
  const row=storage.database.prepare('SELECT channel_id FROM actor_channel_sources WHERE source=?').get(f.source)!;
  const channelId=String(row.channel_id);
  await collaboration.communicate(human,'opencraft/channels/messages/send',{channelId,clientMessageId:'outbound',parts:[{type:'text',text:'reply'}]});
  await until(async()=>f.sends.some(x=>x.text?.content?.includes('reply')));
  await collaboration.communicate(human,'channel/image/send',{channelId,clientMessageId:'outbound-image',type:'image/png',bytes:png});
  await until(async()=>f.sends.some(x=>x.msgtype==='image'));
  await sync.close();sync=await ChannelSync.open(await target(),collaboration);
  assert.equal(sync.transport.bindings.length,1,'existing groups restore even without queued arrivals');
  await collaboration.communicate(human,'opencraft/channels/messages/send',{channelId,clientMessageId:'after-restart',parts:[{type:'text',text:'restored'}]});
  await until(async()=>f.sends.some(x=>x.text?.content?.includes('restored')));
  assert.equal(await f.callback('0','fixture 0'),200);assert.equal((await f.store.snapshot(f.source)).count,0);
  await assert.rejects(collaboration.synchronizeChannels({method:'mirrorLink',params:{actorId:human.actorId,generation:human.generation+1,corpId:provider.corpId,userId:'Other'}}),/channel_denied/);
});

test('participation survives AOF recovery and registration expiry without reviving removed membership',async t=>{
  const f=await redisFixture(t),redis=await f.connect(),store=new MirrorStore(redis),human=humanKey('wxfixture','Wei');
  await store.register('one','One',{[human]:'human-one'});
  const first=await store.participation(human);assert.equal(first.available[0].id,'one');assert.ok(first.available[0].firstConfirmedAt>0);
  const historyKey=store.prefix+'participation:'+human;
  assert.equal(Number(await store.command('TTL',historyKey)),-1);
  await store.register('one','One',{});assert.deepEqual(await store.candidates(human),[]);assert.deepEqual((await store.participation(human)).available,[]);
  assert.equal(Number(await store.command('HLEN',historyKey)),1,'revocation does not erase the historical record');
  await store.register('one','One',{[human]:'human-one'});
  assert.equal((await store.participation(human)).available[0].firstConfirmedAt,first.available[0].firstConfirmedAt);
  await store.command('DEL',store.prefix+'server:one');assert.deepEqual((await store.participation(human)).available,[]);
  f.clients.forEach(c=>c.close());await f.stop();await f.start();
  const recovered=new MirrorStore(await f.connect());assert.equal(Number(await recovered.command('HLEN',historyKey)),1);
  assert.deepEqual(await recovered.candidates(human),[],'history is not live admission');
});

test('bound bare mentions reach assistant intake while unbound rooms retain onboarding and explicit help',async()=>{
  for(const bound of [true,false]) {
    const jobs:any[]=[];
    const store={snapshot:async()=>({binding:bound?{serverId:'one'}:null}),ingest:async(_event:any,_bytes:any,job:any)=>{jobs.push(job);return 'stored';}};
    const transport={subscribe:()=>()=>{}};
    const service=new MirrorService({store,transport,corpId:'wxfixture',servers:[]});
    const event={source:'room',id:'mention',author:'Wei',mentioned:true};
    await service.ingest({...event,text:'@Join 支持 (Join 支持)'});
    assert.equal(jobs[0]?.action,bound?undefined:'帮助');
    await service.ingest({...event,id:'help',text:'@Join 支持 (Join 支持) 帮助'});
    assert.equal(jobs[1].action,'帮助');
    assert.equal(jobs[1].userId,'Wei');
  }
});

test('every verified mention in an unbound room yields personal help; forwarding mode never offers a save command or stores a message',async t=>{
  const f=await serviceFixture(t,true),human=humanKey(provider.corpId,'Wei');
  await f.store.register('one','My server',{[human]:'human-one'});
  await f.store.register('two','Other private server',{[humanKey(provider.corpId,'Other')]:'human-other'});
  assert.equal(await f.callback('plain','hello'),200);assert.equal((await f.store.snapshot(f.source)).count,0);
  assert.equal(await f.callback('mention','@机器人 你好',{mentioned:true}),200);
  assert.equal(await f.callback('mention','@机器人 你好',{mentioned:true}),200);
  await f.service.tick();
  assert.equal(f.sends.length,1);const text=f.sends[0].markdown.content;assert.equal(f.sends[0].msgtype,'markdown');
  assert.match(text,/https:\/\/join.woa.com\/servers/);assert.doesNotMatch(text,/My server/);assert.match(text,/可用命令/);assert.match(text,/机器人 记录/);assert.doesNotMatch(text,/Other private server|机器人 保存/);
  assert.equal((await f.store.snapshot(f.source)).count,0);
  assert.equal(await f.callback('not-a-command','@机器人 保存 one',{mentioned:true}),200);await f.service.tick();
  assert.match(f.sends.at(-1).markdown.content,/沿用已有转发位置/);assert.equal((await f.store.snapshot(f.source)).binding,null);
  await f.store.register('one','My server',{});
  assert.equal(await f.callback('revoked','@机器人 记录',{mentioned:true}),200);await f.service.tick();
  assert.doesNotMatch(f.sends.at(-1).markdown.content,/My server|关联码/);assert.match(f.sends.at(-1).markdown.content,/访问权限/);
});

test('forwarding submodule queues one help notice while preserving the signed native callback and ordinary traffic',async t=>{
  const f=await redisFixture(t),redis=await f.connect(),store=new MirrorStore(redis),dir=await mkdtemp(join(tmpdir(),'wecom-forwarding-'));
  const expiresAt=Date.now()+60000;await redis.put('sessions','d'.repeat(64),{principal:{provider:'tencentoa',subject:'12345',displayName:'Wei',attributes:{loginName:'Wei'},aliases:['login:wei'],expiresAt},expiresAt},expiresAt,100);
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const privateFile=join(dir,'wecom.json');await writeFile(privateFile,JSON.stringify(provider),{mode:0o600});
  const received:string[]=[],sends:any[]=[];
  const receiver=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;received.push(body);res.end('native');});
  const receiverPort=await listen(receiver);t.after(()=>close(receiver));
  const ingress=await createForwardingIngress(privateFile,redis,guard=>createWeComCallbackIngress({hubId:'hub-'+'a'.repeat(40),origin:'http://receiver.test'},async()=>{
    const socket=connectSocket(receiverPort,'127.0.0.1');await once(socket,'connect');return socket;
  },guard),{listServers:async(principal:any)=>{assert.equal(principal.subject,'12345');return {servers:[{id:'mine',name:'Automatic personal server',route:'mine'}],pending:false};},fetcher:async(url:any,options:any)=>{
    if(url.pathname.endsWith('/convert_to_name')){assert.deepEqual(JSON.parse(options.body),{userid_list:['T10001A']});return Response.json({errcode:0,user_list:[{userid:'T10001A',name:'Wei'}]});}
    if(options?.body)sends.push(JSON.parse(options.body));return Response.json({errcode:0,access_token:'fixture-token',expires_in:7200});
  }});
  const server=createServer((req,res)=>{if(!ingress(req,res)){res.writeHead(404);res.end();}}),port=await listen(server);
  t.after(async()=>{await ingress.close?.();await close(server);});
  const source=JSON.stringify(['wecom-customer-service',provider.corpId,provider.serviceId,'room']);
  const payload=(mention:boolean)=>`<xml><ServiceId>${provider.serviceId}</ServiceId><ToUserName>${provider.corpId}</ToUserName><AgentType>chat</AgentType><Msg><From><Type>group</Type><Id>room</Id><Sender>T10001A</Sender></From><MsgId>${mention?'mention':'ordinary'}</MsgId><CreateTime>1700000000</CreateTime><MsgType>text</MsgType><MentionedType>${mention?'1':'0'}</MentionedType><Content>@机器人</Content></Msg></xml>`;
  const post=async(mention:boolean)=>{const {value,query}=encrypted(payload(mention));const body=`<xml>\r\n<Encrypt>${value}</Encrypt>\r\n</xml>`;const r=await fetch('http://127.0.0.1:'+port+'/wecom_callback?'+query,{method:'POST',body});assert.equal(r.status,200);assert.equal(await r.text(),'native');assert.equal(received.at(-1),body);};
  await post(false);await post(true);await post(true);
  await until(async()=>sends.length===1);assert.match(sends[0].markdown.content,/https:\/\/join.woa.com\/servers/);assert.equal(sends[0].msgtype,'markdown');assert.doesNotMatch(sends[0].markdown.content,/Automatic personal server/);assert.match(sends[0].markdown.content,/可用命令/);assert.doesNotMatch(sends[0].markdown.content,/关联码|机器人 关联/);assert.equal((await store.snapshot(source)).count,0);
});

test('directory-only target publishes native verified members and link proofs without polling or accepting messages',async t=>{
  const calls:any[]=[],listeners:any[]=[],human=humanKey(provider.corpId,'Wei');let stopped=false;
  const transport={bindings:[],subscribe(receive:any){listeners.push(receive);return()=>{stopped=true;};}};
  const wrapped=await withWeComDirectory(transport,{relayOrigin:'https://relay.test',serverId:'one',credential:randomBytes(32).toString('base64url'),corpId:provider.corpId},
    {collaboration:{async synchronizeChannels(command:any){assert.equal(command.method,'mirrorDirectory');return {[human]:'native-human'};}}},
    async(url:any,options:any)=>{const action=new URL(url).pathname.split('/').at(-1),input=JSON.parse(options.body);calls.push({action,input});if(action==='link-poll')return Response.json({links:[]});if(action==='link-start')return Response.json({code:'fixture-code'});if(action!=='register')throw Error('Directory may not poll message deliveries');return Response.json({ok:true});});
  t.after(()=>wrapped.close());const receive=async()=>{};const stop=wrapped.subscribe(receive);await until(async()=>calls.some(c=>c.action==='register'));
  assert.equal(listeners[0],receive);assert.deepEqual(calls.find(c=>c.action==='register').input.humans,{[human]:'native-human'});
  assert.deepEqual(await wrapped.link({actorId:'native-human',generation:1,credentialId:null}),{code:'fixture-code'});
  await assert.rejects(async()=>wrapped.link({actorId:'bot',generation:1,credentialId:'session'}),/channel_denied/);
  stop();await wrapped.close();assert.equal(stopped,true);assert.equal(calls.some(c=>c.action==='poll'),false);
});

test('commands use the authenticated sender, handle incomplete arguments and paginate bounded replies',async()=>{
  const user=humanKey('wxfixture','Wei'),event={mentioned:true,text:'@机器人 帮助',author:'Wei'};
  assert.equal(mentionCommand({...event,mentioned:false},'wxfixture'),undefined);
  const job=mentionCommand(event,'wxfixture');assert.equal(job.human,user);assert.equal(job.action,'帮助');
  const choices=Array.from({length:13},(_,i)=>({id:'server-'+i,name:'Server '+i}));
  const store={async candidates(human:string){assert.equal(human,user);return choices;},async participation(){return {available:choices};}};
  const text=await commandReply(store,'room',job);assert.match(text,/第 1\/3 页/);assert.ok(Buffer.byteLength(text)<4500);
  const second=await commandReply(store,'room',{...job,action:'服务器',serverId:'2'});assert.match(second,/Server 6/);assert.doesNotMatch(second,/Server 0/);
  assert.match(await commandReply(store,'room',{...job,action:'关联'}),/关联码/);
  assert.match(await commandReply(store,'room',{...job,action:'保存'}),/服务器ID/);
});

test('trusted employee aliases automatically resolve WeCom senders and persist relationships without linking',async t=>{
  const f=await redisFixture(t),redis=await f.connect(),now=Date.now();
  const principal={provider:'tencentoa',subject:'12345',displayName:'Not the login',attributes:{loginName:'Wei'},aliases:['login:wei'],expiresAt:now+60000};
  await redis.put('sessions','a'.repeat(64),{principal,route:{instanceId:'entry',origin:'http://entry.test'},expiresAt:now+60000},now+60000,100);
  await redis.put('sessions','b'.repeat(64),{principal:{...principal,subject:'999',expiresAt:now-1},expiresAt:now+60000},now+60000,100);
  await redis.put('sessions','c'.repeat(64),{principal:{...principal,provider:'other',subject:'999'},expiresAt:now+60000},now+60000,100);
  const known=await redis.knownPrincipals();assert.equal(known.filter(p=>p.provider==='tencentoa').length,1);
  let available=true,calls=0;
  const query=async(p:any)=>{calls++;assert.equal(p.subject,'12345');assert.equal(p.provider,'tencentoa');assert.ok(p.expiresAt>Date.now());return{servers:available?[{id:'one',name:'My server',route:'one'}]:[],pending:false};};
  const directory=createAutomaticDirectory(redis,provider.corpId,query),job={userId:'WEI',action:'记录'};
  const reply=await commandReply({},'room',job,{forwardingOnly:true,directory});assert.match(reply,/My server/);assert.doesNotMatch(reply,/关联码|机器人 关联/);assert.equal(calls,1);
  const key='wecom-directory:v1:participation:'+humanKey(provider.corpId,'wei');assert.equal(Number(await redis.client.call('TTL',redis.key(key))),-1);
  const first=(await directory(job)).history[0].firstConfirmedAt;
  await redis.delete('sessions','a'.repeat(64));
  const reloaded=createAutomaticDirectory(redis,provider.corpId,query);assert.equal((await reloaded(job)).history[0].firstConfirmedAt,first,'identity attestation survives browser session expiry');
  available=false;assert.deepEqual((await reloaded(job)).history,[],'history is filtered by fresh admission');assert.ok(JSON.parse((await redis.read(key))!).one,'revocation retains the observation without granting access');
  const stranger=await reloaded({userId:'Not the login'});assert.equal(stranger.unresolved,true);assert.equal(calls,4,'display names cannot resolve identity');
  const noLink=await commandReply({},'room',{...job,action:'关联'},{forwardingOnly:true,directory});assert.match(noLink,/无需关联码/);
});

test('automatic discovery distinguishes unavailable lookup from no prior identity and rejects ambiguous aliases',async t=>{
  const f=await redisFixture(t),redis=await f.connect(),expiresAt=Date.now()+60000;
  const claims=(subject:string)=>({provider:'tencentoa',subject,displayName:'Wei',attributes:{loginName:'Wei'},aliases:['login:wei'],expiresAt});
  for(const [id,subject]of [['a','123'],['b','456']])await redis.put('sessions',id.repeat(64),{principal:claims(subject),expiresAt},expiresAt,100);
  let calls=0;const query=async()=>{calls++;return {servers:[],pending:true};};
  const job={userId:'Wei',action:'记录'},directory=createAutomaticDirectory(redis,provider.corpId,query);
  assert.equal((await directory(job)).unresolved,true);assert.equal(calls,0);
  await redis.delete('sessions','b'.repeat(64));
  const resolved=createAutomaticDirectory(redis,provider.corpId,query);
  assert.equal((await resolved(job)).unresolved,true,'conflict remains quarantined after one session disappears');
  const other={...claims('789'),attributes:{loginName:'Another'},aliases:['login:another']};
  await redis.put('sessions','d'.repeat(64),{principal:other,expiresAt},expiresAt,100);
  const fresh=createAutomaticDirectory(redis,provider.corpId,query);
  assert.match(await commandReply({},'room',{...job,userId:'Another'},{forwardingOnly:true,directory:fresh}),/部分服务器暂时无法查询/);
  assert.match(await commandReply({},'room',{...job,userId:'newuser'},{forwardingOnly:true,directory:resolved}),/无需关联码/);
});

test('trusted directory port uses real Hub routes and rechecks target membership on every query', {timeout:20000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'trusted-directory-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),authority={issuer:'fixture',publicKey:publicKey.export({format:'pem',type:'spki'}).toString(),providers:['tencentoa']};
  const reserve=createServer(),port=await listen(reserve);await close(reserve);
  const stateFile=join(dir,'hub.json'),operator=join(dir,'operator.json'),origin='http://personal.test';
  const seed=new HubNetwork(stateFile,{authority,localService:false}),peer=new HubNetwork(join(dir,'peer.json'),{authority});t.after(()=>peer.close());
  let snapshot=seed.snapshot();await seed.command({revision:snapshot.revision,action:'configure',name:'Relay',endpoint:'http://127.0.0.1:'+port,origin:'',accepting:true,forwarding:true},'fixture');
  const invitation:any=await seed.command({revision:seed.snapshot().revision,action:'invite',origins:[origin],allowTransit:false},'fixture');seed.close();
  await writeFile(operator,JSON.stringify({credential:randomBytes(32).toString('base64url')}),{mode:0o600});
  let role='member',requests=0;
  const receiver=createServer((req,res)=>{requests++;assert.equal(req.url,'/__opencraft_access/session');assert.ok(req.headers['x-opencraft-relay-assertion']);res.writeHead(role==='member'?200:403,{'content-type':'application/json'});res.end(JSON.stringify({role}));});
  const receiverPort=await listen(receiver);t.after(()=>close(receiver));peer.start(receiverPort);
  let directory:any;
  const app=await startRelayApplication({schemaVersion:1,host:'127.0.0.1',port,routes:[{instanceId:'entry',origin:'http://entry.test',credential:randomBytes(32).toString('base64url')}],authentication:{issuer:authority.issuer,privateKey:privateKey.export({format:'pem',type:'pkcs8'}).toString(),origin:'http://entry.test',providers:['tencentoa']},hubNetwork:{stateFile,operatorCredentialFile:operator}},
    {createIdentity:async()=>({provider:{authenticate:()=>null},close(){}}),createIngress:services=>{directory=services.listServers;return()=>false;}});
  t.after(()=>app.close());
  await peer.command({revision:peer.snapshot().revision,action:'configure',name:'Personal server',endpoint:'',origin,accepting:false,forwarding:false},'fixture');
  await peer.command({revision:peer.snapshot().revision,action:'connect',invitation:invitation.invitation,trustIdentity:true,publishOrigin:origin},'fixture');
  await until(async()=>app.hub!.routes().some(r=>r.service.origin===origin));
  const principal={provider:'tencentoa',subject:'12345',displayName:'Wei',expiresAt:Date.now()+60000};
  const first=await directory(principal);assert.equal(first.servers.length,1);assert.equal(first.servers[0].id,peer.store.id);assert.equal(first.servers[0].name,'Personal server');
  role='denied';assert.deepEqual((await directory(principal)).servers,[]);assert.equal(requests,2);
  await assert.rejects(()=>directory({...principal,expiresAt:Date.now()-1}),/authentication_required/);
});


test('web selection links work without sender lookup and records cannot inject markdown links',async()=>{
  const directory=async()=>{throw Error('provider unavailable');};
  for(const action of ['帮助','help','服务器','关联','保存']) {
    const text=await commandReply({},'room',{action},{forwardingOnly:true,directory});
    assert.match(text,/\[打开 Join，选择服务器\]\(https:\/\/join.woa.com\/servers\)/);
    assert.doesNotMatch(text,/hub-|第 1\//);
  }
  const text=await commandReply({},'room',{action:'记录'},{forwardingOnly:true,directory:async()=>({servers:[],history:[{id:'private-id',name:'[fake](https://evil.test)\nnext'}]})});
  assert.doesNotMatch(text,/private-id|\[fake\]\(https:/);
  assert.match(text,/https:\/\/join.woa.com\/servers/);
});

test('browser group selection scopes identity and target, confirms binding, and waits for native SQLite receipt', {timeout:25000},async t=>{
  const f=await serviceFixture(t),dir=await mkdtemp(join(tmpdir(),'mirror-web-')),storage=await openServerDatabase(dir),actors=new ActorStore(storage),collaboration=new Collaboration(storage,actors);
  isolatedTargetPaths(t,dir);
  const human=actors.resolveHuman({provider:'local',subject:'Alice',displayName:'Alice',expiresAt:Date.now()+60000});
  const target=await createMirrorTarget({relayOrigin:f.origin,allowLoopbackInsecure:true,serverId:'one',credential:f.credential,corpId:provider.corpId},{collaboration});
  let sync:ChannelSync|undefined;
  t.after(async()=>{await sync?.close();await target.close();await collaboration.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});});
  let login='wei',enabled=true;
  const principal=()=>({provider:'tencentoa',subject:'123',attributes:{loginName:login},aliases:['login:'+login],expiresAt:Date.now()+60000});
  const options={store:f.store,transport:{resolveSender:async(source:string,id:string)=>{assert.equal(source,f.source);assert.equal(id,'Wei');return 'Wei';}},corpId:provider.corpId,
    authenticate:async()=>login?{principal:principal(),origin:'http://join.woa.com'}:null,beginLogin:async(_req:any,res:any)=>{res.writeHead(303,{location:'/login'});res.end();},listServers:async()=>({servers:[{id:'one',name:'One',route:'one-alias'},{id:'two',name:'Other',route:'two-alias'}],pending:false})};
  const selection=createGroupSelection({...options,enabled:true}),disabled=createGroupSelection({...options,enabled:false});
  const server=createServer((req,res)=>{if(!(enabled?selection:disabled).ingress(req,res)){res.writeHead(404);res.end();}}),port=await listen(server);t.after(()=>close(server));
  const reply=await selection.reply(f.source,{userId:'Wei'}),ticket=reply.match(/\/wecom\/record\/([\w-]+)/)![1];
  const path='/wecom/record/'+ticket,url='http://127.0.0.1:'+port+path;
  const headers={host:'join.woa.com',origin:'http://join.woa.com','content-type':'application/json','x-wecom-recording':'1'};
  const webFetch=(url:string,options:any={})=>new Promise<Response>((resolve,reject)=>{
    const req=httpRequest(url,{method:options.method??'GET',headers:options.headers},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers as Record<string,string>})));});req.on('error',reject);req.end(options.body);
  });
  const get=async()=>webFetch(url+'?status',{headers:{host:'join.woa.com'}});
  const post=async(body:any,extra:any={})=>webFetch(url,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.match(reply,/本群聊天记录/);assert.doesNotMatch(reply,/https:\/\/join.woa.com\/servers/);
  login='';assert.equal((await webFetch(url,{headers:{host:'join.woa.com',accept:'text/html'},redirect:'manual'})).status,303);
  login='other';assert.equal((await get()).status,403);login='wei';
  assert.equal((await webFetch(url+'x',{headers:{host:'join.woa.com'}})).status,410);
  const expired=await webFetch(url+'x',{headers:{host:'join.woa.com',accept:'text/html'}});
  assert.equal(expired.status,410);assert.match(expired.headers.get('content-type')!,/html/);
  assert.match(await expired.text(),/链接已过期/);
  assert.equal((await post({serverId:'one'},{origin:'http://evil.test'})).status,403);
  assert.deepEqual((await (await get()).json()).servers,[],'unregistered targets are not recordable');
  sync=await ChannelSync.open(target,collaboration);
  await until(async()=>(await f.store.recordingServers()).length===1);
  assert.deepEqual((await (await get()).json()).servers,[{id:'one',name:'One',route:'one-alias'}]);
  const html=await(await webFetch(url,{headers:{host:'join.woa.com',accept:'text/html'}})).text();assert.match(html,/确认保存到所选服务器/);assert.doesNotMatch(html,/location\.(replace|assign)/);
  assert.equal((await post({serverId:'two'})).status,403);
  const foreign=await f.store.beginLink('two','other',1);
  assert.equal((await post({serverId:'one',code:foreign.code})).status,409);
  const proof=await target.link(human);
  assert.equal((await post({serverId:'one',code:proof.code})).status,202);
  await until(async()=>(await f.store.candidates(humanKey(provider.corpId,'Wei'))).length===1);
  const chosen=await post({serverId:'one'});assert.equal(chosen.status,200);assert.equal((await chosen.json()).binding.delivered,false,'selection alone is not a storage receipt');
  assert.equal((await post({serverId:'two'})).status,409);
  assert.equal(await f.callback('web-selected-message','stored by web selection'),200);
  await until(async()=>(await f.store.snapshot(f.source)).lastDeliveredAt>0);
  await until(async()=>!!(await f.store.snapshot(f.source)).channelId);
  const final=await(await get()).json();assert.equal(final.binding.delivered,true);
  const native=storage.database.prepare('SELECT channel_id FROM actor_channel_sources WHERE source=?').get(f.source)!;
  assert.equal(final.binding.route,'one-alias');
  assert.equal(final.binding.serverId,'one');
  assert.equal(final.binding.channelId,native.channel_id,'deep link targets the room that actually stored the message');
  await f.store.registerChannels('two',[{source:f.source,channelId:'group:'+randomUUID()}]);
  assert.equal((await f.store.snapshot(f.source)).channelId,native.channel_id,'other receivers cannot overwrite a bound room');
  await f.store.command('HDEL',f.store.keys(f.source).meta,'channelId');
  await until(async()=>(await f.store.snapshot(f.source)).channelId===native.channel_id);
  assert.equal((await f.store.snapshot(f.source)).count,0,'existing delivered rooms recover links without another message');
  await assert.rejects(()=>f.store.registerChannels('one',[{source:f.source,channelId:'https://untrusted.test'}]),/invalid_channels/);
  assert.equal(final.binding.receiverOnline,true);
  assert.equal(storage.database.prepare("SELECT COUNT(*) AS n FROM actor_messages WHERE content='stored by web selection'").get()!.n,1);
  await target.close();await f.store.command('DEL',f.store.prefix+'server:one');
  const offline=await(await get()).json();assert.equal(offline.binding.delivered,true);
  assert.equal(offline.binding.receiverOnline,false);assert.equal(offline.binding.name,'One');
  enabled=false;
  const another=await disabled.reply(f.source+'-new',{userId:'Wei'});assert.match(another,/wecom\/record/);assert.match(another,/尚未接通/);assert.doesNotMatch(another,/确认后开始同步/);
  assert.equal((await post({serverId:'one'})).status,409,'disabled forwarding mode cannot claim storage');
});

test('binding preserves history without replaying old assistant mentions; live mentions keep durable eligibility',async t=>{
 const f=await redisFixture(t),store=new MirrorStore(await f.connect()),source='assistant-room';
 const old={source,id:'before',author:'Wei',text:'总结',at:1000,mentioned:true};
 await store.ingest(old);
 const human=humanKey('wxfixture','Wei');await store.register('one','One',{[human]:'human-fixture'},true);
 await store.bind(source,human,'one','Group');
 assert.equal(await store.ingest(old),'duplicate');
 await store.ingest({...old,id:'after'});
 let token=await store.claim(source);let event=await store.head(source,token);assert.equal(event.assistantEligible,false);
 await store.ack(source,token,event.id);await store.release(source,token);
 token=await store.claim(source);event=await store.head(source,token);assert.equal(event.assistantEligible,true);
 await store.release(source,token);
});

test('multi-person submissions are atomic and survive Redis restart; retirement fences old traffic',async t=>{
 const f=await redisFixture(t),store=new MirrorStore(await f.connect());
 const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','multi-room']);
 const human=humanKey('wxfixture','owner');await store.register('server','Server',{[human]:'actor'},true);
 await store.bind(source,human,'server','Room');const generation=(await store.snapshot(source)).binding.generation;
 const answer=(actor:string)=>({actor,author:actor,selected:[{questionKey:'q0',optionIds:['o1']}],choice:'饭'});
 await Promise.all(['alice','bob'].map(a=>store.submitCard(source,'poll',a,answer(a))));
 assert.equal((await store.submitCard(source,'poll','alice',answer('alice'))).answers.length,2);
 await f.stop();await f.start();const recovered=new MirrorStore(await f.connect());
 const closed=await recovered.submitCard(source,'poll','owner',undefined,true);assert.equal(closed.answers.length,2);assert.equal(closed.closed,true);
 assert.equal((await recovered.submitCard(source,'poll','charlie',answer('charlie'))).accepted,false);
 await recovered.ingest({source,id:'queued',author:'owner',text:'hi',at:Date.now()});
 await recovered.retire(source,'server','quit-request');assert.equal((await recovered.snapshot(source)).binding,null);
 assert.equal(await recovered.retirement(source,'server','quit-request'),true);
 assert.equal(await recovered.ingest({source,id:'late',author:'owner',text:'late',at:Date.now()}),'ignored');
 await recovered.bind(source,human,'server','Room');assert.notEqual((await recovered.snapshot(source)).binding.generation,generation);
 assert.equal((await recovered.snapshot(source)).count,0);
});

test('poll deadlines atomically reject late submissions and durable reminders survive AOF restart',async t=>{
 const f=await redisFixture(t),store=new MirrorStore(await f.connect()),source='deadline-room',now=Date.now();
 await store.rememberCard(source,'poll',{multi:true,deadlineAt:now+1000});
 await store.scheduleInteraction(source,'poll',now+1000,now+500);
 await store.scheduleInteraction(source,'poll',now+1000,now+500);
 assert.equal((await store.dueInteractions(now+600)).length,1);
 const answer={author:'alice',actor:'alice',selected:[{questionKey:'q0',optionIds:['o0']}],choice:'a'};
 assert.equal((await store.submitCard(source,'poll','alice',answer,false,now+999)).accepted,true);
 const late=await store.submitCard(source,'poll','bob',{...answer,author:'bob'},false,now+1000);
 assert.equal(late.closed,true);assert.equal(late.accepted,false);assert.equal(late.answers.length,1);
 await store.rememberShortcut(source,'key',{prompt:'查询我的状态',binding:{generation:'old'}});
 await f.stop();await f.start();const recovered=new MirrorStore(await f.connect());
 assert.equal((await recovered.dueInteractions(now+1001)).length,2);
 assert.equal((await recovered.shortcut(source,'key')).prompt,'查询我的状态');
 assert.equal(await recovered.shortcut('another-room','key'),null);
 const jobs=await recovered.dueInteractions(now+1001);await recovered.finishInteractionSchedule(jobs[0].member);
 assert.equal((await recovered.dueInteractions(now+1001)).length,1);
 assert.equal((await recovered.submitCard(source,'poll','alice',answer,false,now+1001)).accepted,false);
});

test('manual collection close atomically cancels deadline and reminder jobs, keeping the reason across restart',async t=>{
 const f=await redisFixture(t),store=new MirrorStore(await f.connect()),source='manual-close-room',now=Date.now();
 await store.rememberCard(source,'poll',{multi:true,deadlineAt:now+1000});await store.scheduleInteraction(source,'poll',now+1000,now+500);
 const closed=await store.submitCard(source,'poll','owner',undefined,true,now);assert.equal(closed.closedReason,'manual');assert.equal((await store.dueInteractions(now+2000)).length,0);
 await f.stop();await f.start();const recovered=new MirrorStore(await f.connect());
 assert.equal((await recovered.submitCard(source,'poll','',undefined,true,now+2000,'deadline')).closedReason,'manual','an already-read timer must not overwrite a manual close');
 assert.equal((await recovered.dueInteractions(now+2000)).length,0);
 await recovered.rememberCard(source,'auto',{multi:true,deadlineAt:now+3000});const automatic=await recovered.submitCard(source,'auto','',undefined,true,now+3000,'deadline');assert.equal(automatic.closedReason,'deadline');
});

test('media follow-up admission remains frozen in real Redis after the window expires and across AOF restart',async t=>{
 const f=await redisFixture(t);let redis=await f.connect(),store=new MirrorStore(redis);const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','followup']);
 await store.openWindow(source,'owner',5000);assert.equal(await store.followUpDecision(source,'image','owner'),true);await redis.client.call('DEL',store.windowKey(source,'owner'));
 assert.equal(await store.followUpDecision(source,'image','owner'),true);assert.equal(await store.followUpDecision(source,'other','owner'),false);assert.equal(await store.followUpDecision(source,'image','someone-else'),false);
 for(const c of f.clients)c.close();await f.stop();await f.start();redis=await f.connect();store=new MirrorStore(redis);assert.equal(await store.followUpDecision(source,'image','owner'),true);assert.equal(await store.followUpDecision(source,'other','owner'),false);
});
