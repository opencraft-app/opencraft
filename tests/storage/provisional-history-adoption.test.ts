import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {openManagedDatabase,resolveStoreMigrations} from "../../packages/sqlite-node/src/index.js";
import {ProvisionalThreads} from "../../apps/opencraft-daemon/src/provisional-threads.js";
// Exact deployed history, independent of generated output.
const history=[
  {
    "version": 1,
    "name": "thread-creation-lifecycle",
    "sql": "CREATE TABLE thread_creations (\n  thread_id TEXT PRIMARY KEY, result_json TEXT NOT NULL,\n  phase TEXT NOT NULL CHECK(phase IN ('created','attempted','accepted','persisted')),\n  input_id TEXT, turn_id TEXT\n) STRICT;"
  },
  {
    "version": 2,
    "name": "creation-environment-owner",
    "sql": "ALTER TABLE thread_creations ADD COLUMN environment_owner TEXT;"
  },
  {
    "version": 3,
    "name": "creation-catalog-evidence",
    "sql": "ALTER TABLE thread_creations ADD COLUMN catalog_state TEXT CHECK(catalog_state IN ('pending','retired'));\nALTER TABLE thread_creations ADD COLUMN catalog_only INTEGER NOT NULL DEFAULT 0 CHECK(catalog_only IN (0,1));"
  }
] as const;
assert.deepEqual(resolveStoreMigrations("provisional-threads",history.slice(0,2)),history);
async function fixture(t:test.TestContext,version?:2|3){
 const root=await mkdtemp(join(tmpdir(),"provisional-history-"));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,"thread-creations.sqlite");
 if(version){const old=openManagedDatabase({path,migrations:history.slice(0,version)});old.database.prepare("INSERT INTO thread_creations(thread_id,result_json,phase,environment_owner) VALUES(?,?,?,?)").run("existing",JSON.stringify({thread:{id:"existing"}}),"created","private-owner");old.database.close();}return{root,path};
}
for(const version of [undefined,2,3] as const)test(`creation evidence adopts private v3 from ${version??"fresh"}`,async t=>{
 const f=await fixture(t,version),owner=new ProvisionalThreads(f.root);
 try{assert.equal(owner.outcome.status,version===undefined?"fresh":version===2?"migrated":"up-to-date");assert.equal(owner.outcome.appliedVersion,3);assert.equal(owner.get("existing")?.environmentOwner,version?"private-owner":undefined);}
 finally{owner.close();}
 const db=new DatabaseSync(f.path,{readOnly:true});try{const row=db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=3").get()!;assert.equal(row.name,history[2].name);assert.equal(row.checksum,"55c711380776998c659c2d90130fec6c82b94f555311ed5f188bd2323e9f8490");assert.ok(db.prepare("PRAGMA table_info(thread_creations)").all().some(c=>c.name==="catalog_only"));}finally{db.close();}
 const again=new ProvisionalThreads(f.root);try{assert.equal(again.outcome.status,"up-to-date");}finally{again.close();}
});
for(const damage of ["name","checksum","schema"] as const)test(`creation evidence rejects changed ${damage}`,async t=>{
 const f=await fixture(t,3),db=new DatabaseSync(f.path);
 if(damage==="schema")db.exec("ALTER TABLE thread_creations ADD COLUMN unexpected TEXT");else db.prepare(`UPDATE schema_migrations SET ${damage}=? WHERE version=3`).run("changed");db.close();
 assert.throws(()=>new ProvisionalThreads(f.root),(e:any)=>e.kind==="history-mismatch");const read=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(read.prepare("SELECT environment_owner FROM thread_creations WHERE thread_id='existing'").get()!.environment_owner,"private-owner");}finally{read.close();}
});
