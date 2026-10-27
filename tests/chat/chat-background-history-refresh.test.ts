import assert from "node:assert/strict";
import test from "node:test";
import { asTurnId } from "@opencraft/chat-core";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { createHarness, waitForAuthoritative, waitForRequest } from "../fixtures/workbench-draft-harness";

test("background refresh does not read history while a turn is streaming", async () => {
  const h = createHarness(false, false, [], false, undefined, "message-window");
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: h.transport, autoReconnect: false });
  try {
    await runtime.connect(); const lease = await runtime.acquireThread("thread-created"); await waitForAuthoritative(lease);
    h.notify("turn/started", { threadId: "thread-created", turn: { id: "streaming", status: "inProgress", items: [] } });
    for (let i = 0; i < 20 && !lease.getSnapshot().activeTurn; i++) await new Promise(r => setTimeout(r, 0));
    assert.ok(lease.getSnapshot().activeTurn);
    const reads = h.requests.filter(r => r.method === "thread/read").length;
    assert.equal(await lease.refreshHistory(), false);
    assert.equal(h.requests.filter(r => r.method === "thread/read").length, reads);
    lease.release();
  } finally { await runtime.dispose(); }
});

test("background refresh does not read history while an interrupt command is pending", async () => {
  const h = createHarness(false, false, [], false, undefined, "message-window");
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", transport: h.transport, autoReconnect: false });
  try {
    await runtime.connect(); const lease = await runtime.acquireThread("thread-created"); await waitForAuthoritative(lease);
    h.holdInterrupt(); const stopping = lease.interrupt(asTurnId("historical-turn"));
    await waitForRequest(h, "turn/interrupt");
    assert.equal(lease.getSnapshot().activeTurn, null, "exercise the pending-command guard independently");
    assert.ok(runtime.getThreadResidency("thread-created")!.pendingCommandCount > 0);
    const reads = h.requests.filter(r => r.method === "thread/read").length;
    assert.equal(await lease.refreshHistory(), false);
    assert.equal(h.requests.filter(r => r.method === "thread/read").length, reads);
    h.releaseInterrupt(); await stopping; lease.release();
  } finally { h.releaseInterrupt(); await runtime.dispose(); }
});
