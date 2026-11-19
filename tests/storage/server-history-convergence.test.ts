import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {openManagedDatabase,createSchemaValidator,type Migration} from "../../packages/sqlite-node/src/index.js";
import {openServerDatabase,SERVER_MIGRATIONS,SERVER_DATA_CONTRACT} from "../../packages/storage-node/src/server/index.js";
import {SERVER_ALTERNATE_MIGRATIONS} from "../../packages/storage-node/src/server/migrations.generated.js";
const identities=(chain:readonly Migration[])=>chain.map(m=>({version:m.version,name:m.name,checksum:createHash("sha256").update(m.sql).digest("hex")}));
const privatePublished=SERVER_MIGRATIONS.slice(0,20);
const publicPublished=SERVER_ALTERNATE_MIGRATIONS[0]!.migrations.slice(0,5);
assert.deepEqual(identities(privatePublished),[
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
    "name": "0002_native_channels",
    "checksum": "750d52e3cb3dd983a5b7339f4cb59779456cc6fa5228f3f5289bd7d0e5065dd8"
  },
  {
    "version": 4,
    "name": "0003_actor_inbox",
    "checksum": "f41a01bbeeb44df393266b4e36bf4440e30f86359082630a8a9cbb53d84148f1"
  },
  {
    "version": 5,
    "name": "0004_native_channel_sync",
    "checksum": "f1beed6031ff9069ce1b1697c466213d2547c6587227d1895da46c088dc34efd"
  },
  {
    "version": 6,
    "name": "0005_personal_assistants",
    "checksum": "f42175da982c1380f855fe0fda80e87a9b2084b88b982be36b6748e2bc42f53f"
  },
  {
    "version": 7,
    "name": "0006_personal_assistant_credentials",
    "checksum": "8f4a7481d769026df0d35756e33e841744ca291a63f5733aad2daf2fa4177103"
  },
  {
    "version": 8,
    "name": "0007_assistant_model_selection",
    "checksum": "272febfc9fd6d396bd05ab16f12ab7b99485058f6aa7312bb1ac28df98939a60"
  },
  {
    "version": 9,
    "name": "0008_thread_access_and_notes",
    "checksum": "569fa2217ae43ec59b90b6323573af514663aa00c370eb0614d473158665a47e"
  },
  {
    "version": 10,
    "name": "0009_project_automations",
    "checksum": "ed4100079a93f254664dc61176cf01202d8d00a7df8184d36f67acb33981874f"
  },
  {
    "version": 11,
    "name": "0010_eminent_mathemanic",
    "checksum": "7281923e750c75042b9b0cd784bf8017594566aaedebd96a3a0130853864bdd6"
  },
  {
    "version": 12,
    "name": "0011_dear_wild_pack",
    "checksum": "d3cb22474c9393bf2a8787e45cd67b6143b87606f1246ee0d921f2211dfea5b9"
  },
  {
    "version": 13,
    "name": "0012_channel_attachments",
    "checksum": "f58b0bbe9d80a47d9247535059881587be505b33dfe679859bf930bcf42a1b59"
  },
  {
    "version": 14,
    "name": "0013_join_wecom_assistants",
    "checksum": "83ca7e2215baf628925c6848188a9652778733a4d4aa11087acb2e7f3c144d87"
  },
  {
    "version": 15,
    "name": "0014_join_wecom_group_sync",
    "checksum": "4e6c69ba8f5807649ec90ad2ed504787a7e937db50f81eb6e3fd1b5fb4416ae7"
  },
  {
    "version": 16,
    "name": "0015_native_channel_mentions",
    "checksum": "fa9447bfcc3ab802054f0d2b705705e2c0775453e52a0ee8a6bd6fa04a40a868"
  },
  {
    "version": 17,
    "name": "0016_visible_mention_reads",
    "checksum": "6730029e68957a8a788500baa6ec3c31bac39429efda69be3d3653e6c1a3e471"
  },
  {
    "version": 18,
    "name": "0017_human_reservations",
    "checksum": "ea19b836061f82c6c25908f5c10c7e70f18306bd31c239c138d171e75f69cb6c"
  },
  {
    "version": 19,
    "name": "0018_multi_bot_assignments",
    "checksum": "92419be103c6c03065cdf4ad7cf903e75def97eef97b7718920d1dd3f7b1f16f"
  },
  {
    "version": 20,
    "name": "0019_native_group_lifecycle",
    "checksum": "0c322591d0f760d46eb10adecad67adcebf8f9b504effebcbf9a28b6e48f6814"
  }
]);
assert.deepEqual(identities(publicPublished),[
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
  }
]);
const ledger=(db:DatabaseSync)=>db.prepare("SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version").all();
async function fixture(t:test.TestContext,chain?:readonly Migration[]){
 const directory=await mkdtemp(join(tmpdir(),"server-lineage-"));t.after(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,"opencraft-server.sqlite");let before:any[]=[];
 if(chain){const old=openManagedDatabase({path,migrations:chain,legacyPolicy:"reject"});
  old.database.exec("INSERT INTO access_audit VALUES(1,1,'fixture','binding','action')");
  if(chain===publicPublished)old.database.exec("INSERT INTO collaboration_spaces VALUES('space','Retained space','synthetic-owner',1)");
  if(chain===publicPublished || chain===privatePublished)old.database.exec("INSERT INTO thread_access VALUES('server','thread','fixture-owner','private',7,1); INSERT INTO thread_notes VALUES('server','thread',X'000102ff',1); INSERT INTO automation_grants VALUES('grant','server','project','fixture-owner',1,'{}',NULL,1)");
  before=ledger(old.database);old.database.close();}
 return{directory,path,before};
}
for(const [label,chain] of [["fresh",undefined],["common-v2",privatePublished.slice(0,2)],["private-v20",privatePublished],["public-v5",publicPublished]] as const)test(`Server converges ${label} without rewriting published rows`,async t=>{
 const f=await fixture(t,chain),owner=await openServerDatabase(f.directory);
 try{
  assert.equal(owner.outcome.appliedVersion,21);assert.equal(owner.contract.hash,SERVER_DATA_CONTRACT.hash);
  assert.deepEqual(ledger(owner.database).slice(0,f.before.length),f.before,"old names/checksums/timestamps remain exactly unchanged");
  assert.equal(owner.database.prepare("SELECT count(*) n FROM access_audit").get()!.n,chain?1:0);
  if(label==="public-v5")assert.equal(owner.database.prepare("SELECT name FROM collaboration_spaces WHERE id='space'").get()!.name,"Retained space");
  if(label==="public-v5"||label==="private-v20"){
    assert.deepEqual(owner.database.prepare("SELECT access_mode,creator_actor_id,revision FROM thread_access WHERE thread_id='thread'").get(),Object.assign(Object.create(null),{access_mode:"private",creator_actor_id:"fixture-owner",revision:7}));
    assert.deepEqual([...owner.database.prepare("SELECT state FROM thread_notes WHERE thread_id='thread'").get()!.state as Uint8Array],[0,1,2,255]);
    assert.equal(owner.database.prepare("SELECT actor_id FROM automation_grants WHERE id='grant'").get()!.actor_id,"fixture-owner");
  }
  createSchemaValidator(SERVER_MIGRATIONS.map(m=>m.sql).join("\n"))(owner.database);
  if(chain)assert.ok(owner.outcome.backupPath,"ordinary managed backup precedes appending missing SQL");
 }finally{await owner.close();}
 const again=await openServerDatabase(f.directory);try{assert.equal(again.outcome.status,"up-to-date");}finally{await again.close();}
});
for(const damage of ["name","checksum","mixed","newer"] as const)test(`Server refuses ${damage} lineage without editing ledger or rows`,async t=>{
 const f=await fixture(t,privatePublished),db=new DatabaseSync(f.path);
 if(damage==="mixed")db.prepare("UPDATE schema_migrations SET name=?,checksum=? WHERE version=3").run(publicPublished[2].name,identities(publicPublished)[2]!.checksum);
 else if(damage==="newer")db.prepare("INSERT INTO schema_migrations VALUES(22,'future',?,1)").run("0".repeat(64));
 else db.prepare(`UPDATE schema_migrations SET ${damage}=? WHERE version=3`).run("changed");
 const expected=ledger(db);db.close();
 await assert.rejects(openServerDatabase(f.directory),(error:any)=>error.kind===(damage==="newer"?"newer-schema":"history-mismatch"));
 const read=new DatabaseSync(f.path,{readOnly:true});try{assert.deepEqual(ledger(read),expected);assert.equal(read.prepare("SELECT count(*) n FROM access_audit").get()!.n,1);}finally{read.close();}
});
