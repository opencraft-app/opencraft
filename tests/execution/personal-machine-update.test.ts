import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {createServer} from 'node:http';
import {verifyArchive,activate,runUpdate,download} from '../../scripts/personal-machine/update.mjs';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function directory(t:test.TestContext){const path=await realpath(await mkdtemp(join(tmpdir(),'oc-update-')));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function fixture(t:test.TestContext){const state=await directory(t);await mkdir(join(state,'releases'));await mkdir(join(state,'runtime'));await writeFile(join(state,'runtime','old'),'original runtime');const config={schemaVersion:1,id:randomUUID(),hubId:randomUUID(),phase:'enrolled',origin:'https://machine.fixture.test',credential:randomBytes(32).toString('base64url')};const text=JSON.stringify(config);await writeFile(join(state,'connection.json'),text,{mode:0o600});await mkdir(join(state,'data'));await writeFile(join(state,'data','session'),'original session');const candidate=join(state,'releases','new');await mkdir(candidate);return {state,candidate,text};}
test('corrupt bytes, traversal and links fail archive validation',async t=>{
 const malicious=Buffer.alloc(1024);malicious.write('../escape',0);malicious.write('00000000000\0',124);malicious.fill(32,148,156);malicious.write('0',156);const sum=malicious.subarray(0,512).reduce((a,b)=>a+b,0);malicious.write(sum.toString(8).padStart(6,'0')+'\0 ',148);const unsafe=gzipSync(malicious);assert.throws(()=>verifyArchive(unsafe,hash(unsafe)),/Unsafe/);
 const root=await directory(t);await writeFile(join(root,'fixture'),'safe');execFileSync('tar',['-czf',join(root,'safe.tgz'),'-C',root,'fixture']);const bytes=await readFile(join(root,'safe.tgz'));verifyArchive(bytes,hash(bytes));assert.throws(()=>verifyArchive(bytes,'a'.repeat(64)));
 await symlink('/etc/passwd',join(root,'link'));execFileSync('tar',['-czf',join(root,'link.tgz'),'-C',root,'link']);const linked=await readFile(join(root,'link.tgz'));assert.throws(()=>verifyArchive(linked,hash(linked)),/links/);
});
test('successful activation migrates legacy runtime and preserves credentials and sessions',async t=>{
 const f=await fixture(t);let stopped=false;await activate(f.state,f.candidate,'a'.repeat(64),{stop:async()=>{stopped=true},start:async()=>{assert(stopped);assert.equal(await realpath(join(f.state,'runtime')),f.candidate);}});
 const version=JSON.parse(await readFile(join(f.state,'update-version.json'),'utf8'));assert.equal(await readFile(join(version.previous,'old'),'utf8'),'original runtime');assert.equal(await readFile(join(f.state,'connection.json'),'utf8'),f.text);assert.equal(await readFile(join(f.state,'data','session'),'utf8'),'original session');
});
test('failed new runtime rolls back the pointer and keeps machine data intact',async t=>{
 const f=await fixture(t);let attempts=0;await assert.rejects(activate(f.state,f.candidate,'b'.repeat(64),{stop:async()=>{},start:async()=>{if(++attempts===1)throw new Error('candidate failed');assert.equal(await readFile(join(f.state,'runtime','old'),'utf8'),'original runtime');}}),/previous runtime restored and restarted/);assert.equal(attempts,2);assert.equal(await readFile(join(f.state,'connection.json'),'utf8'),f.text);
});
test('update check uses the existing machine bearer without changing the running files',async t=>{
 const f=await fixture(t);let requests=0;const config=JSON.parse(f.text);const server=createServer((req,res)=>{requests++;assert.equal(req.headers.authorization,'Bearer '+config.credential);assert.equal(req.url,'/__opencraft_machines/bootstrap?update=1&id='+config.id);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...config,origin:config.origin,digest:'c'.repeat(64)}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));config.origin='http://127.0.0.1:'+(server.address() as any).port;await writeFile(join(f.state,'connection.json'),JSON.stringify(config),{mode:0o600});await runUpdate(f.state,'--check-update');assert.equal(requests,1);assert.equal(await readFile(join(f.state,'runtime','old'),'utf8'),'original runtime');
});
test('redirects never forward a machine credential to another origin',async t=>{
 const server=createServer((_req,res)=>{res.writeHead(302,{location:'https://another.test/'});res.end();});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));await assert.rejects(download({origin:'http://127.0.0.1:'+(server.address() as any).port,credential:'x'.repeat(43)},'/update'),/302/);
});

