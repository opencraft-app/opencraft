import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmployeeGitVaultStore } from "../../../../scripts/employee-git-vault-store";
import { OrdinaryWorkspaceServices } from "../../assets/ordinary-workspace-services";
import { SandboxConfigurations } from "../../assets/sandbox-configurations";
import type { HostFileSelector } from "../../../../scripts/host-filesystem-transport";
import type { HostTerminalServiceSelector } from "../../../../scripts/host-terminal-transport";
function fixture(t: test.TestContext) {
 const root=mkdtempSync(join(tmpdir(),"ordinary-services-"));
 const vault=new EmployeeGitVaultStore(root),configurations=new SandboxConfigurations(vault);
 const options={dataDirectory:root,machineId:"stable-machine",configurations,
  actors:{get(){return null},bindings(){return []},isCurrent(){return false}},getInstanceAccess(){return null}};
 const service=new OrdinaryWorkspaceServices(options);
 t.after(async()=>{try{await service.close()}finally{vault.close();rmSync(root,{recursive:true,force:true})}});
 return {service,options};
}
test("installed owner preserves explicit local file and terminal ports without E2B configuration",async t=>{
 const {service}=fixture(t),context={sender:null},scope={account:"alice",hostId:"host",threadId:"local",projectId:null};
 const files={async request(){return {local:true}}},terminal={async probe(){},subscribe(){return()=>{}},async dispatch(){return {}}};
 const localFiles:HostFileSelector=async(c,p)=>{assert.strictEqual(c,context);assert.deepEqual(p,{path:"/tmp"});return {files,assertCurrent(){}}};
 const localTerminal:HostTerminalServiceSelector=async(s,c)=>{assert.strictEqual(c,context);assert.deepEqual(s,scope);return terminal};
 assert.strictEqual((await service.selectFiles("host",context,{path:"/tmp"},localFiles)).files,files);
 assert.strictEqual(await service.selectTerminal("host",scope,context,localTerminal),terminal);
 await assert.rejects(service.selectTerminal("other",scope,context,localTerminal),/mismatch/);
});
test("workspace-scoped file requests cannot inherit the local port when admission is absent",async t=>{
 const {service}=fixture(t);let fallback=false;
 const local:HostFileSelector=async()=>{fallback=true;throw Error("local fallback")};
 await assert.rejects(service.selectFiles("host",{sender:null},{path:"/workspace",workspaceThreadId:"foreign"},local),/admission_unavailable/);
 assert.equal(fallback,false);
});
test("identity shutdown fences requests immediately and drains runtime before journal close",async t=>{
 const {service}=fixture(t);let release!:()=>void;
 const gate=new Promise<void>(r=>release=r),events:string[]=[];
 const runtimeClose=service.runtime.close.bind(service.runtime);
 service.runtime.close=async()=>{events.push("runtime");await gate;await runtimeClose();events.push("drained")};
 const store=(service as unknown as {store:{close():void}}).store,storeClose=store.close.bind(store);
 store.close=()=>{events.push("journal");storeClose()};
 const closing=service.close();assert.strictEqual(service.close(),closing);
 assert.throws(()=>service.selectFiles("host",{sender:null},{},async()=>{throw Error("fallback")}),/closed/);
 assert.deepEqual(events,["runtime"]);release();await closing;
 assert.deepEqual(events,["runtime","drained","journal"]);
});
test("runtime cleanup failure still closes journal and remains visible",async()=>{
 const root=mkdtempSync(join(tmpdir(),"ordinary-services-failure-"));
 const vault=new EmployeeGitVaultStore(root);
 const options={dataDirectory:root,machineId:"stable-machine",configurations:new SandboxConfigurations(vault),
  actors:{get(){return null},bindings(){return []},isCurrent(){return false}},getInstanceAccess(){return null}};
 const service=new OrdinaryWorkspaceServices(options);
 const close=service.runtime.close.bind(service.runtime);
 service.runtime.close=async()=>{await close();throw Error("cleanup failed")};
 try{
  await assert.rejects(service.close(),/cleanup unconfirmed/);
  const successor=new OrdinaryWorkspaceServices(options);
  await successor.close();
 }finally{vault.close();rmSync(root,{recursive:true,force:true})}
});

