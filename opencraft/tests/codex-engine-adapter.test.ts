import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { OPENCRAFT_THREAD_START_DURABILITY_EXTENSION } from "@opencraft/appserver-protocol";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.js";

function waitFor(frames: Array<Record<string, unknown>>, predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const existing = frames.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for Codex adapter frame")), 2_000);
    const poll = () => {
      const found = frames.find(predicate);
      if (found) { clearTimeout(timeout); resolve(found); return; }
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("Codex Engine shares one physical initialize and restores logical client routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-engine-"));
  const nativeCodexHomeDirectory = join(root, "native-codex");
  const accessToken = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    email: "native@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "chatgpt-native" },
  })).toString("base64url")}.signature`;
  await mkdir(nativeCodexHomeDirectory, { recursive: true });
  await writeFile(join(nativeCodexHomeDirectory, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: accessToken, refresh_token: "refresh-native", account_id: "chatgpt-native" },
  }));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = new CodexEngineAdapter({
    executable: process.execPath,
    runtimeDirectory: root,
    dataDirectory: join(root, "data"),
    nativeCodexHomeDirectory,
    upstreamBaseUrl: "http://127.0.0.1:9/backend-api/codex",
    fetch: async input => String(input).includes("/wham/usage")
      ? Response.json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } } })
      : Response.json({ ok: true }),
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath, [new URL("./fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }),
    createMaintenanceClient: async () => { throw new Error("not used"); },
  });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  try {
    await adapter.connect();
    await Promise.all([
      adapter.send(JSON.stringify({ id: "a:init", method: "initialize", params: { clientInfo: { name: "a", version: "1" } }, [LOGICAL_CLIENT_FIELD]: "client-a" })),
      adapter.send(JSON.stringify({ id: "b:init", method: "initialize", params: { clientInfo: { name: "b", version: "1" } }, [LOGICAL_CLIENT_FIELD]: "client-b" })),
    ]);
    const first = await waitFor(frames, frame => frame.id === "a:init");
    const second = await waitFor(frames, frame => frame.id === "b:init");
    assert.equal(first[LOGICAL_CLIENT_FIELD], "client-a");
    assert.equal(second[LOGICAL_CLIENT_FIELD], "client-b");
    assert.equal((first.result as any).serverInfo.version, "1");
    assert.equal((second.result as any).serverInfo.version, "1");
    assert.deepEqual(
      (first.result as any).capabilities.extensions[OPENCRAFT_THREAD_START_DURABILITY_EXTENSION],
      { version: 1, durableAfter: "first-turn-accepted" },
    );

    await adapter.send(JSON.stringify({ id: "a:start", method: "thread/start", params: { cwd: root }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:start");
    const started = await waitFor(frames, frame => frame.method === "thread/started");
    assert.equal(started[LOGICAL_CLIENT_FIELD], "client-a");
    const serverRequest = await waitFor(frames, frame => frame.id === 900 && frame.method === "item/tool/requestUserInput");
    assert.equal(serverRequest[LOGICAL_CLIENT_FIELD], "client-a");
    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const resolved = await waitFor(frames, frame => frame.method === "serverRequest/resolved");
    assert.equal(resolved[LOGICAL_CLIENT_FIELD], "client-a");

    await adapter.send(JSON.stringify({ id: "b:accounts", method: "opencraft/codex/accounts/list", params: {}, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const accounts = await waitFor(frames, frame => frame.id === "b:accounts");
    assert.equal(accounts[LOGICAL_CLIENT_FIELD], "client-b");
    assert.deepEqual(accounts.result, { accounts: [] });

    await adapter.send(JSON.stringify({ id: "b:import", method: "opencraft/codex/accounts/import", params: {}, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const imported = await waitFor(frames, frame => frame.id === "b:import");
    assert.equal((imported.result as any).account.email, "native@example.com");
    assert.doesNotMatch(JSON.stringify(imported), /refresh-native|Bearer/);
    let refreshed: Record<string, any> | null = null;
    for (let attempt = 0; attempt < 20 && refreshed === null; attempt += 1) {
      const id = `b:accounts:${attempt}`;
      await adapter.send(JSON.stringify({ id, method: "opencraft/codex/accounts/list", params: {}, [LOGICAL_CLIENT_FIELD]: "client-b" }));
      const listed = await waitFor(frames, frame => frame.id === id);
      if ((listed.result as any).accounts[0]?.subscriptionType === "pro") refreshed = listed as Record<string, any>;
      else await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((refreshed?.result as any).accounts[0].subscriptionType, "pro");
    assert.equal((refreshed?.result as any).accounts[0].limitWindows[0].utilization, 0.1);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("enabling a Codex account returns before background subscription usage refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-enable-"));
  const dataDirectory = join(root, "data");
  const store = new AccountPoolStore({
    databasePath: join(dataDirectory, "account-pool.sqlite"),
    secretsDirectory: join(dataDirectory, "secrets"),
  });
  store.addAccount({
    id: "account-a",
    provider: "codex",
    label: "A",
    upstreamAccountId: "chatgpt-a",
    priority: 1,
    enabled: false,
  }, { accessToken: "access-a", refreshToken: "refresh-a", expiresAt: null });
  store.close();
  let releaseUsage!: (response: Response) => void;
  const usage = new Promise<Response>(resolve => { releaseUsage = resolve; });
  const frames: Array<Record<string, unknown>> = [];
  const adapter = new CodexEngineAdapter({
    executable: process.execPath,
    runtimeDirectory: root,
    dataDirectory,
    nativeCodexHomeDirectory: join(root, "native-codex"),
    upstreamBaseUrl: "http://127.0.0.1:9/backend-api/codex",
    fetch: async input => String(input).includes("/wham/usage") ? usage : Response.json({ ok: true }),
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath, [new URL("./fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }),
    createMaintenanceClient: async () => { throw new Error("not used"); },
  });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  try {
    await adapter.connect();
    await adapter.send(JSON.stringify({
      id: "enable",
      method: "opencraft/codex/accounts/setEnabled",
      params: { accountId: "account-a", enabled: true },
      [LOGICAL_CLIENT_FIELD]: "client-a",
    }));
    const response = await waitFor(frames, frame => frame.id === "enable");
    assert.equal((response.result as any).accounts[0].enabled, true);
    assert.equal((response.result as any).accounts[0].status, "ready");
  } finally {
    releaseUsage(Response.json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 5 } } }));
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});
