import assert from "node:assert/strict";
import test from "node:test";
import { prepareOfflineShell, waitForOfflinePreparation } from "../../apps/workbench-web/src/runtime/offline-shell";

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

for (const phase of ["load", "grace", "idle"]) test("retiring during " + phase + " removes optional startup work", async () => {
  const e = environment();
  try {
    e.doc.readyState = phase === "load" ? "loading" : "complete";
    const owner = new AbortController(); const pending = waitForOfflinePreparation(owner.signal);
    await turns(); if (phase === "idle") await e.fireGrace();
    owner.abort(new Error("retired")); await assert.rejects(pending, /retired/);
    e.view.dispatchEvent(new Event("load")); e.doc.dispatchEvent(new Event("visibilitychange"));
    await turns(); assert.equal(e.idle.size, 0); assert.equal(e.timers.size, 0);
  } finally { e.restore(); }
});

for (const constraint of ["none", "save-data", "2g", "slow-2g", "offline"]) test("registration respects connection preference: " + constraint, async () => {
  const e = environment();
  try {
    e.navigator.connection.saveData = constraint === "save-data";
    e.navigator.connection.effectiveType = constraint.includes("2g") ? constraint : "4g";
    e.navigator.onLine = constraint !== "offline";
    const pending = prepareOfflineShell(new AbortController().signal);
    assert.equal(e.calls.lookup, 0); await e.fireGrace(); await e.fireIdle(); await pending;
    assert.equal(e.calls.register, constraint === "none" ? 1 : 0);
    assert.equal(e.calls.messages.length, 1, "existing worker can still receive a public recipe");
    assert.equal(e.calls.messages[0].browserBackend, "remote");
    assert.equal(e.doc.documentElement.dataset.offlineReady, "build");
    assert.equal(e.timers.size, 0); assert.ok(e.channels.every(c => c.port1.closed && c.port2.closed));
  } finally { e.restore(); }
});

for (const phase of ["lookup", "register", "configuration"]) test("late " + phase + " completion cannot configure a retired page", async () => {
  const e = environment(); let finish!: (value: any) => void;
  try {
    const held = new Promise(resolve => { finish = resolve; });
    if (phase === "lookup") e.serviceWorker.getRegistration = () => held;
    if (phase === "register") e.serviceWorker.register = () => held;
    if (phase === "configuration") e.worker.postMessage = message => { e.calls.messages.push(message); };
    const owner = new AbortController(); const pending = prepareOfflineShell(owner.signal);
    await e.fireGrace(); await e.fireIdle(); owner.abort(new Error("retired"));
    await assert.rejects(pending, /retired/); finish(e.registration); await turns();
    assert.equal(e.doc.documentElement.dataset.offlineReady, undefined);
    if (phase !== "configuration") assert.equal(e.calls.messages.length, 0);
    assert.equal(e.timers.size, 0); assert.ok(e.channels.every(c => c.port1.closed && c.port2.closed));
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
