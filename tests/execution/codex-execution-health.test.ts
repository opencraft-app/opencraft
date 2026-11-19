import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { realpath, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import { startCodexAppServer } from "../../apps/codex-core/src/app-server.js";
import { nativeOwnerRequest } from "../../apps/codex-core/src/native-process.js";

test("execution health detects a failed executor while the Native owner and history stay readable", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "oc-exec-health-"));
  const token = "synthetic-execution-health-token-".repeat(2);
  const core = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({
    dataDirectory: join(root, "data"), launch: {args: ['chatgpt_base_url="http://127.0.0.1:1"'],
      env: {OPENCRAFT_CODEX_POOL_AUTH_TOKEN: "synthetic"}, auth: {type: "chatgptAuthTokens", accessToken: "synthetic", chatgptAccountId: "fixture"}},
  })); });
  let runtime: Awaited<ReturnType<typeof startCodexAppServer>> | undefined;
  let socket: WebSocket | undefined;
  try {
    await mkdir(join(root, "data"));
    await new Promise<void>(resolve => core.listen(join(root, "accounts.sock"), resolve));
    const configuration = join(root, "sandbox.json");
    await writeFile(configuration, JSON.stringify({schemaVersion: 1, backend: {id: "remote-test", options: {}},
      pool: {idPrefix: "fixture"}, environment: {mode: "selected", names: []}}), {mode: 0o600});
    runtime = await startCodexAppServer({endpoint: join(root, "app/control.sock"), coreEndpoint: join(root, "accounts.sock"),
      dataDirectory: join(root, "data"), runtimeDirectory: root, authToken: token, executable: process.execPath,
      executionSandbox: {configuration, runner: join(root, "unused-runner.mjs")},
      spawnAppServer: ({args, cwd, env}) => spawn(process.execPath, [new URL("../fixtures/fake-codex-unix-appserver.mjs", import.meta.url).pathname,
        args[2]!.slice("unix://".length)], {cwd, env, stdio: ["pipe", "pipe", "pipe"]})});
    const client = new CodexCoreControlClient(join(root, "app/control.sock"), token);
    const before = await client.appServerHealth();
    socket = new WebSocket(`ws+unix://${before.nativeSocket}:/`);
    await new Promise<void>((resolve, reject) => {socket!.once("open", resolve); socket!.once("error", reject);});
    await nativeOwnerRequest(socket, "initialize", {clientInfo: {name: "fixture", version: "1"}});
    const {thread} = await nativeOwnerRequest(socket, "thread/start", {cwd: root}) as {thread: {id: string}};
    for (const status of ["disconnected", "pending", "unknown"]) {
      await nativeOwnerRequest(socket, "fixture/executionStatus", {status});
      await assert.rejects(client.appServerHealth(), /unavailable/i);
      assert.equal((await client.appServerHealth("native")).codexPid, before.codexPid);
      const result = await nativeOwnerRequest(socket, "thread/read", {threadId: thread.id}) as {thread: {id: string}};
      assert.equal(result.thread.id, thread.id);
    }
    await nativeOwnerRequest(socket, "fixture/executionStatus", {status: "ready"});
    assert.equal((await client.appServerHealth()).codexPid, before.codexPid);
  } finally {
    socket?.terminate(); await runtime?.close();
    await new Promise<void>(resolve => core.close(() => resolve()));
    await rm(root, {recursive: true, force: true});
  }
});
