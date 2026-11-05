import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import {
  encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage,
  OPENCRAFT_METHOD_ACCESS_EXTENSION, OPENCRAFT_TERMINAL_RESTORE_EXTENSION,
  supportsTerminalMethod, type JsonRpcErrorObject,
} from "@opencraft/appserver-protocol";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import {
  AppServerTerminalController, ConversationTerminalSessionRegistry, TerminalRestoreUnavailableError,
} from "@opencraft/workbench-runtime";

const persistent = { [OPENCRAFT_TERMINAL_RESTORE_EXTENSION]: { version: 1 } };
const command = ["/bin/bash", "--noprofile", "--norc"];

async function fixture(options: { extensions?: Record<string, unknown>; attachError?: JsonRpcErrorObject } = {}) {
  const peers = new Set<InMemoryAppServerPeer>();
  const calls: Array<{ method: string; params: any }> = [];
  const client = new JsonRpcAppServerClient({ hostId: "terminal-test", transport: new MemoryTransport({
    connected(peer) { peers.add(peer); },
    receive(frame, peer) {
      const message = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(message)) return;
      calls.push(message);
      if (message.method === "process/attach" && options.attachError) {
        peer.send(encodeJsonRpcMessage({ id: message.id, error: options.attachError }));
        return;
      }
      const result = message.method === "initialize"
        ? { userAgent: "terminal-test", capabilities: { extensions: options.extensions } }
        : message.method === "process/attach"
          ? { processHandle: (message.params as any).processHandle, phase: "running", exitCode: null,
            output: [], nextSequence: 1, truncated: false }
          : message.method === "process/list" ? { processes: [] } : {};
      peer.send(encodeJsonRpcMessage({ id: message.id, result }));
    },
  }) });
  const connect = () => client.connect({ clientInfo: { name: "terminal-test", version: "1" } });
  await connect();
  const controller = new AppServerTerminalController("terminal-test", client);
  return { client, controller, calls,
    async open() {
      const session = controller.open({ command, cols: 80, rows: 24 });
      await session.resize(80, 24);
      return session;
    },
    async output(processHandle: string, text: string) {
      for (const peer of peers) peer.send(encodeJsonRpcMessage({ method: "process/outputDelta", params: {
        processHandle, sequence: 1, stream: "stdout", deltaBase64: Buffer.from(text).toString("base64"),
      } }));
      await new Promise<void>(resolve => setImmediate(resolve));
    },
    disconnect() { for (const peer of peers) peer.close("test network loss"); peers.clear(); },
    async reconnect() { await connect(); await controller.reconnect(); },
    async close() { await controller.dispose(); await client.close(); },
  };
}

