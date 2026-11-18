import assert from "node:assert/strict";
import test from "node:test";
import { waitForOfflinePreparation, prepareOfflineShell } from "../../apps/workbench-web/src/runtime/offline-shell";

test("offline warming waits for load, grace and idle, and cancellation removes its work", async () => {
 const originals = Object.fromEntries(["window", "document", "setTimeout", "clearTimeout"].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
 const view = new EventTarget(), doc = new EventTarget();
 Object.assign(doc, {readyState:"loading",visibilityState:"visible"});
 const pending = new Map<number,{callback:()=>void,ms:number}>(); let id=0;
 Object.assign(view,{requestIdleCallback:(callback:()=>void)=>{pending.set(++id,{callback,ms:1000});return id;},cancelIdleCallback:(key:number)=>pending.delete(key)});
 try {
  Object.defineProperties(globalThis, {window:{value:view,configurable:true},document:{value:doc,configurable:true},setTimeout:{value:(callback:()=>void,ms:number)=>{pending.set(++id,{callback,ms});return id;},configurable:true},clearTimeout:{value:(key:number)=>pending.delete(key),configurable:true}});
  const tick=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
  const owner = new AbortController(); let ready=false;
  const operation=waitForOfflinePreparation(owner.signal).then(()=>{ready=true;});
  await tick(); assert.equal(pending.size,0); assert.equal(ready,false);
  view.dispatchEvent(new Event("load")); await tick();
  assert.equal([...pending.values()][0].ms,10000);
  const grace=[...pending.entries()][0];pending.delete(grace[0]);grace[1].callback();await tick();
  assert.equal(ready,false);assert.equal([...pending.values()][0].ms,1000);
  const idle=[...pending.entries()][0];pending.delete(idle[0]);idle[1].callback();await operation;assert.equal(ready,true);
  Object.assign(doc,{readyState:"complete"});const retiring=new AbortController();const stopped=waitForOfflinePreparation(retiring.signal);retiring.abort();await assert.rejects(stopped);assert.equal(pending.size,0);
  Object.assign(doc,{readyState:"loading"});const early=new AbortController();const loading=waitForOfflinePreparation(early.signal);early.abort();await assert.rejects(loading);view.dispatchEvent(new Event("load"));await tick();assert.equal(pending.size,0);
 } finally {for(const [k,descriptor] of Object.entries(originals)){if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete (globalThis as any)[k];}}
});



async function turns() { for (let i = 0; i < 30; i++) await Promise.resolve(); }


function environment() {
  const names = ["window", "document", "navigator", "location", "isSecureContext", "MessageChannel", "setTimeout", "clearTimeout"] as const;
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const view = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    readyState: "complete", visibilityState: "visible",
    documentElement: { dataset: {} as Record<string, string> },
    querySelector: (selector: string) => ({ content: selector.includes("browser-backend") ? "remote" : "build" }),
    getElementById: () => null,
  });
  let nextId = 0;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  const idle = new Map<number, () => void>();
  Object.assign(view, {
    requestIdleCallback: (callback: () => void) => { idle.set(++nextId, callback); return nextId; },
    cancelIdleCallback: (id: number) => idle.delete(id),
  });
  const worker = Object.assign(new EventTarget(), {
    state: "activated",
    postMessage: (_message: unknown, _ports: unknown[]) => {},
  });
  const registration = { active: worker };
  const calls = { lookup: 0, register: 0, messages: [] as any[] };
  const serviceWorker = {
    getRegistration: async (_scope: string): Promise<any> => { calls.lookup++; return registration; },
    register: async (_url: URL, _options: unknown): Promise<any> => { calls.register++; return registration; },
  };
  const navigator = { onLine: true, connection: { saveData: false, effectiveType: "4g" }, serviceWorker };
  const channels: { port1: { close: () => void; closed: boolean; onmessage: ((event: any) => void) | null }; port2: { close: () => void; closed: boolean } }[] = [];
  class Channel {
    port1 = { closed: false, close: () => { this.port1.closed = true; }, onmessage: null as ((event: any) => void) | null };
    port2 = { closed: false, close: () => { this.port2.closed = true; } };
    constructor() { channels.push(this); }
  }
  worker.postMessage = message => {
    calls.messages.push(message);
    queueMicrotask(() => channels.at(-1)!.port1.onmessage?.({ data: { ok: true, buildId: "build" } }));
  };
  const values: Record<string, unknown> = {
    window: view, document: doc, navigator, location: { origin: "https://example.test" },
    isSecureContext: true, MessageChannel: Channel,
    setTimeout: (callback: () => void, ms: number) => { timers.set(++nextId, { callback, ms }); return nextId; },
    clearTimeout: (id: number) => timers.delete(id),
  };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, value });
  async function fireGrace() {
    await turns();
    const grace = [...timers].find(([, timer]) => timer.ms === 10_000);
    assert.ok(grace); timers.delete(grace[0]); grace[1].callback(); await turns();
  }
  async function fireIdle() {
    assert.equal(idle.size, 1);
    for (const [id, callback] of idle) { idle.delete(id); callback(); }
    await turns();
  }
  return { doc, view, navigator, calls, serviceWorker, worker, registration, channels, timers, idle, fireGrace, fireIdle,
    restore() { for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    } },
  };
}


test("offline preparation waits for load, ten-second grace and visible idle", async () => {
  const e = environment();
  try {
    e.doc.readyState = "loading";
    const owner = new AbortController(); let ready = false;
    const pending = waitForOfflinePreparation(owner.signal).then(() => { ready = true; });
    await turns(); assert.equal(e.timers.size, 0); assert.equal(ready, false);
    e.view.dispatchEvent(new Event("load")); await e.fireGrace();
    assert.equal(ready, false); assert.equal(e.idle.size, 1);
    e.doc.visibilityState = "hidden"; e.doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(e.idle.size, 0);
    e.doc.visibilityState = "visible"; e.doc.dispatchEvent(new Event("visibilitychange"));
    await e.fireIdle(); await pending;
    assert.equal(ready, true); assert.equal(e.timers.size, 0);
  } finally { e.restore(); }
});



test("retirement while worker installs detaches its state listener and never posts configuration", async () => {
  const e = environment();
  try {
    e.worker.state = "installing";
    const owner = new AbortController(); const pending = prepareOfflineShell(owner.signal);
    await e.fireGrace(); await e.fireIdle(); owner.abort(new Error("retired"));
    await assert.rejects(pending, /retired/);
    e.worker.state = "installed"; e.worker.dispatchEvent(new Event("statechange")); await turns();
    assert.equal(e.calls.messages.length, 0); assert.equal(e.doc.documentElement.dataset.offlineReady, undefined);
    assert.equal(e.timers.size, 0);
  } finally { e.restore(); }
});


test("missing configuration acknowledgement closes both message ports at its deadline", async () => {
  const e = environment();
  try {
    e.worker.postMessage = () => {};
    const pending = prepareOfflineShell(new AbortController().signal);
    await e.fireGrace(); await e.fireIdle();
    const timeout = [...e.timers][0]; assert.ok(timeout); assert.equal(timeout[1].ms, 10000);
    e.timers.delete(timeout[0]); timeout[1].callback();
    await assert.rejects(pending, /configuration timed out/);
    assert.ok(e.channels.every(c => c.port1.closed && c.port2.closed && c.port1.onmessage === null));
    assert.equal(e.doc.documentElement.dataset.offlineReady, undefined);
  } finally { e.restore(); }
});