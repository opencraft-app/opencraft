import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {WebSocket,WebSocketServer} from 'ws';
import {PersonalMachines,personalMachineOrigin,personalMachineEnrollmentOrigin} from '../../apps/local-agent-host/src/personal-machines';
import {PersonalMachineStore} from '../../apps/local-agent-host/src/personal-machines-store';
import {connectRelay} from '../../plugins/relay-connect/src/server';
import {createLocalIngress} from '../../packages/hub-network/src/local-ingress';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const machine={machineId:'11111111-1111-4111-8111-111111111111',name:'Remote fixture',platform:'linux' as const};
const wait=async(f:()=>boolean)=>{for(let i=0;i<200;i++){if(f())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Machine state did not settle');};
async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'personal-machines-')),archive=join(root,'source.tgz'),installer=join(root,'install.sh');await writeFile(archive,'source');await writeFile(installer,'#!/bin/bash\n');
 const enrollmentOrigin='https://machine.fixture.example';
 const token=randomBytes(24).toString('base64url');const service=new PersonalMachines({directory:root,ownerActorId:'human:owner',ownerToken:token,archive,digest:hash('source'),installer,enrollmentOrigin});await service.ready();
 const server=createServer((req,res)=>void service.http(req,res).then(ok=>{if(!ok){res.writeHead(404);res.end();}}));server.on('upgrade',(r,s,h)=>{if(!service.upgrade(r,s,h))s.destroy();});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+(server.address() as any).port;
 t.after(async()=>{await service.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});});
 const actualFetch=globalThis.fetch;t.mock.method(globalThis,'fetch',(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{const url=String(input);return actualFetch(url.startsWith(enrollmentOrigin+'/')?origin+url.slice(enrollmentOrigin.length):input,init);});
 const result=await service.command({action:'create'});assert(result.command);
 const pairingKey=/-- ([A-Za-z0-9_-]{43})/.exec(result.command)![1]!;
 const bootstrap=await (await fetch(origin+'/__opencraft_machines/bootstrap',{headers:{authorization:'Bearer '+pairingKey}})).json();
 assert(result.command.length<220,'generated command contains one URL and a short key');
 const credential=randomBytes(32).toString('base64url');
 const claim=(secret=credential)=>fetch(origin+'/__opencraft_machines/enroll?id='+bootstrap.id,{method:'POST',headers:{authorization:'Bearer '+bootstrap.secret,'content-type':'application/json'},body:JSON.stringify({credentialHash:hash(secret),machine})});
 return {root,service,origin,enrollmentOrigin,bootstrap,credential,claim,token,command:result.command};
}
test('pairing is private, durable, single machine and scoped to its local owner',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.origin+'/__opencraft_machines/status')).status,403);
 assert.equal((await fetch(f.origin+'/__opencraft_machines/source.tgz?id='+f.bootstrap.id)).status,403);
 assert.equal((await f.claim()).status,200);
 assert.equal((await f.claim()).status,200,'same durable identity reconciles a lost response');
 assert.equal((await f.claim(randomBytes(32).toString('base64url'))).status,403,'a used command cannot claim a second machine');
 assert.equal(f.service.directory().ownerActorId,'human:owner');
 const text=await readFile(join(f.root,'personal-machines.json'),'utf8');assert(!text.includes(f.credential));assert(!text.includes(f.bootstrap.secret));assert.equal((await stat(join(f.root,'personal-machines.json'))).mode&0o777,0o600);
 await f.service.close();const restored=new PersonalMachineStore(f.root,'human:owner');await restored.ready;assert.equal(restored.state.machines[0]!.credentialHash,hash(f.credential));await restored.close();
 const wrong=new PersonalMachineStore(f.root,'human:someone-else');await assert.rejects(wrong.ready);await wrong.close();
});
test('remote Relay attachment reuses native RPC, reconnects without replay and revokes live channels',async t=>{
 const f=await fixture(t);assert.equal((await f.claim()).status,200);
 const native=createServer(),sockets=new WebSocketServer({noServer:true});let executions=0;
 native.on('upgrade',(r,s,h)=>{if(r.url!=='/rpc?token=private-native-token'){s.destroy();return;}sockets.handleUpgrade(r,s,h,ws=>sockets.emit('connection',ws));});
 sockets.on('connection',ws=>ws.on('message',raw=>{const p=JSON.parse(String(raw));if(p.method==='turn/start')executions++;ws.send(JSON.stringify({id:p.id,result:p.method==='runtime/machine/read'?{machine,agent:'OpenCraft'}:{data:[{id:'native-existing'}],executions}}));}));
 await new Promise<void>(r=>native.listen(0,'127.0.0.1',r));
 const ingress=createLocalIngress(()=>({port:(native.address() as any).port,origin:'http://personal-machine',path:'/rpc?token=private-native-token'}),['/rpc']);
 let relay=connectRelay({relay:f.origin,credential:f.credential,allowLoopbackInsecure:true,acceptStream:s=>ingress.accept(s)});
 t.after(async()=>{relay.close();ingress.close();for(const ws of sockets.clients)ws.terminate();sockets.close();await new Promise<void>(r=>native.close(()=>r()));});
 await wait(()=>f.service.directory().machines[0]?.connected===true);
 const connect=async(token=f.token)=>{const ws=new WebSocket(f.origin.replace('http','ws')+'/__opencraft_machines/'+f.bootstrap.id+'/rpc',{headers:{authorization:'Bearer '+token}});await once(ws,'open');return ws;};
 await assert.rejects(connect('wrong'));
 let ws=await connect();const call=async(method:string)=>{const response=once(ws,'message');ws.send(JSON.stringify({id:1,method,params:{}}));return JSON.parse(String((await response)[0]));};
 assert.deepEqual((await call('runtime/machine/read')).result,{machine,agent:'OpenCraft'});
 await call('turn/start');assert.equal(executions,1);
 const closed=once(ws,'close');relay.close();await closed;
 relay=connectRelay({relay:f.origin,credential:f.credential,allowLoopbackInsecure:true,acceptStream:s=>ingress.accept(s)});
 await wait(()=>f.service.directory().machines[0]?.connected===true);ws=await connect();await call('thread/list');assert.equal(executions,1,'attachment recovery does not replay a native input');
 const revoked=once(ws,'close');await f.service.command({action:'revoke',id:f.bootstrap.id});await revoked;assert.equal(f.service.directory().machines.length,0);await assert.rejects(connect());
});
test('storage failure fences current relay credentials',async t=>{
 const f=await fixture(t);assert.equal((await f.claim()).status,200);await (f.service.store as any).worker.terminate();await wait(()=>!f.service.store.available);
 await assert.rejects(f.service.command({action:'list'}));
});
test('enrollment address rejects insecure public origins and path confusion',()=>{
 assert.equal(personalMachineOrigin('https://example.test'),'https://example.test');
 for(const origin of ['http://example.test','https://example.test/path','https://user:secret@example.test','file:///tmp'])assert.throws(()=>personalMachineOrigin(origin));
});

