import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { createComposerController } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const notify of [true, false]) test(`a ${notify ? "queue change" : "local submission"} supersedes an in-flight empty read without hiding the accepted follow-up`, async () => {
  const reads: ((data: unknown[]) => void)[] = [];
  let peer!: InMemoryAppServerPeer;
  let row: unknown;
  const thread = { id: "one", name: "Queue", cwd: "/workspace", status: { type: "active" }, turns: [] };
  const transport = new MemoryTransport({ connected(value) { peer = value; }, receive(frame, peer: InMemoryAppServerPeer) {
    const request = JSON.parse(frame);
    if (request.id === undefined) return;
    const send = (result: unknown) => peer.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "initialize") send({ codexHome: "/tmp", platformFamily: "unix", platformOs: "linux", userAgent: "queue-test" });
    else if (request.method === "thread/read") send({ thread });
    else if (request.method === "thread/resume") send({ thread, model: "test", modelProvider: "test", cwd: "/workspace",
      runtimeWorkspaceRoots: ["/workspace"], instructionSources: [], serviceTier: null, reasoningEffort: null,
      approvalsReviewer: "user", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] }, activePermissionProfile: null, initialTurnsPage: { data: [], nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
    else if (request.method === "thread/queue/list") reads.push(data => send({ data, nextCursor: null }));
    else if (request.method === "model/list") send({ data: [{ id: "test", model: "test", isDefault: true, inputModalities: ["text"] }], nextCursor: null });
    else if (request.method === "thread/queue/add") {
      row = { id: "server-one", clientUserMessageId: request.params.clientUserMessageId, input: request.params.input, createdAt: 101, pausedReason: null };
      if (notify) peer.send(JSON.stringify({ method: "thread/queue/changed", params: { threadId: "one" } }));
      send({ queuedSubmission: row });
    } else if (request.method.endsWith("/list")) send({ data: [], nextCursor: null });
    else send({});
  } });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "queue-test", transport, autoReconnect: false });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("one");
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(lease.getSnapshot().authoritative, true, lease.getSnapshot().error?.message);
    assert.equal(reads.length, 1);
    const composer = createComposerController({ type: "enqueue-follow-up", key: createConversationKey("queue-test", "one") }, { now: () => 100, createId: () => "queue-one" });
    composer.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "queue" }] }] } });
    await lease.submit(composer.createSubmitIntent());
    assert.equal(lease.getSnapshot().queuedSubmissions.length, 1);
    const counts: number[] = [];
    const unsubscribe = lease.subscribe(() => counts.push(lease.getSnapshot().queuedSubmissions.length));
    reads[0]!([]);
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(reads.length, 2);
    assert.equal(lease.getSnapshot().queuedSubmissions.length, 1, "old empty response must not clear the newly accepted message");
    reads[1]!([row]);
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(lease.getSnapshot().queuedSubmissions[0]?.serverSubmissionId, "server-one");
    assert.equal(counts.includes(0), false, "the queue never publishes an empty intermediate state");
    // A fresh authoritative empty list must still remove consumed/deleted input.
    peer.send(JSON.stringify({ method: "thread/queue/changed", params: { threadId: "one" } }));
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(reads.length, 3);
    reads[2]!([]);
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(lease.getSnapshot().queuedSubmissions.length, 0);
    unsubscribe();
    lease.release();
  } finally { await runtime.dispose(); }
});


