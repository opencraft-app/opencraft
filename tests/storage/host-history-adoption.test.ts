import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { OpenCraftHostStateDatabase, OPENCRAFT_HOST_STATE_MIGRATIONS as legacy } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.js";
import { openManagedDatabase, resolveStoreMigrations } from "../../packages/sqlite-node/src/index.js";
const adopted={"version": 17, "name": "input-delivery-lifecycle", "sql": "\nALTER TABLE opencraft_host_queue RENAME TO opencraft_host_queue_v16;\nDROP INDEX opencraft_host_queue_order;\nDROP INDEX opencraft_host_queue_state;\nCREATE TABLE opencraft_host_queue (\n  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, client_id TEXT NOT NULL, input_json TEXT NOT NULL,\n  position INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,\n  state TEXT NOT NULL CHECK(state IN ('queued','dispatching','steering','unknown','delivered','discarded','closed')),\n  target_turn_id TEXT, paused_reason TEXT, UNIQUE(thread_id,client_id)\n) STRICT;\nINSERT INTO opencraft_host_queue SELECT * FROM opencraft_host_queue_v16;\nDROP TABLE opencraft_host_queue_v16;\nCREATE INDEX opencraft_host_queue_order ON opencraft_host_queue(thread_id,position,created_at_ms);\nCREATE INDEX opencraft_host_queue_state ON opencraft_host_queue(state,thread_id);\nCREATE INDEX opencraft_host_queue_turn ON opencraft_host_queue(thread_id,target_turn_id,state);\nCREATE TABLE opencraft_input_delivery (\n  thread_id TEXT NOT NULL, client_id TEXT NOT NULL,\n  native_admission TEXT NOT NULL CHECK(native_admission IN ('pending','accepted','unknown','rejected')),\n  context_state TEXT NOT NULL CHECK(context_state IN ('unobserved','recorded')),\n  revision INTEGER NOT NULL, PRIMARY KEY(thread_id,client_id),\n  FOREIGN KEY(thread_id,client_id) REFERENCES opencraft_host_queue(thread_id,client_id)\n) STRICT;\nCREATE TABLE opencraft_turn_delivery (\n  thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,\n  outcome TEXT NOT NULL CHECK(outcome IN ('completed','interrupted','failed')),\n  observed_at_ms INTEGER NOT NULL, PRIMARY KEY(thread_id,turn_id)\n) STRICT;\nINSERT INTO opencraft_input_delivery(thread_id,client_id,native_admission,context_state,revision)\nSELECT thread_id,client_id,CASE WHEN state IN ('steering','delivered') THEN 'accepted'\n  WHEN state IN ('dispatching','unknown') THEN 'unknown' ELSE 'pending' END,'unobserved',1\nFROM opencraft_host_queue;\n"} as const;
assert.equal(legacy.length,16);
assert.deepEqual(legacy.map(m=>createHash("sha256").update(m.sql).digest("hex")),["c2508ef065ded8821d7c071fab1603b403b4e5e9220569916f1cee53f82025c3", "809a3629f5a894a7cf6dbebc50b6f89b8a6485ee894480efa3aaafa1516a394d", "8cb7b36a3d2735390617cdd83718400eb690cad4db51de5db582f6d08f6c1749", "882898aab8d89b0f6f2c2122ef62835541b238a76aab58afd64694caf83bbc84", "4e8ef5e0d3c77f29b5b7d8c7b25613b46c61aa9fe2943014baaa2350fa66a738", "b6b659d6dcb27563e2f46f2b7a769869104e53c681c2d143d2f14c444435c9b1", "0c13491d10765f1c1999214f735e76d80f099b7b9f908591183700e462c7f316", "aa471aeaf733439963eee5cb986bbd133750b9ee2ee285a8e668eb0880364ad2", "2978f6731e228a8caa6e67d31f932215464ee608bf4e673bbc63990510318ef0", "4ecc69a600fc726fcea62d7358c4d564d59915470965da2fdc92a489dce4393c", "c600ec13cc362bc937a377bbfbd5c447175218d438f9db8fac0752dc77a8a359", "3978288eb0a59ba87004b4f964cfd65eb7a8867ef591709a9c492d1c9392b46b", "6f9f5094f84e11792897f3e232b3371a22cfe2bbfee91c338755464f9102aa1a", "9339b195ffd243ddc903e86a88722d65c24386ec64ac71917546c885c7583e73", "555091035a70dcc3e413a6be64dcfdc4a574799bfe2608ae546dab8de089d7b9", "54d6f348751c19776c29569fa98f69bcf094196e5b92d5fc67e3dae66387ffad"]);
assert.deepEqual(resolveStoreMigrations("opencraft-host-state-database",legacy),[...legacy,adopted]);
async function fixture(t:test.TestContext,version?:16|17){
 const directory=await mkdtemp(join(tmpdir(),"host-history-"));t.after(()=>rm(directory,{recursive:true,force:true}));
 const path=join(directory,"opencraft-host-state.sqlite");
 if(version){
  const old=openManagedDatabase({path,migrations:version===16?legacy:[...legacy,adopted]});
  old.database.prepare("INSERT INTO opencraft_host_queue(id,thread_id,client_id,input_json,position,created_at_ms,updated_at_ms,state) VALUES(?,?,?,?,?,?,?,?)").run("queue","thread","input","{}",0,1,1,"delivered");
  old.database.close();
 }
 return {directory,path};
}
for(const version of [undefined,16,17] as const)test(`Host ledger preserves private v17 from ${version??"fresh"}`,async t=>{
 const f=await fixture(t,version),owner=new OpenCraftHostStateDatabase(f.directory);
 try{
  assert.equal(owner.outcome.status,version===undefined?"fresh":version===16?"migrated":"up-to-date");assert.equal(owner.outcome.appliedVersion,17);
  const row=owner.database.prepare("SELECT name,checksum FROM schema_migrations WHERE version=17").get()!;
  assert.equal(row.name,adopted.name);assert.equal(row.checksum,"67f4d4d9067c1f168c1ec3d342f9d650ee640286ed325cce1be972be58f8e118");
  assert.equal(owner.database.prepare("SELECT count(*) AS n FROM opencraft_host_queue").get()!.n,version?1:0);
  if(version===16)assert.equal(owner.database.prepare("SELECT native_admission FROM opencraft_input_delivery WHERE thread_id='thread' AND client_id='input'").get()!.native_admission,"accepted");
 }finally{owner.close();}
 const again=new OpenCraftHostStateDatabase(f.directory);try{assert.equal(again.outcome.status,"up-to-date");}finally{again.close();}
});
for(const damage of ["name","checksum","schema"] as const)test(`Host ledger rejects altered ${damage}`,async t=>{
 const f=await fixture(t,17),db=new DatabaseSync(f.path);
 if(damage==="schema")db.exec("DROP TABLE opencraft_turn_delivery");
 else db.prepare(`UPDATE schema_migrations SET ${damage}=? WHERE version=17`).run("changed");
 db.close();assert.throws(()=>new OpenCraftHostStateDatabase(f.directory),(e:any)=>e.kind==="history-mismatch");
 const read=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(read.prepare("SELECT count(*) AS n FROM opencraft_host_queue").get()!.n,1);}finally{read.close();}
});
