import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { AppServerInteractionBroker } from "@opencraft/composer-appserver";
import { ThreadViewStoreService } from "../../packages/appserver-session/src/view-store";
import { SHARED_INTERACTIONS_CHANGED, SHARED_INTERACTIONS_EXTENSION } from "@opencraft/appserver-protocol";

function fixture(viewStore?: ThreadViewStoreService) {
  let notify!: (event: any) => void, status!: (event: any) => void;
  const stores = new Map<string, Map<string, any>>(), calls: any[] = [];
  const storedFor = (threadId: string) => {
    const stored = stores.get(threadId) ?? new Map<string, any>();
    stores.set(threadId, stored);
    return stored;
  };
  const client: any = {
    handleServerRequest: () => () => {}, interceptServerRequest: () => () => {},
    subscribeStatus: (listener: any) => { status = listener; return () => {}; },
    subscribeNotification: (listener: any) => { notify = listener; return () => {}; },
    initializeResult: { capabilities: { extensions: { [SHARED_INTERACTIONS_EXTENSION]: { version: 1 } } } },
    request: (method: string, params: any) => new Promise(resolve => { calls.push({ method, params, resolve }); }),
  };
  const broker = new AppServerInteractionBroker({ hostId: "host", client, sharedClient: client, store: viewStore ?? {
    upsertPendingInteraction: i => storedFor(i.threadId).set(i.requestId, i),
    removePendingInteraction: (thread, id) => storedFor(thread).delete(id),
    applyPendingInteractionPatch: (thread, { remove, upsert }) => {
      const store = storedFor(thread);
      for (const id of remove) store.delete(id);
      for (const interaction of upsert) store.set(interaction.requestId, interaction);
    },
  } });
  const snapshot = (epoch: string, revision: number, requests: any[] = [{ id: "approval", method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: "turn", itemId: "item" }, state: "pending", receivedAtMs: 1 }]) => ({ threadId: "thread", epoch, revision, canRespond: true, requests });
  return { broker, client, stored: storedFor("thread"), storedFor, calls, snapshot,
    emit: (value: any) => notify({ method: SHARED_INTERACTIONS_CHANGED, params: value }),
    disconnect: () => status({ state: "closed" }), finish: (value: any, index = calls.length - 1) => calls[index].resolve(value) };
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

test("mixed Hosts use each conversation engine's complete approval capability set", async () => {
  const f = fixture();
  try {
    // The default engine supports shared approvals; an alternate engine does not.
    // A third engine explicitly supports them and must still recover approvals.
    f.client.initializeResult.capabilities.extensions["opencraft/execution-engines"] = { version: 1,
      providers: [{ id: "no-approvals", threadPrefix: "plain_", extensions: {} },
        { id: "approvals", threadPrefix: "shared_", extensions: { [SHARED_INTERACTIONS_EXTENSION]: { version: 1 } } }] };
    await f.broker.sync("plain_original");
    assert.equal(f.calls.length, 0);
    const alternate = f.broker.sync("shared_original");
    f.finish({ ...f.snapshot("source", 1), threadId: "shared_original", requests: [] }); await alternate;
    assert.equal(f.calls.length, 1);
    const read = f.broker.sync("thread");
    f.finish(f.snapshot("source", 1)); await read;
    assert.equal(f.stored.size, 1);
  } finally { f.broker.dispose(); }
});

test("only a complete batch sends explicit Skip over the shared response wire", async () => {
  const f = fixture();
  const request = (complete: boolean) => ({
    id: complete ? "complete" : "legacy", method: "item/tool/requestUserInput",
    params: { threadId: "thread", turnId: "turn", itemId: "item",
      ...(complete ? { answerMode: "complete" } : {}),
      questions: ["a", "b"].map(id => ({ id, header: id, question: id, isOther: true, isSecret: false, options: null })),
    }, state: "pending", receivedAtMs: 1,
  });
  const key = { hostId: "host", threadId: "thread" };
  try {
    f.emit(f.snapshot("fixture", 1, [request(true)]));
    const requestId = [...f.stored.keys()][0]!;
    await assert.rejects(f.broker.respond(key, { type: "question", requestId, answers: { a: ["partial"] } }), /Answer each/);
    assert.equal(f.calls.length, 0);
    const skipped = f.broker.respond(key, { type: "question", requestId, answers: {}, skip: true });
    assert.deepEqual(f.calls[0].params.result, { answers: {}, skip: true });
    f.finish({ disposition: "submitted", snapshot: f.snapshot("fixture", 2, [request(false)]) });
    await skipped;
    const legacy = f.broker.respond(key, { type: "question", requestId: [...f.stored.keys()][0]!, answers: {}, skip: true });
    assert.deepEqual(f.calls[1].params.result, { answers: {} });
    f.finish({ disposition: "submitted", snapshot: f.snapshot("fixture", 3, []) });
    await legacy;
  } finally { f.broker.dispose(); }
});