test("queue add ACK supplies exact custody for early Steer without a list refresh", async () => {
  let acceptAdd!: () => void;
  const steers: unknown[] = [];
  const active = { id: "running", status: "inProgress", items: [] };
  const thread = { id: "one", name: "Queue", cwd: "/workspace", status: { type: "active" }, turns: [active] };
  const transport = new MemoryTransport({ receive(frame, peer: InMemoryAppServerPeer) {
    const request = JSON.parse(frame);
    if (request.id === undefined) return;
    const send = (result: unknown) => peer.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "initialize") send({ codexHome: "/tmp", platformFamily: "unix", platformOs: "linux", userAgent: "queue-test",
      capabilities: { extensions: { "opencraft/thread-queue": { version: 2, atomicSteer: true, reorder: true, perItemPause: true } } } });
    else if (request.method === "thread/read") send({ thread });
    else if (request.method === "thread/resume") send({ thread, model: "test", modelProvider: "test", cwd: "/workspace",
      runtimeWorkspaceRoots: ["/workspace"], instructionSources: [], serviceTier: null, reasoningEffort: null,
      approvalsReviewer: "user", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] }, activePermissionProfile: null,
      initialTurnsPage: { data: [active], nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
    else if (request.method === "thread/queue/list") { /* Deliberately withhold list/notifications. */ }
    else if (request.method === "model/list") send({ data: [{ id: "test", model: "test", isDefault: true, inputModalities: ["text"] }], nextCursor: null });
    else if (request.method === "thread/queue/add") acceptAdd = () => send({ queuedSubmission: {
      id: "ack-only", clientUserMessageId: request.params.clientUserMessageId, input: request.params.input, createdAt: 101, pausedReason: null,
    } });
    else if (request.method === "thread/queue/steer") { steers.push(request.params); send({ turnId: "running" }); }
    else if (request.method.endsWith("/list")) send({ data: [], nextCursor: null });
    else send({});
  } });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "queue-test", transport, autoReconnect: false });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("one");
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(lease.getSnapshot().authoritative, true);
    assert.equal(lease.getSnapshot().activeTurn?.turnId, "running");
    const composer = createComposerController({ type: "enqueue-follow-up", key: createConversationKey("queue-test", "one") },
      { now: () => 100, createId: () => "queue-early" });
    composer.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "queue" }] }] } });
    const send = lease.submit(composer.createSubmitIntent());
    for (let i = 0; i < 10; i++) await tick();
    const pending = lease.getSnapshot().queuedSubmissions[0]!;
    assert.equal(pending.steerable, true);
    const promotion = lease.steerQueuedSubmission(pending.commandId);
    assert.equal(lease.getSnapshot().queuedSubmissions[0]?.operation, "starting");
    assert.deepEqual(steers, []);
    acceptAdd();
    await Promise.all([send, promotion]);
    assert.deepEqual(steers, [{ threadId: "one", queuedSubmissionId: "ack-only", expectedTurnId: "running" }]);
    assert.equal(lease.getSnapshot().queuedSubmissions.length, 0);
    lease.release();
  } finally { await runtime.dispose(); }
});

test("queue refresh reads every loaded receipt scope and walks pending pagination only once", async () => {
  const turns = Array.from({ length: 1002 }, (_, index) => ({
    id: "turn-" + index, status: "completed",
    items: [{ id: "message-" + index, type: "agentMessage", text: "History " + index }],
  }));
  const thread = { id: "one", name: "Long queue history", cwd: "/workspace", status: { type: "idle" }, turns };
  const submission = (id: string) => ({
    id, clientUserMessageId: id, input: [{ type: "text", text: id }], createdAt: 1, pausedReason: null, sender: null,
  });
  const closed = (id: string, targetTurnId: string) => ({
    ...submission(id), targetTurnId, delivery: {
      version: 1, custody: "accepted", nativeAdmission: "accepted", context: "unobserved",
      targetTurnId, execution: "completed", revision: 3,
    },
  });
  const receipts = [closed("early receipt", "turn-0"), closed("late receipt", "turn-1001")];
  const unconfirmed = { ...submission("still unconfirmed"), targetTurnId: "unknown", pausedReason: "steer-delivery-unconfirmed" };
  const reads: Array<{ cursor: string | null; limit: number; receiptTurnIds: string[] }> = [];
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = JSON.parse(frame);
    if (request.id === undefined) return;
    const send = (result: unknown) => peer.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "initialize") send({ codexHome: "/tmp", platformFamily: "unix", platformOs: "linux", userAgent: "queue-test" });
    else if (request.method === "thread/read") send({ thread });
    else if (request.method === "thread/resume") send({
      thread, model: "test", modelProvider: "test", cwd: "/workspace",
      runtimeWorkspaceRoots: ["/workspace"], instructionSources: [], serviceTier: null, reasoningEffort: null,
      approvalsReviewer: "user", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] },
      activePermissionProfile: null, initialTurnsPage: { data: turns, nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
    });
    else if (request.method === "thread/queue/list") {
      const { cursor, limit, receiptTurnIds } = request.params;
      reads.push({ cursor, limit, receiptTurnIds });
      if (receiptTurnIds.length > 1000) {
        peer.send(JSON.stringify({ id: request.id, error: { code: -32602, message: "Invalid receipt Turn scope" } }));
        return;
      }
      if (cursor === "next") send({ data: [submission("queued second")], nextCursor: null });
      else send({
        data: [submission("queued first")], nextCursor: "next",
        steering: [unconfirmed, ...receipts.filter(receipt => receiptTurnIds.includes(receipt.targetTurnId))],
      });
    } else if (request.method.endsWith("/list")) send({ data: [], nextCursor: null });
    else send({});
  } });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "long-queue-test", transport, autoReconnect: false });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("one");
    for (let i = 0; i < 10; i++) await tick();
    const snapshot = lease.getSnapshot();
    assert.equal(snapshot.authoritative, true, snapshot.error?.message);
    const loadedRefresh = reads.findIndex(read => read.receiptTurnIds.length > 0);
    assert.ok(loadedRefresh >= 0);
    assert.deepEqual(reads.slice(loadedRefresh).map(({ cursor, limit, receiptTurnIds }) => [cursor, limit, receiptTurnIds.length]), [
      [null, 100, 1000], ["next", 100, 0], [null, 1, 2],
    ]);
    assert.deepEqual(new Set(reads.flatMap(read => read.receiptTurnIds)), new Set(turns.map(turn => turn.id)));
    assert.deepEqual(snapshot.queuedSubmissions.map(row => row.serverSubmissionId), ["queued first", "queued second"]);
    assert.equal(snapshot.unconfirmedSteers.length, 1);
    const restored = snapshot.timeline.frames.flatMap(frame => frame.blocks)
      .filter(block => block.type === "user-message" && receipts.some(receipt => receipt.clientUserMessageId === block.clientId))
      .map(block => block.type === "user-message" ? block.clientId : null);
    assert.deepEqual(new Set(restored), new Set(receipts.map(receipt => receipt.clientUserMessageId)));
    assert.equal(restored.length, receipts.length);
    lease.release();
  } finally { await runtime.dispose(); }
});

