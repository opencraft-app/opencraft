import assert from "node:assert/strict";
import test from "node:test";

import type { SubmitIntent } from "@opencraft/composer-core";
import { asHostId, asThreadId } from "@opencraft/chat-core";
import { isStandaloneHermesStop } from "../apps/workbench-web/src/hermes-stop-command";
import { HermesAppServerAdapter } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import { dispatchAppServerRequest } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol";
import type { HermesRpcClient } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/rpc-transport";

const baseIntent: SubmitIntent = {
  commandId: "command",
  clientMessageId: "message",
  target: { type: "existing-thread", key: { hostId: asHostId("hermes"), threadId: asThreadId("thread") } },
  document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "/stop " }] }] },
  attachments: [],
  context: [],
  selections: {},
  options: { autoContext: false },
  createdAt: 0,
};

test("Hermes Stop recognizes only a standalone command without other input", () => {
  assert.equal(isStandaloneHermesStop(baseIntent), true);
  assert.equal(isStandaloneHermesStop({
    ...baseIntent,
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "command", name: "stop" }] }] },
  }), true);
  assert.equal(isStandaloneHermesStop({
    ...baseIntent,
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "/stop please" }] }] },
  }), false);
  assert.equal(isStandaloneHermesStop({
    ...baseIntent,
    document: { version: 1, blocks: [{ type: "code-block", text: "/stop" }] },
  }), false);
  assert.equal(isStandaloneHermesStop({
    ...baseIntent,
    attachments: [{ id: "image", name: "image.png", mimeType: "image/png", size: 1, uri: "file://image", lifecycle: "ready", error: null }],
  }), false);
  assert.equal(isStandaloneHermesStop({ ...baseIntent, context: [{ id: "file", kind: "file", title: "file", uri: "file://example", visible: true }] }), false);
});

test("Hermes /stop cleans background processes while idle and interrupts before cleanup while active", async () => {
  const calls: string[] = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === "session.create") return {
        session_id: "live-stop",
        stored_session_id: "stored-stop",
        message_count: 0,
        messages: [],
        running: false,
      } as T;
      if (method === "prompt.submit") return { status: "running" } as T;
      if (method === "session.interrupt") return { status: "interrupted" } as T;
      if (method === "process.stop") return { killed: 2 } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const thread = await adapter.startThread();

  calls.length = 0;
  assert.deepEqual(await dispatchAppServerRequest(adapter, {
    id: 1, method: "hermes/stop", params: { threadId: thread.id, expectedTurnId: null },
  }), { killed: 2 });
  assert.deepEqual(calls, ["process.stop"]);

  const active = await adapter.startTurn(thread.id, [{ type: "text", text: "work" }]);
  calls.length = 0;
  await dispatchAppServerRequest(adapter, {
    id: 2, method: "hermes/stop", params: { threadId: thread.id, expectedTurnId: "older-turn" },
  });
  assert.deepEqual(calls, ["process.stop"], "a stale Stop must not interrupt a newer Turn");

  calls.length = 0;
  assert.deepEqual(await dispatchAppServerRequest(adapter, {
    id: 3, method: "hermes/stop", params: { threadId: thread.id, expectedTurnId: active.id },
  }), { killed: 2 });
  assert.deepEqual(calls, ["session.interrupt", "process.stop"]);

  calls.length = 0;
  await dispatchAppServerRequest(adapter, {
    id: 4, method: "turn/interrupt", params: { threadId: thread.id, turnId: active.id },
  });
  assert.deepEqual(calls, ["session.interrupt"], "the ordinary Stop button does not kill background processes");
  adapter.dispose();
});

test("Hermes /stop from a new chat cleans background processes without creating a session", async () => {
  const calls: string[] = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === "process.stop") return { killed: 1 } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  assert.deepEqual(await dispatchAppServerRequest(adapter, {
    id: 1, method: "hermes/stop", params: { threadId: null, expectedTurnId: null },
  }), { killed: 1 });
  assert.deepEqual(calls, ["process.stop"]);
  adapter.dispose();
});

test("Hermes /stop still attempts background cleanup if interrupt fails", async () => {
  const calls: string[] = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === "session.create") return {
        session_id: "live-stop-failure",
        stored_session_id: "stored-stop-failure",
        message_count: 0,
        messages: [],
        running: false,
      } as T;
      if (method === "prompt.submit") return { status: "running" } as T;
      if (method === "session.interrupt") throw new Error("interrupt unavailable");
      if (method === "process.stop") return { killed: 1 } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const thread = await adapter.startThread();
  const active = await adapter.startTurn(thread.id, [{ type: "text", text: "work" }]);
  calls.length = 0;
  await assert.rejects(dispatchAppServerRequest(adapter, {
    id: 1, method: "hermes/stop", params: { threadId: thread.id, expectedTurnId: active.id },
  }), /interrupt unavailable/);
  assert.deepEqual(calls, ["session.interrupt", "process.stop"]);
  adapter.dispose();
});
