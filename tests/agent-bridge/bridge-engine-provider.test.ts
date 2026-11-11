import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeHost, attachGateway, type Generation } from "../../apps/agent-bridge-host/src/index.js";
import { negotiateHandshake, type BridgeDeclaration } from "@opencraft/agent-bridge-protocol";
import { BridgeEngineProvider } from "../../apps/local-agent-host/src/bridge-engine-provider.js";
import { localTestBackend } from "./fixtures/local-backend.js";

const token = "test-private-token-000000000000000000000";
const declaration: BridgeDeclaration = {
  providerId: "fixture", protocolVersion: 1, grammarRange: { min: 1, max: 1 }, approvalExecutor: "provider",
  minNativeVersion: "1", probeBasis: "provider adapter fixture",
  capabilities: {
    model: false, reasoning: false, history: false, usage: false, approval: false,
    inputContentTypes: ["text"], cliExecutable: false, forkCheckpoint: false, skills: false, installation: false,
    steer: {
      deliveryMethods: ["native-inject"], evidenceKinds: ["admission"], withdrawal: "none",
      contentLimits: { maxBytes: 1024, allowedContentTypes: ["text"] }, maxPendingWithoutNativeId: 1,
      fallbackPolicy: "reject-unknown",
    },
  },
};
const policy = { id: "bridge-provider-test", capacity: { cpuMillis: 8000, memoryBytes: 8 * 1024 ** 3 } };

async function generation(root: string): Promise<Generation> {
  const artifact = resolve("tests/agent-bridge/fixtures/fake-bridge.mjs");
  const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, declaration);
  assert(handshake.ok);
  return {
    id: "fixture-g1",
    artifact,
    digest: createHash("sha256").update(await readFile(artifact)).digest("hex"),
    provider: declaration,
    launch: {
      command: [process.execPath, artifact],
      cwd: root,
      env: {
        HANDSHAKE: JSON.stringify(handshake.result),
        EXECUTIONS: join(root, "executions"),
        HOST_PID: String(process.pid),
      },
    },
  };
}

test("bridge engine provider maps AppServer new Threads and steer onto one Host generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-provider-"));
  const host = await BridgeHost.open({ path: join(root, "host.db"), policy, backend: localTestBackend() });
  const gateway = await attachGateway(host, token);
  t.after(async () => {
    await gateway.close().catch(() => {});
    await host.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await host.add(await generation(root));
  await host.activate("fixture-g1", "");
  const provider = new BridgeEngineProvider({
    id: "fixture", label: "Fixture", engine: "pi",
    threadPrefix: "fixture_bridge_", modelPrefix: "fixture:",
    defaultCwd: root, defaultModel: "fixture/model",
    models: [{ id: "fixture/model", name: "Fixture model", isDefault: true }],
    gateway: { url: gateway.url, token, serverId: "server-1", inboxPath: join(root, "inbox.db") },
  });
  t.after(() => provider.close().catch(() => {}));
  await provider.start();
  assert.equal(provider.ownsThread("fixture_bridge_id"), true);
  assert.equal(provider.ownsThread("legacy"), false);
  assert.equal(provider.ownsModel("fixture:model"), true);

  const created = await provider.request("thread/start", { cwd: root, model: "fixture:model" }, { request: async () => ({}), notify() {} });
  assert.match(created.thread.id, /^fixture_bridge_/u);
  assert.equal(created.thread.cwd, root);
  assert.equal(created.thread.model, "fixture:model");

  const started = await provider.request("turn/start", {
    threadId: created.thread.id,
    clientUserMessageId: "client-input-1",
    input: [{ type: "text", text: "read one file" }],
  }, { request: async () => ({}), notify() {} });
  assert.match(started.turn.id, /^t\d+\.\d+$/u);
  assert.equal(started.turn.status, "inProgress");

  // The fake bridge keeps the turn active long enough for the same mapped
  // native turn identity to be used by turn/steer.
  const steered = await provider.request("turn/steer", {
    threadId: created.thread.id,
    expectedTurnId: started.turn.id,
    clientUserMessageId: "client-input-2",
    input: [{ type: "text", text: "use the blue door" }],
  }, { request: async () => ({}), notify() {} });
  assert.equal(steered.turnId, started.turn.id);
  assert.equal(steered.disposition, "steered");

  const models = await provider.request("model/list", {}, { request: async () => ({}), notify() {} });
  assert.equal(models.data[0].id, "fixture/model");
  assert.equal(models.data[0].isDefault, true);

  const read = await provider.request("thread/read", { threadId: created.thread.id }, { request: async () => ({}), notify() {} });
  assert.equal(read.thread.id, created.thread.id);
  const list = await provider.request("thread/list", { archived: false }, { request: async () => ({}), notify() {} });
  assert.ok(list.data.some((entry: any) => entry.id === created.thread.id));
  const steerStatus = await provider.request("opencraft/steer/status", { threadId: created.thread.id }, { request: async () => ({}), notify() {} });
  assert.equal(steerStatus.schemaVersion, 1);
});

test("new bridge Threads only use their configured prefix; legacy identities never fall through", async () => {
  const provider = new BridgeEngineProvider({
    id: "fixture", label: "Fixture", engine: "claude-code",
    threadPrefix: "claude_bridge_", modelPrefix: "claude-code:",
    defaultCwd: "/tmp", models: [],
    gateway: { url: "http://127.0.0.1:1", token: "x".repeat(32), serverId: "server-1", inboxPath: "/tmp/provider-inbox.sqlite" },
  });
  assert.equal(provider.ownsThread("claude_bridge_id"), true);
  assert.equal(provider.ownsThread("claude_legacy"), false);
  assert.equal(provider.ownsModel("claude-code:current"), true);
  await assert.rejects(provider.request("thread/start", { cwd: "/tmp" }, { request: async () => ({}), notify() {} }), /Bridge generation|fetch failed|ECONNREFUSED|unavailable/iu);
  await provider.close();
});
