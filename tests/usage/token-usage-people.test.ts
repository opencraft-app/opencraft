import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { labelUsagePeople } from "../../apps/opencraft-daemon/src/token-usage-people.js";

test("authorized paginated people use current directory names without storing names, changing allocation or exposing other people to self", async () => {
  const directory = await mkdtemp(join(tmpdir(),"oc-usage-people-")), state = new TokenUsageStateDatabase(directory);
  const at = Date.parse("2026-10-21T00:00:00Z"), ledger = new OpenCraftTokenUsageLedger(state,"server",()=>at);
  const key = {threadId:"thread",turnId:"turn"}, request = {from:"2026-10-21",through:"2026-10-21"};
  const admin = ()=>({actorId:"admin",administrator:true}), self = ()=>({actorId:"A",administrator:false});
  try {
    ledger.startTurn(key,at,"human",true);
    for (const actorId of ["A","B"]) ledger.recordInput(key,{inputId:actorId,actorId,actorKind:"human",mode:"start",admission:"confirmed"});
    ledger.recordSource({...key,lineage:"epoch",sourceId:"r",kind:"response",version:0,provider:"p",model:"m",counts:{totalTokens:"120000"}});
    let name = "Alice", lookups:string[]=[];
    const lookup=(id:string)=>{lookups.push(id);return {kind:"human",displayName:id==="A"?name:"Bob"};};
    const people=ledger.query({...request,scope:"team",view:"actors",limit:1},admin), revision=people.snapshotRevision;
    const first=labelUsagePeople(people,lookup);assert.equal((first.rows[0] as any).label,"Alice");assert.equal((people.rows[0] as any).label,undefined);
    const second=labelUsagePeople(ledger.query({...request,scope:"team",view:"actors",limit:1,cursor:first.nextCursor},admin),lookup);
    assert.equal((second.rows[0] as any).label,"Bob");assert.deepEqual(lookups,["A","B"]);
    const selected=ledger.query({...request,scope:"team",actorId:"A"},admin);assert.equal(selected.summary.tokens,"60000");assert.equal(selected.snapshotRevision,revision);
    name="Alice renamed";assert.equal((labelUsagePeople(people,lookup).rows[0] as any).label,name);
    const own=ledger.query(request,self), before=lookups.length;assert.equal(labelUsagePeople(own,lookup),own);assert.equal(lookups.length,before);assert.ok(!JSON.stringify(own).includes("Bob"));
    assert.equal((labelUsagePeople(people,()=>null).rows[0] as any).label,null);
    assert.equal((labelUsagePeople(people,()=>({kind:"session",displayName:"Session credential"})).rows[0] as any).label,null);
    assert.equal(JSON.stringify(state.database.prepare("SELECT * FROM token_usage_inputs").all()).includes("Alice"),false);
  } finally {state.close();await rm(directory,{recursive:true,force:true});}
});
