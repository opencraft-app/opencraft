import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openManagedDatabase} from "@opencraft/sqlite-node";
import {ActorStore} from "@opencraft/access-control/actors";
import {openServerDatabase,SERVER_MIGRATIONS,SERVER_DATA_CONTRACT} from "@opencraft/storage-node/server";
import {SERVER_ALTERNATE_MIGRATIONS} from "../../packages/storage-node/src/server/migrations.generated.js";
const publishedGenericIdentity = [
  {
    "version": 1,
    "name": "0000_server_core",
    "checksum": "d9988a3f715bac332da54dd79455a47fd34ef568cb1dbef797936e8286df05af"
  },
  {
    "version": 2,
    "name": "0001_execution_capability_bindings",
    "checksum": "5fe82f0e68f34983b2b5255d7873485f5b826318d59fccd07ff6c23384b19b31"
  },
  {
    "version": 3,
    "name": "0002_thread_access_and_notes",
    "checksum": "569fa2217ae43ec59b90b6323573af514663aa00c370eb0614d473158665a47e"
  },
  {
    "version": 4,
    "name": "0003_project_automations",
    "checksum": "ed4100079a93f254664dc61176cf01202d8d00a7df8184d36f67acb33981874f"
  },
  {
    "version": 5,
    "name": "0004_magenta_aqueduct",
    "checksum": "f6d13ee0808a333c14a05a9febbcf5a7a58e4689b802e03869b6203fd7bb84c6"
  },
  {
    "version": 6,
    "name": "0005_native_channels",
    "checksum": "750d52e3cb3dd983a5b7339f4cb59779456cc6fa5228f3f5289bd7d0e5065dd8"
  },
  {
    "version": 7,
    "name": "0006_actor_inbox",
    "checksum": "f41a01bbeeb44df393266b4e36bf4440e30f86359082630a8a9cbb53d84148f1"
  },
  {
    "version": 8,
    "name": "0007_native_channel_sync",
    "checksum": "f1beed6031ff9069ce1b1697c466213d2547c6587227d1895da46c088dc34efd"
  },
  {
    "version": 9,
    "name": "0008_personal_assistants",
    "checksum": "f42175da982c1380f855fe0fda80e87a9b2084b88b982be36b6748e2bc42f53f"
  },
  {
    "version": 10,
    "name": "0009_personal_assistant_credentials",
    "checksum": "8f4a7481d769026df0d35756e33e841744ca291a63f5733aad2daf2fa4177103"
  },
  {
    "version": 11,
    "name": "0010_assistant_model_selection",
    "checksum": "272febfc9fd6d396bd05ab16f12ab7b99485058f6aa7312bb1ac28df98939a60"
  },
  {
    "version": 12,
    "name": "0011_eminent_mathemanic",
    "checksum": "7281923e750c75042b9b0cd784bf8017594566aaedebd96a3a0130853864bdd6"
  },
  {
    "version": 13,
    "name": "0012_dear_wild_pack",
    "checksum": "d3cb22474c9393bf2a8787e45cd67b6143b87606f1246ee0d921f2211dfea5b9"
  },
  {
    "version": 14,
    "name": "0013_channel_attachments",
    "checksum": "f58b0bbe9d80a47d9247535059881587be505b33dfe679859bf930bcf42a1b59"
  },
  {
    "version": 15,
    "name": "0014_native_channel_mentions",
    "checksum": "fa9447bfcc3ab802054f0d2b705705e2c0775453e52a0ee8a6bd6fa04a40a868"
  },
  {
    "version": 16,
    "name": "0015_visible_mention_reads",
    "checksum": "6730029e68957a8a788500baa6ec3c31bac39429efda69be3d3653e6c1a3e471"
  },
  {
    "version": 17,
    "name": "0016_human_reservations",
    "checksum": "ea19b836061f82c6c25908f5c10c7e70f18306bd31c239c138d171e75f69cb6c"
  },
  {
    "version": 18,
    "name": "0017_multi_bot_assignments",
    "checksum": "92419be103c6c03065cdf4ad7cf903e75def97eef97b7718920d1dd3f7b1f16f"
  },
  {
    "version": 19,
    "name": "0018_native_group_lifecycle",
    "checksum": "0c322591d0f760d46eb10adecad67adcebf8f9b504effebcbf9a28b6e48f6814"
  }
];
const identities=(chain:readonly {version:number;name:string;sql:string}[])=>chain.map(m=>({version:m.version,name:m.name,checksum:createHash("sha256").update(m.sql).digest("hex")}));
const ledger=(db:any)=>db.prepare("SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version").all();
const retained=(db:any)=>Object.fromEntries([
 ["actor_authority","singleton"],["actors","id"],["actor_credentials","id"],["actor_grants","actor_id,resource,action"],
 ["thread_access","server_id,thread_id"],["thread_notes","server_id,thread_id"],
].map(([table,order])=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()]));
test("declared generic v19 preserves its ledger, authority, credentials and policy when opened by the current owner",async t=>{
 const families=[{id:"canonical",migrations:SERVER_MIGRATIONS},...SERVER_ALTERNATE_MIGRATIONS];
 const family=families.find(f=>JSON.stringify(identities(f.migrations.slice(0,19)))===JSON.stringify(publishedGenericIdentity));
 assert.ok(family,"exact frozen generic history must be declared, never guessed from table shape");
 const prefix=family.migrations.slice(0,19);assert.deepEqual(identities(prefix),publishedGenericIdentity);
 const root=await mkdtemp(join(tmpdir(),"generic-owner-upgrade-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const old=openManagedDatabase({path:join(root,"opencraft-server.sqlite"),migrations:prefix,legacyPolicy:"reject"});
 const actors=new ActorStore(old);const actor=actors.createSession("Synthetic migration owner","fixture-operator");
 actors.issueCredential(actor.id,Date.now()+600_000,"fixture-operator");
 actors.setGrant(actor.id,actor.id,"message.send",true,"fixture-operator");
 old.database.prepare("INSERT INTO thread_access VALUES('fixture-host','fixture-thread',?,'private',7,1)").run(actor.id);
 old.database.exec("INSERT INTO thread_notes VALUES('fixture-host','fixture-thread',X'000102ff',1)");
 const beforeRows=retained(old.database),beforeLedger=ledger(old.database);actors.close();old.database.close();
 const owner=await openServerDatabase(root);
 try{
  assert.equal(owner.contract.hash,SERVER_DATA_CONTRACT.hash);
  assert.equal(owner.outcome.appliedVersion,family.migrations.length);
  assert.deepEqual(ledger(owner.database).slice(0,19),beforeLedger,"no prior migration row or timestamp may be rewritten");
  assert.deepEqual(retained(owner.database),beforeRows,"authority, credentials, grants, access policy and note bytes remain unchanged");
  if(family.migrations.length>19)assert.ok(owner.outcome.backupPath,"appending owner-specific SQL uses normal managed backup");
 }finally{await owner.close();}
 const again=await openServerDatabase(root);try{
  assert.equal(again.outcome.status,"up-to-date");assert.deepEqual(retained(again.database),beforeRows);
  assert.deepEqual(ledger(again.database).slice(0,19),beforeLedger);
 }finally{await again.close();}
});
