import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { AbsentDshClient } from "../../apps/local-agent-host/src/dsh-absent-client.js";
import { DshSupervisor } from "../../apps/local-agent-host/src/dsh-supervisor.js";
import { startLocalAgentHost } from "../../apps/local-agent-host/src/main.js";

// OpenCraft bridges DSH but does not distribute it. A host without an
// installed runtime still starts and serves its other engines.
test("DSH availability is a probe, not a start", async () => {
  const missing = new DshSupervisor({ executable: "/nonexistent/dsh/lib/bin.js" });
  assert.equal(await missing.available(), false);
  await assert.rejects(missing.start(), /DSH runtime is missing/);
});

test("the absent client answers initialization reads and refuses everything else", async () => {
  const client = new AbsentDshClient({} as never);
  assert.deepEqual(await client.call("session.list"), { items: [] });
  assert.deepEqual(await client.call("llm.models"), { groups: [], failures: [] });
  await assert.rejects(
    client.call("session.create"),
    (error: any) => error.code === "DSH_UNAVAILABLE" && /not installed/.test(error.message),
  );
  const abort = new AbortController();
  let opened = false;
  const stream = client.stream(
    "/api/events.mux",
    () => assert.fail("no native frames"),
    abort.signal,
    () => {
      opened = true;
    },
  );
  assert.equal(opened, true);
  abort.abort();
  await stream;
});

test("a local host without DSH starts, initializes and reports DSH threads as not installed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oc-host-no-dsh-"));
  const previous = { url: process.env.OPENCRAFT_DSH_URL, repository: process.env.OPENCRAFT_DSH_REPOSITORY };
  delete process.env.OPENCRAFT_DSH_URL;
  delete process.env.OPENCRAFT_DSH_REPOSITORY;
  const host = await startLocalAgentHost({
    dataDirectory: directory,
    modelStorageDirectory: join(directory, "models"),
    runtimeDirectory: join(directory, "runtime"),
    dshExecutable: join(directory, "missing/dsh/lib/bin.js"),
  });
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const value = new WebSocket(host.websocketUrl);
    value.once("open", () => resolve(value));
    value.once("error", reject);
  });
  t.after(async () => {
    socket.close();
    await host.close();
    await rm(directory, { recursive: true, force: true });
    if (previous.url !== undefined) process.env.OPENCRAFT_DSH_URL = previous.url;
    if (previous.repository !== undefined) process.env.OPENCRAFT_DSH_REPOSITORY = previous.repository;
  });
  let id = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const current = ++id;
      const listener = (data: WebSocket.RawData) => {
        const frame = JSON.parse(data.toString());
        if (frame.id !== current) return;
        socket.off("message", listener);
        frame.error === undefined ? resolve(frame.result) : reject(frame.error);
      };
      socket.on("message", listener);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }));
    });
  assert.ok(await request("initialize", {}));
  assert.deepEqual(
    (await request("thread/list", {})).data.filter(
      (thread: any) => !/^(codex|claude|cursor|codebuddy|pi)/.test(thread.id),
    ),
    [],
  );
  // Only connected agents on this computer contribute models; DSH offers none.
  assert.ok((await request("model/list", {})).data.every((model: any) => typeof model.agentId === "string"));
  assert.deepEqual((await request("runtime/models/list", {})).groups, []);
  // No DSH model exists to start a thread with, and the runtime reports DSH as missing.
  await assert.rejects(request("thread/start", {}));
  assert.equal((await request("runtime/status/read", {})).version, "not installed");
});

