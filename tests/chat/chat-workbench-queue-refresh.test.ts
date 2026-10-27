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
