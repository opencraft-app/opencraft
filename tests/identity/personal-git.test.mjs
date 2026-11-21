import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildGitIdentityRuntime } from '../../scripts/build/package-git-identity-runtime.mjs';

const bytes = value => { const b=Buffer.from(value),n=Buffer.alloc(4);n.writeUInt32BE(b.length);return Buffer.concat([n,b]); };
const field = (b,at) => { const n=b.readUInt32BE(at);return [b.subarray(at+4,at+4+n),at+4+n]; };
async function rpc(path,request,raw=false) {
  const socket=createConnection(path);await once(socket,'connect');
  socket.write(raw?bytes(request):JSON.stringify(request)+'\n');
  let data=Buffer.alloc(0);
  return new Promise((resolve,reject)=>{socket.setTimeout(4000,()=>{socket.destroy();reject(Error('broker timeout'));});socket.on('error',reject);socket.on('data',b=>{data=Buffer.concat([data,b]);if(raw?data.length>=4+data.readUInt32BE(0):data.includes(10)){socket.destroy();resolve(raw?data.subarray(4):JSON.parse(data.toString()));}});});
}
async function fixture(t, {legacy = false} = {}) {
  const root=await mkdtemp(join(tmpdir(),'personal-git-')),data=join(root,'data'),runtime=join(root,'runtime');
  await mkdir(data,{mode:0o700});await mkdir(join(data,'codex'));await mkdir(runtime);
  const key=randomBytes(32);await writeFile(join(data,'employee-git-vault.key'),key,{mode:0o600});
  const vault=new DatabaseSync(join(data,'employee-git-vault.sqlite'));vault.exec('CREATE TABLE employee_git_credentials(account TEXT,host TEXT,revision INTEGER,credential BLOB,PRIMARY KEY(account,host))');await chmod(join(data,'employee-git-vault.sqlite'),0o600);
  const pair=generateKeyPairSync('ed25519'),jwk=pair.publicKey.export({format:'jwk'}),blob=Buffer.concat([bytes('ssh-ed25519'),bytes(Buffer.from(jwk.x,'base64url'))]);
  const credential={identity:{username:'employee-one',name:'Employee One',email:'one@example.test'},token:'',signing:null,sshAuth:{generation:'fixture-1',privateKey:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKey:'ssh-ed25519 '+blob.toString('base64'),fingerprint:'fixture'}};
  function setCredential(account='synthetic:1',revision=1,value=credential) {
    let encrypted=null;
    if(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(JSON.stringify(['employee-git-vault',1,account,'github.com','credential'])));encrypted=Buffer.concat([iv,c.update(JSON.stringify(value)),c.final(),c.getAuthTag()]);}
    vault.prepare('INSERT OR REPLACE INTO employee_git_credentials VALUES(?,?,?,?)').run(account,'github.com',revision,encrypted);
  }
  setCredential();setCredential('synthetic:2',1,{...credential,identity:{...credential.identity,username:'employee-two'}});
  const actors=new DatabaseSync(join(data,'opencraft-server.sqlite'));actors.exec("CREATE TABLE actors(id TEXT,kind TEXT,enabled INTEGER);CREATE TABLE actor_bindings(binding TEXT,actor_id TEXT);CREATE TABLE actor_members(actor_id TEXT,enabled INTEGER);CREATE TABLE members(binding TEXT,enabled INTEGER);");
  for(const id of ['1','2']){actors.prepare('INSERT INTO actors VALUES(?,?,?)').run(id,'human',1);actors.prepare('INSERT INTO actor_bindings VALUES(?,?)').run(JSON.stringify(['synthetic',id]),id);actors.prepare('INSERT INTO actor_members VALUES(?,?)').run(id,1);}
  const leases=new DatabaseSync(join(data,'codex',legacy?'codex-host-queue.sqlite':'opencraft-host-state.sqlite'));leases.exec(`CREATE TABLE execution_submissions(thread_id TEXT,input_id TEXT,principal_json TEXT,ownership TEXT,admission TEXT);CREATE TABLE execution_leases(execution_id TEXT,thread_id TEXT,input_id TEXT,generation INTEGER,state TEXT,turn_id TEXT,engine_incarnation TEXT)`);
  for(const [thread,input,execution,subject] of [['thread-one','input-one','execution-one','1'],['thread-two','input-two','execution-two','2']]){leases.prepare('INSERT INTO execution_submissions VALUES(?,?,?,?,?)').run(thread,input,JSON.stringify({provider:'synthetic',subject}),'human','accepted');leases.prepare('INSERT INTO execution_leases VALUES(?,?,?,?,?,?,?)').run(execution,thread,input,1,'active','turn-one','engine-one');}
  await buildGitIdentityRuntime(runtime,['personal-git','personal-git-protocol'].map(name=>({entry:resolve('packages/execution-environment/src/'+name+'.ts'),name:name+'.mjs'})));
  const {PersonalGitEnvironment}=await import(pathToFileURL(join(runtime,'personal-git.mjs')).href);
  const {sealGitGrant,gitGrantAuthority,openGitGrant,readyGitBroker}=await import(pathToFileURL(join(runtime,'personal-git-protocol.mjs')).href);
  const issuer={authority:gitGrantAuthority(key),seal:scope=>sealGitGrant(key,scope)};
  const bridge=new PersonalGitEnvironment(data,join(root,'sockets'),join(runtime,'personal-git-worker.mjs'),['github.com'],issuer);
  const scope={account:'synthetic:1',hostId:'local-codex',threadId:'thread-one',projectId:null,inputId:'input-one',executionId:'execution-one',leaseGeneration:1};
  const grant=bridge.grant(scope);await grant.ready;const env=grant.environment,path=env.OPENCRAFT_GIT_BROKER_SOCKET;
  for(let i=0;i<100;i++){try{await stat(path);break;}catch{await new Promise(r=>setTimeout(r,20));}}
  t.after(async()=>{await bridge.close();actors.close();leases.close();vault.close();await rm(root,{recursive:true,force:true});});
  const open=(extra={})=>rpc(path,{op:'open',threadId:'thread-one',host:'github.com',operation:'ls-remote',capability:env.OPENCRAFT_GIT_CAPABILITY,...extra});
  const payload=Buffer.concat([bytes(Buffer.alloc(32,3)),Buffer.from([50]),bytes('git'),bytes('ssh-connection'),bytes('publickey'),Buffer.from([1]),bytes('ssh-ed25519'),bytes(blob)]);
  const sign=agent=>rpc(agent,Buffer.concat([Buffer.from([13]),bytes(blob),bytes(payload),Buffer.alloc(4)]),true);
  return {root,data,runtime,bridge,grant,env,scope,path,open,sign,payload,pair,actors,leases,setCredential,credential,issuer,PersonalGitEnvironment,openGitGrant,readyGitBroker};
}
test('bound SSH authorizes reads, never exports its private key, and overrides legacy repository SSH',async t=>{
  const f=await fixture(t),opened=await f.open();assert.equal(opened.status,'configured');assert.equal(opened.identity.username,'employee-one');assert.ok(opened.sshAuth);assert.ok(!JSON.stringify(opened).includes('PRIVATE KEY'));
  const signed=await f.sign(opened.sshAuth.socket);assert.equal(signed[0],14);const [signature]=field(signed,1),[,end]=field(signature,0),[raw]=field(signature,end);assert.ok(verify(null,f.payload,f.pair.publicKey,raw));
  const repo=join(f.root,'repo');const run=async(command,args,env)=>{const p=spawn(command,args,{cwd:f.root,env,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const [code]=await once(p,'exit');return {code,out,err};};
  await run('/usr/bin/git',['init','-q',repo],process.env);await run('/usr/bin/git',['-C',repo,'remote','add','origin','git@github.com:fixture/repo.git'],process.env);await run('/usr/bin/git',['-C',repo,'config','core.sshCommand','ssh -i /missing/other-employee-key'],process.env);
  const native=join(f.root,'native-git');await writeFile(native,'#!/usr/bin/env node\nconst cp=require("node:child_process"),a=process.argv.slice(2);if(a.includes("ls-remote")&&!a.includes("--get-url")){console.log(JSON.stringify({ssh:process.env.GIT_SSH_COMMAND}));}else{const r=cp.spawnSync("/usr/bin/git",a,{stdio:"inherit"});process.exit(r.status??1);}\n',{mode:0o755});
  const r=await run(process.execPath,[join(f.runtime,'git-identity-wrapper.mjs'),'-C',repo,'ls-remote','origin'],{...process.env,...f.env,CODEX_THREAD_ID:'thread-one',OPENCRAFT_GIT_NATIVE:native,GIT_CONFIG_GLOBAL:'/dev/null'});
  assert.equal(r.code,0,r.err);const selected=JSON.parse(r.out).ssh;assert.match(selected,/IdentityAgent=/);assert.match(selected,/StrictHostKeyChecking=accept-new/);assert.doesNotMatch(selected,/other-employee-key/);
});
test('a capability cannot switch users, threads, hosts or execution inputs',async t=>{
  const f=await fixture(t);assert.equal((await f.open({threadId:'thread-two'})).status,'expired');assert.equal((await f.open({host:'elsewhere.test'})).status,'denied');assert.equal((await f.open({capability:'forged'})).status,'expired');
  const bad=f.bridge.grant({...f.scope,inputId:'input-two',executionId:'execution-two'});await new Promise(r=>setTimeout(r,20));assert.equal((await f.open({capability:bad.environment.OPENCRAFT_GIT_CAPABILITY})).status,'expired');
});
test('execution end and credential revocation invalidate an existing agent',async t=>{
  const f=await fixture(t),opened=await f.open();assert.equal(opened.status,'configured');f.setCredential('synthetic:1',2,null);assert.equal((await f.sign(opened.sshAuth.socket))[0],5);
  f.setCredential('synthetic:1',3);const next=await f.open();assert.equal(next.status,'configured');f.leases.exec("UPDATE execution_leases SET state='ended'");assert.equal((await f.open()).status,'expired');assert.equal((await f.sign(next.sshAuth.socket))[0],5);
});
test('missing binding is reported separately from unavailable execution authority',async t=>{
  const f=await fixture(t);f.setCredential('synthetic:1',2,null);assert.equal((await f.open()).status,'unbound');f.leases.exec("UPDATE execution_submissions SET admission='rejected'");assert.equal((await f.open()).status,'expired');
});
test('creation and catalog scopes cannot mint Git grants before execution admission',async t=>{
 const f=await fixture(t);assert.equal(f.bridge.grant({...f.scope,threadId:null,inputId:undefined,executionId:undefined},{creation:true}),undefined);
 assert.equal(f.bridge.grant({...f.scope,inputId:undefined,executionId:undefined}),undefined);
 assert.throws(()=>f.bridge.grant({...f.scope,leaseGeneration:undefined}),/attestation_missing/);
});

test('a retained capability cannot cross a native incarnation or lease generation change',async t=>{
  const f=await fixture(t),opened=await f.open();assert.equal(opened.status,'configured');f.leases.exec("UPDATE execution_leases SET engine_incarnation='replacement-engine',generation=2");assert.equal((await f.open()).status,'expired');assert.equal((await f.sign(opened.sshAuth.socket))[0],5);
});
test('identity status works without an MCP token and fences disabled account membership',async t=>{
  const f=await fixture(t);const status=await f.bridge.status(f.scope);assert.equal(status.identity.subject,'1');assert.equal(status.hosts[0].sshConfigured,true);assert.equal(status.mcpCredentialsIndependent,true);assert.ok(!JSON.stringify(status).includes('PRIVATE KEY'));
  f.actors.exec("UPDATE actor_members SET enabled=0 WHERE actor_id='1'");await assert.rejects(f.bridge.status(f.scope),/execution_unavailable/);assert.equal((await f.open()).status,'expired');
});

test('failed preparation of another input does not revoke the current execution',async t=>{
 const f=await fixture(t);const before=await f.open();assert.equal(before.status,'configured');
 const bad=f.bridge.grant({...f.scope,inputId:'missing-input',executionId:'missing-execution'});
 assert.equal((await f.open({capability:bad.environment.OPENCRAFT_GIT_CAPABILITY})).status,'expired');
 assert.equal((await f.open()).status,'configured');assert.equal((await f.sign(before.sshAuth.socket))[0],14);
});
test('a closed bridge can be replaced without changing the retained execution environment',async t=>{
 const f=await fixture(t);const retained={...f.env};const second=new f.PersonalGitEnvironment(f.data,join(f.root,'sockets'),join(f.runtime,'personal-git-worker.mjs'),['github.com'],f.issuer);
 const fresh=second.grant(f.scope);await fresh.ready;t.after(()=>second.close());await f.bridge.close();
 const endpoint=await f.readyGitBroker(retained.OPENCRAFT_GIT_BROKER_DIRECTORY,retained.OPENCRAFT_GIT_BROKER_AUTHORITY,Number(retained.OPENCRAFT_GIT_BROKER_UID),retained.OPENCRAFT_GIT_BROKER_SOCKET,Date.now()+2000);
 assert.notEqual(endpoint,retained.OPENCRAFT_GIT_BROKER_SOCKET);
 const opened=await rpc(endpoint,{op:'open',threadId:f.scope.threadId,host:'github.com',operation:'ls-remote',capability:retained.OPENCRAFT_GIT_CAPABILITY,requestId:'retained-command'});assert.equal(opened.status,'configured');assert.equal(opened.identity.username,'employee-one');assert.equal((await f.sign(opened.sshAuth.socket))[0],14);
 const repo=join(f.root,'retained-repo');const exec=async(command,args,env)=>{const p=spawn(command,args,{env,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const[code]=await once(p,'exit');return{code,out,err}};
 await exec('/usr/bin/git',['init','-q',repo],process.env);await exec('/usr/bin/git',['-C',repo,'remote','add','origin','git@github.com:fixture/retained.git'],process.env);
 const native=join(f.root,'native-retained');await writeFile(native,'#!/usr/bin/env node\nconst cp=require("node:child_process"),a=process.argv.slice(2);if(a.includes("ls-remote")&&!a.includes("--get-url"))console.log(JSON.stringify({endpoint:process.env.OPENCRAFT_GIT_BROKER_SOCKET,ssh:process.env.GIT_SSH_COMMAND}));else{const r=cp.spawnSync("/usr/bin/git",a,{stdio:"inherit"});process.exit(r.status??1)}\n',{mode:0o755});
 const result=await exec(process.execPath,[join(f.runtime,'git-identity-wrapper.mjs'),'-C',repo,'ls-remote','origin'],{...process.env,...retained,CODEX_THREAD_ID:f.scope.threadId,OPENCRAFT_GIT_NATIVE:native,GIT_CONFIG_GLOBAL:'/dev/null'});assert.equal(result.code,0,result.err);const actual=JSON.parse(result.out);assert.equal(actual.endpoint,endpoint);assert.match(actual.ssh,/IdentityAgent=/);
 f.leases.exec("UPDATE execution_leases SET generation=2,engine_incarnation='new-engine'");assert.equal((await rpc(endpoint,{op:'open',threadId:f.scope.threadId,host:'github.com',operation:'ls-remote',capability:retained.OPENCRAFT_GIT_CAPABILITY})).status,'expired');
});
test('same authorization request is idempotent and close releases the cached result',async t=>{
 const f=await fixture(t);const values=await Promise.all(Array.from({length:12},()=>f.open({requestId:'one-command'})));assert(values.every(v=>v.status==='configured'));assert.equal(new Set(values.map(v=>v.sessionId)).size,1);
 await rpc(f.path,{op:'close',sessionId:values[0].sessionId});const next=await f.open({requestId:'one-command'});assert.equal(next.status,'configured');assert.notEqual(next.sessionId,values[0].sessionId);
});
test('tampered or foreign-authority attestations never authenticate',async t=>{
 const f=await fixture(t);let token=f.env.OPENCRAFT_GIT_CAPABILITY;const at=Math.floor(token.length/2);token=token.slice(0,at)+(token[at]==='a'?'b':'a')+token.slice(at+1);assert.equal((await f.open({capability:token})).status,'expired');
 await assert.rejects(f.readyGitBroker(f.env.OPENCRAFT_GIT_BROKER_DIRECTORY,'0'.repeat(64),Number(f.env.OPENCRAFT_GIT_BROKER_UID),f.path,Date.now()+100),/not_ready/);
});

test('a repeated open cannot reuse a cached session after revocation or change its thread',async t=>{
 const f=await fixture(t);assert.equal((await f.open({requestId:'revoked-command'})).status,'configured');
 assert.equal((await f.open({requestId:'revoked-command',threadId:'thread-two'})).status,'expired');
 f.actors.exec("UPDATE actor_members SET enabled=0");assert.equal((await f.open({requestId:'revoked-command'})).status,'expired');
});
test('parallel requests reserve capacity before asynchronous signer creation',async t=>{
 const f=await fixture(t);const results=await Promise.all(Array.from({length:136},(_,i)=>f.open({requestId:'capacity-'+i})));const accepted=results.filter(v=>v.status==='configured');assert.equal(accepted.length,128);assert.equal(results.filter(v=>v.reason==='session-capacity').length,8);
 await Promise.all(accepted.map(v=>rpc(f.path,{op:'close',sessionId:v.sessionId})));assert.equal((await f.open()).status,'configured');
});
test('worker start failure rejects readiness without leaving an indefinitely pending close',async t=>{
 const f=await fixture(t);const broken=new f.PersonalGitEnvironment(f.data,join(f.root,'sockets'),join(f.runtime,'missing-worker.mjs'),['github.com'],f.issuer);const grant=broken.grant(f.scope);await assert.rejects(grant.ready,/bridge_failed|bridge_exited/);await broken.close();
});

test('closing the Gateway issuer leaves an execution-owned command agent alive',async t=>{
 const f=await fixture(t);const gateway=new f.PersonalGitEnvironment(f.data,join(f.root,'sockets'),join(f.runtime,'personal-git-worker.mjs'),['github.com'],f.issuer,'issuer');
 const grant=gateway.grant(f.scope);await grant.ready;const env=grant.environment;const endpoint=await f.readyGitBroker(env.OPENCRAFT_GIT_BROKER_DIRECTORY,env.OPENCRAFT_GIT_BROKER_AUTHORITY,Number(env.OPENCRAFT_GIT_BROKER_UID),env.OPENCRAFT_GIT_BROKER_SOCKET,Date.now()+2000);
 const opened=await rpc(endpoint,{op:'open',threadId:f.scope.threadId,host:'github.com',operation:'ls-remote',capability:env.OPENCRAFT_GIT_CAPABILITY});assert.equal(opened.status,'configured');await gateway.close();assert.equal((await f.sign(opened.sshAuth.socket))[0],14);
});
test('metadata-only owners do not advertise or accept command execution',async t=>{
 const f=await fixture(t);const statusOwner=new f.PersonalGitEnvironment(f.data,join(f.root,'sockets'),join(f.runtime,'personal-git-worker.mjs'),['github.com']);t.after(()=>statusOwner.close());const status=await statusOwner.status(f.scope);assert.equal(status.bindingStateOnly,true);assert.equal(status.commandProbe,'not-run');
});

test('stale socket directories cannot hide a ready execution replica after 64 owners',async t=>{
 const f=await fixture(t),root=f.env.OPENCRAFT_GIT_BROKER_DIRECTORY;
 for(let i=0;i<80;i++){const dir=join(root,'owner-'+i.toString(16).padStart(12,'0'));await mkdir(dir,{mode:0o700});await writeFile(join(dir,'ready.json'),JSON.stringify({protocol:2,authority:f.issuer.authority,socket:join(dir,'broker.sock')}),{mode:0o600});}
 assert.equal(await f.readyGitBroker(root,f.issuer.authority,process.getuid(),f.path,Date.now()+2000),f.path);
});

test('issuer readiness is retried on a later preparation instead of caching a failed preflight',async t=>{
 const f=await fixture(t),issuer={...f.issuer};const gateway=new f.PersonalGitEnvironment(f.data,join(f.root,'sockets'),join(f.runtime,'personal-git-worker.mjs'),['github.com'],issuer,'issuer');t.after(()=>gateway.close());
 const grant=gateway.grant(f.scope);issuer.authority='invalid-authority';await assert.rejects(grant.ready,/locator_invalid/);issuer.authority=f.issuer.authority;
 assert.equal(gateway.grant(f.scope),grant);await grant.ready;await gateway.close();assert.throws(()=>gateway.grant(f.scope),/bridge_unavailable/);await assert.rejects(gateway.status(f.scope),/bridge_unavailable/);
});

test('disconnected undelivered opens release asynchronous agent reservations',async t=>{
 const f=await fixture(t);
 await Promise.all(Array.from({length:136},(_,i)=>new Promise((resolve,reject)=>{
   const client=createConnection(f.path);client.on('error',reject);client.once('connect',()=>client.write(JSON.stringify({op:'open',threadId:f.scope.threadId,host:'github.com',operation:'ls-remote',capability:f.env.OPENCRAFT_GIT_CAPABILITY,requestId:'abandoned-'+i})+'\n',()=>{client.destroy();resolve();}));
 })));
 let opened;for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,20));opened=await f.open({requestId:'after-abandoned'});if(opened.status==='configured')break;}
 assert.equal(opened.status,'configured');assert.equal((await f.sign(opened.sshAuth.socket))[0],14);
});

test('authority store outage is not reported as revocation and cannot authorize a signature',async t=>{
 const f=await fixture(t),opened=await f.open({requestId:'store-outage'});assert.equal(opened.status,'configured');
 f.leases.exec('ALTER TABLE execution_leases RENAME TO unavailable_leases');
 try {
  const cached=await f.open({requestId:'store-outage'});assert.equal(cached.status,'unavailable');assert.equal(cached.reason,'authority-store-unavailable');
  assert.equal((await f.sign(opened.sshAuth.socket))[0],5);
  await new Promise(r=>setTimeout(r,1100));
 } finally { f.leases.exec('ALTER TABLE unavailable_leases RENAME TO execution_leases'); }
 assert.equal((await f.sign(opened.sshAuth.socket))[0],14);assert.equal((await f.open({requestId:'after-store-outage'})).status,'configured');
});

// Retained installations keep their original storage identity. Read-only Git
// authority must resolve exactly the same file as the execution owner.
test('legacy Host storage authorizes Git without creating or moving a database',async t=>{
 const f=await fixture(t,{legacy:true});assert.equal((await f.open()).status,'configured');
 await assert.rejects(stat(join(f.data,'codex/opencraft-host-state.sqlite')),{code:'ENOENT'});
 assert.ok((await stat(join(f.data,'codex/codex-host-queue.sqlite'))).isFile());
 f.leases.exec("UPDATE execution_leases SET state='ended'");assert.equal((await f.open()).status,'expired');
});
test('ambiguous storage and pending offline maintenance cannot select an authority store',async t=>{
 const f=await fixture(t,{legacy:true});assert.equal((await f.open()).status,'configured');
 const current=join(f.data,'codex/opencraft-host-state.sqlite');
 await writeFile(current,'',{mode:0o600});assert.equal((await f.open()).status,'unavailable');
 await rm(current);assert.equal((await f.open()).status,'configured');
 const journal=join(f.data,'codex/.opencraft-owned-storage-move.json');
 await writeFile(journal,'{}',{mode:0o600});assert.equal((await f.open()).status,'unavailable');
 await rm(journal);assert.equal((await f.open()).status,'configured');
 await assert.rejects(stat(current),{code:'ENOENT'});
});
