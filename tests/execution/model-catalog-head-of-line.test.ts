import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";
import { MessagePortAppHostClient } from "@opencraft/app-host-client";
import { AppHostServer } from "@opencraft/app-host-server";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";

for (const method of ["model/list", "thread/list"] as const) test(`${method} reaches Codex while an earlier Turn is preparing its tools`, { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-head-of-line-"));
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const adapter = new CodexEngineAdapter({
    executable: process.execPath, runtimeDirectory: root, dataDirectory: join(root, "data"),
    nativeCodexHomeDirectory: join(root, "empty-home"),
    upstreamBaseUrl: "http://127.0.0.1:9/synthetic-only",
    fetch: async () => Response.json({ ok: true }),
    createMaintenanceClient: async () => { throw new Error("not used"); },
    logDiagnostic: () => undefined,
    sessionMcp: async () => { entered(); await hold; return null; },
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath,
      [new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname],
      { cwd, env: { CODEX_HOME: env.CODEX_HOME, OPENCRAFT_TEST_AUTO_TITLES: "1" }, stdio: ["pipe", "pipe", "pipe"] }),
  });
  const server = new AppHostServer({ logicalClientRouting: true, createTransport: () => adapter });
  const { port1, port2 } = new MessageChannel();
  server.accept({ postMessage: value => port1.postMessage(value), subscribe(listener) {
    port1.on("message", listener); return () => port1.off("message", listener);
  }, start: () => port1.start(), close: () => port1.close() }, "catalog-test");
  const host = new MessagePortAppHostClient(port2, "catalog-test");
  const client = new JsonRpcAppServerClient({ hostId: "local-codex", transport: host.createTransport("local-codex") });
  let turn: Promise<unknown> | undefined;
  try {
    await client.connect({ clientInfo: { name: "catalog-test", version: "1" } });
    const started = await client.request("thread/start", { testNoServerRequest: true } as never);
    turn = client.request("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "synthetic" }] });
    await preparing;
    const catalog = await client.request(method, {}, { timeoutMs: 500 });
    assert.ok(Array.isArray(catalog.data));
    if (method === "model/list") assert.ok(catalog.data.length > 0);
    release();
    await turn;
  } finally {
    release(); await turn?.catch(() => {});
    await client.close(); host.close(); await server.close();
    port1.close(); port2.close(); await rm(root, { recursive: true, force: true });
  }
});
