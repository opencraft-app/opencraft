import assert from "node:assert/strict";
import test from "node:test";
import { startConversationHistoryRefresh } from "../../apps/workbench-web/src/components/conversation-history-refresh";

test("visible conversation polling is serial, pauses in background, backs off, and retires late results", async () => {
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let id = 0;
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout(callback: () => void, delay: number) { timers.set(++id, { callback, delay }); return id; },
    clearTimeout(timer: number) { timers.delete(timer); },
  } });
  let resolve!: (changed: boolean) => void;
  let reject!: (error: Error) => void;
  let calls = 0, changes = 0;
  let signal: AbortSignal | undefined;
  const flush = () => new Promise<void>(done => setImmediate(done));
  const tick = () => {
    assert.equal(timers.size, 1);
    const [key, timer] = [...timers][0]!; timers.delete(key); timer.callback();
  };
  const stop = startConversationHistoryRefresh(input => {
    calls++; signal = input;
    return new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  }, async () => { changes++; });
  try {
    assert.equal([...timers.values()][0]?.delay, 5000);
    tick(); assert.equal(calls, 1);
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(calls, 1, "visibility cannot overlap an active request");
    resolve(true); await flush(); assert.equal(changes, 1);
    doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(timers.size, 0);
    doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(calls, 2, "returning checks immediately");
    resolve(false); await flush(); assert.equal(changes, 1, "unchanged transcript does not refresh catalog");
    for (const delay of [10000, 20000, 40000, 60000, 60000]) {
      tick(); reject(new Error("temporary network failure")); await flush();
      assert.equal([...timers.values()][0]?.delay, delay);
    }
    tick(); resolve(false); await flush();
    assert.equal([...timers.values()][0]?.delay, 5000, "success resets backoff");
    tick(); const callsAtStop = calls;
    stop(); assert.equal(signal?.aborted, true);
    resolve(true); await flush();
    assert.equal(changes, 1, "retired conversation cannot publish a late refresh");
    assert.equal(timers.size, 0);
    doc.dispatchEvent(new Event("visibilitychange")); assert.equal(calls, callsAtStop);
  } finally {
    stop();
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});
