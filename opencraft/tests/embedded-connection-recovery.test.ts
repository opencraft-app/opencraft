import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerWorkbenchSnapshot } from "@opencraft/workbench-runtime";
import { observeEmbeddedConnection } from "../apps/workbench-web/src/embedded-chat/embedded-connection";
import { LightVelaHermesTransport } from "@opencraft/plugin-lightvela-hermes";
import type { LightVelaBotInstance } from "../plugins/lightvela-hermes/src/account/lightvela-account-service";

test("initial failure retains Host observation and manual recovery; disposal fences late events", async () => {
  let phase: AppServerWorkbenchSnapshot["phase"] = "idle";
  let listener = () => {};
  let reconnects = 0;
  const updates: string[] = [];
  const connection = observeEmbeddedConnection({
    getSnapshot: () => ({ phase, transport: { state: "failed" } }) as AppServerWorkbenchSnapshot,
    subscribe: next => { listener = next; return () => { listener = () => {}; }; },
    connect: async () => { phase = "error"; listener(); throw new Error("temporary network failure"); },
    reconnect: async () => { reconnects++; phase = "ready"; listener(); },
  }, detail => updates.push(detail.phase));
  let ready = false;
  void connection.ready.then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  assert.deepEqual(updates, ["idle", "error"]);
  await connection.reconnect();
  await connection.ready;
  assert.equal(reconnects, 1);
  assert.equal(ready, true);
  connection.dispose();
  phase = "error"; listener();
  await connection.reconnect();
  assert.deepEqual(updates, ["idle", "error", "ready"]);
  assert.equal(reconnects, 1);
});

test("disposing an initial wait settles it", async () => {
  const connection = observeEmbeddedConnection({
    getSnapshot: () => ({ phase: "connecting", transport: { state: "connecting" } }) as AppServerWorkbenchSnapshot,
    subscribe: () => () => {}, connect: async () => {}, reconnect: async () => {},
  }, () => {});
  connection.dispose();
  await assert.rejects(connection.ready, /disposed/);
});

test("Hermes startup deadline fences late Bot resolution before a tunnel is created", async () => {
  let resolveBot!: (value: LightVelaBotInstance) => void;
  let requests = 0;
  const transport = new LightVelaHermesTransport({
    profile: "test-profile", connectTimeoutMs: 5,
    account: {
      getSnapshot: () => ({ phase: "authenticated", activeBotId: "test-bot" }),
      subscribe: () => () => {},
      resolveActiveBot: () => new Promise(resolve => { resolveBot = resolve; }),
      request: async () => { requests++; throw new Error("Must not create a tunnel"); },
    },
  });
  try {
    await assert.rejects(transport.connect(), /timed out/);
    assert.equal(transport.status.state, "failed");
    resolveBot({ instanceId: "test-bot" } as LightVelaBotInstance);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(requests, 0);
    assert.equal(transport.status.state, "failed");
  } finally { await transport.close(); }
});

test("closing a hung startup cancels immediately instead of waiting for its deadline", async () => {
  const transport = new LightVelaHermesTransport({
    profile: "test-profile",
    account: {
      getSnapshot: () => ({ phase: "authenticated", activeBotId: "test-bot" }),
      subscribe: () => () => {}, resolveActiveBot: () => new Promise(() => {}),
      request: async () => { throw new Error("unexpected API request"); },
    },
  });
  const pending = transport.connect();
  const rejected = assert.rejects(pending, /aborted/);
  await transport.close();
  await rejected;
  assert.equal(transport.status.state, "closed");
});