test("queue refresh abandons a cyclic or invalid cursor and recovers on the next hint", async () => {
  const thread = { id: "one", name: "Queue", cwd: "/workspace", status: { type: "idle" }, turns: [] };
  const row = (id: string) => ({
    id, clientUserMessageId: id, input: [{ type: "text", text: id }], createdAt: 1, pausedReason: null, sender: null,
  });
  let peer!: InMemoryAppServerPeer;
  let mode: "initial" | "cycle" | "invalid" | "recovered" = "initial";
  const cursors: (string | null)[] = [];
  const transport = new MemoryTransport({ connected(value) { peer = value; }, receive(frame, peer) {
    const request = JSON.parse(frame);
    if (request.id === undefined) return;
    const send = (result: unknown) => peer.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "initialize") send({ codexHome: "/tmp", platformFamily: "unix", platformOs: "linux", userAgent: "queue-test" });
    else if (request.method === "thread/read") send({ thread });
    else if (request.method === "thread/resume") send({
      thread, model: "test", modelProvider: "test", cwd: "/workspace",
      runtimeWorkspaceRoots: ["/workspace"], instructionSources: [], serviceTier: null, reasoningEffort: null,
      approvalsReviewer: "user", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] },
      activePermissionProfile: null, initialTurnsPage: { data: [], nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
    });
    else if (request.method === "thread/queue/list") {
      const { cursor } = request.params;
      cursors.push(cursor);
      if (mode === "cycle") {
        // Leave the invalid fourth read unanswered if the client follows the cycle.
        if (cursors.length <= 3) send({ data: [row("partial")], nextCursor: cursor === "a" ? "b" : "a" });
      } else if (mode === "invalid") {
        if (cursors.length === 1) send({ data: [row("partial")], nextCursor: 42 });
      } else send({ data: [row(mode === "initial" ? "saved" : "updated")], nextCursor: null });
    } else if (request.method.endsWith("/list")) send({ data: [], nextCursor: null });
    else send({});
  } });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "queue-cursor-test", transport, autoReconnect: false });
  const changed = async () => {
    cursors.length = 0;
    peer.send(JSON.stringify({ method: "thread/queue/changed", params: { threadId: "one" } }));
    for (let i = 0; i < 10; i++) await tick();
  };
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("one");
    for (let i = 0; i < 10; i++) await tick();
    const visible = () => lease.getSnapshot().queuedSubmissions.map(item => item.serverSubmissionId);
    assert.deepEqual(visible(), ["saved"]);

    mode = "cycle";
    await changed();
    assert.deepEqual(cursors, [null, "a", "b"]);
    assert.deepEqual(visible(), ["saved"]);
    mode = "invalid";
    await changed();
    assert.deepEqual(cursors, [null]);
    assert.deepEqual(visible(), ["saved"]);

    mode = "recovered";
    await changed();
    assert.deepEqual(cursors, [null]);
    assert.deepEqual(visible(), ["updated"]);
    lease.release();
  } finally { await runtime.dispose(); }
});

