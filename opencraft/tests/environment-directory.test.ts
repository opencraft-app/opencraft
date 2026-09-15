import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { EnvironmentDirectory, EnvironmentDirectoryService, EnvironmentProfileStore, HostRuntimeRegistry, connectEnvironmentRuntimeRegistry, environmentIdentity,
  type EnvironmentEntry, type EnvironmentSource, type EnvironmentSourceSnapshot, type HostConnectionProfile, type HostConnectionProfileStore } from "../packages/workbench-runtime/src/index";
import { LightVelaEnvironmentSource } from "../plugins/lightvela-hermes/src/environment-directory";
import type { LightVelaAccountSnapshot } from "../plugins/lightvela-hermes/src/account/lightvela-account-service";

const profile = (hostId: string, providerId = "manual"): HostConnectionProfile => ({hostId, providerId, displayName: hostId, providerConfig: {}, providerConfigVersion: 1,
  hostKind: hostId === "local" ? "local" : "remote-control", enabled: true, autoConnect: false, includeInSidebar: true, credentialRef: null,
  transportEndpoint: null, executionLocation: null, workspaceBrowseRoots: [], revision: 1});
const entry = (id = "one", state = "running"): EnvironmentEntry => ({id, sourceId: "cloud", name: id, location: "Cloud", lifecycle: state, connectable: state === "running", profile: {...profile(id,"cloud"), enabled: state === "running"}});
function sourceFixture() {
  let state: EnvironmentSourceSnapshot = {revision: 0, phase: "ready", entries: [entry()], error: null};
  const listeners = new Set<() => void>();
  const source: EnvironmentSource = {id: "cloud", label: "Cloud", providerIds: ["cloud"], getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => {listeners.delete(listener);}; }, refresh: async () => {},
    matchProfile: profile => (profile.providerConfig as {id?:string}).id ?? null};
  return {source, set: (entries: EnvironmentEntry[]) => {state = {...state, entries, revision: state.revision+1}; listeners.forEach(fn=>fn());}, listeners};
}
function storeFixture(initial = [profile("local")]) {
  let state = {revision: 0, profiles: initial};
  const listeners = new Set<() => void>();
  let writes = 0;
  const store: HostConnectionProfileStore = {getSnapshot: () => state, subscribe: listener => {listeners.add(listener); return () => {listeners.delete(listener);};},
    put: async value => {writes++; state = {revision: state.revision+1, profiles: [...state.profiles.filter(p=>p.hostId!==value.hostId),value]};listeners.forEach(fn=>fn());},
    remove: async id => {writes++;state={revision:state.revision+1,profiles:state.profiles.filter(p=>p.hostId!==id)};listeners.forEach(fn=>fn());return true;},close:()=>listeners.clear()};
  return {store, writes:()=>writes};
}
test("directory aggregates recipes, preserves legacy identity and never persists discovery", () => {
  const d = new EnvironmentDirectory();
  const f = sourceFixture();
  const saved = storeFixture([profile("local"), {...profile("legacy","cloud"),providerConfig:{id:"one"}}]);
  const overlay = new EnvironmentProfileStore(saved.store,d);
  const unregister = d.register("plugin",f.source);
  assert.deepEqual(overlay.getSnapshot().profiles.map(p=>p.hostId),["local","legacy"]);
  assert.equal(saved.writes(),0);
  const snapshot=d.getSnapshot(); f.set([entry()]);
  assert.equal(d.getSnapshot(),snapshot,"identical source refresh preserves snapshot identity");
  f.set([entry(),entry("stopped","stopped")]);
  assert.equal(d.getSnapshot().entries.length,3);
  assert.equal(overlay.getSnapshot().profiles.find(p=>p.hostId==="stopped")?.enabled,false);
  unregister();assert.deepEqual(overlay.getSnapshot().profiles.map(p=>p.hostId),["local"],"unload does not resurrect a saved cloud alias");
  assert.equal(saved.writes(),0); overlay.close();d.close();
});
test("registration collision and unsubscribe are isolated by owner", () => {
  const d=new EnvironmentDirectory(),f=sourceFixture();const off=d.register("first",f.source);
  assert.throws(()=>d.register("second",f.source),/Duplicate/);
  off();off(); assert.equal(f.listeners.size,0);
  d.register("replacement",f.source);off();assert.equal(d.getSnapshot().entries.length,1);d.close();assert.equal(f.listeners.size,0);
});
test("discovery registers factories lazily without connecting or rebuilding resident runtimes", async () => {
  const d=new EnvironmentDirectory(),f=sourceFixture(),saved=storeFixture();const store=new EnvironmentProfileStore(saved.store,d);
  const registry=new HostRuntimeRegistry<{connect():Promise<void>;dispose():Promise<void>}>();let created=0,connected=0;
  const stop=connectEnvironmentRuntimeRegistry(store,registry,p=>({descriptor:{hostId:p.hostId,label:p.displayName,kind:p.hostKind,transportEndpoint:null,executionLocation:null,workspaceBrowseRoots:[]},
    createRuntime:()=>{created++;return {connect:async()=>{connected++;},dispose:async()=>{}};}}));
  const off=d.register("cloud",f.source);assert.equal(registry.has("one"),true);assert.equal(registry.peekRuntime("one"),null);
  assert.equal(connected,0);assert.equal(created,0);await registry.ensureConnected("one");const runtime=registry.peekRuntime("one");f.set([entry()]);assert.equal(registry.peekRuntime("one"),runtime);assert.equal(connected,1);
  off();stop();await registry.dispose();store.close();d.close();assert.equal(created,1);
});
test("Cordis owns directory lifetime", async () => {
  const ctx=new Context();const fiber=ctx.plugin(EnvironmentDirectoryService);await fiber;
  const d=ctx.environmentDirectory.directory;d.register("test",sourceFixture().source);assert.equal(d.getSnapshot().entries.length,1);
  await fiber.dispose();assert.equal(d.getSnapshot().entries.length,0);
});
test("identity is account scoped and separator safe",()=>{
  assert.notEqual(environmentIdentity("x","a:b","c"),environmentIdentity("x","a","b:c"));
  assert.notEqual(environmentIdentity("lv","cn","a","id"),environmentIdentity("lv","intl","a","id"));
});

