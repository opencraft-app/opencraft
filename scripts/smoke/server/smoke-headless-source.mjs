#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { startHeadlessServer } from "../../headless-server.mjs";
import { smokeCodexAppHost } from "./smoke-headless-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporary = await mkdtemp(join(tmpdir(), "opencraft-headless-source-"));
const priorDshUrl = process.env.OPENCRAFT_DSH_URL;
delete process.env.OPENCRAFT_DSH_URL;
let server;
let socket;

function rpc(id, method) {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
    const receive = (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.id !== id) return;
      clearTimeout(timeout);
      socket.off("message", receive);
      if (frame.error) reject(new Error(`${method}: ${frame.error.message}`));
      else resolvePromise(frame.result);
    };
    socket.on("message", receive);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }));
  });
}

try {
  server = await startHeadlessServer({
    root,
    webRoot: join(root, "apps/workbench-web/dist"),
    dshCapabilityPlugin: join(root, "apps/local-agent-host/src/dsh-capability-plugin.mjs"),
    codexExecutable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex",
    dataDirectory: join(temporary, "data"),
    port: 0,
  });
  const healthResponse = await fetch(`${server.url}/__opencraft_health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.appServerConfigured, true);
  assert.ok(Array.isArray(health.storage) && health.storage.length > 0,
    "Headless startup must report its opened storage owners");
  for (const storage of health.storage) {
    assert.equal(storage.movedAside, false, `Unexpected storage recovery: ${storage.name}`);
  }
  assert.match(await fetch(server.url).then((response) => response.text()), /opencraft-build-id/u);
  socket = new WebSocket(`${server.url.replace(/^http/u, "ws")}/appserver`, { origin: server.url });
  await new Promise((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
  const initialized = await rpc(1, "initialize");
  assert.equal(typeof initialized.codexHome, "string");
  const threads = await rpc(2, "thread/list");
  assert.deepEqual(threads.data, []);
  await smokeCodexAppHost(server.url, null, {
    expectQueueSteer: process.env.OPENCRAFT_CODEX_EXPECT_QUEUE_STEER === "1",
  });
  process.stdout.write("Headless source smoke passed: WebUI, DSH and Codex AppServers are reachable\n");
} finally {
  socket?.terminate();
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
  if (priorDshUrl !== undefined) process.env.OPENCRAFT_DSH_URL = priorDshUrl;
}
