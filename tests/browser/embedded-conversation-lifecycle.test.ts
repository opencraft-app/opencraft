import assert from "node:assert/strict";
import test from "node:test";
import {
  bindConversationReturnLifecycle,
  type ConversationLifecycleSnapshot,
} from "../../apps/workbench-web/src/runtime/conversation-return-lifecycle";

test("a hidden panel defers network recovery until activation and releases its lease on disposal", () => {
  let snapshot = { visible: true, online: true };
  const listeners = new Set<(value: ConversationLifecycleSnapshot) => void>();
  let restores = 0;
  const visibility: boolean[] = [];
  const stop = bindConversationReturnLifecycle({
    source: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    getRuntime: () => ({ getSnapshot: () => ({ phase: "ready" }) }),
    getLease: () => ({
      setRecoveryVisibility: (value) => visibility.push(value),
      retryRestore: async () => {
        restores++;
      },
    }),
    now: () => 40_000,
  });
  function update(visible: boolean, online: boolean) {
    snapshot = { visible, online };
    for (const listener of listeners) listener(snapshot);
  }
  update(false, false);
  update(false, true);
  assert.equal(restores, 0);
  assert.equal(visibility.at(-1), false);
  update(true, true);
  update(true, true);
  assert.equal(restores, 1);
  assert.equal(visibility.at(-1), true);
  stop();
  assert.equal(listeners.size, 0);
  assert.equal(visibility.at(-1), false);
});