function forThread(snapshot: ReturnType<ReturnType<typeof fixture>["snapshot"]>, threadId: string) {
  return { ...snapshot, threadId, requests: snapshot.requests.map(source => ({
    ...source, params: { ...source.params, threadId },
  })) };
}

test("two Threads with the same provider request ID retain independent approvals", async () => {
  const f = fixture();
  try {
    const here = f.snapshot("producer", 1);
    const elsewhere = forThread(f.snapshot("producer", 1), "other-thread");
    f.emit(here);
    f.emit(elsewhere);
    const requestId = [...f.stored.keys()][0];
    assert.equal([...f.storedFor("other-thread").keys()][0], requestId);
    const first = f.broker.respond({ hostId: "host", threadId: "thread" }, {
      type: "command-approval", requestId, decision: "accept",
    });
    if (f.calls.length > 0) f.finish({ disposition: "submitted", snapshot: f.snapshot("producer", 2, []) });
    await first;
    assert.equal(f.calls[0].params.threadId, "thread");
    assert.equal(f.stored.size, 0);
    assert.equal(f.storedFor("other-thread").size, 1);

    const second = f.broker.respond({ hostId: "host", threadId: "other-thread" }, {
      type: "command-approval", requestId, decision: "decline",
    });
    f.finish({ disposition: "submitted", snapshot: forThread(f.snapshot("producer", 2, []), "other-thread") });
    await second;
    assert.equal(f.calls[1].params.threadId, "other-thread");
    assert.equal(f.storedFor("other-thread").size, 0);
  } finally { f.broker.dispose(); }
});

test("a delayed first read cannot replace a newer producer already seen in a live notification", async () => {
  const f = fixture();
  try {
    const read = f.broker.sync("thread");
    f.emit(f.snapshot("live-new", 0));
    f.finish(f.snapshot("old-unseen", 50, []));
    await read;
    assert.equal(f.stored.size, 1);
    const pending = [...f.stored.values()][0];
    assert.equal(pending.canRespond, true);

    const later = f.broker.sync("thread");
    f.emit(f.snapshot("live-new", 1));
    f.finish(f.snapshot("live-new", 2, []));
    await later;
    assert.equal(f.stored.size, 0, "a newer revision from the current producer still applies");
  } finally { f.broker.dispose(); }
});

test("responses from a superseded read cannot retire the source recovered by a later read", async () => {
  const f = fixture();
  try {
    const first = f.broker.sync("thread");
    const second = f.broker.sync("thread");
    f.finish(f.snapshot("newer-source", 0), 1);
    await second;
    f.finish(f.snapshot("older-source", 1, []), 0);
    await first;
    assert.equal(f.stored.size, 1);
  } finally { f.broker.dispose(); }
});

test("read and response receipts are scoped to the requested Thread", async () => {
  const f = fixture();
  try {
    f.emit(f.snapshot("source", 1));
    f.emit(forThread(f.snapshot("source", 1), "other-thread"));
    const read = f.broker.sync("thread");
    f.finish(forThread(f.snapshot("source", 2, []), "other-thread"));
    await read;
    assert.equal(f.storedFor("other-thread").size, 1);

    const response = f.broker.respond({ hostId: "host", threadId: "thread" }, {
      type: "command-approval", requestId: [...f.stored.keys()][0], decision: "accept",
    });
    f.finish({ disposition: "submitted", snapshot: forThread(f.snapshot("source", 3, []), "other-thread") });
    await response;
    assert.equal(f.storedFor("other-thread").size, 1);
    assert.equal(f.stored.size, 1);
  } finally { f.broker.dispose(); }
});

test("a later live permission update survives an earlier read at the same or a higher revision", async () => {
  for (const revision of [1, 2]) {
    const f = fixture();
    try {
      f.emit(f.snapshot("source", 1));
      const read = f.broker.sync("thread");
      f.emit({ ...f.snapshot("source", 1), canRespond: false });
      const reply = f.snapshot("source", revision);
      if (revision > 1) reply.requests[0].state = "responding";
      f.finish(reply);
      await read;
      const approval = [...f.stored.values()][0];
      assert.equal(approval.canRespond, false);
      assert.equal(approval.responseState, revision > 1 ? "responding" : "pending");
    } finally { f.broker.dispose(); }
  }
});

