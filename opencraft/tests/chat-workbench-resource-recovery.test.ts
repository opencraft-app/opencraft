import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const thread = (id: string) => ({ id, sessionId: id, name: id, cwd: "/workspace", path: `/rollouts/${id}`, historyMode: "paginated", status: { type: "idle" }, turns: [] });

test("Host and active Thread recover independently of a rejected Thread and stalled watch", async () => {
  let peer!: InMemoryAppServerPeer;
  let recovering = false;
  const requests: string[] = [];
  const transport = new MemoryTransport({
    connected(value) { peer = value; },
    receive(frame, reply) {
      const message = JSON.parse(frame);
      if (message.id === undefined) return;
      requests.push(message.method);
      const send = (result: unknown) => reply.send(JSON.stringify({ id: message.id, result }));
      if (message.method === "initialize") send({ codexHome: "/tmp", platformFamily: "unix", platformOs: "linux", userAgent: "recovery-test" });
      else if (message.method === "thread/read") send({ thread: thread(message.params.threadId) });
      else if (message.method === "thread/resume") {
        if (recovering && message.params.threadId === "missing") {
          reply.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Thread no longer exists" } }));
        } else send({ thread: thread(message.params.threadId), model: "test", modelProvider: "test", cwd: "/workspace",
          serviceTier: "default", reasoningEffort: "medium", approvalsReviewer: "user",
          runtimeWorkspaceRoots: ["/workspace"], instructionSources: [], activePermissionProfile: { id: "workspace" },
          approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] },
          initialTurnsPage: { data: [], nextCursor: null }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
      } else if (message.method === "fs/watch" && recovering) return;
      else if (message.method.endsWith("/list")) send({ data: [], nextCursor: null });
      else send({});
    },
  });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "recovery", transport, autoReconnect: false, requestTimeoutMs: 100 });
  try {
    await runtime.connect();
    const missing = await runtime.acquireThread("missing");
    const healthy = await runtime.acquireThread("healthy");
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(healthy.getSnapshot().authoritative, true, healthy.getSnapshot().error?.message);
    // Existing watcher restoration must not delay current chat readiness.
    await runtime.resources.fileSystem.watch("/workspace", () => undefined);
    recovering = true; peer.close("network lost");
    await runtime.reconnect();
    assert.equal(runtime.getSnapshot().phase, "ready");
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(healthy.getSnapshot().authoritative, true);
    assert.equal(runtime.getThreadResidency("missing")?.phase, "error");
    assert.equal(runtime.getSnapshot().phase, "ready");
    assert.equal(requests.filter(method => method === "initialize").length, 2);
    assert.equal(requests.includes("turn/start"), false);
    missing.release(); healthy.release();
  } finally { await runtime.dispose(); }
});
