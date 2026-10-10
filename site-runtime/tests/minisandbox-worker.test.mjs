import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const wrapper = fs.readFileSync(new URL('../internal/runtime/minisandbox_worker.mjs', import.meta.url),'utf8');
const todoSource = fs.readFileSync(new URL('./fixtures/todo-backend.mjs', import.meta.url),'utf8');
const digest='a'.repeat(64);

async function worker(backend, database, timers = {}) {
 const context=vm.createContext({Headers,Request,Response,URL,TextEncoder,console,setTimeout,clearTimeout,...timers});
 class DurableObject { constructor(state,env) { this.ctx=state;this.env=env; } }
 const builtin=new vm.SyntheticModule(['DurableObject'],function(){this.setExport('DurableObject',DurableObject)},{context});
 const main=new vm.SourceTextModule(`const platformPackageID="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const backends=globalThis.Object.freeze({"${digest}":()=>import('./backend.mjs')});\n`+wrapper,{
  context,identifier:'main.mjs',
  importModuleDynamically: async()=>{ await user.evaluate(); return user; }
 });
 const user=new vm.SourceTextModule(backend,{context,identifier:'backend.mjs'});
 const linker=async(name)=>{if(name==='cloudflare:workers')return builtin;throw Error('unexpected import: '+name)};
 await user.link(linker);await main.link(linker);await main.evaluate();
 let sequence=0;
 const sql={
  get databaseSize(){return database.prepare('PRAGMA page_count').get().page_count*database.prepare('PRAGMA page_size').get().page_size},
  exec(query,...bindings){
   const stmt=database.prepare(query);let rows=[],written=0;
   const columns=stmt.columns().map(c=>c.name);
   if(columns.length)rows=stmt.all(...bindings);else written=Number(stmt.run(...bindings).changes);
   return Object.assign(rows,{columnNames:columns,rowsRead:rows.length,rowsWritten:written});
  }
 };
 const storage={sql,transactionSync(fn){const name='test_'+(++sequence);database.exec('SAVEPOINT '+name);try{const out=fn();database.exec('RELEASE '+name);return out}catch(error){database.exec('ROLLBACK TO '+name);database.exec('RELEASE '+name);throw error}}};
 const aborts=[];
 const instance=new main.namespace.VelaSite({storage,abort(reason){aborts.push(reason);throw Error("native object reset");}},{});
 return {instance,aborts,evaluate:code=>vm.runInContext(code,context),prepare:()=>main.namespace.default.fetch(new Request('https://site.invalid/__platform_prepare'))};
}
function request(method='GET',body,readOnly=false) {
 const headers={'X-Lightvela-Backend-Digest':digest,'Cookie':'must-not-leak','Authorization':'must-not-leak'};
 if(readOnly)headers['X-Lightvela-Storage-Read-Only']='1';
 if(body!==undefined)headers['Content-Type']='application/json';
 return new Request('https://site.invalid/api/todos',{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
}

test('prepare never calls user fetch; owner Todo is readable in independent instance and new module',async()=>{
 const db=new DatabaseSync(':memory:');
 const w=await worker(todoSource,db);
 assert.equal((await w.prepare()).status,200);
 assert.equal(db.prepare("SELECT COUNT(*) AS total FROM sqlite_schema WHERE name='todos'").get().total,0);
 const id='20261002-0000-4000-8000-000000000001';
 const saved=await w.instance.fetch(request('POST',{id,title:'persistent todo'}));assert.equal(saved.status,201);
 const duplicate=await w.instance.fetch(request('POST',{id,title:'persistent todo'}));assert.equal(duplicate.status,201);
 assertExecutionIdentity(saved);assertExecutionIdentity(duplicate);
 const second=await worker(todoSource+'\n// next release',db);
 const shared=await second.instance.fetch(request('GET',undefined,true));assert.equal(shared.status,200);assertExecutionIdentity(shared);
 assert.equal((await shared.json()).todos[0].id,id);
 assert.equal(db.prepare('SELECT COUNT(*) AS total FROM todos').get().total,1);db.close();
});
test('platform credentials and digest selectors do not enter user code',async()=>{
 const db=new DatabaseSync(':memory:');const w=await worker('export default {fetch(r,e,c){return Response.json({headers:[...r.headers.keys()],env:Object.keys(e)})}}',db);
 const data=await (await w.instance.fetch(request())).json();assert.deepEqual(data.headers,[]);assert.deepEqual(data.env,['RIVET_STORAGE']);db.close();
});
test('share cannot execute mutations, multi-statements, or tamper with header checks',async()=>{
 for(const query of ['INSERT INTO todos VALUES (\'evil\')','SELECT 1; DELETE FROM todos','WITH x AS (SELECT 1) DELETE FROM todos','PRAGMA query_only=OFF']){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE todos (id TEXT)');
  const code=`try { Headers.prototype.get = () => null; } catch {}\nexport default {async fetch(r,e){await e.RIVET_STORAGE.sql.exec(${JSON.stringify(query)});return new Response('unsafe')}}`;
  const w=await worker(code,db);const denied=await w.instance.fetch(request('GET',undefined,true));assert.equal(denied.status,500);assertExecutionIdentity(denied);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM todos').get().total,0);db.close();
 }
});
test('share supports SELECT literals containing semicolon and SQL comments',async()=>{
 const db=new DatabaseSync(':memory:');const w=await worker("export default {async fetch(r,e){return Response.json(await e.RIVET_STORAGE.sql.exec(\"SELECT ';' AS value /* comment ; */\"))}}",db);
 const response=await w.instance.fetch(request('GET',undefined,true));assert.equal(response.status,200);assert.equal((await response.json()).rows[0].value,';');db.close();
});
test('oversized result failure rolls back its write transaction',async()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE todos (id TEXT)');
 const w=await worker("export default {async fetch(r,e){await e.RIVET_STORAGE.sql.exec(\"INSERT INTO todos VALUES ('x') RETURNING printf('%.*c',1048577,'a') AS oversized\");return new Response('bad')}}",db);
 assert.equal((await w.instance.fetch(request('POST',{}))).status,500);assert.equal(db.prepare('SELECT COUNT(*) AS total FROM todos').get().total,0);db.close();
});


test('private package rotation resets only mismatched valid markers and never executes backend or SQL',async()=>{
 const db=new DatabaseSync(':memory:');const w=await worker('export default {fetch(){throw Error("application executed")}}',db);
 const control=(expected)=>new Request('https://site.invalid/__platform_prepare',{headers:expected===null?{}:{'X-Lightvela-Expected-Package-ID':expected}});
 assert.equal((await w.instance.fetch(control(null))).status,200);
 assert.equal((await w.instance.fetch(control('b'.repeat(64)))).status,200);
 assert.equal((await w.instance.fetch(control('malformed-target'))).status,400);
 assert.deepEqual(w.aborts,[]);
 await assert.rejects(w.instance.fetch(control('c'.repeat(64))),/native object reset/);
 assert.equal(w.aborts.length,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='todos'").get().n,0);db.close();
});

const executionPackageHeader='X-Lightvela-Execution-Package-ID';
const executionDigestHeader='X-Lightvela-Execution-Backend-SHA256';
function assertExecutionIdentity(response) {
 assert.equal(response.headers.get(executionPackageHeader),'b'.repeat(64));
 assert.equal(response.headers.get(executionDigestHeader),digest);
}
test('execution identity overwrites user headers and ignores response instance and primordial tampering',async()=>{
 const db=new DatabaseSync(':memory:');
 const w=await worker(`
 const NativeResponse=Response, nativeDefine=Object.defineProperty;
 for(const name of ['headers','status','statusText','body'])
  nativeDefine(Object.getOwnPropertyDescriptor(Response.prototype,name).get,'call',{value(){throw Error('user builtin call')},configurable:true});
 nativeDefine(Headers.prototype.forEach,'call',{value(){throw Error('user forEach call')},configurable:true});
 Reflect.apply=()=>{throw Error('replaced Reflect.apply')};
 try { Response.prototype.clone=()=>new Response('forged'); } catch {}
 try { Headers.prototype.set=()=>{}; } catch {}
 globalThis.Response=function(){throw Error('replaced response constructor')};
 globalThis.Headers=function(){throw Error('replaced headers constructor')};
 globalThis.Object={getOwnPropertyDescriptor(){throw Error('replaced descriptor getter')}};
 export default {fetch(){
  const response=new NativeResponse('{"todos":[]}',{status:201,headers:{
   'Content-Type':'application/json','X-Lightvela-Execution-Package-ID':'forged-package',
   'X-Lightvela-Execution-Backend-SHA256':'forged-digest'
  }});
  nativeDefine(response.headers,'forEach',{value(){throw Error('user headers forEach')}});
  nativeDefine(response.headers,Symbol.iterator,{value(){throw Error('user headers iterator')}});
  for(const name of ['headers','status','statusText','body','clone'])
   nativeDefine(response,name,{get(){throw Error('user response getter '+name)}});
  return response;
 }};`,db);
 const response=await w.instance.fetch(request('POST',{}));
 assert.equal(response.status,201);assertExecutionIdentity(response);
 assert.equal(response.headers.get('Content-Type'),'application/json');
 assert.deepEqual(await response.json(),{todos:[]});db.close();
});
test('execution identity is detached from retained user response and stamped on application errors',async()=>{
 const db=new DatabaseSync(':memory:');
 const w=await worker(`export default {fetch(){globalThis.reply=new Response('bad input',{status:400});return reply}}`,db);
 const response=await w.instance.fetch(request());
 w.evaluate(`reply.headers.set('${executionPackageHeader}','late-forgery');reply.headers.set('${executionDigestHeader}','late-forgery')`);
 assert.equal(response.status,400);assertExecutionIdentity(response);assert.equal(await response.text(),'bad input');
 for(const code of [`export default {fetch(){throw Error('failed')}}`,`export default {fetch(){return {status:200,headers:{}}}}`]) {
  const failed=await worker(code,db);const error=await failed.instance.fetch(request());
  assert.equal(error.status,500);assertExecutionIdentity(error);
 }
 db.close();
});
test('private control and unselected backend responses never carry application execution identity',async()=>{
 const db=new DatabaseSync(':memory:');
 const w=await worker(`throw Error('private control must not import application');export default {fetch(){throw Error('application executed')}}`,db);
 for(const control of [new Request('https://site.invalid/__platform_prepare'),new Request('https://site.invalid/__platform_prepare',{headers:{'X-Lightvela-Expected-Package-ID':'invalid'}})]) {
  const response=await w.instance.fetch(control);
  assert.equal(response.headers.get(executionPackageHeader),null);assert.equal(response.headers.get(executionDigestHeader),null);
 }
 const response=await w.instance.fetch(new Request('https://site.invalid/api/todos',{headers:{'X-Lightvela-Backend-Digest':'c'.repeat(64)}}));
 assert.equal(response.status,409);assert.equal(response.headers.get(executionPackageHeader),null);assert.equal(response.headers.get(executionDigestHeader),null);db.close();
});

const deadlineTimers={setTimeout:(callback,ms)=>setTimeout(callback,ms===3500?10:ms)};
test('stamped completion, failure and timeout revoke escaped SQL before a read-only invocation',async()=>{
 for(const ending of ['return new Response("done")','throw Error("failed")','await new Promise(resolve=>globalThis.resume=resolve);await escaped.exec("INSERT INTO todos VALUES (1)")']) {
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE todos (id INTEGER)');
  const w=await worker(`export default {async fetch(r,e){
   if(r.method==='POST') {globalThis.escaped=e.RIVET_STORAGE.sql;${ending};return new Response('late')}
   try {await escaped.exec('INSERT INTO todos VALUES (2)');return new Response('capability leaked')}
   catch {return Response.json(await e.RIVET_STORAGE.sql.exec('SELECT COUNT(*) AS total FROM todos'))}
  }}`,db,deadlineTimers);
  const owner=await w.instance.fetch(request('POST',{}));assertExecutionIdentity(owner);
  assert.equal(owner.status,ending.startsWith('return')?200:500);
  const shared=await w.instance.fetch(request('GET',undefined,true));assertExecutionIdentity(shared);
  assert.equal((await shared.json()).rows[0].total,0);
  if(ending.startsWith('await')) {
   w.evaluate('resume()');await new Promise(resolve=>setImmediate(resolve));
  }
  await assert.rejects(w.evaluate("escaped.exec('INSERT INTO todos VALUES (3)')"),/invocation has ended/);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM todos').get().total,0);db.close();
 }
});
test('a suspended owner is serialized ahead of read-only execution without lending writable SQL',async()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE todos (id INTEGER)');
 const w=await worker(`export default {async fetch(r,e){
  if(r.method==='POST') {globalThis.escaped=e.RIVET_STORAGE.sql;await new Promise(resolve=>globalThis.resume=resolve);return new Response('owner')}
  globalThis.shareStarted=true;
  try {await escaped.exec('INSERT INTO todos VALUES (1)');return new Response('capability leaked')}
  catch {return Response.json(await e.RIVET_STORAGE.sql.exec('SELECT COUNT(*) AS total FROM todos'))}
 }}`,db);
 const owner=w.instance.fetch(request('POST',{}));await new Promise(resolve=>setImmediate(resolve));
 const shared=w.instance.fetch(request('GET',undefined,true));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(w.evaluate('globalThis.shareStarted'),undefined);
 w.evaluate('resume()');assertExecutionIdentity(await owner);
 const result=await shared;assertExecutionIdentity(result);assert.equal((await result.json()).rows[0].total,0);db.close();
});
test('backend import resolving after timeout never starts user fetch or SQL',async()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE todos (id INTEGER)');
 const w=await worker(`globalThis.fetches=0;await new Promise(resolve=>globalThis.finishImport=resolve);
 export default {async fetch(r,e){fetches++;await e.RIVET_STORAGE.sql.exec('INSERT INTO todos VALUES (1)');return new Response('late')}}`,db,deadlineTimers);
 const response=await w.instance.fetch(request('POST',{}));assert.equal(response.status,500);assertExecutionIdentity(response);
 w.evaluate('finishImport()');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(w.evaluate('fetches'),0);assert.equal(db.prepare('SELECT COUNT(*) AS total FROM todos').get().total,0);db.close();
});
