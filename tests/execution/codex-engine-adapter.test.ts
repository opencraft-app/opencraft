import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { OPENCRAFT_ATTACHMENT_STAGING_EXTENSION, OPENCRAFT_THREAD_LIFECYCLE_EXTENSION, OPENCRAFT_THREAD_QUEUE_EXTENSION, OPENCRAFT_THREAD_START_DURABILITY_EXTENSION, OPENCRAFT_PERMISSION_MODES_EXTENSION } from "@opencraft/appserver-protocol";
import { CodexEngineAdapter, capacityRetryDelayMs } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { InterruptedTurnRecovery } from "@opencraft/host-recovery";
import { OpenCraftHostQueue } from "../../apps/opencraft-daemon/src/opencraft-host-queue.js";
import { LocalDesktopService } from "../../apps/local-agent-host/src/desktop/local-desktop-service.js";
import { OPENCRAFT_DESKTOP_ATTACH, OPENCRAFT_DESKTOP_RELEASE, OPENCRAFT_DESKTOP_EXTENSION } from "@opencraft/appserver-protocol/desktop";

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

function createRoutingAdapter(root: string, frames: Array<Record<string, unknown>>, nativeQueueSteerVersion: 0 | 1 | 2 = 0, steerResponse?: string, nativeSubscriptionGraceMs?: number, desktop?: LocalDesktopService, autoTitles = false, tokenUsage?:ConstructorParameters<typeof CodexEngineAdapter>[0]["tokenUsage"], sessionMcp?: ConstructorParameters<typeof CodexEngineAdapter>[0]["sessionMcp"]): CodexEngineAdapter {
  const adapter = new CodexEngineAdapter({
    executable: process.execPath,
    runtimeDirectory: root,
    dataDirectory: join(root, "data"),
    nativeCodexHomeDirectory: join(root, "native-codex"),
    upstreamBaseUrl: "http://127.0.0.1:9/backend-api/codex",
    fetch: async () => Response.json({ ok: true }),
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath, [new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname], { cwd, env: { ...env, ...(autoTitles ? { OPENCRAFT_TEST_AUTO_TITLES: "1" } : {}), ...(nativeQueueSteerVersion ? { OPENCRAFT_TEST_NATIVE_QUEUE_STEER: String(nativeQueueSteerVersion) } : {}), ...(steerResponse ? { OPENCRAFT_TEST_STEER_RESPONSE: steerResponse } : {}) }, stdio: ["pipe", "pipe", "pipe"] }),
    createMaintenanceClient: async () => { throw new Error("not used"); },
    logDiagnostic: () => undefined,
    nativeSubscriptionGraceMs,
    tokenUsage,
    sessionMcp,
    desktop,
  });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  return adapter;
}

