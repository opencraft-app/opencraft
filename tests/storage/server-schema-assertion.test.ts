import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {assertServerDeclaredSchema} from "../support/assert-server-declared-schema.js";
const declared="CREATE TABLE personal_assistants (id TEXT PRIMARY KEY,owner_human_id TEXT NOT NULL,is_default INTEGER NOT NULL DEFAULT 1,CHECK(is_default IN (0,1))) STRICT; CREATE UNIQUE INDEX personal_assistants_default_owner_unique ON personal_assistants(owner_human_id) WHERE is_default=1;";
test("reviewed physical schema comparison admits equivalent inline CHECK representation",()=>{
 const db=new DatabaseSync(':memory:');try{db.exec(declared.replace('DEFAULT 1,CHECK(is_default IN (0,1))','DEFAULT 1 CHECK(is_default IN (0,1))'));assertServerDeclaredSchema(db,declared);}finally{db.close();}
});
for(const damage of ["default","check","foreign","strict","partial-index","extra-index"] as const)test(`reviewed physical schema comparison still rejects ${damage}`,()=>{
 const db=new DatabaseSync(':memory:');try{
  let changed=declared;
  if(damage==="default")changed=changed.replace('DEFAULT 1','DEFAULT 0');
  if(damage==="check")changed=changed.replace('IN (0,1)','IN (0,1,2)');
  if(damage==="foreign")changed=changed.replace('owner_human_id TEXT NOT NULL','owner_human_id TEXT NOT NULL REFERENCES owners(id)');
  if(damage==="strict")changed=changed.replace(' STRICT','');
  if(damage==="partial-index")changed=changed.replace('WHERE is_default=1','WHERE is_default=0');
  db.exec(changed);if(damage==="extra-index")db.exec('CREATE INDEX unexpected ON personal_assistants(is_default)');
  assert.throws(()=>assertServerDeclaredSchema(db,declared));
 }finally{db.close();}
});