test('concurrent enrollment admits one durable claimant',async t=>{
 const f=await fixture(t);
 const responses=await Promise.all([f.claim(),f.claim(randomBytes(32).toString('base64url'))]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,403]);
 assert.equal(f.service.directory().machines.filter(m=>m.phase==='enrolled').length,1);
});
test('expired pairing cannot enroll after restart',async t=>{
 const f=await fixture(t);await f.service.close();
 const path=join(f.root,'personal-machines.json');const state=JSON.parse(await readFile(path,'utf8'));
 state.machines[0].expiresAt=Date.now()-1;await writeFile(path,JSON.stringify(state),{mode:0o600});
 const restored=new PersonalMachineStore(f.root,'human:owner');await restored.ready;
 try{await assert.rejects(restored.command('claim',{id:f.bootstrap.id,pairHash:hash(f.bootstrap.secret),credentialHash:hash(f.credential),machine}));}
 finally{await restored.close();}
});

test('generated Bash command preserves installer and download failures',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);
 const run=()=>new Promise<number|null>((resolve,reject)=>{const child=spawn('bash',[],{stdio:['pipe','ignore','ignore']});child.once('error',reject);child.once('exit',resolve);child.stdin.end(f.command.replaceAll(f.enrollmentOrigin,f.origin)+'\n');});
 assert.equal(await run(),0);
 await writeFile(join(f.root,'install.sh'),'#!/bin/bash\nexit 9\n');
 assert.equal(await run(),9,'a failing installer cannot report successful enrollment');
 await f.service.close();
 assert.notEqual(await run(),0,'a failed script download cannot become an empty successful Bash invocation');
});

test('Server owns a deployment-owned HTTPS enrollment address and rejects loopback, intranet HTTP and browser-origin overrides',async t=>{
 const f=await fixture(t);
 assert.equal(personalMachineEnrollmentOrigin('https://relay.example.test'),'https://relay.example.test');
 assert.equal(f.bootstrap.origin,f.enrollmentOrigin);assert.equal(f.service.directory().enrollmentOrigin,f.enrollmentOrigin);
 await assert.rejects(f.service.command({action:'create',origin:'http://127.0.0.1:5173'} as any));
 for(const origin of ['http://10.42.0.8:15473','http://192.168.1.2:15473','http://172.16.0.1:15473','http://127.0.0.1:5173','https://127.0.0.1','https://127.2.3.4','https://localhost','https://localhost.','https://sub.localhost','https://[::1]','https://[::ffff:127.0.0.1]','https://0.0.0.0','http://8.8.8.8','http://192.168.1.2.example'])assert.throws(()=>personalMachineEnrollmentOrigin(origin));
 const unavailable=new PersonalMachines({directory:join(f.root,'no-origin'),ownerActorId:'human:owner',ownerToken:f.token,archive:join(f.root,'source.tgz'),digest:hash('source'),installer:join(f.root,'install.sh')});
 try{await unavailable.ready();assert.equal(unavailable.directory().enrollmentOrigin,null);await assert.rejects(unavailable.command({action:'create'}));assert.equal(unavailable.directory().machines.length,0);}finally{await unavailable.close();}
});
test('a login page, wrong Server or unavailable public entrance cannot mint a command',async t=>{
 const f=await fixture(t);const count=f.service.directory().machines.length;
 t.mock.method(globalThis,'fetch',async()=>new Response('login',{status:200}));
 await assert.rejects(f.service.command({action:'create'}));assert.equal(f.service.directory().machines.length,count);
});