test("a stop during the final asynchronous tool preparation prevents the automatic native send", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-final-recovery-admission-"));
  await mkdir(join(root, "data"));
  const seed = new InterruptedTurnRecovery(join(root, "data"), { serialize: async (_id, work) => work(), inspect: async () => "lost", continue: async () => null, changed() {} });
  seed.started("recovery-thread", "old-turn"); await seed.close();
  let prepares = 0, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, false, undefined, async () => {
    if (++prepares === 2) { entered(); await gate; }
    return null;
  });
  const rpc = async (id: string, method: string, params: object) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    await rpc("seed-history", "test/setHistory", { threadId: "recovery-thread", turns: [{ id: "old-turn", status: "interrupted", items: [] }] });
    let timeout: ReturnType<typeof setTimeout>;
    await Promise.race([preparing, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Recovery did not reach final preparation")), 5000); })]).finally(() => clearTimeout(timeout!));
    await rpc("user-stop", "turn/interrupt", { threadId: "recovery-thread", turnId: "old-turn" });
    release();
    await new Promise(resolve => setTimeout(resolve, 50));
    const response = await rpc("accepted", "test/readAcceptedInputs", {});
    assert.deepEqual((response.result as any).data, []);
    const notice = await rpc("notice", "opencraft/turn-recovery/read", { threadId: "recovery-thread" });
    assert.equal((notice.result as any).recovery, null);
  } finally { release(); await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

async function initializeClient(adapter: CodexEngineAdapter, frames: Array<Record<string, unknown>>, clientId: string): Promise<void> {
  await adapter.send(JSON.stringify({ id: `${clientId}:init`, method: "initialize", params: {}, [LOGICAL_CLIENT_FIELD]: clientId }));
  await waitFor(frames, frame => frame.id === `${clientId}:init`);
}

test("model capacity failures continue with exponential backoff capped at 120 seconds", async () => {
  assert.deepEqual([0, 1, 2, 6, 7, 20].map(capacityRetryDelayMs), [1_000, 2_000, 4_000, 64_000, 120_000, 120_000]);
  const root = await mkdtemp(join(tmpdir(), "opencraft-capacity-retry-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const response = await waitFor(frames, frame => frame.id === id);
    assert.equal(response.error, undefined);
    return response.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    assert.deepEqual((frames.find(frame => frame.id === "writer:init")?.result as any).capabilities.extensions["opencraft/capacity-retry"], { version: 1 });
    const threadId = (await request("capacity:create", "thread/start", { cwd: root, testNoServerRequest: true })).thread.id;
    await request("capacity:initial", "turn/start", { threadId, input: [{ type: "text", text: "Continue this task" }] });
    await request("capacity:fail", "test/completeTurn", { threadId, codexErrorInfo: "serverOverloaded" });
    const retry = await waitFor(frames, frame => frame.method === "turn/started" && (frame.params as any).turn.id === "turn-2");
    assert.equal((retry.params as any).threadId, threadId);
    const accepted = (await request("capacity:inputs", "test/readAcceptedInputs", {})).data;
    assert.deepEqual(accepted.at(-1).params.input, []);
    assert.match(accepted.at(-1).params.clientUserMessageId, /^capacity-retry:/);
    const usageDb=new DatabaseSync(join(root,"data","token-usage.sqlite"),{readOnly:true});
    try{
      const fact=usageDb.prepare("SELECT actor_id,actor_kind,source_kind,mode FROM token_usage_submissions WHERE server_id=? AND thread_id=? AND input_id=?").get("local-codex",threadId,accepted.at(-1).params.clientUserMessageId);
      assert.deepEqual({...fact},{actor_id:null,actor_kind:"session",source_kind:"system",mode:"start"});
    }finally{usageDb.close();}
    await request("capacity:fail-again", "test/completeTurn", { threadId, codexErrorInfo: "serverOverloaded" });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal((await request("capacity:before-second-backoff", "test/readAcceptedInputs", {})).data.length, 2);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal((await request("capacity:second-retry", "test/readAcceptedInputs", {})).data.length, 3);
    await request("capacity:done", "test/completeTurn", { threadId });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal((await request("capacity:after-success", "test/readAcceptedInputs", {})).data.length, 3);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("new user input cancels a pending capacity continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-capacity-cancel-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const response = await waitFor(frames, frame => frame.id === id);
    assert.equal(response.error, undefined);
    return response.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const threadId = (await request("cancel:create", "thread/start", { cwd: root, testNoServerRequest: true })).thread.id;
    await request("cancel:initial", "turn/start", { threadId, input: [{ type: "text", text: "First" }] });
    await request("cancel:fail", "test/completeTurn", { threadId, codexErrorInfo: "serverOverloaded" });
    await request("cancel:manual", "turn/start", { threadId, input: [{ type: "text", text: "New direction" }] });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal((await request("cancel:inputs", "test/readAcceptedInputs", {})).data.length, 2);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex Host titles a new conversation after its View disconnects, without leaking the inference Thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-auto-title-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, true);
  const request = async (id: string, method: string, params: Record<string, unknown>, client = "writer") => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
    const result = await waitFor(frames, frame => frame.id === id); assert.equal(result.error, undefined); return result.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer"); await initializeClient(adapter, frames, "catalog-reader");
    const started = await request("auto:create", "thread/start", { cwd: root, testNoServerRequest: true });
    const threadId = started.thread.id;
    await request("auto:input", "turn/start", { threadId, input: [{ type: "text", text: "修复自动会话标题" }] });
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "writer" }));
    await waitFor(frames, frame => frame.method === "thread/name/updated" && frame[LOGICAL_CLIENT_FIELD] === "catalog-reader");
    const read = await request("auto:read", "thread/read", { threadId }, "catalog-reader");
    assert.equal(read.thread.name, "修复自动会话标题");
    assert.equal(read.thread.status.type, "active", "background title must not stop the user's turn");
    assert.equal(frames.some(frame => JSON.stringify(frame).includes("title-thread-")), false);
    assert.equal(frames.filter(frame => frame.method === "turn/completed").length, 0);
    assert.equal((await request("auto:list", "thread/list", {}, "catalog-reader")).data.length, 1);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("manual native rename during background generation survives and is returned by the catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-auto-title-manual-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, undefined, true);
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const result = await waitFor(frames, frame => frame.id === id); assert.equal(result.error, undefined); return result.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const started = await request("manual:create", "thread/start", { cwd: root, testNoServerRequest: true });
    const threadId = started.thread.id;
    await request("manual:input", "turn/start", { threadId, input: [{ type: "text", text: "修复自动会话标题" }] });
    await request("manual:rename", "thread/name/set", { threadId, name: "用户保留的标题" });
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal((await request("manual:read", "thread/read", { threadId })).thread.name, "用户保留的标题");
    assert.equal(frames.some(frame => frame.method === "thread/name/updated" && (frame.params as any).threadName === "修复自动会话标题"), false);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex Host stages ordinary files for its native process without forwarding the extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-attachment-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const clientId = "attachment-client";
  const request = {
    clientAttachmentId: "markdown-attachment",
    name: "notes.md",
    mimeType: "text/markdown",
    size: 11,
    source: { kind: "client-bytes", dataBase64: Buffer.from("hello world").toString("base64") },
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, clientId);
    const initialized = await waitFor(frames, frame => frame.id === `${clientId}:init`);
    assert.deepEqual((initialized.result as any).capabilities.extensions[OPENCRAFT_ATTACHMENT_STAGING_EXTENSION], {
      version: 1, chunkBytes: 1024 * 1024, sources: ["client-bytes"], locations: ["host-file"], maxBytes: 1024 * 1024 * 1024,
    });
    const upload = { uploadId: crypto.randomUUID(), clientAttachmentId: "chunked-notes", name: "chunked.md", mimeType: "text/markdown", size: 6 };
    const chunk = async (id: string, offset: number, text: string) => {
      await adapter.send(JSON.stringify({ id, method: "attachment/uploadChunk", params: { ...upload, offset, dataBase64: Buffer.from(text).toString("base64") }, [LOGICAL_CLIENT_FIELD]: clientId }));
      const response = await waitFor(frames, frame => frame.id === id);
      assert.equal(response[LOGICAL_CLIENT_FIELD], clientId);
      assert.equal(response.error, undefined);
      return response.result as any;
    };
    assert.deepEqual(await chunk("chunk-1", 0, "abc"), { receivedBytes: 3, ref: null });
    const uploaded = await chunk("chunk-2", 3, "def");
    assert.equal(uploaded.receivedBytes, 6);
    assert.equal(await readFile(uploaded.ref.location.path, "utf8"), "abcdef");
    await adapter.send(JSON.stringify({ id: "chunk-remove", method: "attachment/remove", params: { id: uploaded.ref.id }, [LOGICAL_CLIENT_FIELD]: clientId }));
    assert.deepEqual((await waitFor(frames, frame => frame.id === "chunk-remove")).result, { removed: true });
    await adapter.send(JSON.stringify({ id: "stage-1", method: "attachment/stage", params: request, [LOGICAL_CLIENT_FIELD]: clientId }));
    const staged = await waitFor(frames, frame => frame.id === "stage-1");
    assert.equal(staged[LOGICAL_CLIENT_FIELD], clientId);
    const path = (staged.result as any).ref.location.path as string;
    assert.ok(path.startsWith(join(root, "data", "attachments") + "/"));
    assert.equal((await readFile(path)).toString("utf8"), "hello world");
    await adapter.send(JSON.stringify({ id: "stage-replay", method: "attachment/stage", params: request, [LOGICAL_CLIENT_FIELD]: clientId }));
    assert.deepEqual((await waitFor(frames, frame => frame.id === "stage-replay")).result, staged.result);
    await adapter.send(JSON.stringify({ id: "thread-1", method: "thread/start", params: {}, [LOGICAL_CLIENT_FIELD]: clientId }));
    const threadId = (await waitFor(frames, frame => frame.id === "thread-1")).result as any;
    const actualThreadId = threadId.thread.id as string;
    await adapter.send(JSON.stringify({ id: "turn-1", method: "turn/start", params: {
      threadId: actualThreadId, clientUserMessageId: "with-file", input: [
        { type: "text", text: "What is in this file?" }, { type: "mention", name: "notes.md", path },
      ],
    }, [LOGICAL_CLIENT_FIELD]: clientId }));
    const turn = await waitFor(frames, frame => frame.id === "turn-1");
    assert.ok(turn.result);
    await adapter.send(JSON.stringify({ id: "items-1", method: "thread/items/list", params: { threadId: actualThreadId }, [LOGICAL_CLIENT_FIELD]: clientId }));
    const items = (await waitFor(frames, frame => frame.id === "items-1")).result as any;
    const content = items.data[0].item.content;
    assert.equal(content[0].text, "What is in this file?");
    assert.match(content[1].text, /notes\.md/);
    assert.ok(content[1].text.includes(path));
    assert.equal(content[1].text_elements[0].placeholder, "opencraft:staged-file:v1");
    assert.deepEqual(content[2], { type: "mention", name: "notes.md", path });
    assert.deepEqual(items.data[0].item.attachments, [{
      id: request.clientAttachmentId, name: "notes.md", mimeType: "text/markdown",
      size: 11, path,
    }]);
    await adapter.send(JSON.stringify({ id: "queue-add", method: "thread/queue/add", params: {
      threadId: actualThreadId, clientUserMessageId: "queued-file", input: [{ type: "mention", name: "notes.md", path }],
    }, [LOGICAL_CLIENT_FIELD]: clientId }));
    const queued = (await waitFor(frames, frame => frame.id === "queue-add")).result as any;
    await adapter.send(JSON.stringify({ id: "queue-steer", method: "thread/queue/steer", params: {
      threadId: actualThreadId, queuedSubmissionId: queued.queuedSubmission.id,
      expectedTurnId: (turn.result as any).turn.id,
    }, [LOGICAL_CLIENT_FIELD]: clientId }));
    assert.ok((await waitFor(frames, frame => frame.id === "queue-steer")).result);
    await adapter.send(JSON.stringify({ id: "items-2", method: "thread/items/list", params: { threadId: actualThreadId }, [LOGICAL_CLIENT_FIELD]: clientId }));
    const steeredItems = (await waitFor(frames, frame => frame.id === "items-2")).result as any;
    assert.ok(steeredItems.data[1].item.content[0].text.includes(path));
    assert.deepEqual(steeredItems.data[1].item.content[1], { type: "mention", name: "notes.md", path });
    assert.deepEqual(steeredItems.data[1].item.attachments, items.data[0].item.attachments);
    await adapter.send(JSON.stringify({ id: "remove-1", method: "attachment/remove", params: { id: request.clientAttachmentId }, [LOGICAL_CLIENT_FIELD]: clientId }));
    assert.equal(((await waitFor(frames, frame => frame.id === "remove-1")).error as any).code, -32602);
    assert.equal((await readFile(path)).toString("utf8"), "hello world");
    await adapter.send(JSON.stringify({ id: "stage-unsent", method: "attachment/stage", params: {
      ...request, clientAttachmentId: "unsent-file",
    }, [LOGICAL_CLIENT_FIELD]: clientId }));
    const unsentPath = ((await waitFor(frames, frame => frame.id === "stage-unsent")).result as any).ref.location.path as string;
    await adapter.send(JSON.stringify({ id: "remove-unsent", method: "attachment/remove", params: { id: "unsent-file" }, [LOGICAL_CLIENT_FIELD]: clientId }));
    assert.deepEqual((await waitFor(frames, frame => frame.id === "remove-unsent")).result, { removed: true });
    await assert.rejects(() => readFile(unsentPath));
    await adapter.send(JSON.stringify({ id: "stale-file", method: "turn/steer", params: {
      threadId: actualThreadId, expectedTurnId: (turn.result as any).turn.id,
      clientUserMessageId: "stale-file", input: [{ type: "mention", name: "notes.md", path: unsentPath }],
    }, [LOGICAL_CLIENT_FIELD]: clientId }));
    assert.equal(((await waitFor(frames, frame => frame.id === "stale-file")).error as any).code, -32602);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex desktop authorization reads the engine Thread and retires logical Client grants", async t => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-desktop-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let inspections = 0;
  const desktop = new LocalDesktopService({ serverId: "backend-server", environmentId: "backend-machine", principalId: "local-owner",
    observer: { inspect: async () => { inspections++; return "a".repeat(64); }, open: async () => { throw new Error("not needed"); } } });
  t.after(() => desktop.close());
  const revoked: string[] = [], release: string[] = [];
  const originalRevoke = desktop.revoke.bind(desktop), originalRelease = desktop.release.bind(desktop);
  desktop.revoke = key => { revoked.push(key); originalRevoke(key); };
  desktop.release = (key, id) => { release.push(key); originalRelease(key, id); };
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, undefined, desktop);
  t.after(() => adapter.close());
  await adapter.connect();
  await initializeClient(adapter, frames, "client-a");
  const init = frames.find(frame => frame.id === "client-a:init")!;
  assert.deepEqual((init.result as any).capabilities.extensions[OPENCRAFT_DESKTOP_EXTENSION], desktop.capability());
  const request = async (id: string, method: string, params: unknown, client = "client-a") => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
    return waitFor(frames, frame => frame.id === id);
  };
  assert.ok((await request("not-durable", OPENCRAFT_DESKTOP_ATTACH, { threadId: "missing-thread" })).error);
  assert.equal(inspections, 0, "native observer must not run for nonexistent/ephemeral Thread");
  await request("resume-desktop", "thread/resume", { threadId: "desktop-thread" });
  assert.ok((await request("forged-instance", OPENCRAFT_DESKTOP_ATTACH, { threadId: "desktop-thread", instanceId: "attacker" })).error);
  await adapter.send(JSON.stringify({ id: "uninitialized", method: OPENCRAFT_DESKTOP_ATTACH,
    params: { threadId: "desktop-thread" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
  assert.equal(((await waitFor(frames, frame => frame.id === "uninitialized")).error as any).code, -32600);
  assert.equal(inspections, 0);
  const attached = await request("grant", OPENCRAFT_DESKTOP_ATTACH, { threadId: "desktop-thread" });
  const credential = attached.result as any;
  assert.equal(credential.target.conversationId, "desktop-thread");
  assert.equal(credential.target.serverId, "backend-server");
  assert.equal(credential.instanceId, "backend-machine");
  await initializeClient(adapter, frames, "client-b");
  await request("foreign-release", OPENCRAFT_DESKTOP_RELEASE, { attachmentId: credential.attachmentId }, "client-b");
  const foreignKey = release.at(-1)!;
  await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
  assert.notEqual(revoked.at(-1), foreignKey);
  const oldKey = revoked.at(-1);
  // Reusing the same Client ID is a different authorization epoch.
  frames.splice(0);
  await initializeClient(adapter, frames, "client-a");
  await request("new-grant", OPENCRAFT_DESKTOP_ATTACH, { threadId: "desktop-thread" });
  await adapter.close();
  assert.ok(revoked.some(key => key !== oldKey && key !== foreignKey));
});

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
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath, [new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }),
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
      event: "turn-interrupt", clientId: "client-a", requestId: diagnostics.find(event => event.event === "turn-interrupt")?.requestId,
      threadId: "thread-a", turnId: "turn-a", pid: diagnostics.find(event => event.event === "appserver-start")?.pid,
    });
    assert.match(String(diagnostics.find(event => event.event === "turn-interrupt")?.requestId), /^opencraft:\d+$/);
    assert.ok(diagnostics.some(event => event.event === "client-disconnect" && event.clientId === "client-b"));
    assert.ok(diagnostics.some(event => event.event === "client-initialize" && event.clientId === "client-a" && event.outcome === "succeeded"));
    assert.doesNotMatch(JSON.stringify(diagnostics), /must not be logged/);
    const serverRequest = await waitFor(frames, frame => frame.id === 900 && frame.method === "item/tool/requestUserInput");
    assert.equal(serverRequest[LOGICAL_CLIENT_FIELD], "client-a");
    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const resolved = await waitFor(frames, frame => frame.method === "serverRequest/resolved");
    assert.equal(resolved[LOGICAL_CLIENT_FIELD], "client-a");
    await adapter.send(JSON.stringify({ id: "a:resume", method: "thread/resume", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.id === "a:resume");
    assert.ok(diagnostics.some(event => event.event === "thread-resume-start" && event.clientId === "client-a" && event.threadId === "fixture-thread-1"));
    assert.ok(diagnostics.some(event => event.event === "thread-resume-finish" && event.clientId === "client-a" && event.threadId === "fixture-thread-1" && event.outcome === "succeeded"));

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
    await adapter.send(JSON.stringify({ id: "b:resume", method: "thread/resume", params: { threadId: "fixture-thread-1", testDelayMs: 50 }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const before = frames.length;
    await adapter.send(JSON.stringify({ id: "a:probe", method: "test/emitThreadNotification", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
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
    const threadId = "fixture-thread-1";
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
    const threadId = "fixture-thread-1";
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
      await send("client-b", id, "test/emitThreadNotification", { threadId: "fixture-thread-1" });
      const probe = await waitFor(frames, frame => frame.id === id);
      if ((probe.result as any).nativeSubscribed === false) {
        released = true;
        break;
      }
    }
    assert.equal(released, true);
    await send("client-b", "b:duplicate-unsubscribe", "thread/unsubscribe", { threadId: "fixture-thread-1" });
    assert.deepEqual((await waitFor(frames, frame => frame.id === "b:duplicate-unsubscribe")).result, { status: "notSubscribed" });
    await send("client-b", "b:resume", "thread/resume", { threadId: "fixture-thread-1" });
    await waitFor(frames, frame => frame.id === "b:resume");
    await send("client-b", "b:probe-after-resume", "test/emitThreadNotification", { threadId: "fixture-thread-1" });
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

test("Host-owned Codex queue admits a second steer before the first appears in history", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-queue-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, "defer-history");
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
      threadId: "fixture-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first",
    });
    const activeTurnId = (started.result as any).turn.id;
    const added = await request("add", "thread/queue/add", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "follow up" }], clientUserMessageId: "queued-1",
    });
    const queuedId = (added.result as any).queuedSubmission.id;
    const secondAdded = await request("add-2", "thread/queue/add", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "another follow up" }], clientUserMessageId: "queued-2",
    });
    const secondQueuedId = (secondAdded.result as any).queuedSubmission.id;
    const queued = await request("list-1", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.equal((queued.result as any).data[0].id, queuedId);
    const steered = await request("steer", "thread/queue/steer", {
      threadId: "fixture-thread-1", queuedSubmissionId: queuedId, expectedTurnId: activeTurnId,
    });
    assert.deepEqual(steered.result, { turnId: activeTurnId });
    const afterSteer = await request("list-2", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.equal((afterSteer.result as any).data[0].id, secondQueuedId);
    assert.equal((afterSteer.result as any).steering[0].clientUserMessageId, "queued-1");
    const secondSteer = await request("steer-2", "thread/queue/steer", {
      threadId: "fixture-thread-1", queuedSubmissionId: secondQueuedId, expectedTurnId: activeTurnId,
    });
    assert.deepEqual(secondSteer.result, { turnId: activeTurnId });
    const afterSecondSteer = await request("list-3", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.deepEqual((afterSecondSteer.result as any).data, []);
    assert.deepEqual((afterSecondSteer.result as any).steering.map((item: any) => item.clientUserMessageId), ["queued-1", "queued-2"]);
    await request("complete", "test/completeTurn", { threadId: "fixture-thread-1" });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listed = await request(`list-final-${attempt}`, "thread/queue/list", { threadId: "fixture-thread-1" });
      if ((listed.result as any).steering.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const settled = await request("settled", "thread/queue/list", { threadId: "fixture-thread-1" });
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
      threadId: "fixture-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first",
    });
    const targetTurnId = (turn.result as any).turn.id;
    const added = await request("add", "thread/queue/add", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "possibly delivered" }], clientUserMessageId: "maybe-1",
    });
    const queuedId = (added.result as any).queuedSubmission.id;
    const next = await request("add-next", "thread/queue/add", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "must wait" }], clientUserMessageId: "next-1",
    });
    const steer = await request("steer", "thread/queue/steer", {
      threadId: "fixture-thread-1", queuedSubmissionId: queuedId, expectedTurnId: targetTurnId,
    });
    assert.ok(steer.error);
    const unknown = await request("unknown", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.equal((unknown.result as any).steering[0].pausedReason, "steer-delivery-unconfirmed");
    const blocked = await request("blocked", "thread/queue/steer", {
      threadId: "fixture-thread-1", queuedSubmissionId: (next.result as any).queuedSubmission.id, expectedTurnId: targetTurnId,
    });
    assert.match((blocked.error as any).message, /Earlier delivery is unconfirmed/);
    const stillQueued = await request("still-queued", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.equal((stillQueued.result as any).data[0].clientUserMessageId, "next-1");
    await request("complete", "test/completeTurn", { threadId: "fixture-thread-1" });
    const deleted = await request("discard", "thread/queue/delete", {
      threadId: "fixture-thread-1", queuedSubmissionId: queuedId,
      expectedTurnId: targetTurnId, acknowledgeUnknownDelivery: true,
    });
    assert.deepEqual(deleted.result, { deleted: true });
    const settled = await request("settled", "thread/queue/list", { threadId: "fixture-thread-1" });
    assert.deepEqual((settled.result as any).steering, []);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a queued start with an unknown target reconciles against all Turn history by client message identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-host-unknown-start-"));
  const dataRoot = join(root, "data");
  await mkdir(dataRoot);
  const queue = new OpenCraftHostQueue(dataRoot);
  const claim = queue.add("fixture-thread-1", "accepted-before-restart", [{ type: "text", text: "same input" }]);
  queue.claim("fixture-thread-1", claim.id, "unknown");
  queue.settle("fixture-thread-1", claim.id, "unknown", "steer-delivery-unconfirmed");
  queue.close();
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
      threadId: "fixture-thread-1", input: [{ type: "text", text: "same input" }], clientUserMessageId: "accepted-before-restart",
    });
    let reconciled = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listed = await request(`list-${attempt}`, "thread/queue/list", { threadId: "fixture-thread-1" });
      if ((listed.result as any).steering.length === 0) { reconciled = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(reconciled, true);
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
      threadId: "fixture-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first",
    });
    const firstTurnId = (first.result as any).turn.id;
    await request("add", "thread/queue/add", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "next" }], clientUserMessageId: "next",
    });
    await request("complete", "test/completeTurn", { threadId: "fixture-thread-1" });
    const second = await waitFor(frames, frame => frame.method === "turn/started" && (frame.params as any).turn.id !== firstTurnId);
    assert.ok((second.params as any).turn.id);
    const listed = await request("listed", "thread/queue/list", { threadId: "fixture-thread-1" });
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
  const threadId = "fixture-thread-1";
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

