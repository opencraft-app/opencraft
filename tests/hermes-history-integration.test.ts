import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { HermesAppServerAdapter } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import { dispatchAppServerRequest } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol";
import { HermesProjectionRecovery } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/projection-recovery";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for the integration boundary");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test("real adapter → AppServer → Workbench paints REST before runtime, backfills once, and refreshes without duplicate groups", async () => {
  let peer: InMemoryAppServerPeer;
  let release!: () => void;
  let paused = new Promise<void>(resolve => { release = resolve; });
  let resumeCalls = 0;
  let reads = 0;
  const rows = Array.from({ length: 260 }, (_, index) => ({ id: index + 1, role: index % 2 === 0 ? "user" : "assistant", content: `message ${index + 1}` }));
  const summary = { id: "s", title: "history integration", preview: "", profile: "default", message_count: rows.length };
  const recovery = new HermesProjectionRecovery();
  const makeAdapter = () => {
  const adapter = new HermesAppServerAdapter({
    onEvent() { return () => {}; },
    async call<T>(name: string): Promise<T> {
      if (name === "profiles.list") return { profiles: [{ name: "default" }] } as T;
      if (name === "session.list") return { sessions: [summary] } as T;
      if (name === "session.resume") {
        resumeCalls++;
        await paused;
        return { session_id: "live", stored_session_id: "s", running: false, messages: [], message_count: rows.length } as T;
      }
      throw new Error(`Unexpected Hermes RPC ${name}`);
    },
  }, "/", {
    async readMessages(id, q) {
      reads++;
      // An actively transferring REST body outlives the control-RPC budget.
      await new Promise(resolve => setTimeout(resolve, 80));
      const messages = rows.slice(Math.max(0, rows.length - q.offset - q.limit), rows.length - q.offset);
      return { session_id: id, messages, pagination: { limit: q.limit, offset: q.offset, order: q.order, returned: messages.length } };
    }, dispose() {},
  }, undefined, recovery);
  adapter.subscribeNotification((method, params) => peer.send(encodeJsonRpcMessage({ method, params })));
  return adapter;
  };
  let adapter = makeAdapter();
  let connections = 0;
  const transport = new MemoryTransport({
    connected(connected) {
      peer = connected;
      if (connections++ > 0) { adapter.dispose(); adapter = makeAdapter(); }
    },
    receive(frame, connected) {
      const request = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(request)) return;
      void dispatchAppServerRequest(adapter, request).then(
        result => connected.send(encodeJsonRpcMessage({ id: request.id, result })),
        error => connected.send(encodeJsonRpcMessage({ id: request.id, error: { code: -32000, message: String(error) } })),
      );
    },
  });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "hermes-test", transport, autoReconnect: false, requestTimeoutMs: 50 });
  try {
    await runtime.connect();
    const lease = await runtime.acquireThread("s");
    const navigation = lease.getNavigation();
    await navigation.prepare();
    await until(() => lease.getSnapshot().timeline.frames.length > 0);
    assert.equal(resumeCalls, 1, "metadata read must not resume the runtime");
    assert.equal(reads, 1);
    assert.equal(lease.getSnapshot().authoritative, false, "paint is not execution readiness");
    assert.equal(lease.getSnapshot().phase, "syncing");
    release();
    await until(() => lease.getSnapshot().authoritative);
    await navigation.prepare();
    assert.equal(reads, 1, "Resume consumes the same tail, not a second REST read");
    assert.equal(lease.getSnapshot().history.hasOlder, true);
    const first = lease.loadOlder();
    await Promise.all([first, lease.loadOlder()]);
    assert.equal(reads, 2);
    await lease.loadOlder();
    assert.equal(reads, 3);
    assert.equal(lease.getSnapshot().history.hasOlder, false);
    const before = lease.getSnapshot().timeline.frames.map(frame => frame.id);
    assert.equal(new Set(before).size, before.length);
    await lease.retryRestore();
    assert.equal(reads, 3, "an already resumed lease is not a forced refetch");
    assert.deepEqual(lease.getSnapshot().timeline.frames.map(frame => frame.id), before);
    await runtime.reconnect();
    await until(() => lease.getSnapshot().authoritative);
    assert.equal(reads, 4, "reconnection refreshes only one tail page");
    assert.deepEqual(lease.getSnapshot().timeline.frames.map(frame => frame.id), before);
    lease.release();
  } finally {
    release();
    await runtime.dispose();
    adapter.dispose();
  }
});