test("public catalog uses current actor admission and projects only logical choices",async t=>{
 const root=mkdtempSync(join(tmpdir(),"ordinary-public-catalog-")),vault=new EmployeeGitVaultStore(root);
 const configurations=new SandboxConfigurations(vault);
 configurations.adoptInstallation({apiUrl:'https://private.example.test',sandboxUrl:'https://private.example.test',
  capacity:{cpuMillis:1,memoryBytes:1},lease:{timeoutMs:300000,renewEveryMs:60000,maxLifetimeMs:3600000},persistentWorkspaces:true,
  templates:[{id:'base',name:'Base',workspaceRoot:'/workspace',resources:{cpuMillis:1,memoryBytes:1}}]},'private-catalog-fixture-key');
 let allowed=true;
 const actor={id:'alice',kind:'human' as const,displayName:'Alice',enabled:true,generation:1,createdAt:1,createdBy:null};
 const actors={get:()=>actor,bindings:()=>[{provider:'tencentoa',subject:'alice-subject'}],isCurrent:()=>allowed};
 const service=new OrdinaryWorkspaceServices({dataDirectory:root,machineId:'fixture',configurations,actors,
  getInstanceAccess:()=>({admitsActor:()=>allowed,store:{revocationRevision:()=>0}})});
 t.after(async()=>{await service.close();vault.close();rmSync(root,{recursive:true,force:true})});
 const context={sender:null,actorContext:{actorId:'alice',generation:1,expiresAt:Date.now()+60000,credentialId:null},
  executionPrincipal:{provider:'tencentoa',subject:'alice-subject'},validUntil:Date.now()+60000};
 const value=await service.readCatalog('host',context);
 assert.equal(value.version,1);assert.equal(value.environments.length,1);assert.equal(value.environments[0]!.name,'Base');
 const encoded=JSON.stringify(value);
 for(const secret of ['private-catalog-fixture-key','private.example.test','credentialId','volumeId','mountPath'])
  assert.equal(encoded.includes(secret),false);
 allowed=false;await assert.rejects(service.readCatalog('host',context),/admission_unavailable/);
});

test("browser placement retains exact remote lease and cannot fall back on missing configuration",async t=>{
 const {service,options}=fixture(t);let allowed=true,placed=false,configured=true;
 const actor={id:"alice",kind:"human",enabled:true,generation:1};
 Object.assign(options.actors,{get:(id:string)=>id==="alice"?actor:null,bindings:()=>[{provider:"tencentoa",subject:"alice"}]});
 Object.assign(options,{getInstanceAccess:()=>({admitsActor:()=>allowed,store:{revocationRevision:()=>0}})});
 const local={assertCurrent(){},async connect(){throw Error("must not connect during resolution")}};
 const remote={...local};
 Object.assign(service.runtime,{hasPlacement:()=>placed,async bindingFor(admission: {authority:{principalId:string}},threadId:string){
 assert.equal(admission.authority.principalId,"alice");assert.equal(threadId,"thread");return configured?{browser:remote}:{};}});
 const descriptor={ownerId:"alice",hostId:"host",threadId:"thread"};
 assert.strictEqual((await service.browserRoute(descriptor,local,()=>{})).lease,local);
 placed=true;const route=await service.browserRoute(descriptor,local,()=>{});assert.strictEqual(route.lease,remote);
 configured=false;await assert.rejects(service.browserRoute(descriptor,local,()=>{}),/not configured/);
 allowed=false;assert.throws(route.assertCurrent,/retired/);
 await assert.rejects(service.browserRoute(descriptor,local,()=>{}),/unavailable/);
});
