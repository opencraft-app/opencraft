import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = await mkdtemp(resolve(tmpdir(), "opencraft-smoke-"));
// This command tests the bundled dependency, never an already running server.
delete process.env.OPENCRAFT_DSH_URL;
delete process.env.OPENCRAFT_DSH_REPOSITORY;
let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined;
let socket: WebSocket | undefined;
async function request(id: number, method: string, params: Record<string, unknown> = {}) {
  const client = socket!;
  return new Promise<any>((resolveResponse, reject) => {
    const timeout = setTimeout(() => {
      client.off("message", listener);
      reject(new Error(`AppServer ${method} timed out`));
    }, 15_000);
    const listener = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString());
      if (frame.id !== id) return;
      clearTimeout(timeout);
      client.off("message", listener);
      if (frame.error) reject(new Error(`AppServer ${method}: ${frame.error.message}`));
      else resolveResponse(frame.result);
    };
    client.on("message", listener);
    client.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}
try {
  host = await startLocalAgentHost({
    dshExecutable: resolve(root, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    dataDirectory,
  });
  socket = new WebSocket(host.websocketUrl);
  await new Promise<void>((resolveOpen, reject) => {
    socket!.once("open", resolveOpen);
    socket!.once("error", reject);
  });
  const initialized = await request(1, "initialize");
  assert.equal(typeof initialized.codexHome, "string");
  const threads = await request(2, "thread/list");
  assert.ok(Array.isArray(threads.data));
  assert.equal(threads.data.length, 0, "Smoke host must not reuse existing session data");
  const before = await request(3, "runtime/settings/describe");
  const defaults = before.namespaces.find((entry: any) => entry.ns === "agent-default-model").value;
  let id = 4;
  for (const api of ["openai-completions", "openai-responses"]) {
    const directory = await request(id++, "runtime/providers/list");
    assert.ok(directory.creation.apis.includes(api));
    const saved = await request(id++, "runtime/providers/apply", {
      target: { kind: "create", id: `smoke-${api}` }, expectedRevision: directory.creation.revision,
      displayName: `Smoke ${api}`, baseURL: "http://127.0.0.1:1/v1", api,
      models: [{ id: `smoke-model-${api}`, contextWindow: 8192, maxTokens: 1024 }],
      credential: { kind: "replace", value: "synthetic-smoke-key-not-a-real-secret" },
    });
    assert.equal(saved.saved, true);
    const disabled = await request(id++, "runtime/providers/list");
    const connection = disabled.providers.find((entry: any) => entry.provider === `smoke-${api}`);
    assert.equal(connection.configured, true);
    assert.equal(connection.enabled, false);
    assert.equal(connection.active, false);
    await request(id++, "runtime/providers/setEnabled", { provider: `smoke-${api}`, enabled: true, expectedRevision: saved.revision });
    const enabledDirectory = await request(id++, "runtime/providers/list");
    const stopped = await request(id++, "runtime/providers/setEnabled", { provider: `smoke-${api}`, enabled: false, expectedRevision: enabledDirectory.creation.revision });
    const stoppedDirectory = await request(id++, "runtime/providers/list");
    const retained = stoppedDirectory.providers.find((entry: any) => entry.provider === `smoke-${api}`);
    assert.equal(retained.configured, true);
    assert.equal(retained.active, false);
    const stoppedModels = await request(id++, "runtime/models/list");
    assert.equal(stoppedModels.groups.some((group: any) => group.id === `smoke-${api}`), false);
    await request(id++, "runtime/providers/setEnabled", { provider: `smoke-${api}`, enabled: true, expectedRevision: stopped.revision });
  }
  const models = await request(id++, "runtime/models/list");
  for (const api of ["openai-completions", "openai-responses"]) {
    assert.ok(models.groups.find((group: any) => group.id === `smoke-${api}`)?.models.some((model: any) => model.id === `smoke-model-${api}`));
  }
  const after = await request(id++, "runtime/settings/describe");
  assert.deepEqual(after.namespaces.find((entry: any) => entry.ns === "agent-default-model").value, defaults);
  assert.equal(JSON.stringify(after).includes("synthetic-smoke-key-not-a-real-secret"), false);
  const nativeRevision = () => request(id++, "runtime/settings/describe").then((settings: any) => settings.namespaces.find((entry: any) => entry.ns === "llm-deepseek").revision);
  await assert.rejects(request(id++, "runtime/providers/setEnabled", { provider: "deepseek-official", enabled: false, expectedRevision: await nativeRevision() }), /default model/);
  const defaultRevision = after.namespaces.find((entry: any) => entry.ns === "agent-default-model").revision;
  await request(id++, "runtime/settings/mutate", { ns: "agent-default-model", expectedRevision: defaultRevision, ops: [
    { op: "set", path: ["provider"], value: "smoke-openai-completions" }, { op: "set", path: ["model"], value: "smoke-model-openai-completions" },
  ] });
  await request(id++, "runtime/providers/apply", { target: { kind: "update", id: "deepseek-official" }, expectedRevision: await nativeRevision(), baseURL: "", enabled: false, credential: { kind: "none" } });
  await assert.rejects(request(id++, "runtime/providers/setEnabled", { provider: "deepseek-official", enabled: true, expectedRevision: await nativeRevision() }), /authentication/);
  await request(id++, "runtime/providers/apply", { target: { kind: "update", id: "deepseek-official" }, expectedRevision: await nativeRevision(), baseURL: "",
    credential: { kind: "replace", value: "synthetic-native-key" } });
  await request(id++, "runtime/providers/setEnabled", { provider: "deepseek-official", enabled: true, expectedRevision: await nativeRevision() });
  const nativeBefore = await request(id++, "runtime/settings/describe");
  const nativeConfig = nativeBefore.namespaces.find((entry: any) => entry.ns === "llm-deepseek").value;
  await request(id++, "runtime/providers/setEnabled", { provider: "deepseek-official", enabled: false, expectedRevision: await nativeRevision() });
  const nativeDisabled = (await request(id++, "runtime/providers/list")).providers.find((entry: any) => entry.provider === "deepseek-official");
  assert.equal(nativeDisabled.configuration.canToggle, true);
  assert.equal(nativeDisabled.enabled, false); assert.equal(nativeDisabled.active, false);
  assert.equal((await request(id++, "runtime/models/list")).groups.some((group: any) => group.id === "deepseek-official"), false);
  await request(id++, "runtime/models/setEnabled", { provider: "smoke-openai-responses", model: "smoke-model-openai-responses", enabled: false,
    expectedRevision: after.namespaces.find((entry: any) => entry.ns === "llm-pi-ai").revision });
  socket.terminate();
  await host.close();
  host = await startLocalAgentHost({ dshExecutable: resolve(root, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"), dataDirectory });
  socket = new WebSocket(host.websocketUrl);
  await new Promise<void>((resolveOpen, reject) => { socket!.once("open", resolveOpen); socket!.once("error", reject); });
  const restored = await request(id++, "runtime/models/list");
  assert.ok(restored.groups.some((group: any) => group.id === "smoke-openai-responses"));
  assert.equal(restored.groups.find((group: any) => group.id === "smoke-openai-responses").models.length, 0);
  const managed = await request(id++, "runtime/models/list", { includeDisabled: true });
  assert.equal(managed.groups.find((group: any) => group.id === "smoke-openai-responses").models[0].enabled, false);
  const nativeRestored = (await request(id++, "runtime/providers/list")).providers.find((entry: any) => entry.provider === "deepseek-official");
  assert.equal(nativeRestored.active, false); assert.equal(nativeRestored.enabled, false);
  assert.ok(managed.groups.find((group: any) => group.id === "deepseek-official").models.length > 0);
  const nativeAfter = (await request(id++, "runtime/settings/describe")).namespaces.find((entry: any) => entry.ns === "llm-deepseek").value;
  assert.deepEqual(nativeAfter.models, nativeConfig.models);
  assert.equal(nativeAfter.apiKeyEnv, nativeConfig.apiKeyEnv);
  assert.equal((await request(id++, "runtime/credentials/describe", { refs: [nativeAfter.apiKeyEnv] })).credentials[nativeAfter.apiKeyEnv].configured, true);
  await request(id++, "runtime/providers/setEnabled", { provider: "deepseek-official", enabled: true, expectedRevision: await nativeRevision() });
  assert.equal((await request(id++, "runtime/providers/list")).providers.find((entry: any) => entry.provider === "deepseek-official").active, true);
  const restoreSettings = await request(id++, "runtime/settings/describe");
  await request(id++, "runtime/settings/mutate", { ns: "agent-default-model", expectedRevision: restoreSettings.namespaces.find((entry: any) => entry.ns === "agent-default-model").revision, ops: [
    { op: "set", path: ["provider"], value: defaults.provider }, { op: "set", path: ["model"], value: defaults.model },
  ] });
  assert.deepEqual((await request(id++, "runtime/settings/describe")).namespaces.find((entry: any) => entry.ns === "agent-default-model").value, defaults);
  console.log("Native provider parity passed: default and credential guards, unregister, disabled restart, preserved catalog/credential, re-enable.");
  console.log("Local Agent smoke passed: real DSH → AppServer → WebSocket, both custom protocols registered, restart persistence, unchanged defaults, no external model request.");
} finally {
  socket?.terminate();
  await host?.close();
  await rm(dataDirectory, { recursive: true, force: true });
}
