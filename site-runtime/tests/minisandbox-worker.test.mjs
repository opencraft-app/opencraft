import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const wrapper = fs.readFileSync(new URL('../internal/runtime/minisandbox_worker.mjs', import.meta.url),'utf8');
const todoSource = fs.readFileSync(new URL('../../.agents/skills/website-builder/templates/todo-backend.mjs', import.meta.url),'utf8');
const digest='a'.repeat(64);

async function worker(backend, database) {
 const context=vm.createContext({Headers,Request,Response,URL,TextEncoder,console});
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
 return {instance,aborts,prepare:()=>main.namespace.default.fetch(new Request('https://site.invalid/__platform_prepare'))};
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
 const second=await worker(todoSource+'\n// next release',db);
 const shared=await second.instance.fetch(request('GET',undefined,true));assert.equal(shared.status,200);
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
  const w=await worker(code,db);assert.equal((await w.instance.fetch(request('GET',undefined,true))).status,500);
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
