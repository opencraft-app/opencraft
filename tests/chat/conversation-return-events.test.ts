import assert from "node:assert/strict";
import test from "node:test";
import { createConversationReturnProbe } from "@opencraft/workbench-runtime";
import { startConversationReturnRecovery } from "../../apps/workbench-web/src/runtime/conversation-return-events";
function fixture() {
  const previous = ["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" }); const window = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: window }); Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  let now = 1000, reads = 0, ready = true;
  const stop = startConversationReturnRecovery({ probe: createConversationReturnProbe(), now: () => now, ready: () => ready, lease: () => ({ setRecoveryVisibility() {}, async retryRestore() { reads++; } }) });
  return { document, window, get reads() { return reads; }, set now(value: number) { now = value; }, set ready(value: boolean) { ready = value; }, visibility(value: string) { document.visibilityState = value; document.dispatchEvent(new Event("visibilitychange")); }, close() { stop(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } } };
}
test("hidden online cannot consume the next foreground history read", () => {
  const f = fixture(); try { f.visibility("hidden"); f.window.dispatchEvent(new Event("offline")); f.now = 20000; f.window.dispatchEvent(new Event("online")); assert.equal(f.reads, 0); f.now = 21000; f.visibility("visible"); assert.equal(f.reads, 1); } finally { f.close(); }
});
test("foreground validates history despite a missing online event", () => {
  const f = fixture(); try { f.window.dispatchEvent(new Event("offline")); f.visibility("hidden"); f.now = 30000; f.visibility("visible"); assert.equal(f.reads, 1); } finally { f.close(); }
});
test("pageshow validates the current conversation and coalesces duplicate hints", () => {
  const f = fixture(); try { f.now = 30000; f.window.dispatchEvent(new Event("pageshow")); f.window.dispatchEvent(new Event("pageshow")); assert.equal(f.reads, 1); } finally { f.close(); }
});
test("unready hints cannot consume validation admission", () => {
  const f = fixture(); try { f.ready = false; f.window.dispatchEvent(new Event("pageshow")); assert.equal(f.reads, 0); f.ready = true; f.window.dispatchEvent(new Event("pageshow")); assert.equal(f.reads, 1); } finally { f.close(); }
});