function accountFixture() {
  let snapshot: LightVelaAccountSnapshot = {session:{status:"authenticated",epoch:0},region:"intl",authGeneration:0,credentialScope:"test",revision:0,phase:"authenticated",bots:[],activeBotId:null,error:null,
    details:{phase:"ready",profile:{id:"a",name:"Test",avatarUrl:null,pendingName:null,nameAuditStatus:null},subscription:null,pass:null,error:null}};
  const listeners=new Set<()=>void>();
  let loader:(path:string)=>Promise<unknown>=async()=>({items:[{instance_id:"vm",name:"Existing",status:"Running"},{instance_id:"stopped",name:"Stopped",status:"Stopped"}]});
  const account={getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    hasStoredSession:()=>snapshot.phase!=="anonymous",refreshAccountDetails:async()=>snapshot.details,
    request:async<T>(path:string)=>await loader(path) as T};
  return {account,setLoader:(next:typeof loader)=>{loader=next;},change:(id:string|null)=>{
    snapshot={...snapshot,session:{status:id?"authenticated":"anonymous",epoch:snapshot.authGeneration+1},authGeneration:snapshot.authGeneration+1,phase:id?"authenticated":"anonymous",details:{...snapshot.details,profile:id?{...snapshot.details.profile!,id}:null}};
    listeners.forEach(fn=>fn());
  }};
}
test("LightVela discovers existing and non-running instances without provisioning",async()=>{
  const f=accountFixture();const source=new LightVelaEnvironmentSource(f.account);await source.refresh();
  assert.equal(source.getSnapshot().phase,"ready");assert.equal(source.getSnapshot().entries.length,2);
  assert.equal(source.getSnapshot().entries[0]?.profile.autoConnect,false);
  assert.equal(source.getSnapshot().entries[1]?.connectable,false);
  const before=source.getSnapshot().entries[0]!.id;
  f.change("b");await source.refresh();assert.notEqual(source.getSnapshot().entries[0]?.id,before);
  assert.equal(source.matchProfile({...profile("old","lightvela.hermes"),providerConfig:{region:"intl",accountId:"a",instanceId:"vm"}}),null);
  f.change(null);assert.equal(source.getSnapshot().entries.length,0);source.dispose();
});
test("refresh failures retain last-known inventory; logout fences late replies",async()=>{
  const f=accountFixture(),s=new LightVelaEnvironmentSource(f.account);await s.refresh();
  f.setLoader(async()=>{throw Error("network");});await s.refresh();assert.equal(s.getSnapshot().phase,"error");assert.equal(s.getSnapshot().entries.length,2);
  let release!:(value:unknown)=>void;f.setLoader(()=>new Promise(resolve=>{release=resolve;}));const pending=s.refresh();
  await new Promise(resolve=>setTimeout(resolve,0));f.change(null);release({items:[{instance_id:"late",status:"Running"}]});await pending;
  assert.equal(s.getSnapshot().phase,"signed-out");assert.equal(s.getSnapshot().entries.length,0);s.dispose();
});
test("LightVela fetches all pages and deduplicates instance identity",async()=>{
  const f=accountFixture();let calls=0;f.setLoader(async()=>({items:++calls===1?Array.from({length:100},(_,i)=>({instance_id:`vm-${i}`,status:"Running"})):[{instance_id:"vm-0",status:"Stopped"},{instance_id:"last",status:"Creating"}]}));
  const s=new LightVelaEnvironmentSource(f.account);await s.refresh();assert.equal(calls,2);assert.equal(s.getSnapshot().entries.length,101);assert.equal(s.getSnapshot().entries[0]?.connectable,false);s.dispose();
});