test('directory reports connected machine runtime version, update availability and one-line update command',async t=>{
 const f=await fixture(t);assert.equal((await f.claim()).status,200);
 const outdated=connectRelay({relay:f.origin,credential:f.credential,headers:{'x-opencraft-machine-version':'0'.repeat(64)},allowLoopbackInsecure:true,acceptStream:s=>s.destroy()});
 t.after(()=>outdated.close());
 await wait(()=>f.service.directory().machines[0]?.connected===true);
 const before=f.service.directory().machines[0]!;
 assert.equal(before.version,'0'.repeat(64));
 assert.equal(before.updateAvailable,true);
 assert.match(before.updateCommand??'',/--update /);
 outdated.close();

 const current=connectRelay({relay:f.origin,credential:f.credential,headers:{'x-opencraft-machine-version':hash('source')},allowLoopbackInsecure:true,acceptStream:s=>s.destroy()});
 t.after(()=>current.close());
 await wait(()=>f.service.directory().machines[0]?.version===hash('source'));
 assert.equal(f.service.directory().machines[0]?.updateAvailable,false);
});

test('packagePersonalMachine snapshots unstaged tracked edits without touching git index or archiving untracked files',async t=>{
 const {execFileSync}=await import('node:child_process');
 const {packagePersonalMachine}=await import('../../scripts/package-personal-machine.mjs');
 const repo=await mkdtemp(join(tmpdir(),'oc-pkg-machine-')),out=join(repo,'out');
 t.after(()=>rm(repo,{recursive:true,force:true}));
 execFileSync('git',['init'],{cwd:repo,stdio:'ignore'});
 execFileSync('git',['config','user.email','test@example.invalid'],{cwd:repo});
 execFileSync('git',['config','user.name','Test'],{cwd:repo});
 await writeFile(join(repo,'tracked.txt'),'v1\n');
 execFileSync('git',['add','tracked.txt'],{cwd:repo});
 execFileSync('git',['commit','-m','init'],{cwd:repo,stdio:'ignore'});
 await writeFile(join(repo,'tracked.txt'),'v2-unstaged\n');
 await writeFile(join(repo,'1.txt'),'private-untracked-note\n');
 const result=await packagePersonalMachine(repo,out);
 const entries=execFileSync('tar',['-tzf',result.path]).toString().trim().split('\n');
 assert.deepEqual(entries,['tracked.txt']);
 assert.equal(execFileSync('tar',['-xzOf',result.path,'tracked.txt']).toString(),'v2-unstaged\n');
 assert.equal(execFileSync('git',['diff','--cached','--name-only'],{cwd:repo}).toString().trim(),'','real git index remains untouched');
});

 test('short key configuration is private and disappears after use or revocation',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.origin+'/__opencraft_machines/bootstrap')).status,403);
 assert.equal((await f.claim()).status,200);
 assert.equal((await fetch(f.origin+'/__opencraft_machines/bootstrap',{headers:{authorization:'Bearer '+f.bootstrap.secret}})).status,403);
 await f.service.command({action:'revoke',id:f.bootstrap.id});
 assert.equal((await fetch(f.origin+'/__opencraft_machines/bootstrap',{headers:{authorization:'Bearer '+f.bootstrap.secret}})).status,403);
});

test('enrolled update endpoints require the existing machine credential and honor revocation',async t=>{
 const f=await fixture(t);assert.equal((await f.claim()).status,200);
 const path='/__opencraft_machines/bootstrap?update=1&id='+f.bootstrap.id;
 assert.equal((await fetch(f.origin+path,{headers:{authorization:'Bearer '+f.bootstrap.secret}})).status,403);
 const headers={authorization:'Bearer '+f.credential};const response=await fetch(f.origin+path,{headers});assert.equal(response.status,200);const metadata=await response.json();assert.equal(metadata.hubId,f.bootstrap.hubId);assert.equal(metadata.id,f.bootstrap.id);assert.equal(metadata.secret,undefined);
 assert.equal((await fetch(f.origin+'/__opencraft_machines/source.tgz?update=1&id='+f.bootstrap.id,{headers})).status,200);
 assert.equal((await fetch(f.origin+'/__opencraft_machines/install.sh?module=update&id='+f.bootstrap.id,{headers})).status,200);
 await f.service.command({action:'revoke',id:f.bootstrap.id});assert.equal((await fetch(f.origin+path,{headers})).status,403);
});
