import assert from "node:assert/strict";

import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { EnvironmentDirectory, EnvironmentDirectoryService, EnvironmentProfileStore, HostRuntimeRegistry, connectEnvironmentRuntimeRegistry, environmentIdentity,
  normalizeMachineResourcePhase,
  type EnvironmentEntry, type EnvironmentSource, type EnvironmentSourceSnapshot, type HostConnectionProfile, type HostConnectionProfileStore } from "../../packages/workbench-runtime/src/index";


const profile = (hostId: string, providerId = "manual"): HostConnectionProfile => ({hostId, providerId, displayName: hostId, providerConfig: {}, providerConfigVersion: 1,
  hostKind: hostId === "local" ? "local" : "remote-control", enabled: true, autoConnect: false, includeInSidebar: true, credentialRef: null,
  transportEndpoint: null, executionLocation: null, workspaceBrowseRoots: [], revision: 1});

const entry = (id = "one", state = "running"): EnvironmentEntry => ({id, sourceId: "cloud", name: id, location: "Cloud",
  resource: {providerId:"cloud",...normalizeMachineResourcePhase(state),message:null,capabilities:{suspend:false,resume:false,remove:false}},
  connectable: state === "running", profile: {...profile(id,"cloud"), enabled: state === "running"}});


test("machine resource phases normalize without losing an unknown provider state", () => {
  assert.deepEqual(normalizeMachineResourcePhase("Running"), { phase: "active", rawPhase: "running" });
  assert.deepEqual(normalizeMachineResourcePhase("pending"), { phase: "creating", rawPhase: "pending" });
  assert.deepEqual(normalizeMachineResourcePhase("Stopping"), { phase: "suspending", rawPhase: "stopping" });
  assert.deepEqual(normalizeMachineResourcePhase("Stopped"), { phase: "suspended", rawPhase: "stopped" });
  assert.deepEqual(normalizeMachineResourcePhase("Restarting"), { phase: "resuming", rawPhase: "restarting" });
  assert.deepEqual(normalizeMachineResourcePhase("Deleting"), { phase: "removing", rawPhase: "deleting" });
  assert.deepEqual(normalizeMachineResourcePhase("Deleted"), { phase: "destroyed", rawPhase: "deleted" });
  assert.deepEqual(normalizeMachineResourcePhase("ProviderSpecific"), { phase: "unknown", rawPhase: "providerspecific" });
});

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
  assert.equal((d.getSnapshot().entries.find(value => value.profile.hostId === "local") as any).resource, null);
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

test("resource actions route only through an explicitly capable source", async () => {
  const directory = new EnvironmentDirectory();
  directory.setConfiguredProfiles([profile("local")]);
  const localId = directory.getSnapshot().entries[0]!.id;
  await assert.rejects(
    directory.performResourceAction({ environmentId: localId, action: "remove", operationId: "local-remove" }),
    /not provider-managed/u,
  );

  const requests: unknown[] = [];
  const fixture = sourceFixture();
  const managed = {
    ...entry("managed"),
    resource: {
      providerId: "cloud",
      phase: "active",
      rawPhase: "running",
      message: null,
      capabilities: { suspend: true, resume: false, remove: false },
    },
  } satisfies EnvironmentEntry;
  fixture.set([managed]);
  const capableSource: EnvironmentSource = {
    ...fixture.source,
    performResourceAction: async (request: unknown) => {
      requests.push(request);
      const value = request as {environmentId:string;action:"suspend"|"resume"|"remove";operationId:string};
      return value.operationId === "wrong-receipt"
        ? { accepted: true, environmentId: value.environmentId, action: "remove", operationId: value.operationId }
        : { accepted: true, environmentId: value.environmentId, action: value.action, operationId: value.operationId };
    },
  };
  directory.register("cloud-owner", capableSource);
  const receipt = await directory.performResourceAction({
    environmentId: managed.id,
    action: "suspend",
    operationId: "suspend-managed",
  });
  assert.deepEqual(receipt, { accepted: true, environmentId: managed.id, action: "suspend", operationId: "suspend-managed" });
  assert.deepEqual(requests, [{ environmentId: managed.id, action: "suspend", operationId: "suspend-managed" }]);
  await assert.rejects(
    directory.performResourceAction({ environmentId: managed.id, action: "remove", operationId: "remove-managed" }),
    /does not support remove/u,
  );
  await assert.rejects(
    directory.performResourceAction({ environmentId: managed.id, action: "suspend", operationId: "wrong-receipt" }),
    /invalid receipt/u,
  );
  directory.close();
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
