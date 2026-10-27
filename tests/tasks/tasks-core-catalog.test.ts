import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import { startCodexCore } from "../../apps/codex-core/src/main";
import { CodexNativeCoreTransport } from "../../apps/opencraft-daemon/src/codex-native-core-transport";
import { readTaskCoreConversations } from "../../scripts/tasks-conversation-catalog.mjs";
import { startIndependentDshHost } from "../../scripts/server-deployment/dsh-host.mjs";

test("split Tasks catalog reads the existing Core, strips history, and leaves its process and other clients alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-tasks-core-"));
  const token = "synthetic-task-catalog-core-token";
  const core = await startCodexCore({
    endpoint: join(root, "control.sock"), authToken: token,
    executable: process.execPath, runtimeDirectory: root,
    dataDirectory: join(root, "data"), nativeCodexHomeDirectory: join(root, "native"),
    spawnAppServer: ({ args, cwd, env }) => spawn(process.execPath,
      [new URL("../fixtures/fake-codex-unix-appserver.mjs", import.meta.url).pathname, args[2]!.slice("unix://".length)],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] }),
  });
  const control = new CodexCoreControlClient(core.endpoint, token);
  const client = new JsonRpcAppServerClient({ hostId: "fixture", transport: new CodexNativeCoreTransport(core.endpoint, token) });
  try {
    await client.connect({ clientInfo: { name: "tasks-catalog-test", version: "1" } });
    const { thread } = await client.request("thread/start", { cwd: root });
    const before = await control.health();
    assert.deepEqual(await readTaskCoreConversations(core.endpoint, token, "", 20), {
      conversations: [{ serverId: "local-codex", threadId: thread.id, title: thread.id }], nextCursor: null,
    });
    assert.deepEqual(await control.health(), before);
    assert.equal((await client.request("thread/read", { threadId: thread.id, includeTurns: false })).thread.id, thread.id);
    await assert.rejects(readTaskCoreConversations(core.endpoint, "wrong", "", 20));
    assert.deepEqual(await control.health(), before);
  } finally { await client.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test("independent Task catalog rejects incomplete or non-private Core credentials before engine startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-tasks-core-private-"));
  const tokenPath = join(root, "token");
  const options = { descriptorPath: join(root, "descriptor.json"), dataDirectory: join(root, "agent"), taskCodexCoreEndpoint: join(root, "control.sock") };
  try {
    await assert.rejects(startIndependentDshHost(options), /explicit absolute connection paths/);
    await writeFile(tokenPath, "synthetic-token", { mode: 0o600 });
    await chmod(tokenPath, 0o644);
    await assert.rejects(startIndependentDshHost({ ...options, taskCodexCoreTokenFile: tokenPath }), /owned private token/);
    await assert.rejects(access(join(root, "agent/tasks.sqlite")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
