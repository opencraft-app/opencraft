import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { OPENCRAFT_THREAD_LIFECYCLE_EXTENSION, OPENCRAFT_THREAD_QUEUE_EXTENSION, OPENCRAFT_THREAD_START_DURABILITY_EXTENSION, OPENCRAFT_PERMISSION_MODES_EXTENSION } from "@opencraft/appserver-protocol";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { CodexHostQueue } from "../apps/opencraft-daemon/src/codex-host-queue.js";

function waitFor(frames: Array<Record<string, unknown>>, predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const existing = frames.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => { settled = true; reject(new Error("Timed out waiting for Codex adapter frame")); }, 2_000);
    const poll = () => {
      if (settled) return;
      const found = frames.find(predicate);
      if (found) { settled = true; clearTimeout(timeout); resolve(found); return; }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function createRoutingAdapter(root: string, frames: Array<Record<string, unknown>>, nativeQueueSteerVersion: 0 | 1 | 2 = 0, steerResponse?: string, nativeSubscriptionGraceMs?: number): CodexEngineAdapter {
  const adapter = new CodexEngineAdapter({
    executable: process.execPath,
    runtimeDirectory: root,
    dataDirectory: join(root, "data"),
    nativeCodexHomeDirectory: join(root, "native-codex"),
    upstreamBaseUrl: "http://127.0.0.1:9/backend-api/codex",
    fetch: async () => Response.json({ ok: true }),
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath, [new URL("./fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname], { cwd, env: { ...env, ...(nativeQueueSteerVersion ? { OPENCRAFT_TEST_NATIVE_QUEUE_STEER: String(nativeQueueSteerVersion) } : {}), ...(steerResponse ? { OPENCRAFT_TEST_STEER_RESPONSE: steerResponse } : {}) }, stdio: ["pipe", "pipe", "pipe"] }),
    createMaintenanceClient: async () => { throw new Error("not used"); },
    logDiagnostic: () => undefined,
    nativeSubscriptionGraceMs,
  });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  return adapter;
}

async function initializeClient(adapter: CodexEngineAdapter, frames: Array<Record<string, unknown>>, clientId: string): Promise<void> {
  await adapter.send(JSON.stringify({ id: `${clientId}:init`, method: "initialize", params: {}, [LOGICAL_CLIENT_FIELD]: clientId }));
  await waitFor(frames, frame => frame.id === `${clientId}:init`);
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
  const diagnostics: Array<Record<string, unknown>> = [];
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
    logDiagnostic: event => diagnostics.push(event),
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
    assert.deepEqual(
      (first.result as any).capabilities.extensions[OPENCRAFT_THREAD_LIFECYCLE_EXTENSION],
      { version: 1, fork: true, ephemeral: true, injectItems: true, rename: true, archive: true, unsubscribe: true },
    );
    assert.deepEqual((first.result as any).capabilities.extensions[OPENCRAFT_THREAD_QUEUE_EXTENSION],
      { version: 2, reorder: true, atomicSteer: true, unconfirmedSteerDiscard: true, perItemPause: false });

    await adapter.send(JSON.stringify({ id: "a:start", method: "thread/start", params: { cwd: root }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:start");
    const started = await waitFor(frames, frame => frame.method === "thread/started");
    assert.equal(started[LOGICAL_CLIENT_FIELD], "client-a");
    await adapter.send(JSON.stringify({ id: "a:interrupt", method: "turn/interrupt", params: {
      threadId: "thread-a", turnId: "turn-a", prompt: "must not be logged",
    }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-b" }));
    assert.ok(diagnostics.some(event => event.event === "appserver-start" && typeof event.pid === "number"));
    assert.deepEqual(diagnostics.find(event => event.event === "turn-interrupt"), {
      component: "codex-engine-adapter", at: diagnostics.find(event => event.event === "turn-interrupt")?.at,
      event: "turn-interrupt", clientId: "client-a", requestId: "opencraft:3",
      threadId: "thread-a", turnId: "turn-a", pid: diagnostics.find(event => event.event === "appserver-start")?.pid,
    });
    assert.ok(diagnostics.some(event => event.event === "client-disconnect" && event.clientId === "client-b"));
    assert.ok(diagnostics.some(event => event.event === "client-initialize" && event.clientId === "client-a" && event.outcome === "succeeded"));
    assert.doesNotMatch(JSON.stringify(diagnostics), /must not be logged/);
    const serverRequest = await waitFor(frames, frame => frame.id === 900 && frame.method === "item/tool/requestUserInput");
    assert.equal(serverRequest[LOGICAL_CLIENT_FIELD], "client-a");
    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const resolved = await waitFor(frames, frame => frame.method === "serverRequest/resolved");
    assert.equal(resolved[LOGICAL_CLIENT_FIELD], "client-a");
    await adapter.send(JSON.stringify({ id: "a:resume", method: "thread/resume", params: { threadId: "codex-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:resume");
    assert.ok(diagnostics.some(event => event.event === "thread-resume-start" && event.clientId === "client-a" && event.threadId === "codex-thread-1"));
    assert.ok(diagnostics.some(event => event.event === "thread-resume-finish" && event.clientId === "client-a" && event.threadId === "codex-thread-1" && event.outcome === "succeeded"));

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
    assert.ok(diagnostics.some(event => event.event === "appserver-exit" && event.intentional === true));
    await rm(root, { recursive: true, force: true });
  }
});

test("one logical unsubscribe cannot revoke another Client's shared native Thread stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-multi-subscribe-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (clientId: string, id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    const started = await request("client-a", "a:start", "thread/start", { cwd: root });
    const threadId = (started.result as any).thread.id as string;
    await request("client-b", "b:resume", "thread/resume", { threadId });

    const before = frames.length;
    await request("client-a", "a:probe-1", "test/emitThreadNotification", { threadId });
    await waitFor(frames, frame => frames.indexOf(frame) >= before && frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-b");
    assert.deepEqual(new Set(frames.slice(before).filter(frame => frame.method === "thread/status/changed")
      .map(frame => frame[LOGICAL_CLIENT_FIELD])), new Set(["client-a", "client-b"]));

    const detached = await request("client-b", "b:unsubscribe", "thread/unsubscribe", { threadId });
    assert.deepEqual(detached.result, { status: "unsubscribed" });
    assert.deepEqual((await request("client-b", "b:unsubscribe-again", "thread/unsubscribe", { threadId })).result,
      { status: "notSubscribed" });
    const afterDetach = frames.length;
    const probe = await request("client-a", "a:probe-2", "test/emitThreadNotification", { threadId });
    assert.deepEqual(probe.result, { nativeSubscribed: true });
    await waitFor(frames, frame => frames.indexOf(frame) >= afterDetach && frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-a");
    assert.equal(frames.slice(afterDetach).some(frame => frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-b"), false);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("joining Client receives Thread events before its delayed resume acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-joining-subscribe-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await adapter.send(JSON.stringify({ id: "a:start", method: "thread/start", params: { cwd: root }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:start");
    await adapter.send(JSON.stringify({ id: "b:resume", method: "thread/resume", params: { threadId: "codex-thread-1", testDelayMs: 50 }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const before = frames.length;
    await adapter.send(JSON.stringify({ id: "a:probe", method: "test/emitThreadNotification", params: { threadId: "codex-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:probe");
    const joinedEvent = await waitFor(frames, frame => frames.indexOf(frame) >= before && frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-b");
    assert.ok(joinedEvent);
    assert.equal(frames.some(frame => frame.id === "b:resume"), false);
    await waitFor(frames, frame => frame.id === "b:resume");
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Client that detaches during resume cannot regain notifications or interaction ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-detached-join-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const send = (clientId: string, id: string, method: string, params: Record<string, unknown>) =>
    adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await send("client-a", "a:start", "thread/start", { cwd: root });
    await waitFor(frames, frame => frame.id === "a:start");
    const threadId = "codex-thread-1";
    await send("client-b", "b:resume", "thread/resume", { threadId, testDelayMs: 50 });
    await send("client-b", "b:detach", "thread/unsubscribe", { threadId });
    assert.deepEqual((await waitFor(frames, frame => frame.id === "b:detach")).result, { status: "notSubscribed" });
    await waitFor(frames, frame => frame.method === "test/delayedResponseSent");
    assert.equal(frames.some(frame => frame.id === "b:resume"), false);
    const before = frames.length;
    await send("client-a", "a:probe", "test/emitThreadNotification", { threadId });
    await waitFor(frames, frame => frame.id === "a:probe");
    await waitFor(frames, frame => frames.indexOf(frame) >= before && frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-a");
    assert.equal(frames.slice(before).some(frame => frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-b"), false);
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await send("client-b", "b:emit", "test/emitServerRequest", { threadId });
    const emitted = await waitFor(frames, frame => frame.id === "b:emit");
    const requestId = (emitted.result as { requestId: number }).requestId;
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);
    await initializeClient(adapter, frames, "client-c");
    await send("client-c", "c:resume", "thread/resume", { threadId });
    await waitFor(frames, frame => frame.id === "c:resume");
    assert.equal((await waitFor(frames, frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"))[LOGICAL_CLIENT_FIELD], "client-c");
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a reused logical Client ID cannot inherit the previous connection's late resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-reused-client-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const send = (clientId: string, id: string, method: string, params: Record<string, unknown>) =>
    adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await send("client-a", "a:start", "thread/start", { cwd: root });
    await waitFor(frames, frame => frame.id === "a:start");
    const threadId = "codex-thread-1";
    await send("client-a", "a:old-resume", "thread/resume", { threadId, testDelayMs: 50 });
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await initializeClient(adapter, frames, "client-a");
    await waitFor(frames, frame => frame.method === "test/delayedResponseSent");
    assert.equal(frames.some(frame => frame.id === "a:old-resume"), false);
    const before = frames.length;
    await send("client-b", "b:probe", "test/emitThreadNotification", { threadId });
    await waitFor(frames, frame => frame.id === "b:probe");
    assert.equal(frames.slice(before).some(frame => frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-a"), false);
    await send("client-a", "a:fresh-resume", "thread/resume", { threadId });
    await waitFor(frames, frame => frame.id === "a:fresh-resume");
    const afterJoin = frames.length;
    await send("client-b", "b:probe-after-join", "test/emitThreadNotification", { threadId });
    await waitFor(frames, frame => frame.id === "b:probe-after-join");
    await waitFor(frames, frame => frames.indexOf(frame) >= afterJoin && frame.method === "thread/status/changed" && frame[LOGICAL_CLIENT_FIELD] === "client-a");
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("late thread/start success after disconnect releases the otherwise orphaned native subscription", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-late-start-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, 10);
  const send = (clientId: string, id: string, method: string, params: Record<string, unknown>) =>
    adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await send("client-a", "a:start", "thread/start", { cwd: root, testDelayMs: 50, testNoServerRequest: true });
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.method === "test/delayedResponseSent");
    assert.equal(frames.some(frame => frame.id === "a:start"), false);
    let released = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const id = `b:probe:${attempt}`;
      await send("client-b", id, "test/emitThreadNotification", { threadId: "codex-thread-1" });
      const probe = await waitFor(frames, frame => frame.id === id);
      if ((probe.result as any).nativeSubscribed === false) {
        released = true;
        break;
      }
    }
    assert.equal(released, true);
    await send("client-b", "b:duplicate-unsubscribe", "thread/unsubscribe", { threadId: "codex-thread-1" });
    assert.deepEqual((await waitFor(frames, frame => frame.id === "b:duplicate-unsubscribe")).result, { status: "notSubscribed" });
    await send("client-b", "b:resume", "thread/resume", { threadId: "codex-thread-1" });
    await waitFor(frames, frame => frame.id === "b:resume");
    await send("client-b", "b:probe-after-resume", "test/emitThreadNotification", { threadId: "codex-thread-1" });
    assert.deepEqual((await waitFor(frames, frame => frame.id === "b:probe-after-resume")).result, { nativeSubscribed: true });
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Host archives and restores through the native Thread catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-archive-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const clientId = "archive-client";
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, clientId);
    const initialized = await waitFor(frames, frame => frame.id === `${clientId}:init`);
    assert.equal((initialized.result as any).capabilities.extensions[OPENCRAFT_THREAD_LIFECYCLE_EXTENSION].archive, true);

    const started = await request("archive:start", "thread/start", { cwd: root });
    const threadId = (started.result as any).thread.id;
    const archived = await request("archive:write", "thread/archive", { threadId });
    assert.deepEqual(archived.result, {});
    assert.equal(archived[LOGICAL_CLIENT_FIELD], clientId);
    const archivedList = await request("archive:list", "thread/list", { archived: true });
    assert.deepEqual((archivedList.result as any).data.map((thread: any) => thread.id), [threadId]);

    const restored = await request("archive:restore", "thread/unarchive", { threadId });
    assert.equal((restored.result as any).thread.id, threadId);
    const afterRestore = await request("archive:after-restore", "thread/list", { archived: true });
    assert.deepEqual((afterRestore.result as any).data, []);
    const activeList = await request("archive:active-list", "thread/list", {});
    assert.deepEqual((activeList.result as any).data.map((thread: any) => thread.id), [threadId]);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Host renames a Thread through native AppServer and reads its name back", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-rename-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const clientId = "rename-client";
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, clientId);
    const initialized = await waitFor(frames, frame => frame.id === `${clientId}:init`);
    assert.equal((initialized.result as any).capabilities.extensions[OPENCRAFT_THREAD_LIFECYCLE_EXTENSION].rename, true);

    const started = await request("rename:start", "thread/start", { cwd: root });
    const threadId = (started.result as any).thread.id;
    const renamed = await request("rename:write", "thread/name/set", { threadId, name: "A useful title" });
    assert.deepEqual(renamed.result, {});
    assert.equal(renamed[LOGICAL_CLIENT_FIELD], clientId);
    const listed = await request("rename:list", "thread/list", {});
    assert.equal((listed.result as any).data[0].name, "A useful title");
    const read = await request("rename:read", "thread/read", { threadId, includeTurns: false });
    assert.equal((read.result as any).thread.name, "A useful title");
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Host queue Steer capability does not depend on a patched native marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-native-queue-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 2);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    const initialized = await waitFor(frames, frame => frame.id === "client-a:init");
    assert.deepEqual(
      (initialized.result as any).capabilities.extensions[OPENCRAFT_THREAD_QUEUE_EXTENSION],
      { version: 2, reorder: true, atomicSteer: true, unconfirmedSteerDiscard: true, perItemPause: false },
    );
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Host marks only verified built-in profiles as portable modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-permission-catalog-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    const initialized = await waitFor(frames, frame => frame.id === "client-a:init");
    assert.deepEqual((initialized.result as any).capabilities.extensions[OPENCRAFT_PERMISSION_MODES_EXTENSION], { version: 1 });
    await adapter.send(JSON.stringify({ [LOGICAL_CLIENT_FIELD]: "client-a", id: "catalog", method: "permissionProfile/list", params: { cursor: null, limit: 100 } }));
    const response = await waitFor(frames, frame => frame.id === "catalog");
    assert.deepEqual((response.result as any).data.map((entry: any) => entry.openCraftMode ?? null), [
      "read-only", "accept-edits", "full", null,
    ]);
    assert.equal((response.result as any).data[1].id, "opencraft:permission-mode:accept-edits");
    assert.equal((response.result as any).data[1].openCraftNativeProfileId, ":workspace");
    assert.equal((response.result as any).data[3].id, "team-custom");
    await adapter.send(JSON.stringify({ [LOGICAL_CLIENT_FIELD]: "client-a", id: "create-with-mode", method: "thread/start", params: { cwd: root, permissions: "opencraft:permission-mode:accept-edits" } }));
    const created = await waitFor(frames, frame => frame.id === "create-with-mode");
    assert.equal((created.result as any).testNativePermission, ":workspace");
    await adapter.send(JSON.stringify({ [LOGICAL_CLIENT_FIELD]: "client-a", id: "create-unsupported-auto", method: "thread/start", params: { cwd: root, permissions: "opencraft:permission-mode:auto" } }));
    const unsupported = await waitFor(frames, frame => frame.id === "create-unsupported-auto");
    assert.equal((unsupported.error as any).code, -32602);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("older native queue marker does not change Host queue capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-native-queue-v1-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 1);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    const initialized = await waitFor(frames, frame => frame.id === "client-a:init");
    assert.deepEqual(
      (initialized.result as any).capabilities.extensions[OPENCRAFT_THREAD_QUEUE_EXTENSION],
      { version: 2, reorder: true, atomicSteer: true, unconfirmedSteerDiscard: true, perItemPause: false },
    );
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host-owned Codex queue steers through standard turn/steer and reconciles the accepted message", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-queue-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const client = "client-a";
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, client);
    await request("thread", "thread/start", { cwd: root });
    const started = await request("turn", "turn/start", {
      threadId: "codex-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first",
    });
    const activeTurnId = (started.result as any).turn.id;
    const added = await request("add", "thread/queue/add", {
      threadId: "codex-thread-1", input: [{ type: "text", text: "follow up" }], clientUserMessageId: "queued-1",
    });
    const queuedId = (added.result as any).queuedSubmission.id;
    const queued = await request("list-1", "thread/queue/list", { threadId: "codex-thread-1" });
    assert.equal((queued.result as any).data[0].id, queuedId);
    const steered = await request("steer", "thread/queue/steer", {
      threadId: "codex-thread-1", queuedSubmissionId: queuedId, expectedTurnId: activeTurnId,
    });
    assert.deepEqual(steered.result, { turnId: activeTurnId });
    const afterSteer = await request("list-2", "thread/queue/list", { threadId: "codex-thread-1" });
    assert.deepEqual((afterSteer.result as any).data, []);
    assert.equal((afterSteer.result as any).steering[0].clientUserMessageId, "queued-1");
    await request("complete", "test/completeTurn", { threadId: "codex-thread-1" });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listed = await request(`list-final-${attempt}`, "thread/queue/list", { threadId: "codex-thread-1" });
      if ((listed.result as any).steering.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const settled = await request("settled", "thread/queue/list", { threadId: "codex-thread-1" });
    assert.deepEqual((settled.result as any).steering, []);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous Codex queue steer stays claimed until explicit history-checked discard", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-unknown-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, "ambiguous");
  const client = "client-a";
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, client);
    await request("thread", "thread/start", { cwd: root });
    const turn = await request("turn", "turn/start", {
      threadId: "codex-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first",
    });
    const targetTurnId = (turn.result as any).turn.id;
    const added = await request("add", "thread/queue/add", {
      threadId: "codex-thread-1", input: [{ type: "text", text: "possibly delivered" }], clientUserMessageId: "maybe-1",
    });
    const queuedId = (added.result as any).queuedSubmission.id;
    const steer = await request("steer", "thread/queue/steer", {
      threadId: "codex-thread-1", queuedSubmissionId: queuedId, expectedTurnId: targetTurnId,
    });
    assert.ok(steer.error);
    const unknown = await request("unknown", "thread/queue/list", { threadId: "codex-thread-1" });
    assert.equal((unknown.result as any).steering[0].pausedReason, "steer-delivery-unconfirmed");
    await request("complete", "test/completeTurn", { threadId: "codex-thread-1" });
    const deleted = await request("discard", "thread/queue/delete", {
      threadId: "codex-thread-1", queuedSubmissionId: queuedId,
      expectedTurnId: targetTurnId, acknowledgeUnknownDelivery: true,
    });
    assert.deepEqual(deleted.result, { deleted: true });
    const settled = await request("settled", "thread/queue/list", { threadId: "codex-thread-1" });
    assert.deepEqual((settled.result as any).steering, []);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host queue starts the next turn after completion without sending a native queue RPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-drain-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await request("thread", "thread/start", { cwd: root });
    const first = await request("turn", "turn/start", {
      threadId: "codex-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first",
    });
    const firstTurnId = (first.result as any).turn.id;
    await request("add", "thread/queue/add", {
      threadId: "codex-thread-1", input: [{ type: "text", text: "next" }], clientUserMessageId: "next",
    });
    await request("complete", "test/completeTurn", { threadId: "codex-thread-1" });
    const second = await waitFor(frames, frame => frame.method === "turn/started" && (frame.params as any).turn.id !== firstTurnId);
    assert.ok((second.params as any).turn.id);
    const listed = await request("listed", "thread/queue/list", { threadId: "codex-thread-1" });
    assert.deepEqual((listed.result as any).data, []);
    assert.deepEqual((listed.result as any).steering, []);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("last viewer leaving preserves background turns and queued work until the Host can safely release native subscription", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-background-subscription-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, 10);
  let sequence = 0;
  const request = async (clientId: string, method: string, params: Record<string, unknown>) => {
    const id = `request-${++sequence}`;
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    return waitFor(frames, frame => frame.id === id);
  };
  const threadId = "codex-thread-1";
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await request("client-a", "thread/start", { cwd: root });
    await waitFor(frames, frame => frame.id === 900 && frame.method === "item/tool/requestUserInput");
    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.method === "serverRequest/resolved");
    await request("client-a", "turn/start", { threadId, input: [{ type: "text", text: "first" }], clientUserMessageId: "first" });
    await request("client-a", "thread/queue/add", { threadId, input: [{ type: "text", text: "second" }], clientUserMessageId: "second" });
    await request("client-a", "thread/unsubscribe", { threadId });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual((await request("client-b", "test/emitThreadNotification", { threadId })).result, { nativeSubscribed: true });
    await request("client-b", "test/completeTurn", { threadId });
    let queueDrained = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listed = await request("client-b", "thread/queue/list", { threadId });
      if ((listed.result as any).data.length === 0 && (listed.result as any).steering.length === 0) {
        queueDrained = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(queueDrained, true);
    const running = await request("client-b", "thread/read", { threadId, includeTurns: false });
    assert.equal((running.result as any).thread.status.type, "active");
    assert.deepEqual((await request("client-b", "test/emitThreadNotification", { threadId })).result, { nativeSubscribed: true });
    await request("client-b", "test/completeTurn", { threadId });
    let released = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const probe = await request("client-b", "test/emitThreadNotification", { threadId });
      if ((probe.result as any).nativeSubscribed === false) { released = true; break; }
    }
    assert.equal(released, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("definitive Codex steer rejection releases the Host claim without losing the queued item", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-reject-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await request("thread", "thread/start", { cwd: root });
    await request("turn", "turn/start", {
      threadId: "codex-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first",
    });
    const added = await request("add", "thread/queue/add", {
      threadId: "codex-thread-1", input: [{ type: "text", text: "follow" }], clientUserMessageId: "follow",
    });
    const queuedId = (added.result as any).queuedSubmission.id;
    const rejected = await request("steer", "thread/queue/steer", {
      threadId: "codex-thread-1", queuedSubmissionId: queuedId, expectedTurnId: "stale-turn",
    });
    assert.ok(rejected.error);
    const listed = await request("listed", "thread/queue/list", { threadId: "codex-thread-1" });
    assert.equal((listed.result as any).data[0].id, queuedId);
    assert.deepEqual((listed.result as any).steering, []);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("restart preserves an unconfirmed claim and blocks a later queued turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-restart-"));
  const dataRoot = join(root, "data");
  await mkdir(dataRoot);
  const queue = new CodexHostQueue(dataRoot);
  const uncertain = queue.add("codex-thread-1", "uncertain", [{ type: "text", text: "maybe" }]);
  queue.claim("codex-thread-1", uncertain.id, "turn-old");
  queue.add("codex-thread-1", "later", [{ type: "text", text: "later" }]);
  queue.close();
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await adapter.send(JSON.stringify({ id: "list", method: "thread/queue/list", params: { threadId: "codex-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const listed = await waitFor(frames, frame => frame.id === "list");
    assert.equal((listed.result as any).steering[0].id, uncertain.id);
    assert.equal((listed.result as any).steering[0].pausedReason, "steer-delivery-unconfirmed");
    assert.equal((listed.result as any).data[0].clientUserMessageId, "later");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(frames.some(frame => frame.method === "turn/started"), false);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host resumes an unloaded Codex thread and drains a durable queued message without a browser subscription", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-background-"));
  const dataRoot = join(root, "data");
  await mkdir(dataRoot);
  const queue = new CodexHostQueue(dataRoot);
  queue.add("codex-thread-1", "background", [{ type: "text", text: "continue" }]);
  queue.close();
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    let cleared = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const id = `list-${attempt}`;
      await adapter.send(JSON.stringify({ id, method: "thread/queue/list", params: { threadId: "codex-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
      const listed = await waitFor(frames, frame => frame.id === id);
      if ((listed.result as any).data.length === 0 && (listed.result as any).steering.length === 0) { cleared = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(cleared, true);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex Fork subscribes only its requester to the child and late disconnected responses cannot reclaim it", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-fork-routing-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await adapter.send(JSON.stringify({ id: "a:start", method: "thread/start", params: { cwd: root }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:start");
    await adapter.send(JSON.stringify({ id: "a:fork", method: "thread/fork", params: { threadId: "codex-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const forked = await waitFor(frames, frame => frame.id === "a:fork");
    assert.equal((forked.result as any).thread.id, "codex-fork-1");
    const childStarted = await waitFor(frames, frame => frame.method === "thread/started" && (frame.params as any).thread.id === "codex-fork-1");
    assert.equal(childStarted[LOGICAL_CLIENT_FIELD], "client-a");
    assert.equal(frames.some(frame => frame.method === "thread/started" && (frame.params as any).thread.id === "codex-fork-1" && frame[LOGICAL_CLIENT_FIELD] === "client-b"), false);
    await adapter.send(JSON.stringify({ id: "a:failed-fork", method: "thread/fork", params: { threadId: "codex-thread-1", testFail: true }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const rejected = await waitFor(frames, frame => frame.id === "a:failed-fork");
    assert.match((rejected.error as { message: string }).message, /fork rejected/);
    assert.equal(frames.filter(frame => frame.method === "thread/started" && (frame.params as any).thread.id !== "codex-thread-1").length, 1);
    await adapter.send(JSON.stringify({ id: "b:late-fork", method: "thread/fork", params: { threadId: "codex-thread-1", testDelayMs: 50 }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-b" }));
    await waitFor(frames, frame => frame.method === "test/delayedResponseSent");
    assert.equal(frames.some(frame => frame.id === "b:late-fork"), false);
    await adapter.send(JSON.stringify({ id: "a:emit", method: "test/emitServerRequest", params: { threadId: "codex-fork-late" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const emitted = await waitFor(frames, frame => frame.id === "a:emit");
    const requestId = (emitted.result as { requestId: number }).requestId;
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pending Codex server requests follow the resumed Thread owner, not an arbitrary connected client", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-routing-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, 10);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await adapter.send(JSON.stringify({ id: "a:start", method: "thread/start", params: { cwd: root }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:start");
    const original = await waitFor(frames, frame => frame.id === 900 && frame.method === "item/tool/requestUserInput");
    assert.equal(original[LOGICAL_CLIENT_FIELD], "client-a");

    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await new Promise(resolve => setTimeout(resolve, 40));
    await adapter.send(JSON.stringify({ id: "b:probe", method: "test/emitThreadNotification", params: { threadId: "codex-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    assert.deepEqual((await waitFor(frames, frame => frame.id === "b:probe")).result, { nativeSubscribed: true });
    await adapter.send(JSON.stringify({ id: "b:emit", method: "test/emitServerRequest", params: { threadId: "codex-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const emitted = await waitFor(frames, frame => frame.id === "b:emit");
    const requestId = (emitted.result as { requestId: number }).requestId;
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);
    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await adapter.send(JSON.stringify({ id: requestId, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-b" }));

    await initializeClient(adapter, frames, "client-c");
    await adapter.send(JSON.stringify({ id: "c:resume", method: "thread/resume", params: { threadId: "codex-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-c" }));
    await waitFor(frames, frame => frame.id === "c:resume");
    const replayedOriginal = frames.filter(frame => frame.id === 900 && frame.method === "item/tool/requestUserInput");
    assert.deepEqual(replayedOriginal.map(frame => frame[LOGICAL_CLIENT_FIELD]), ["client-a", "client-c"]);
    const replayedNew = frames.filter(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput");
    assert.deepEqual(replayedNew.map(frame => frame[LOGICAL_CLIENT_FIELD]), ["client-c"]);
    assert.equal(frames.some(frame => frame.method === "serverRequest/resolved"), false);

    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-c" }));
    await adapter.send(JSON.stringify({ id: requestId, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-c" }));
    await waitFor(frames, frame => frame.method === "serverRequest/resolved" && (frame.params as any).requestId === requestId);
    const resolved = frames.filter(frame => frame.method === "serverRequest/resolved");
    assert.deepEqual(resolved.map(frame => (frame.params as any).requestId), [900, requestId]);
    assert.ok(resolved.every(frame => frame[LOGICAL_CLIENT_FIELD] === "client-c"));
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a late Thread resume response cannot reclaim ownership for a disconnected client", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-late-resume-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await adapter.send(JSON.stringify({ id: "a:resume", method: "thread/resume", params: { threadId: "codex-thread-1", testDelayMs: 50 }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.method === "test/delayedResponseSent");
    assert.equal(frames.some(frame => frame.id === "a:resume"), false);
    await adapter.send(JSON.stringify({ id: "b:emit", method: "test/emitServerRequest", params: { threadId: "codex-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const emitted = await waitFor(frames, frame => frame.id === "b:emit");
    const requestId = (emitted.result as { requestId: number }).requestId;
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);

    await adapter.send(JSON.stringify({ id: "b:wrong-resume", method: "thread/resume", params: { threadId: "codex-thread-1", testWrongThreadId: true }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    await waitFor(frames, frame => frame.id === "b:wrong-resume");
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);

    await adapter.send(JSON.stringify({ id: "b:resume", method: "thread/resume", params: { threadId: "codex-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    await waitFor(frames, frame => frame.id === "b:resume");
    const request = await waitFor(frames, frame => frame.id === requestId && frame.method === "item/tool/requestUserInput");
    assert.equal(request[LOGICAL_CLIENT_FIELD], "client-b");
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