test("a delayed response receipt cannot replace another producer already visible on the Thread", async () => {
  const f = fixture();
  try {
    f.emit(f.snapshot("first-source", 1));
    const response = f.broker.respond({ hostId: "host", threadId: "thread" }, {
      type: "command-approval", requestId: [...f.stored.keys()][0], decision: "accept",
    });
    f.emit(f.snapshot("latest-source", 0));
    f.finish({ disposition: "submitted", snapshot: f.snapshot("unseen-previous-source", 99, []) });
    await response;
    assert.equal(f.stored.size, 1);
    assert.equal([...f.stored.values()][0].canRespond, true);
  } finally { f.broker.dispose(); }
});

test("a shared snapshot publishes the complete Thread View once, including on first creation", () => {
  const views = new ThreadViewStoreService(new Context(), { hostId: "host" });
  const f = fixture(views);
  const observed: string[][] = [];
  const stop = views.subscribeThread("thread", () => {
    observed.push(views.get("thread")?.pendingInteractions.map(item => item.requestId) ?? []);
  });
  try {
    const snapshot = f.snapshot("source", 1);
    snapshot.requests.push({ ...snapshot.requests[0], id: "peer-approval" });
    f.emit(snapshot);
    assert.deepEqual(observed, [["host-interaction:approval", "host-interaction:peer-approval"]]);

    const first = views.get("thread")!.pendingInteractions[0];
    views.upsertPendingInteraction({ ...first, requestId: "appserver-rpc:legacy" });
    observed.length = 0;
    f.emit(f.snapshot("source", 2, []));
    assert.deepEqual(observed, [["appserver-rpc:legacy"]]);
  } finally { stop(); f.broker.dispose(); }
});

test("a newer snapshot applied from a View observer cannot be overwritten by the first snapshot", () => {
  const views = new ThreadViewStoreService(new Context(), { hostId: "host" });
  const f = fixture(views);
  let replaced = false;
  const stop = views.subscribeThread("thread", () => {
    if (replaced || !views.get("thread")?.pendingInteractions.some(item => item.requestId === "host-interaction:approval")) return;
    replaced = true;
    const latest = f.snapshot("source", 2);
    latest.requests[0].id = "current";
    f.emit(latest);
  });
  try {
    const old = f.snapshot("source", 1);
    old.requests.push({ ...old.requests[0], id: "old-peer" });
    f.emit(old);
    assert.ok(replaced);
    assert.deepEqual(views.get("thread")?.pendingInteractions.map(item => item.requestId), ["host-interaction:current"]);
  } finally { stop(); f.broker.dispose(); }
});

for (const operation of ["disconnect", "dispose"] as const) {
  test(`shared answers in other Threads are revoked before the first View observes ${operation}`, async () => {
    const views = new ThreadViewStoreService(new Context(), { hostId: "host" });
    const f = fixture(views);
    f.emit(f.snapshot("source", 1));
    f.emit(forThread(f.snapshot("source", 1), "other-thread"));
    let attempted: Promise<unknown> | undefined;
    const stop = views.subscribeThread("thread", () => {
      if (attempted) return;
      attempted = f.broker.respond({ hostId: "host", threadId: "other-thread" }, {
        type: "command-approval", requestId: "host-interaction:approval", decision: "accept",
      }).catch(error => error);
    });
    try {
      if (operation === "disconnect") f.disconnect();
      else f.broker.dispose();
      assert.ok(attempted);
      assert.deepEqual(f.calls, [], "no response command reached the AppServer client");
      assert.ok(await attempted instanceof Error);
      if (operation === "disconnect") {
        assert.equal(views.get("other-thread")?.pendingInteractions[0]?.canRespond, false);
      } else assert.equal(views.get("other-thread")?.pendingInteractions.length, 0);
    } finally {
      stop();
      if (f.calls.length > 0) f.finish({ disposition: "submitted", snapshot: forThread(f.snapshot("source", 2, []), "other-thread") });
      f.broker.dispose();
    }
  });
}

test("disconnect publication cannot insert a stale card over another Thread's reconnected snapshot", () => {
  const views = new ThreadViewStoreService(new Context(), { hostId: "host" });
  const f = fixture(views);
  f.emit(f.snapshot("old", 1));
  f.emit(forThread(f.snapshot("old", 1), "other-thread"));
  let reconnected = false;
  const stop = views.subscribeThread("thread", () => {
    if (reconnected || views.get("thread")?.pendingInteractions[0]?.canRespond !== false) return;
    reconnected = true;
    const next = forThread(f.snapshot("new", 0), "other-thread");
    next.requests[0].id = "new-approval";
    f.emit(next);
  });
  try {
    f.disconnect();
    assert.ok(reconnected);
    assert.deepEqual(views.get("other-thread")?.pendingInteractions.map(item => [item.requestId, item.canRespond]), [
      ["host-interaction:new-approval", true],
    ]);
  } finally { stop(); f.broker.dispose(); }
});
