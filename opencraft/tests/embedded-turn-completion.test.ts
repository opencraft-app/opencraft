import assert from "node:assert/strict";
import test from "node:test";

import { embeddedTurnCompletionDetail, observeEmbeddedTurnCompletions } from "../apps/workbench-web/src/embedded-chat/embedded-turn-completion";

test("embedded completion marks finished or failed work, but not loading or interruption", () => {
  const notification = (status: string) => ({
    method: "turn/completed",
    params: { threadId: "chat-1", turn: { id: "turn-1", status } },
  });
  assert.deepEqual(embeddedTurnCompletionDetail(notification("completed")), { chatId: "chat-1", turnId: "turn-1" });
  assert.deepEqual(embeddedTurnCompletionDetail(notification("failed")), { chatId: "chat-1", turnId: "turn-1" });
  assert.equal(embeddedTurnCompletionDetail(notification("interrupted")), null);
  assert.equal(embeddedTurnCompletionDetail(notification("inProgress")), null);
  assert.equal(embeddedTurnCompletionDetail({ method: "session.info", params: { running: false } }), null);
});

test("embedded completion listener follows client replacement and stops after disposal", () => {
  const firstListeners = new Set<(notification: { method: string; params: unknown }) => void>();
  const secondListeners = new Set<(notification: { method: string; params: unknown }) => void>();
  const client = (listeners: typeof firstListeners) => ({
    subscribeNotification(listener: (notification: { method: string; params: unknown }) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
  let currentClient = client(firstListeners);
  const registryListeners = new Set<(event: { hostId: string }) => void>();
  const observed: string[] = [];
  const stop = observeEmbeddedTurnCompletions({
    get: () => currentClient,
    subscribeEvent(listener) {
      registryListeners.add(listener);
      return () => { registryListeners.delete(listener); };
    },
  }, "host-1", (detail) => observed.push(detail.turnId));
  const finished = { method: "turn/completed", params: { threadId: "chat-1", turn: { id: "turn-1", status: "completed" } } };
  for (const listener of firstListeners) listener(finished);
  currentClient = client(secondListeners);
  for (const listener of registryListeners) listener({ hostId: "host-1" });
  assert.equal(firstListeners.size, 0);
  for (const listener of secondListeners) listener({ ...finished, params: { ...finished.params, turn: { id: "turn-2", status: "completed" } } });
  stop();
  assert.equal(secondListeners.size, 0);
  assert.deepEqual(observed, ["turn-1", "turn-2"]);
});