test("queue receipts refresh when an authoritative history window replaces an interior Turn", async () => {
  let middle = "previous-middle";
  let update = 1;
  const turns = () => ["first", middle, "last"].map((id) => ({
    id, itemsView: "full", status: "completed",
    items: [{ id: "message-" + id, type: "agentMessage", text: id + " revision " + update }],
  }));
  const thread = () => ({
    id: "one", name: "Receipt window", cwd: "/workspace", status: { type: "idle" },
    updatedAt: update, preview: "Revision " + update, historyMode: "message-window", turns: [],
  });
  const receipt = (targetTurnId: string) => ({
    id: "receipt-" + targetTurnId, clientUserMessageId: "receipt-" + targetTurnId, targetTurnId,
    input: [{ type: "text", text: "Receipt for " + targetTurnId }], createdAt: 1, pausedReason: null, sender: null,
    delivery: {
      version: 1, custody: "accepted", nativeAdmission: "accepted", context: "unobserved",
      targetTurnId, execution: "completed", revision: 3,
    },
  });
  const scopes: string[][] = [];
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = JSON.parse(frame);
    if (request.id === undefined) return;
    const send = (result: unknown) => peer.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "initialize") send({ capabilities: { extensions: {
      "opencraft/message-window-history": { version: 1 },
      "opencraft/resume-history": { version: 1, mode: "message-window" },
    } } });
    else if (request.method === "thread/read") send({ thread: thread() });
    else if (request.method === "thread/resume") send({
      thread: thread(), model: "test", modelProvider: "test", cwd: "/workspace",
      runtimeWorkspaceRoots: ["/workspace"], instructionSources: [], serviceTier: null, reasoningEffort: null,
      approvalsReviewer: "user", approvalPolicy: "on-request", sandbox: {}, activePermissionProfile: null,
      initialTurnsPage: { data: turns().reverse(), nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
    });
    else if (request.method === "thread/turns/list") send({ data: turns().reverse(), nextCursor: null });
    else if (request.method === "thread/queue/list") {
      const scope = request.params.receiptTurnIds as string[];
      scopes.push(scope);
      send({ data: [], nextCursor: null, steering: scope.includes(middle) ? [receipt(middle)] : [] });
    } else if (request.method.endsWith("/list")) send({ data: [], nextCursor: null });
    else send({});
  } });

  const runtime = createAppServerWorkbenchRuntime({ hostId: "receipt-window-test", transport, autoReconnect: false });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("one");
    for (let i = 0; i < 10; i++) await tick();
    const ids = () => [...new Set(lease.getSnapshot().timeline.frames.map(frame => String(frame.turnId)))];
    const receipts = () => lease.getSnapshot().timeline.frames.flatMap(frame => frame.blocks)
      .flatMap(block => block.type === "user-message" && block.clientId?.startsWith("receipt-") ? [block.clientId] : []);
    assert.equal(lease.getSnapshot().authoritative, true, lease.getSnapshot().error?.message);
    assert.deepEqual(ids(), ["first", "previous-middle", "last"]);
    assert.deepEqual(receipts(), ["receipt-previous-middle"]);

    middle = "replacement-middle";
    update++;
    scopes.length = 0;
    assert.equal(await lease.refreshHistory(), true);
    for (let i = 0; i < 10; i++) await tick();
    assert.deepEqual(ids(), ["first", "replacement-middle", "last"]);
    assert.deepEqual(scopes, [["first", "replacement-middle", "last"]]);
    assert.deepEqual(receipts(), ["receipt-replacement-middle"]);

    update++;
    scopes.length = 0;
    assert.equal(await lease.refreshHistory(), true);
    for (let i = 0; i < 10; i++) await tick();
    assert.deepEqual(scopes, [], "content changes with identical Turn IDs do not reread the queue");
    lease.release();
  } finally { await runtime.dispose(); }
});