test("terminal restoration requires positive support and still respects method admission", () => {
  assert.equal(supportsTerminalMethod(undefined, "process/spawn"), true);
  for (const method of ["process/attach", "process/list"] as const) {
    assert.equal(supportsTerminalMethod(undefined, method), false);
    assert.equal(supportsTerminalMethod(persistent, method), true);
    for (const capability of [null, true, [], { version: 2 }, { version: "1" }])
      assert.equal(supportsTerminalMethod({ [OPENCRAFT_TERMINAL_RESTORE_EXTENSION]: capability }, method), false);
    assert.equal(supportsTerminalMethod({ ...persistent, [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { version: 1, methods: [] } }, method), false);
    assert.equal(supportsTerminalMethod({ [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { version: 1, methods: [method] } }, method), true);
  }
});

test("native terminal disconnect preserves output without unsupported RPCs or automatic respawn", async () => {
  const f = await fixture();
  try {
    const session = await f.open();
    await f.output(session.processId, "original shell output");
    const output = session.getSnapshot().output;
    assert.equal(output.length, 1);
    f.disconnect();
    await f.reconnect();
    assert.equal(session.getSnapshot().phase, "failed");
    assert.ok(session.getSnapshot().error instanceof TerminalRestoreUnavailableError);
    assert.deepEqual(session.getSnapshot().output, output);
    assert.deepEqual(await f.controller.list(), { processes: [] });
    await assert.rejects(session.write(Buffer.from("echo unsafe\n").toString("base64")), TerminalRestoreUnavailableError);
    f.disconnect();
    await f.reconnect();
    assert.equal(session.getSnapshot().phase, "failed");
    assert.equal(f.calls.filter(call => call.method === "process/spawn").length, 1);
    assert.ok(!f.calls.some(call => ["process/attach", "process/list", "process/kill", "process/writeStdin"].includes(call.method)));
  } finally { await f.close(); }
});

test("an explicit new terminal retains the previous terminal and the same execution scope", async () => {
  const f = await fixture();
  const registry = new ConversationTerminalSessionRegistry(() => ({
    getSnapshot: () => ({ phase: "ready" }),
    resources: { terminal: f.controller, host: { canRequest: () => true } },
  } as any));
  try {
    const options = { hostId: "terminal-test", cwd: "/workspace", threadId: "thread", projectId: "project",
      resourceOwnerId: "scope", cols: 91, rows: 30 };
    const firstId = registry.open(options);
    const first = registry.get(firstId)!;
    await first.resize(91, 30);
    await f.output(first.processId, "keep this output");
    f.disconnect(); await f.reconnect();
    assert.equal(first.getSnapshot().phase, "failed");
    const secondId = registry.openAnother(firstId);
    const second = registry.get(secondId)!;
    await second.resize(91, 30);
    assert.notEqual(secondId, firstId);
    assert.equal(registry.get(firstId), first);
    assert.equal(first.getSnapshot().output.length, 1);
    assert.equal(second.getSnapshot().phase, "running");
    const spawns = f.calls.filter(call => call.method === "process/spawn").map(call => call.params);
    assert.equal(spawns.length, 2);
    for (const spawn of spawns) {
      assert.equal(spawn.resourceOwnerId, options.resourceOwnerId);
      assert.equal(spawn.threadId, options.threadId);
      assert.equal(spawn.projectId, options.projectId);
      assert.equal(spawn.cwd, options.cwd);
      assert.deepEqual(spawn.size, { cols: 91, rows: 30 });
    }
    assert.ok(!f.calls.some(call => call.method === "process/kill"));
  } finally { await registry.dispose(); await f.close(); }
});

test("a persistent Host restores the same terminal and never creates a second shell", async () => {
  const f = await fixture({ extensions: persistent });
  try {
    const session = await f.open();
    f.disconnect(); await f.reconnect();
    assert.equal(session.getSnapshot().phase, "running");
    await session.write(Buffer.from("echo restored\n").toString("base64"));
    assert.equal(f.calls.filter(call => call.method === "process/spawn").length, 1);
    assert.equal(f.calls.find(call => call.method === "process/attach")?.params.processHandle, session.processId);
  } finally { await f.close(); }
});

for (const error of [
  { code: -32601, message: "Method not found" },
  { code: -32600, message: "Invalid request: unknown variant `process/attach`, expected process/spawn" },
]) test(`a Host rejecting advertised restoration becomes a permanent, actionable failure (${error.code})`, async () => {
  const f = await fixture({ extensions: persistent, attachError: error });
  try {
    const session = await f.open();
    f.disconnect(); await f.reconnect();
    assert.equal(session.getSnapshot().phase, "failed");
    assert.ok(session.getSnapshot().error instanceof TerminalRestoreUnavailableError);
    await f.controller.reconnect();
    assert.equal(f.calls.filter(call => call.method === "process/attach").length, 1);
  } finally { await f.close(); }
});

test("a transient restoration failure remains recoverable", async () => {
  const options = { extensions: persistent, attachError: { code: -32000, message: "temporarily unavailable" } as JsonRpcErrorObject | undefined };
  const f = await fixture(options);
  try {
    const session = await f.open();
    f.disconnect(); await f.reconnect();
    assert.equal(session.getSnapshot().phase, "disconnected");
    options.attachError = undefined;
    await f.controller.reconnect();
    assert.equal(session.getSnapshot().phase, "running");
  } finally { await f.close(); }
});