test('interrupted activation keeps a recoverable journal and blocks a new update',async t=>{
 const f=await fixture(t);await assert.rejects(activate(f.state,f.candidate,'d'.repeat(64),{stop:async()=>{throw new Error('shutdown outcome unavailable')},start:async()=>{throw new Error('must not start')}}),/shutdown outcome/);
 assert.equal(await readFile(join(f.state,'runtime','old'),'utf8'),'original runtime');
 await assert.rejects(runUpdate(f.state,'--check-update'),/--recover/);
 const {recover}=await import('../../scripts/personal-machine/update.mjs');let recovered=false;
 await recover(f.state,{stop:async()=>{},start:async()=>{recovered=true;}});assert.equal(recovered,true);
 await assert.rejects(readFile(join(f.state,'update-pending.json')),/ENOENT/);
});

test('invalid downloaded candidate never stops or replaces the current runtime',async t=>{
 const f=await fixture(t),config=JSON.parse(f.text),bytes=Buffer.from('not a gzip archive');let requests=0;
 const server=createServer((req,res)=>{requests++;assert.equal(req.headers.authorization,'Bearer '+config.credential);if(req.url?.includes('/bootstrap?'))res.end(JSON.stringify({schemaVersion:1,id:config.id,hubId:config.hubId,origin:config.origin,digest:hash(bytes)}));else res.end(bytes);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));config.origin='http://127.0.0.1:'+(server.address() as any).port;await writeFile(join(f.state,'connection.json'),JSON.stringify(config),{mode:0o600});
 await assert.rejects(runUpdate(f.state,'--update',{nodeVersion:'26.7.0'}));assert.equal(requests,2);assert.equal(await readFile(join(f.state,'runtime','old'),'utf8'),'original runtime');await assert.rejects(readFile(join(f.state,'update-pending.json')),/ENOENT/);
});

test('recovery refuses a live updater and reclaims a recorded exited owner',async t=>{
 const state=await directory(t);const {acquireUpdateLock}=await import('../../scripts/personal-machine/update.mjs');const lock=await acquireUpdateLock(state);
 await assert.rejects(acquireUpdateLock(state,true),/still running/);
 await writeFile(join(lock,'owner.json'),JSON.stringify({pid:2147483647}),{mode:0o600});
 await acquireUpdateLock(state,true);assert.equal(JSON.parse(await readFile(join(lock,'owner.json'),'utf8')).pid,process.pid);
});

test('retry can restore interrupted files without attempting to start the previous broken runtime',async t=>{
 const f=await fixture(t);await assert.rejects(activate(f.state,f.candidate,'e'.repeat(64),{stop:async()=>{throw new Error('interrupted')},start:async()=>{throw new Error('must not start')}}));
 const {recover}=await import('../../scripts/personal-machine/update.mjs');let started=false;
 await recover(f.state,{stop:async()=>{},start:async()=>{started=true;throw new Error('old runtime is broken')}},false);
 assert.equal(started,false);assert.equal(await readFile(join(f.state,'runtime','old'),'utf8'),'original runtime');
 await assert.rejects(readFile(join(f.state,'update-pending.json')),/ENOENT/);
});

test('download rejects intranet HTTP origins and runUpdate delegates build preparation to unpacked prepare.mjs',async t=>{
 await assert.rejects(download({origin:'http://10.42.0.8:15473',credential:'x'.repeat(43)},'/update'),/HTTPS/);
 const f=await fixture(t),config=JSON.parse(f.text),pack=await directory(t);
 await mkdir(join(pack,'scripts','personal-machine'),{recursive:true});
 await writeFile(join(pack,'scripts','personal-machine','prepare.mjs'),"import {writeFileSync} from 'node:fs';import {join} from 'node:path';writeFileSync(join(process.cwd(),'prepared.marker'),'ok');\n");
 const tgz=join(pack,'candidate.tgz');
 execFileSync('tar',['-czf',tgz,'-C',pack,'scripts']);
 const bytes=await readFile(tgz),digest=hash(bytes);
 const server=createServer((req,res)=>{if(req.url?.includes('/bootstrap?')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,id:config.id,hubId:config.hubId,origin:config.origin,digest}));}else{res.writeHead(200);res.end(bytes);}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 config.origin='http://127.0.0.1:'+(server.address() as any).port;
 await writeFile(join(f.state,'connection.json'),JSON.stringify(config),{mode:0o600});
 await assert.rejects(runUpdate(f.state,'--update',{nodeVersion:'24.0.0'}),/26\.7\.0/);
 await runUpdate(f.state,'--update',{stop:async()=>{},start:async()=>{},nodeVersion:'26.7.0'});
 assert.equal(await readFile(join(f.state,'runtime','prepared.marker'),'utf8'),'ok');
 assert.equal(JSON.parse(await readFile(join(f.state,'update-version.json'),'utf8')).version,digest);
});
