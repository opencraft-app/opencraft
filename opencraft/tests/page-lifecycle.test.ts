import test from "node:test";
import assert from "node:assert/strict";
import { bindPageLifecycle } from "../apps/workbench-web/src/runtime/page-lifecycle.js";

test("pagehide unmounts consumers before owner cleanup, but preserves BFCache", () => {
  const target = new EventTarget();
  const calls: string[] = [];
  const stop = bindPageLifecycle(target as unknown as Window, () => {
    calls.push("unmount");
    calls.push("owner cleanup");
  });
  const hide = (persisted: boolean) => {
    const event = new Event("pagehide");
    Object.defineProperty(event, "persisted", { value: persisted });
    target.dispatchEvent(event);
  };
  hide(true);
  assert.deepEqual(calls, []);
  hide(false); hide(false); stop();
  assert.deepEqual(calls, ["unmount", "owner cleanup"]);
});
