import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { HubNetwork } from '../../packages/hub-network/src/node.js';
import { parseInvitation,random,signed } from '../../packages/hub-network/src/store.js';
import { createIpEnrollmentIngress,internalSourceIp,HUB_ENROLLMENT_PATH } from '../ip-enrollment.js';
import { RelayRedis } from '../../apps/relay-server/src/redis.js';

test('IP policy accepts only valid 9/10/11 IPv4 addresses and mapped socket addresses',()=>{
  for(const ip of ['9.0.0.1','10.255.255.254','11.1.2.3','::ffff:9.1.2.3'])assert.ok(internalSourceIp(ip));
  for(const ip of ['8.1.2.3','12.1.2.3','19.1.2.3','90.1.2.3','109.1.2.3','127.0.0.1','192.168.1.1','9.999.1.1','9.1.1.1, 8.1.1.1','::1','2001:db8::9',undefined])assert.equal(internalSourceIp(ip),null);
});
async function fixture(t:test.TestContext,redis?:RelayRedis,otherRedis?:RelayRedis) {
  const dir=await mkdtemp(join(tmpdir(),'ip-enrollment-')),cert=join(dir,'cert.pem'),key=join(dir,'key.pem');
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-keyout',key,'-out',cert]);
  const ca=await readFile(cert,'utf8'),pair=generateKeyPairSync('ed25519');
  const authority={issuer:'fixture',publicKey:pair.publicKey.export({format:'pem',type:'spki'}).toString(),providers:['fixture']};
  const hub=new HubNetwork(join(dir,'relay.json'),{authority,ca,localService:false});
  const events:any[]=[];
  let cached:ReturnType<HubNetwork['snapshot']>|undefined;
  const lagging={snapshot:()=>cached??=hub.snapshot(),command:(input:Record<string,unknown>,operator:string)=>hub.command(input,operator),routes:()=>hub.routes(),open:hub.open.bind(hub),handleUpgrade:hub.handleUpgrade.bind(hub)};
  const replicas=[createIpEnrollmentIngress(hub,redis,event=>events.push(event)),createIpEnrollmentIngress(lagging,otherRedis,event=>events.push(event))];
  let ip='9.1.2.3';
  const server=createServer({cert:ca,key:await readFile(key)},(req,res)=>{
    // TCP source is projected only by this controlled fixture; no request header
    // participates. The actual connection and enrollment protocol use TLS.
    Object.defineProperty(req.socket,'remoteAddress',{value:ip,configurable:true});
    const handler=replicas[req.headers['x-fixture-replica']==='2'?1:0];
    if(!handler(req,res)){res.writeHead(404);res.end();}
  });server.on('upgrade',(req,socket,head)=>{if(!hub.handleUpgrade(req,socket,head))socket.destroy();});
  server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint='https://127.0.0.1:'+(server.address()as{port:number}).port;
  hub.command({action:'configure',revision:hub.snapshot().revision,name:'Fixture Relay',endpoint,origin:'',accepting:true,forwarding:true},'fixture');
  const client=new HubNetwork(join(dir,'client.json'));
  const proof=()=>{const p={audience:'opencraft-hub-enrollment.v1',relay:endpoint,hubId:client.store.id,publicKey:client.store.state.publicKey,origin:'https://fixture.example',timestamp:Date.now(),nonce:random()};return {...p,signature:signed(p,client.store.state.privateKey)};};
  const post=(body:unknown,headers:Record<string,string>={})=>new Promise<{status:number;body:any}>((resolve,reject)=>{
    const req=httpsRequest(endpoint+HUB_ENROLLMENT_PATH,{method:'POST',ca,headers:{'content-type':'application/json',...headers}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(b)}));});req.on('error',reject);req.end(JSON.stringify(body));
  });
  t.after(async()=>{client.close();await Promise.all(replicas.map(r=>r.close?.()));hub.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});await rm(dir,{recursive:true,force:true});});
  return {dir,hub,client,events,post,proof,endpoint,ca,setIp:(value:string)=>{ip=value;}};
}
test('only a valid internal-source proof enrolls; headers, replay and key substitution fail closed',async t=>{
  const f=await fixture(t);f.setIp('8.8.8.8');
  assert.equal((await f.post(f.proof(),{'x-forwarded-for':'9.1.1.1',forwarded:'for=10.1.1.1','x-real-ip':'11.1.1.1'})).status,403);
  f.setIp('10.1.1.1');assert.equal((await f.post(f.proof(),{origin:'https://join.woa.com'})).status,403);
  assert.equal((await f.post({...f.proof(),relay:'https://wrong.example'})).status,400);
  assert.equal((await f.post({...f.proof(),timestamp:Date.now()-600000})).status,400);
  assert.equal((await f.post({...f.proof(),signature:'invalid'})).status,403);
  const proof=f.proof(),first=await f.post(proof);assert.equal(first.status,200);assert.equal((await f.post(proof)).status,409);
  const retry=await f.post(f.proof());assert.equal(retry.status,200);
  assert.equal(parseInvitation(first.body.invitation).credential,parseInvitation(retry.body.invitation).credential,'lost HTTP response can be retried without rotating credentials');
  assert.equal(f.hub.store.state.invitations.length,1);
  assert.equal(f.hub.store.state.invitations[0].hubId,f.client.store.id);
  const log=JSON.stringify(f.events);for(const value of [f.client.store.state.publicKey,proof.signature,first.body.invitation,parseInvitation(first.body.invitation).credential])assert.equal(log.includes(value),false);
  assert.deepEqual(Object.keys(f.events[0]).sort(),['event','ip','status']);
  assert.equal(f.events[0].ip,'8.8.8.8');
  assert.ok(f.hub.snapshot().audit[0].operator.startsWith('source-ip:'));
});
test('real shared Redis fences the same join proof across replicas and fails closed without shared state',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ip-enrollment-redis-')),reserved=createHttpServer();reserved.listen(0,'127.0.0.1');await once(reserved,'listening');const port=(reserved.address()as{port:number}).port;await new Promise<void>(r=>reserved.close(()=>r()));
  const child=spawn(process.env.REDIS_SERVER??'redis-server',['--bind','127.0.0.1','--port',String(port),'--requirepass','synthetic-fixture','--save','','--dir',dir],{stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{child.on('error',reject);child.stdout.on('data',c=>{if(String(c).includes('Ready to accept connections'))resolve();});});
  const configuration={host:'127.0.0.1',port,mode:'standalone' as const,password:'synthetic-fixture',credential:random(),namespace:'ip-enrollment-'+random().slice(0,12),internalPort:port};
  const a=await RelayRedis.connect(configuration),b=await RelayRedis.connect(configuration);
  t.after(async()=>{a.close();b.close();const exited=once(child,'exit');child.kill('SIGTERM');await exited;await rm(dir,{recursive:true,force:true});});
  const f=await fixture(t,a,b),proof=f.proof();
  const results=await Promise.all([f.post(proof),f.post(proof,{'x-fixture-replica':'2'})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const retry=await f.post(f.proof(),{'x-fixture-replica':'2'});assert.equal(retry.status,200);assert.equal(f.hub.store.state.invitations.length,1);
  assert.equal((await f.post(f.proof(),{'x-fixture-replica':'2'})).status,200,'a lagging replica retries with the committed owner revision');
  a.close();b.close();assert.equal((await f.post(f.proof())).status,503);
});
test('local state changes and owner close fence late enrollment responses',async t=>{
  const f=await fixture(t),started=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();
  const original=f.hub.command.bind(f.hub);
  f.hub.command=((input:any,operator:string)=>{const result=original(input,operator);if(input.action!=='enroll')return result;started.resolve();return gate.promise.then(()=>result);})as typeof f.hub.command;
  const connecting=f.client.connectEndpoint(f.endpoint,{ca:f.ca,trustIdentity:true},'fixture');await started.promise;
  f.client.command({action:'configure',revision:f.client.snapshot().revision,name:'New local intent',endpoint:'',origin:'',accepting:false,forwarding:false},'fixture');gate.resolve();
  assert.equal('conflict'in await connecting,true);assert.equal(f.client.store.state.peers.length,0);
  const next=Promise.withResolvers<void>(),pending=Promise.withResolvers<void>();
  f.hub.command=((input:any,operator:string)=>{const result=original(input,operator);next.resolve();return pending.promise.then(()=>result);})as typeof f.hub.command;
  const closing=f.client.connectEndpoint(f.endpoint,{ca:f.ca,trustIdentity:true},'fixture');await next.promise;f.client.close();pending.resolve();await assert.rejects(closing);assert.equal(f.client.store.state.peers.length,0);
});
test('a machine joins by address, preserves explicit identity trust, reconnects and retains one pinned identity',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.client.connectEndpoint(f.endpoint,{publishOrigin:'https://fixture.example',ca:f.ca},'fixture'),/explicitly accepted/);
  const result=await f.client.connectEndpoint(f.endpoint,{publishOrigin:'https://fixture.example',trustIdentity:true,ca:f.ca},'fixture');assert.ok(!('conflict'in result));
  const target=createHttpServer((_req,res)=>{res.writeHead(401);res.end();});target.listen(0,'127.0.0.1');await once(target,'listening');
  t.after(()=>new Promise<void>(resolve=>{target.close(()=>resolve());target.closeAllConnections();}));
  f.hub.start((new URL(f.endpoint)).port?Number(new URL(f.endpoint).port):443);f.client.start((target.address()as{port:number}).port);
  const until=async(check:()=>boolean)=>{const end=Date.now()+8000;while(!check()){if(Date.now()>end)throw Error('connection failed');await new Promise(r=>setTimeout(r,20));}};
  await until(()=>f.hub.links.has(f.client.store.id));assert.equal(f.hub.routes()[0].service.origin,'https://fixture.example');
  const old=f.hub.links.get(f.client.store.id)!;old.ws.terminate();await until(()=>!!f.hub.links.get(f.client.store.id)&&f.hub.links.get(f.client.store.id)!==old);
  assert.equal(f.hub.store.state.invitations.length,1);assert.equal(f.client.store.state.peers.length,1);
  const other=new HubNetwork(join(f.dir,'other.json'));t.after(()=>other.close());
  await assert.rejects(other.connectEndpoint(f.endpoint,{publishOrigin:'https://fixture.example',trustIdentity:true,ca:f.ca},'fixture'),/denied/);
});
test('persisted enrollment survives owner restart and revocation retires its old credential',async t=>{
  const f=await fixture(t),first=await f.post(f.proof());assert.equal(first.status,200);
  const original=parseInvitation(first.body.invitation),statePath=join(f.dir,'relay.json');f.hub.close();
  const restored=new HubNetwork(statePath);t.after(()=>restored.close());
  const enroll=()=>restored.command({action:'enroll',revision:restored.snapshot().revision,peer:{hubId:f.client.store.id,publicKey:f.client.store.state.publicKey},origin:'https://fixture.example'},'source-ip:11.1.2.3');
  const retry=enroll();assert.ok('invitation'in retry);assert.equal(parseInvitation(retry.invitation).credential,original.credential);
  restored.command({action:'revoke',revision:restored.snapshot().revision,id:original.id},'fixture');
  const fresh=enroll();assert.ok('invitation'in fresh);assert.notEqual(parseInvitation(fresh.invitation).credential,original.credential);
  restored.close();
});
test('rejoining upgrades a saved manual invitation and keeps a single usable peer',async t=>{
  const f=await fixture(t);
  const issued=f.hub.command({action:'invite',revision:f.hub.snapshot().revision,origins:['https://fixture.example'],allowTransit:false},'fixture');assert.ok('invitation'in issued);
  f.client.command({action:'connect',revision:f.client.snapshot().revision,invitation:issued.invitation,trustIdentity:true,publishOrigin:'https://fixture.example'},'fixture');
  // The control handshake normally pins this incoming record. Bind the same
  // verified machine here before testing the migration of its saved credential.
  const incoming=f.hub.store.state.invitations[0];incoming.hubId=f.client.store.id;incoming.publicKey=f.client.store.state.publicKey;
  const oldCredential=f.client.store.state.peers[0].credential;
  await f.client.connectEndpoint(f.endpoint,{ca:f.ca,trustIdentity:true,publishOrigin:'https://fixture.example'},'fixture');
  const updated=f.client.store.state.peers[0].credential;assert.notEqual(updated,oldCredential);assert.equal(f.client.store.state.peers.length,1);
  await f.client.connectEndpoint(f.endpoint,{trustIdentity:true,publishOrigin:'https://fixture.example'},'fixture');
  assert.equal(f.client.store.state.peers.length,1);assert.equal(f.client.store.state.peers[0].credential,updated);
});
