import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import WebSocket from "ws";

import { startLocalAgentHost } from "../apps/local-agent-host/src/main.js";
import {
  ModelConfigurationRepository,
  ModelCredentialRepository,
} from "../apps/local-agent-host/src/model-config/repository.js";

const root = await mkdtemp(join(tmpdir(), "opencraft-projectless-smoke-"));
const modelDirectory = join(root, "models");
const projectlessRoot = join(root, "OpenCraft");
await new ModelCredentialRepository(modelDirectory).set("FIXTURE_KEY", "synthetic-only");
await new ModelConfigurationRepository(modelDirectory).initialize({
  schemaVersion: 1,
  revision: 0,
  providers: [{
    id: "fixture-provider",
    name: "Fixture",
    protocol: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    credentialRef: "FIXTURE_KEY",
    enabled: true,
    models: [{ id: "fixture", enabled: true }],
  }],
  defaultModel: { providerId: "fixture-provider", modelId: "fixture" },
});

const host = await startLocalAgentHost({
  dataDirectory: join(root, "runtime"),
  modelStorageDirectory: modelDirectory,
  projectlessWorkspaceDirectory: projectlessRoot,
  dshExecutable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
});
const socket = new WebSocket(host.websocketUrl);
const pending = new Map<string, {
  resolve(value: any): void;
  reject(error: Error): void;
}>();
let sequence = 0;

const request = (method: string, params: unknown = {}): Promise<any> => {
  const id = `projectless-smoke:${++sequence}`;
  return new Promise((resolveRequest, reject) => {
    pending.set(id, { resolve: resolveRequest, reject });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
};

try {
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as any;
    const operation = pending.get(frame.id);
    if (operation === undefined) return;
    pending.delete(frame.id);
    if (frame.error) operation.reject(new Error(frame.error.message));
    else operation.resolve(frame.result);
  });

  await request("initialize", {
    clientInfo: { name: "projectless-smoke", version: "1" },
    capabilities: { experimentalApi: true },
  });
  const model = (await request("model/list")).data[0].model;
  const started = await request("thread/start", {
    model,
    dynamicTools: [{
      type: "function",
      name: "fixture_host_tool",
      description: "Fixture Host tool",
      inputSchema: { type: "object", properties: {} },
    }],
  });
  const canonicalRoot = await realpath(projectlessRoot);
  assert.equal(started.thread.cwd.startsWith(`${canonicalRoot}/thread-`), true);
  assert.equal((await stat(started.thread.cwd)).isDirectory(), true);
  assert.deepEqual(started.runtimeWorkspaceRoots, [started.thread.cwd]);
  console.log(JSON.stringify({
    result: "passed",
    projectlessRoot: canonicalRoot,
    cwd: started.thread.cwd,
    dynamicToolsMounted: true,
  }));
} finally {
  for (const operation of pending.values()) operation.reject(new Error("Smoke closed"));
  pending.clear();
  socket.close();
  await host.close();
  await rm(root, { recursive: true, force: true });
}