// Model configuration is owned by model storage, not by DSH: Pi and Codex read the same models.json, so a host
// without DSH (the default container image) still lets users add providers and save keys.
test("a host without DSH still owns model configuration: providers apply and keys are saved", async (t) => {
  const { ModelConfigurationRepository, ModelCredentialRepository } = await import("../../apps/local-agent-host/src/model-config/repository.js");
  const { fileStateDocumentStore } = await import("@opencraft/document-storage/state-file");
  const { fileSecretStore } = await import("@opencraft/secret-storage/file");
  const directory = await mkdtemp(join(tmpdir(), "oc-host-no-dsh-models-"));
  const previous = { url: process.env.OPENCRAFT_DSH_URL, repository: process.env.OPENCRAFT_DSH_REPOSITORY, caller: process.env.OPENCRAFT_PROXY_CALLER_FILE };
  delete process.env.OPENCRAFT_DSH_URL;
  delete process.env.OPENCRAFT_DSH_REPOSITORY;
  delete process.env.OPENCRAFT_PROXY_CALLER_FILE;
  const models = join(directory, "models");
  const host = await startLocalAgentHost({
    dataDirectory: directory,
    modelStorageDirectory: models,
    runtimeDirectory: join(directory, "runtime"),
    dshExecutable: join(directory, "missing/dsh/lib/bin.js"),
  });
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const value = new WebSocket(host.websocketUrl);
    value.once("open", () => resolve(value));
    value.once("error", reject);
  });
  t.after(async () => {
    socket.close();
    await host.close();
    await rm(directory, { recursive: true, force: true });
    for (const [key, name] of [["url", "OPENCRAFT_DSH_URL"], ["repository", "OPENCRAFT_DSH_REPOSITORY"], ["caller", "OPENCRAFT_PROXY_CALLER_FILE"]] as const)
      if (previous[key] !== undefined) process.env[name] = previous[key];
  });
  let id = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const current = ++id;
      const listener = (data: WebSocket.RawData) => {
        const frame = JSON.parse(data.toString());
        if (frame.id !== current) return;
        socket.off("message", listener);
        frame.error === undefined ? resolve(frame.result) : reject(frame.error);
      };
      socket.on("message", listener);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }));
    });
  assert.ok(await request("initialize", {}));
  const settings = await request("runtime/settings/describe");
  assert.equal(settings.writable, true);
  assert.deepEqual(settings.namespaces.map((n: any) => n.ns).sort(), ["agent-default-model", "llm-deepseek", "llm-pi-ai"]);
  const listed = await request("runtime/providers/list");
  assert.equal(listed.application.state, "applied");
  const revision = listed.creation.revision;
  const saved = await request("runtime/providers/apply", {
    target: { kind: "create", id: "fake-upstream" }, expectedRevision: revision, displayName: "Fake upstream",
    baseURL: "https://models.example.invalid/v1", api: "openai-completions", models: [{ id: "fake-model" }],
    enabled: true, credential: { kind: "replace", value: "sk-dummy-key" },
  });
  assert.equal(saved.saved, true);
  assert.ok(saved.revision > revision);
  const document = await new ModelConfigurationRepository(fileStateDocumentStore(models)).read();
  const provider = document.providers.find(p => p.id === "fake-upstream");
  assert.ok(provider?.enabled);
  assert.deepEqual(provider.models.map(m => [m.id, m.enabled]), [["fake-model", true]]);
  assert.equal(await new ModelCredentialRepository(fileSecretStore(models)).resolve(provider.credentialRef!), "sk-dummy-key",
    "the key is stored once in the model credential owner that Pi and Codex resolve");
  // A standalone key write (rotate) also reaches the same owner, and the settings surface reports it configured.
  await request("runtime/credentials/set", { ref: provider.credentialRef, value: "sk-rotated" });
  assert.equal(await new ModelCredentialRepository(fileSecretStore(models)).resolve(provider.credentialRef!), "sk-rotated");
  assert.equal((await request("runtime/credentials/describe", { refs: [provider.credentialRef] })).credentials[provider.credentialRef!].configured, true);
  const after = await request("runtime/providers/list");
  assert.equal(after.application.state, "applied");
  assert.ok(after.providers.some((p: any) => p.provider === "fake-upstream"));
  assert.deepEqual((await request("runtime/models/list", {})).groups.map((g: any) => [g.id, g.models.map((m: any) => m.id)]), [["fake-upstream", ["fake-model"]]]);
  // The product default model can be chosen for Pi/Codex, but DSH offers no execution models it cannot run.
  await request("runtime/settings/mutate", { ns: "agent-default-model", expectedRevision: (await request("runtime/settings/describe")).namespaces
    .find((n: any) => n.ns === "agent-default-model").revision, ops: [{ op: "set", path: ["provider"], value: "fake-upstream" }, { op: "set", path: ["model"], value: "fake-model" }] });
  assert.deepEqual((await new ModelConfigurationRepository(fileStateDocumentStore(models)).read()).defaultModel, { providerId: "fake-upstream", modelId: "fake-model" });
  assert.deepEqual((await request("model/list", {})).data.filter((m: any) => !String(m.groupKey).startsWith("connected-agent:")), [],
    "only connected agents (not the absent DSH) list execution models");
  // DSH threads still report the missing runtime; model configuration never pretends DSH is installed.
  assert.equal((await request("runtime/status/read", {})).version, "not installed");
});