test("a closed client releases its thread subscriptions and native Codex context", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-disconnect-release-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames, 0, undefined, 10);
  const threadId = "fixture-thread-1";
  let sequence = 0;
  const request = async (clientId: string, method: string, params: Record<string, unknown>) => {
    const id = `disconnect-${++sequence}`;
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    return waitFor(frames, frame => frame.id === id);
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await initializeClient(adapter, frames, "client-b");
    await request("client-a", "thread/start", { cwd: root });
    await waitFor(frames, frame => frame.id === 900 && frame.method === "item/tool/requestUserInput");
    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.method === "serverRequest/resolved");
    assert.deepEqual((await request("client-a", "test/emitThreadNotification", { threadId })).result, { nativeSubscribed: true });
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    let released = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const probe = await request("client-b", "test/emitThreadNotification", { threadId });
      if ((probe.result as { nativeSubscribed?: boolean }).nativeSubscribed === false) { released = true; break; }
    }
    assert.equal(released, true, "the disconnected client no longer retains the native Thread subscription");
    assert.equal(frames.some(frame => frame[LOGICAL_CLIENT_FIELD] === "client-a"
      && frame.method === "thread/started"), true, "the prior subscription remains observable history");
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
      threadId: "fixture-thread-1", input: [{ type: "text", text: "first" }], clientUserMessageId: "first",
    });
    const added = await request("add", "thread/queue/add", {
      threadId: "fixture-thread-1", input: [{ type: "text", text: "follow" }], clientUserMessageId: "follow",
    });
    const queuedId = (added.result as any).queuedSubmission.id;
    const rejected = await request("steer", "thread/queue/steer", {
      threadId: "fixture-thread-1", queuedSubmissionId: queuedId, expectedTurnId: "stale-turn",
    });
    assert.ok(rejected.error);
    const listed = await request("listed", "thread/queue/list", { threadId: "fixture-thread-1" });
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
  const queue = new OpenCraftHostQueue(dataRoot);
  const uncertain = queue.add("fixture-thread-1", "uncertain", [{ type: "text", text: "maybe" }]);
  queue.claim("fixture-thread-1", uncertain.id, "turn-old");
  queue.add("fixture-thread-1", "later", [{ type: "text", text: "later" }]);
  queue.close();
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    await adapter.send(JSON.stringify({ id: "list", method: "thread/queue/list", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
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
  const queue = new OpenCraftHostQueue(dataRoot);
  queue.add("fixture-thread-1", "background", [{ type: "text", text: "continue" }]);
  queue.close();
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "client-a");
    let cleared = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const id = `list-${attempt}`;
      await adapter.send(JSON.stringify({ id, method: "thread/queue/list", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
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
    await adapter.send(JSON.stringify({ id: "a:fork", method: "thread/fork", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const forked = await waitFor(frames, frame => frame.id === "a:fork");
    assert.equal((forked.result as any).thread.id, "fixture-fork-1");
    const childStarted = await waitFor(frames, frame => frame.method === "thread/started" && (frame.params as any).thread.id === "fixture-fork-1");
    assert.equal(childStarted[LOGICAL_CLIENT_FIELD], "client-a");
    assert.equal(frames.some(frame => frame.method === "thread/started" && (frame.params as any).thread.id === "fixture-fork-1" && frame[LOGICAL_CLIENT_FIELD] === "client-b"), false);
    await adapter.send(JSON.stringify({ id: "a:failed-fork", method: "thread/fork", params: { threadId: "fixture-thread-1", testFail: true }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    const rejected = await waitFor(frames, frame => frame.id === "a:failed-fork");
    assert.match((rejected.error as { message: string }).message, /fork rejected/);
    assert.equal(frames.filter(frame => frame.method === "thread/started" && (frame.params as any).thread.id !== "fixture-thread-1").length, 1);
    await adapter.send(JSON.stringify({ id: "b:late-fork", method: "thread/fork", params: { threadId: "fixture-thread-1", testDelayMs: 50 }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-b" }));
    await waitFor(frames, frame => frame.method === "test/delayedResponseSent");
    assert.equal(frames.some(frame => frame.id === "b:late-fork"), false);
    await adapter.send(JSON.stringify({ id: "a:emit", method: "test/emitServerRequest", params: { threadId: "fixture-fork-late" }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
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
    await adapter.send(JSON.stringify({ id: "b:probe", method: "test/emitThreadNotification", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    assert.deepEqual((await waitFor(frames, frame => frame.id === "b:probe")).result, { nativeSubscribed: true });
    await adapter.send(JSON.stringify({ id: "b:emit", method: "test/emitServerRequest", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const emitted = await waitFor(frames, frame => frame.id === "b:emit");
    const requestId = (emitted.result as { requestId: number }).requestId;
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);
    await adapter.send(JSON.stringify({ id: 900, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await adapter.send(JSON.stringify({ id: requestId, result: { answers: {} }, [LOGICAL_CLIENT_FIELD]: "client-b" }));

    await initializeClient(adapter, frames, "client-c");
    await adapter.send(JSON.stringify({ id: "c:resume", method: "thread/resume", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-c" }));
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
    await adapter.send(JSON.stringify({ id: "a:resume", method: "thread/resume", params: { threadId: "fixture-thread-1", testDelayMs: 50 }, [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "client-a" }));
    await waitFor(frames, frame => frame.method === "test/delayedResponseSent");
    assert.equal(frames.some(frame => frame.id === "a:resume"), false);
    await adapter.send(JSON.stringify({ id: "b:emit", method: "test/emitServerRequest", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    const emitted = await waitFor(frames, frame => frame.id === "b:emit");
    const requestId = (emitted.result as { requestId: number }).requestId;
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);

    await adapter.send(JSON.stringify({ id: "b:wrong-resume", method: "thread/resume", params: { threadId: "fixture-thread-1", testWrongThreadId: true }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
    await waitFor(frames, frame => frame.id === "b:wrong-resume");
    assert.equal(frames.some(frame => frame.id === requestId && frame.method === "item/tool/requestUserInput"), false);

    await adapter.send(JSON.stringify({ id: "b:resume", method: "thread/resume", params: { threadId: "fixture-thread-1" }, [LOGICAL_CLIENT_FIELD]: "client-b" }));
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
    spawnAppServer: ({ cwd, env }) => spawn(process.execPath, [new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }),
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
    const refreshing = adapter.send(JSON.stringify({
      id: "quota-refresh", method: "opencraft/codex/accounts/refresh", params: { accountId: "account-a" },
      [LOGICAL_CLIENT_FIELD]: "client-a",
    }));
    releaseUsage(Response.json({ plan_type: "pro", rate_limit_reset_credits: { available_count: 3 },
      rate_limit: { primary_window: { used_percent: 5 } } }));
    await refreshing;
    const refreshed = await waitFor(frames, frame => frame.id === "quota-refresh");
    assert.equal((refreshed.result as any).accounts[0].resetCredits.availableCount, 3);
    assert.ok((refreshed.result as any).accounts[0].resetCredits.observedAt > 0);
    assert.doesNotMatch(JSON.stringify(refreshed), /access-a|refresh-a/);
  } finally {
    releaseUsage(Response.json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 5 } } }));
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host binds each submission to its trusted sender and keeps queued authors through another client's dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-message-senders-integration-"));
  const frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames);
  const a = { kind: "employee" as const, loginName: "employee.a" };
  const b = { kind: "employee" as const, loginName: "employee.b" };
  let seq = 0;
  const request = async (client: string, method: string, params: Record<string, unknown>, sender = a, validUntil = Date.now() + 60_000) => {
    const id = `sender-${++seq}`;
    await adapter.sendWithContext(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }), { sender, validUntil });
    return await waitFor(frames, frame => frame.id === id) as any;
  };
  try {
    await adapter.connect();
    await initializeClient(adapter, frames, "a"); await initializeClient(adapter, frames, "b");
    const threadId = (await request("a", "thread/start", { testNoServerRequest: true })).result.thread.id;
    const first = await request("a", "turn/start", { threadId, clientUserMessageId: "first", input: [{ type: "text", text: "one" }], sender: b });
    const turnId = first.result.turn.id;
    assert.ok((await request("b", "turn/steer", { threadId, expectedTurnId: turnId, clientUserMessageId: "second", input: [{ type: "text", text: "two" }] }, b)).result);
    const added = await request("a", "thread/queue/add", { threadId, clientUserMessageId: "third", input: [{ type: "text", text: "three" }] });
    assert.deepEqual(added.result.queuedSubmission.sender, a);
    // A repeat ID from another employee must not change authorship or reach native Codex.
    const collision = await request("b", "turn/steer", { threadId, expectedTurnId: turnId, clientUserMessageId: "first", input: [{ type: "text", text: "overwrite" }] }, b);
    assert.match(collision.error.message, /another sender/);
    const expired = await request("a", "turn/steer", { threadId, expectedTurnId: turnId, clientUserMessageId: "expired", input: [{ type: "text", text: "expired" }] }, a, Date.now() - 1);
    assert.match(expired.error.message, /expired/);
    // Explicit queue steer is initiated by B, while the queued message remains A's.
    assert.ok((await request("b", "thread/queue/steer", { threadId, expectedTurnId: turnId, queuedSubmissionId: added.result.queuedSubmission.id }, b)).result);
    const history = (await request("b", "thread/items/list", { threadId }, b)).result.data;
    assert.deepEqual(history.map((entry: any) => entry.item.sender), [a, b, a]);
    const native = (await request("a", "test/readAcceptedInputs", {})).result.data;
    assert.deepEqual(native.map((entry: any) => entry.params.input[0].text), ["one", "two", "three"]);
    assert.doesNotMatch(JSON.stringify(native), /employee\.|loginName|staffId|"sender"/);
    const withoutId = await request("a", "turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: "no id" }] });
    assert.match(withoutId.error.message, /Message identity/);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test("scheduled permission snapshots reach native Codex and survive adapter recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-schedule-permissions-"));
  let frames: Array<Record<string, unknown>> = [], adapter = createRoutingAdapter(root, frames);
  const request = async (id: string, method: string, params: Record<string, unknown>) => {
    await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const response = await waitFor(frames, frame => frame.id === id);
    assert.equal(response.error, undefined); return response.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const threadId = (await request("schedule:create", "thread/start", { cwd: root, testNoServerRequest: true })).thread.id;
    const view = await request("schedule:read", "opencraft/schedules/read", { threadId });
    assert.ok(view.permissionProfiles.some((profile: any) => profile.id === "opencraft:permission-mode:full" && profile.allowed));
    await request("schedule:save", "opencraft/schedules/save", { threadId, expectedRevision: 0, prompt: "scheduled check",
      nextRunAt: Date.now() + 60000, intervalMinutes: 60, timeZone: "UTC", permissions: "opencraft:permission-mode:full" });
    await adapter.close(); frames = []; adapter = createRoutingAdapter(root, frames);
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const restored = await request("schedule:restored", "opencraft/schedules/read", { threadId });
    assert.equal(restored.schedule.permissions, "opencraft:permission-mode:full");
    await request("schedule:now", "opencraft/schedules/action", { threadId, expectedRevision: restored.schedule.revision, action: "run-now" });
    let inputs: any[] = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      inputs = (await request(`schedule:inputs:${attempt}`, "test/readAcceptedInputs", {})).data;
      if (inputs.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(inputs.length, 1);
    assert.equal(inputs.at(-1).params.permissions, ":danger-full-access");
    assert.match(inputs.at(-1).params.clientUserMessageId, /^schedule:/);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});



test("native auth rejection fails initialization before a logical client becomes ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-native-auth-reject-"));
  const frames: Record<string, unknown>[] = [];
  const adapter = new CodexEngineAdapter({ executable: process.execPath, runtimeDirectory: root,
    dataDirectory: join(root, "data"), nativeCodexHomeDirectory: join(root, "native"),
    fetch: async () => Response.json({}), logDiagnostic: () => undefined,
    createMaintenanceClient: async () => { throw new Error("not used"); },
    spawnAppServer: ({ cwd, env }) => {
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.CODEX_API_KEY, undefined);
      return spawn(process.execPath, [new URL("../fixtures/fake-codex-stdio-appserver.mjs", import.meta.url).pathname],
        { cwd, env: { ...env, OPENCRAFT_TEST_REJECT_POOL_AUTH: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    },
  });
  adapter.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  try {
    await adapter.connect();
    await adapter.send(JSON.stringify({ id: "native-auth", method: "initialize", params: {
      clientInfo: { name: "test", version: "1" }, capabilities: { experimentalApi: true },
    }, [LOGICAL_CLIENT_FIELD]: "client" }));
    const result = await waitFor(frames, frame => frame.id === "native-auth");
    assert.equal(result.result, undefined);
    assert.equal((result.error as any).message, "Codex initialization failed");
    assert.equal(adapter.status.state, "failed");
    assert.doesNotMatch(JSON.stringify(frames), /accessToken|eyJhbGci/);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});



test("usage attempts follow the actual queue dispatcher and retain definitive rejection outcomes",async()=>{
 const root=await mkdtemp(join(tmpdir(),"oc-usage-attempt-host-")),frames:Array<Record<string,unknown>>=[];
 const adapter=createRoutingAdapter(root,frames,0,undefined,undefined,undefined,false,{serverId:"fixture",actor:context=>({id:context.actorId,kind:"human"}),submission:(threadId,inputId)=>inputId.startsWith("queued-")?{threadId,inputId,actorId:"A",actorKind:"human",mode:"start",sourceKind:"human",submittedAt:1000}:null});
 let seq=0;
 const request=async(actorId:string,method:string,params:Record<string,unknown>)=>{
  const id="usage-attempt:"+(++seq);
  await adapter.sendWithContext(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:actorId}),{sender:null,actorContext:{actorId,generation:1,credentialId:null,expiresAt:Date.now()+60000}});
  return await waitFor(frames,f=>f.id===id) as any;
 };
 try{
  await adapter.connect();await initializeClient(adapter,frames,"A");await initializeClient(adapter,frames,"B");
  const threadId=(await request("A","thread/start",{testNoServerRequest:true})).result.thread.id;
  const turnId=(await request("A","turn/start",{threadId,clientUserMessageId:"start-A",input:[{type:"text",text:"synthetic"}]})).result.turn.id;
  const queued=(await request("A","thread/queue/add",{threadId,clientUserMessageId:"queued-A",input:[{type:"text",text:"synthetic"}]})).result.queuedSubmission;
  assert.ok((await request("B","thread/queue/steer",{threadId,queuedSubmissionId:queued.id,expectedTurnId:turnId})).result);
  const rejected=await request("B","turn/steer",{threadId,clientUserMessageId:"rejected-B",expectedTurnId:"different-turn",input:[{type:"text",text:"synthetic"}]});
  assert.ok(rejected.error);
  const db=new DatabaseSync(join(root,"data","token-usage.sqlite"),{readOnly:true});
  try{
   const dispatched=db.prepare("SELECT actor_id,mode,outcome,turn_id FROM token_usage_attempts WHERE input_id='queued-A'").get()!;
   assert.deepEqual({...dispatched},{actor_id:"B",mode:"steer",outcome:"accepted",turn_id:turnId});
   assert.equal(db.prepare("SELECT actor_id FROM token_usage_submissions WHERE input_id='queued-A'").get()!.actor_id,"B");
   assert.equal(db.prepare("SELECT outcome FROM token_usage_attempts WHERE input_id='rejected-B'").get()!.outcome,"rejected");
   assert.equal(db.prepare("SELECT count(*) AS n FROM token_usage_admissions WHERE input_id='rejected-B'").get()!.n,0);
   const fallback=(await request("A","thread/queue/add",{threadId,clientUserMessageId:"queued-fallback",input:[{type:"text",text:"synthetic"}]})).result.queuedSubmission;
   assert.ok((await request("B","thread/queue/steer",{threadId,queuedSubmissionId:fallback.id,expectedTurnId:"different-turn"})).error);
   await request("A","test/completeTurn",{threadId});
   const deadline=Date.now()+3000;
   while(Date.now()<deadline&&!db.prepare("SELECT 1 FROM token_usage_attempts WHERE input_id='queued-fallback' AND outcome='accepted'").get())await new Promise(resolve=>setTimeout(resolve,10));
   const attempts=db.prepare("SELECT actor_id,mode,outcome FROM token_usage_attempts WHERE input_id='queued-fallback' ORDER BY submitted_ms,attempt_id").all();
   assert.equal(attempts.length,2);
   assert.ok(attempts.some(row=>row.actor_id==="B"&&row.mode==="steer"&&row.outcome==="rejected"));
   assert.ok(attempts.some(row=>row.actor_id==="A"&&row.mode==="start"&&row.outcome==="accepted"));
   assert.equal(db.prepare("SELECT count(*) AS n FROM token_usage_input_conflicts WHERE input_id='queued-fallback'").get()!.n,0);
  }finally{db.close();}
 }finally{await adapter.close();await rm(root,{recursive:true,force:true});}
});

test("ambiguous native rejection remains unknown and exposes a recovery gap",async()=>{
 const root=await mkdtemp(join(tmpdir(),"oc-usage-unknown-host-")),frames:Array<Record<string,unknown>>=[];
 const adapter=createRoutingAdapter(root,frames,0,"ambiguous");let seq=0;
 const request=async(method:string,params:Record<string,unknown>)=>{
  const id="usage-unknown:"+(++seq);await adapter.send(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:"writer"}));return await waitFor(frames,f=>f.id===id) as any;
 };
 try{
  await adapter.connect();await initializeClient(adapter,frames,"writer");
  const threadId=(await request("thread/start",{testNoServerRequest:true})).result.thread.id;
  const turnId=(await request("turn/start",{threadId,clientUserMessageId:"initial",input:[{type:"text",text:"synthetic"}]})).result.turn.id;
  assert.ok((await request("turn/steer",{threadId,expectedTurnId:turnId,clientUserMessageId:"uncertain",input:[{type:"text",text:"synthetic"}]})).error);
  const db=new DatabaseSync(join(root,"data","token-usage.sqlite"),{readOnly:true});
  try{
   assert.equal(db.prepare("SELECT outcome FROM token_usage_attempts WHERE input_id='uncertain'").get()!.outcome,"unknown");
   assert.equal(db.prepare("SELECT count(*) AS n FROM token_usage_admissions WHERE input_id='uncertain'").get()!.n,0);
   assert.ok(Number(db.prepare("SELECT count(*) AS n FROM token_usage_gaps WHERE thread_id=? AND ends_ms IS NULL").get(threadId)!.n)>0);
  }finally{db.close();}
 }finally{await adapter.close();await rm(root,{recursive:true,force:true});}
});

test("scheduled Codex completion is observed from native events without a history read", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-schedule-events-")), frames: Array<Record<string, unknown>> = [];
  const adapter = createRoutingAdapter(root, frames); let seq = 0, inspections = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = `schedule-event:${++seq}`; await adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "writer" }));
    const response = await waitFor(frames, f => f.id === id); assert.equal(response.error, undefined); return response.result as any;
  };
  try {
    await adapter.connect(); await initializeClient(adapter, frames, "writer");
    const threadId = (await request("thread/start", { cwd: root, testNoServerRequest: true })).thread.id;
    (adapter as any).findScheduledTurn = async () => { inspections++; throw new Error("completion must not read history"); };
    await request("opencraft/schedules/save", { threadId, expectedRevision: 0, prompt: "work", nextRunAt: Date.now(), intervalMinutes: null, timeZone: "UTC" });
    await (adapter as any).schedules.tick();
    const active = await request("opencraft/schedules/read", { threadId }); assert.equal(active.runs[0].state, "running");
    await request("test/completeTurn", { threadId }); await (adapter as any).schedules.tick();
    const done = await request("opencraft/schedules/read", { threadId }); assert.equal(done.runs[0].state, "completed");
    assert.equal(inspections, 0); assert.equal((await request("test/readAcceptedInputs", {})).data.length, 1);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});
