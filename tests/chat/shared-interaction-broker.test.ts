import assert from "node:assert/strict";
import test from "node:test";
import { AppServerInteractionBroker } from "@opencraft/composer-appserver";
import { SHARED_INTERACTIONS_CHANGED, SHARED_INTERACTIONS_EXTENSION } from "@opencraft/appserver-protocol";

function fixture() {
  let notify!: (event: any) => void, status!: (event: any) => void, finish!: (value: any) => void;
  const stored = new Map<string, any>(), calls: any[] = [];
  const client: any = {
    handleServerRequest: () => () => {}, interceptServerRequest: () => () => {},
    subscribeStatus: (listener: any) => { status = listener; return () => {}; },
    subscribeNotification: (listener: any) => { notify = listener; return () => {}; },
    initializeResult: { capabilities: { extensions: { [SHARED_INTERACTIONS_EXTENSION]: { version: 1 } } } },
    request: (method: string, params: any) => { calls.push({ method, params }); return new Promise(resolve => { finish = resolve; }); },
  };
  const broker = new AppServerInteractionBroker({ hostId: "host", client, sharedClient: client, store: {
    upsertPendingInteraction: i => stored.set(i.requestId, i), removePendingInteraction: (_thread, id) => stored.delete(id),
  } });
  const snapshot = (epoch: string, revision: number, requests: any[] = [{ id: "approval", method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: "turn", itemId: "item" }, state: "pending", receivedAtMs: 1 }]) => ({ threadId: "thread", epoch, revision, canRespond: true, requests });
  return { broker, stored, calls, snapshot, emit: (value: any) => notify({ method: SHARED_INTERACTIONS_CHANGED, params: value }),
    disconnect: () => status({ state: "closed" }), finish: (value: any) => finish(value) };
}

test("shared broadcasts preserve authority through late reads, settlement and source replacement", async () => {
  const f = fixture();
  try {
    f.emit(f.snapshot("old", 1)); assert.equal(f.stored.size, 1);
    const read = f.broker.sync("thread");
    f.emit(f.snapshot("old", 3, [])); f.finish(f.snapshot("old", 2)); await read;
    assert.equal(f.stored.size, 0, "late baseline cannot revive a resolved request");
    f.emit(f.snapshot("new", 0)); assert.equal(f.stored.size, 1);
    f.emit(f.snapshot("old", 4, [])); assert.equal(f.stored.size, 1, "retired producer cannot erase a successor");
    f.emit({ ...f.snapshot("new", 1), requests: [{}] }); assert.equal(f.stored.size, 1, "malformed update cannot erase a valid source");
  } finally { f.broker.dispose(); }
});

test("the broker sends a response command, retains the card until native settlement and fences disconnected reads", async () => {
  const f = fixture();
  try {
    f.emit(f.snapshot("source", 1));
    const key = { hostId: "host", threadId: "thread" }, requestId = [...f.stored.keys()][0]!;
    const response = f.broker.respond(key, { type: "command-approval", requestId, decision: "accept" });
    assert.equal(f.calls[0].params.interactionId, "approval"); assert.equal(f.calls[0].params.result.decision, "accept");
    assert.equal(f.stored.size, 1);
    const responding = f.snapshot("source", 2); responding.requests[0].state = "responding";
    f.emit(responding); f.finish({ disposition: "submitted", snapshot: responding }); await response;
    assert.equal(f.stored.get(requestId).responseState, "responding");
    const read = f.broker.sync("thread"); f.disconnect(); f.finish(f.snapshot("source", 3)); await read;
    assert.equal(f.stored.get(requestId).canRespond, false, "late response cannot restore revoked access");
    f.emit(f.snapshot("source", 4, [])); assert.equal(f.stored.size, 0);
  } finally { f.broker.dispose(); }
});

test("source availability is independent of subscription permission", () => {
  const f = fixture();
  try { const snapshot = f.snapshot("source", 1); snapshot.requests[0].canRespond = false; f.emit(snapshot);
    assert.equal([...f.stored.values()][0].canRespond, false);
  } finally { f.broker.dispose(); }
});
