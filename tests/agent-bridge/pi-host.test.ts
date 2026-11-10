import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeHost } from "../../apps/agent-bridge-host/src/index.js";
import { PI_BRIDGE_DECLARATION } from "../../plugins/pi-bridge/src/bridge.js";
import { buildPiBridge } from "../../scripts/build-pi-bridge.mjs";
import { localTestBackend } from "./fixtures/local-backend.js";

const MODELS = JSON.stringify({
  providers: {
    test: {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      apiKey: "unused",
      models: [{
        id: "model",
        name: "Test Model",
        input: ["text"],
        contextWindow: 1000,
        maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  },
});
const policy = { id: "pi-bridge-test", capacity: { cpuMillis: 8000, memoryBytes: 8 * 1024 ** 3 } };

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let index = 0; index < 200; index++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Condition timed out");
}

test("Host launches the pinned Pi bridge artifact and owns one native writer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-bridge-host-"));
  const dataDirectory = join(root, "bridge-data");
  const agentDirectory = join(root, "agent");
  const taskDirectory = join(root, "task");
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(agentDirectory, "models.json"), MODELS, { mode: 0o600 });
  await writeFile(join(agentDirectory, "auth.json"), "{}", { mode: 0o600 });
  const artifact = await buildPiBridge(join(root, "pi-bridge.mjs"));
  const host = await BridgeHost.open({ path: join(root, "host.db"), policy, backend: localTestBackend() });
  t.after(async () => {
    await host.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await host.add({
    id: "pi-g1",
    artifact,
    digest: createHash("sha256").update(await readFile(artifact)).digest("hex"),
    provider: PI_BRIDGE_DECLARATION,
    launch: {
      command: [process.execPath, artifact],
      cwd: root,
      env: { PI_BRIDGE_DATA_DIR: dataDirectory, PI_BRIDGE_AGENT_DIR: agentDirectory },
    },
  });
  await host.activate("pi-g1", "");

  const create = await host.accept({
    commandId: "create",
    serverId: "server-1",
    threadId: "thread-1",
    method: "session/create",
    params: { cwd: taskDirectory, model: "test/model" },
  });
  assert.equal(create.state, "registered");
  await until(() => host.query("create"), receipt => receipt?.state === "accepted");
  const events = await host.events(0);
  const identity = events.find(event => event.payload.method === "thread/identity");
  assert.ok(identity, "the bridge identity callback is durable in the Host outbox");
  const snapshot = await host.snapshot();
  const native = snapshot.nativeSessions.find((row: any) => row.route === JSON.stringify(["server-1", "thread-1"]));
  assert.match(native.native_id, /^pi_bridge_[0-9a-f-]{36}$/u);

  const sessions = join(dataDirectory, "sessions");
  const entries = await readdir(sessions);
  const database = entries.find(name => name.endsWith(".sqlite"));
  assert.ok(database, "the bridge created a native durable database");
  const holders = execFileSync("lsof", ["-t", join(sessions, database)], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
  assert.equal(holders.length, 1, "exactly one process may hold the native session writer");
  assert.notEqual(holders[0], String(process.pid), "the Host/test process must not be the native writer");

  await host.accept({
    commandId: "probe",
    serverId: "server-1",
    threadId: "thread-1",
    method: "maintenance/probe",
    params: {},
  });
  const probe = await until(() => host.query("probe"), receipt => receipt?.state === "accepted");
  assert.equal(probe.response?.result?.owner, "pi-durable");
  assert.equal(probe.response?.result?.activeSessions, 1);

  await host.accept({ commandId: "close", serverId: "server-1", threadId: "thread-1", method: "session/close", params: {} });
  await until(() => host.query("close"), receipt => receipt?.state === "accepted");
  const tail = await host.events(events.at(-1)?.seq ?? 0);
  await host.ack(tail.at(-1)?.seq ?? events.at(-1)?.seq ?? 0);
  await host.releaseThread("server-1", "thread-1");
});
