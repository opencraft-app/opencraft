import test from "node:test";
import assert from "node:assert/strict";
import {join} from "node:path";
import {build} from "esbuild";
import {humanAuthFixture} from "../support/human-auth-fixture.js";
import {TokenUsageStateDatabase} from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import {OpenCraftTokenUsageLedger} from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import {TokenUsageQueryService} from "../../apps/opencraft-daemon/src/token-usage-query-service.js";
import {TokenUsageQueryError} from "../../apps/opencraft-daemon/src/token-usage-query.js";

test("server-verified local logins isolate usage and recheck instance membership and logout during a read",async t=>{
 const f=await humanAuthFixture(t),password="isolated-usage-fixture-passphrase";
 const people=[];
 for(const [username,role] of [["alice","member"],["bob","member"],["operator","admin"]] as const){
  const principal=await f.localAccounts.create(username,username,password),actor=f.actors.resolveHuman(principal)!;
  f.members.setActor(actor.actorId,role,true,"fixture-operator");
  const browser=f.browser();assert.equal((await browser.call('/__opencraft_auth/local',{username,password,mode:"login"})).status,200);
  assert.equal((await (await browser.call('/__opencraft_actors/me')).json() as any).actor.id,actor.actorId);
  people.push({browser,id:actor.actorId});
 }
 const [a,b,admin]=people as [typeof people[number],typeof people[number],typeof people[number]];
 const state=new TokenUsageStateDatabase(join(f.directory,"usage")),at=Date.parse("2026-10-21T00:00:00Z"),ledger=new OpenCraftTokenUsageLedger(state,"server",()=>at);
 const entry=join(f.directory,"usage-worker.mjs");
 await build({entryPoints:[new URL("../../apps/opencraft-daemon/src/token-usage-query-worker.ts",import.meta.url).pathname],outfile:entry,bundle:true,platform:"node",format:"esm",target:"node26",logLevel:"silent"});
 const service=new TokenUsageQueryService({entry,databasePath:join(f.directory,"usage","token-usage.sqlite"),serverId:"server"});
 t.after(()=>{service.close();state.close();});
 const key={threadId:"shared",turnId:"turn"};ledger.startTurn(key,at,"human",true);
 for(const person of [a,b])ledger.recordInput(key,{inputId:person.id,actorId:person.id,actorKind:"human",mode:"start",admission:"confirmed"});
 ledger.recordSource({...key,lineage:"native",sourceId:"r",kind:"response",version:0,provider:"p",model:"m",counts:{totalTokens:"120000"}});
 const params={from:"2026-10-21",through:"2026-10-21"};
 const authorize=(cookie:string)=>{const request={headers:{cookie}};return ()=>f.actorAccess.usageAuthority(request);};
 for(const person of [a,b]){
  const own=await service.read(params,authorize(person.browser.cookie));assert.equal(own.summary.tokens,"60000");
  assert.equal(own.rows[0]&&"rawTokens" in own.rows[0]?own.rows[0].rawTokens:null,"120000");
  assert.equal(JSON.stringify(own).includes(person===a?b.id:a.id),false);
  await assert.rejects(service.read({...params,scope:"team"},authorize(person.browser.cookie)),e=>e instanceof TokenUsageQueryError&&e.code==="forbidden");
  await assert.rejects(service.read({...params,actorId:person===a?b.id:a.id},authorize(person.browser.cookie)),e=>e instanceof TokenUsageQueryError&&e.code==="forbidden");
 }
 assert.equal((await service.read({...params,scope:"team"},authorize(admin.browser.cookie))).summary.tokens,"120000");
 const downgrade=service.read({...params,scope:"team"},authorize(admin.browser.cookie));
 f.members.setActor(admin.id,"member",true,"fixture-operator");
 await assert.rejects(downgrade,e=>e instanceof TokenUsageQueryError&&e.code==="forbidden");
 const oldCookie=a.browser.cookie;
 assert.equal((await a.browser.call('/__opencraft_auth/logout',{})).status,200);
 await assert.rejects(service.read(params,authorize(oldCookie)),e=>e instanceof TokenUsageQueryError&&e.code==="unauthorized");
 await assert.rejects(service.read(params,authorize("")),e=>e instanceof TokenUsageQueryError&&e.code==="unauthorized");
 assert.equal((await service.read(params,authorize(b.browser.cookie))).summary.tokens,"60000");
});
