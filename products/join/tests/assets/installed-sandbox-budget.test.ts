import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmployeeGitVaultStore } from "../../../../scripts/employee-git-vault-store";
import { InstalledSandboxBudget } from "../../assets/installed-sandbox-budget";
import { SandboxCreationFault, type SandboxBackend } from "../../../../packages/sandbox/src/index";
const resources={cpuMillis:8000,memoryBytes:16*1024**3},signal=new AbortController().signal;
const identity=(id:string)=>({id,owner:"owner",backend:"e2b"});
const backend=(create:SandboxBackend["create"]):SandboxBackend=>({id:"e2b",async initialize(){},async close(){},create});
const environment=()=>({resources,capabilities:{terminal:true},async spawn():Promise<never>{throw Error("unused")},async close(){}});
function fixture(t:test.TestContext){
 const root=mkdtempSync(join(tmpdir(),"installed-budget-"));let vault=new EmployeeGitVaultStore(root);
 const budget=()=>new InstalledSandboxBudget(vault,()=>resources);
 t.after(()=>{vault.close();rmSync(root,{recursive:true,force:true})});
 return {budget:budget(),reopen(){vault.close();vault=new EmployeeGitVaultStore(root);return budget()}};
}
test("Bot and ordinary creation share capacity before any provider await",async t=>{
 const f=fixture(t);let release!:()=>void,calls=0;
 const gate=new Promise<void>(r=>release=r);
 const provider=backend(async()=>{calls++;await gate;return environment()});
 const bot=f.budget.wrap("bot",provider),ordinary=f.budget.wrap("ordinary",provider);
 const creating=bot.create(identity("bot"),resources,signal);
 await assert.rejects(ordinary.create(identity("ordinary"),resources,signal),e=>e instanceof SandboxCreationFault&&e.outcome==="not-created");
 assert.equal(calls,1);release();const first=await creating;await first.close();
 const second=await ordinary.create(identity("ordinary"),resources,signal);assert.equal(calls,2);await second.close();
});
test("confirmed non-creation releases shared reservation",async t=>{
 const f=fixture(t);
 await assert.rejects(f.budget.wrap("bot",backend(async()=>{throw new SandboxCreationFault("not-created")})).create(identity("failed"),resources,signal));
 const next=await f.budget.wrap("ordinary",backend(async()=>environment())).create(identity("next"),resources,signal);
 await next.close();
});
test("unknown creation remains charged after backend close and vault restart",async t=>{
 const f=fixture(t),wrapped=f.budget.wrap("bot",backend(async()=>{throw Error("connection lost")}));
 await assert.rejects(wrapped.create(identity("unknown"),resources,signal));await wrapped.close();
 let called=false;const next=f.reopen().wrap("ordinary",backend(async()=>{called=true;return environment()}));
 await assert.rejects(next.create(identity("next"),resources,signal));assert.equal(called,false);
});
test("unconfirmed deletion remains charged across restart",async t=>{
 const f=fixture(t),first=await f.budget.wrap("ordinary",backend(async()=>({...environment(),async close(){throw Error("delete unknown")}})))
  .create(identity("first"),resources,signal);
 await assert.rejects(first.close());await assert.rejects(first.close());
 const next=f.reopen().wrap("bot",backend(async()=>environment()));
 await assert.rejects(next.create(identity("next"),resources,signal));
});
test("pending cleanup retains budget and successful repeated close releases only once",async t=>{
 const f=fixture(t);let release!:()=>void,closes=0;
 const gate=new Promise<void>(r=>release=r);
 const first=await f.budget.wrap("ordinary",backend(async()=>({...environment(),async close(){closes++;await gate}})))
  .create(identity("first"),resources,signal);
 const closing=first.close();assert.strictEqual(first.close(),closing);
 const next=f.budget.wrap("bot",backend(async()=>environment()));
 await assert.rejects(next.create(identity("next"),resources,signal));
 release();await closing;assert.equal(closes,1);
 const second=await next.create(identity("next"),resources,signal);await second.close();
});
test("pre-aborted request does not call provider or consume shared capacity",async t=>{
 const f=fixture(t),abort=new AbortController();abort.abort();let calls=0;
 const wrapped=f.budget.wrap("bot",backend(async()=>{calls++;return environment()}));
 await assert.rejects(wrapped.create(identity("abort"),resources,abort.signal));assert.equal(calls,0);
 const first=await wrapped.create(identity("normal"),resources,signal);await first.close();
});
