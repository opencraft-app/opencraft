import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AccountPoolStore, acquireCodexWriter, CodexCoreControlClient } from "@opencraft/account-pool-host";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { startCodexCore, type CodexCoreOptions } from "../../apps/codex-core/src/main.js";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";

const token = "synthetic-core-token-".repeat(3);

test("Core reconnect publishes ready only after the new native initialize finishes", async () => {
  const f = await fixture();
  let hold = false, entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const engine = new CodexEngineAdapter({ ...f.options, coreEndpoint: f.core.endpoint, coreAuthToken: token,
    coreHostOverlays: true, logDiagnostic: () => {}, decorateNativeTransport: native => ({
      get status() { return native.status; },
      connect: signal => native.connect(signal), close: () => native.close(),
      subscribeMessage: listener => native.subscribeMessage(listener),
      subscribeStatus: listener => native.subscribeStatus(listener),
      send: async frame => {
        if (hold && JSON.parse(frame).method === "initialize") { entered = true; await gate; }
        await native.send(frame);
      },
    }) });
  let replacement: Awaited<ReturnType<typeof startCodexCore>> | undefined;
  const frames: any[] = [];
  const states: string[] = [];
  engine.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  engine.subscribeStatus(status => states.push(status.state));
  try {
    await engine.connect();
    await engine.send(JSON.stringify({ id: "first", method: "initialize", params: {}, [LOGICAL_CLIENT_FIELD]: "view" }));
    for (let n = 0; n < 300 && !frames.some(frame => frame.id === "first"); n++) await delay(10);
    assert.ok(frames.some(frame => frame.id === "first"));
    hold = true;
    await f.core.close();
    replacement = await startCodexCore(f.options);
    for (let n = 0; n < 400 && !entered; n++) await delay(10);
    assert.equal(entered, true);
    assert.equal(engine.status.state, "connecting");
    assert.notEqual(states.at(-1), "open");
    await assert.rejects(engine.send(JSON.stringify({ id: "early", method: "initialize", params: {}, [LOGICAL_CLIENT_FIELD]: "next" })), /not connected/);
    release();
    for (let n = 0; n < 300 && engine.status.state !== "open"; n++) await delay(10);
    assert.equal(engine.status.state, "open");
    await engine.send(JSON.stringify({ id: "after", method: "initialize", params: {}, [LOGICAL_CLIENT_FIELD]: "next" }));
    assert.ok(frames.some(frame => frame.id === "after" && frame.result));
  } finally { release(); await engine.close(); await replacement?.close(); await f.close(); }
});
test("failed Core initialize discards that connection and remains unavailable until a fresh handshake", async () => {
  const f = await fixture();
  let recovery = false, rejected = false, entered = false, release!: () => void, nativeOpens = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const listeners = new Set<(frame: string) => void>();
  const engine = new CodexEngineAdapter({ ...f.options, coreEndpoint: f.core.endpoint, coreAuthToken: token,
    coreHostOverlays: true, logDiagnostic: () => {}, decorateNativeTransport: native => ({
      get status() { return native.status; }, connect: signal => native.connect(signal), close: () => native.close(),
      subscribeMessage: listener => { listeners.add(listener); const stop = native.subscribeMessage(listener); return () => { listeners.delete(listener); stop(); }; },
      subscribeStatus: listener => native.subscribeStatus(status => { if (status.state === "open") nativeOpens++; listener(status); }),
      send: async frame => {
        const message = JSON.parse(frame);
        if (recovery && message.method === "initialize") {
          if (!rejected) {
            rejected = true;
            for (const listener of listeners) listener(JSON.stringify({ id: message.id, error: { code: -32000, message: "Synthetic initialize failure" } }));
            return;
          }
          entered = true; await gate;
        }
        await native.send(frame);
      },
    }) });
  let replacement: Awaited<ReturnType<typeof startCodexCore>> | undefined;
  const frames: any[] = []; engine.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  try {
    await engine.connect();
    await engine.send(JSON.stringify({ id: "first", method: "initialize", params: {}, [LOGICAL_CLIENT_FIELD]: "view" }));
    for (let n = 0; n < 300 && !frames.some(frame => frame.id === "first"); n++) await delay(10);
    recovery = true; await f.core.close(); replacement = await startCodexCore(f.options);
    for (let n = 0; n < 600 && !entered; n++) await delay(10);
    assert.equal(rejected, true); assert.equal(entered, true);
    assert.equal(nativeOpens, 3, "initial connection, rejected connection, then a fresh connection");
    assert.notEqual(engine.status.state, "open");
    await assert.rejects(engine.send(JSON.stringify({ id: "early", method: "initialize", params: {}, [LOGICAL_CLIENT_FIELD]: "next" })), /not connected/);
    release(); for (let n = 0; n < 300 && engine.status.state !== "open"; n++) await delay(10);
    assert.equal(engine.status.state, "open");
  } finally { release(); await engine.close(); await replacement?.close(); await f.close(); }
});
async function fixture(configure?: (options: CodexCoreOptions) => Promise<CodexCoreOptions>) {
  const root = await mkdtemp(join(tmpdir(), "oc-core-test-"));
  let options: CodexCoreOptions = {
    endpoint: join(root, "control.sock"), authToken: token,
    executable: process.execPath, runtimeDirectory: root, dataDirectory: join(root, "data"),
    nativeCodexHomeDirectory: join(root, "native"),
    fetch: async () => Response.json({ plan_type: "pro" }),
    spawnAppServer: ({ args, cwd, env }) => spawn(process.execPath,
      [new URL("../fixtures/fake-codex-unix-appserver.mjs", import.meta.url).pathname, args[2]!.slice("unix://".length)],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] }),
  };
  if (configure) options = await configure(options);
  const core = await startCodexCore(options);
  const control = new CodexCoreControlClient(core.endpoint, token);
  const adapters: CodexEngineAdapter[] = [];
  async function adapter(overlays = false) {
    const engine = new CodexEngineAdapter({ ...options, coreEndpoint: core.endpoint, coreAuthToken: token,
      // Remote mode must not touch any local account store or spawn a child.
      dataDirectory: overlays ? options.dataDirectory : join(root, "forbidden"),
      coreHostOverlays: overlays, logDiagnostic: () => undefined,
      spawnAppServer: () => { throw new Error("Remote mode spawned a writer"); } });
    adapters.push(engine);
    const frames: any[] = [];
    engine.subscribeMessage(frame => frames.push(JSON.parse(frame)));
    await engine.connect();
    let sequence = 0;
    async function rpc(client: string, method: string, params: object = {}) {
      const id = ++sequence;
      await engine.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
      for (let i = 0; i < 300; i++) {
        const frame = frames.find(value => value.id === id && !value.method && value[LOGICAL_CLIENT_FIELD] === client);
        if (frame) { if (frame.error) throw new Error(frame.error.message); return frame.result; }
        await delay(10);
      }
      throw new Error(`Timed out: ${method}`);
    }
    return { engine, rpc, frames };
  }
  return { root, options, core, control, adapter, async close() {
    await Promise.all(adapters.map(engine => engine.close()));
    await core.close(); await rm(root, { recursive: true, force: true });
  } };
}

test("core owns accounts and PID across independent daemon clients and zero connections", async () => {
  const f = await fixture();
  try {
    const before = await f.control.health();
    assert.equal((await stat(f.core.endpoint)).mode & 0o777, 0o600);
    assert.equal((await stat(before.nativeSocket)).mode & 0o777, 0o600);
    await assert.rejects(new CodexCoreControlClient(f.core.endpoint, "wrong").health(), /authentication failed/);
    const a = await f.adapter(), b = await f.adapter();
    await Promise.all([a.rpc("a", "initialize"), b.rpc("b", "initialize")]);
    await mkdir(f.options.nativeCodexHomeDirectory);
    const access = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600, email: "fixture@example.test",
      "https://api.openai.com/auth": { chatgpt_account_id: "fixture" },
    })).toString("base64url")}.synthetic`;
    await writeFile(join(f.options.nativeCodexHomeDirectory, "auth.json"), JSON.stringify({ auth_mode: "chatgpt",
      tokens: { access_token: access, refresh_token: "fixture-refresh", account_id: "fixture" } }));
    const { account } = await a.rpc("a", "opencraft/codex/accounts/import");
    await b.rpc("b", "opencraft/codex/accounts/setEnabled", { accountId: account.id, enabled: false });
    assert.equal((await a.rpc("a", "opencraft/codex/accounts/list")).accounts[0].enabled, false);
    await a.engine.close(); await b.engine.close();
    assert.deepEqual(await f.control.health(), before);
    const c = await f.adapter();
    const result = await c.rpc("c", "opencraft/codex/accounts/list");
    assert.equal(result.accounts[0].id, account.id);
    assert.doesNotMatch(JSON.stringify(result), /fixture-refresh|\.synthetic/);
    assert.equal(existsSync(join(f.root, "forbidden")), false);
  } finally { await f.close(); }
});

test("logical unsubscribe/disconnect preserves another subscriber, including pending resume", async () => {
  const f = await fixture();
  try {
    const a = await f.adapter(), independent = await f.adapter();
    await a.rpc("a", "initialize"); await a.rpc("b", "initialize"); await independent.rpc("c", "initialize");
    const { thread } = await a.rpc("a", "thread/start");
    const params = { threadId: thread.id };
    await independent.rpc("c", "thread/resume", params);
    const pending = a.rpc("b", "thread/resume", { ...params, fixtureDelay: true });
    await a.rpc("a", "thread/unsubscribe", params);
    await pending;
    await independent.rpc("c", "fixture/publish", { ...params, delta: "still subscribed" });
    await delay(30);
    assert.ok(a.frames.some(frame => frame.method === "item/agentMessage/delta" && frame[LOGICAL_CLIENT_FIELD] === "b"));
    assert.equal((await independent.rpc("c", "fixture/subscribers", params)).count, 2);
    await a.engine.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "b" }));
    await delay(30);
    assert.equal((await independent.rpc("c", "fixture/subscribers", params)).count, 1);
    await independent.engine.close();
    assert.ok((await f.control.health()).codexPid);
  } finally { await f.close(); }
});

test("second writer fails before opening accounts and remote unavailability never falls back", async () => {
  const f = await fixture();
  try {
    await assert.rejects(startCodexCore({ ...f.options, endpoint: join(f.root, "second", "control.sock") }), /already owned/);
    const embedded = new CodexEngineAdapter(f.options);
    await assert.rejects(embedded.connect(), /already owned/);
    await embedded.close();
    const remote = new CodexEngineAdapter({ ...f.options, coreEndpoint: join(f.root, "missing.sock"), coreAuthToken: token,
      dataDirectory: join(f.root, "forbidden"), spawnAppServer: () => { throw new Error("Unexpected fallback"); } });
    await assert.rejects(remote.connect(), /Codex core unavailable.*missing.sock/);
    assert.equal(remote.status.state, "failed");
    await remote.close();
    assert.equal(existsSync(join(f.root, "forbidden")), false);
  } finally { await f.close(); }
});

test("failed pending resume releases the native subscription after its last prior subscriber leaves", async () => {
  const f = await fixture();
  try {
    const a = await f.adapter(), observer = await f.adapter();
    await a.rpc("a", "initialize"); await a.rpc("b", "initialize"); await observer.rpc("observer", "initialize");
    const { thread } = await a.rpc("a", "thread/start");
    const params = { threadId: thread.id };
    const rejected = assert.rejects(a.rpc("b", "thread/resume", { ...params, fixtureReject: true }), /Resume rejected/);
    await a.engine.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "a" }));
    await rejected;
    assert.equal((await observer.rpc("observer", "fixture/subscribers", params)).count, 0);
    await observer.rpc("observer", "fixture/publish", { ...params, delta: "must not leak to unrelated client" });
    await delay(30);
    assert.equal(a.frames.some(frame => frame.method === "item/agentMessage/delta"), false);
  } finally { await f.close(); }
});

test("core shutdown retains writer ownership until an aborted proxy refresh persists its rotated credential", async () => {
  let finishRefresh!: () => void, startedRefresh!: () => void;
  const heldRefresh = new Promise<void>(resolve => { finishRefresh = resolve; });
  const refreshStarted = new Promise<void>(resolve => { startedRefresh = resolve; });
  let baseUrl = "", hostToken = "", maintenanceClosed = false;
  const f = await fixture(async options => {
    const store = new AccountPoolStore({ databasePath: join(options.dataDirectory, "account-pool.sqlite"),
      secretsDirectory: join(options.dataDirectory, "secrets") });
    store.addAccount({ id: "fixture", provider: "codex", label: "fixture", upstreamAccountId: "fixture", priority: 1, enabled: true },
      { accessToken: "initial-synthetic", refreshToken: "old-synthetic", expiresAt: null });
    store.close();
    return { ...options,
      fetch: async (input, init) => String(input).includes("/wham/usage") ? Response.json({ plan_type: "fixture" })
        : new Headers(init?.headers).get("authorization") === "Bearer initial-synthetic"
          ? new Response(null, { status: 401 }) : Response.json({ ok: true }),
      createMaintenanceClient: async profile => ({
        async request<T>() {
          startedRefresh(); await heldRefresh;
          await writeFile(join(profile, "auth.json"), JSON.stringify({ tokens: {
            account_id: "fixture", access_token: "rotated-synthetic", refresh_token: "new-synthetic",
          } }));
          return {} as T;
        },
        subscribeNotification: () => () => undefined,
        async close() { maintenanceClosed = true; },
      }),
      spawnAppServer(input) {
        const setting = input.args.find(arg => arg.startsWith("model_providers.opencraft-account-pool.base_url="))!;
        baseUrl = JSON.parse(setting.slice(setting.indexOf("=") + 1));
        hostToken = input.env.OPENCRAFT_CODEX_POOL_AUTH_TOKEN!;
        return options.spawnAppServer!(input);
      },
    };
  });
  const abort = new AbortController();
  const inference = fetch(`${baseUrl}/responses`, { method: "POST", headers: {
    "x-opencraft-account-pool-token": hostToken, "content-type": "application/json",
  }, body: JSON.stringify({ model: "fixture", input: [] }), signal: abort.signal }).catch(() => undefined);
  try {
    await Promise.race([refreshStarted, delay(3000).then(() => { throw new Error("Refresh did not start"); })]);
    abort.abort(); await inference;
    let closed = false;
    const closing = f.core.close().then(() => { closed = true; });
    await delay(80);
    assert.equal(closed, false);
    await assert.rejects(acquireCodexWriter(f.options.dataDirectory), /already owned/);
    finishRefresh(); await closing;
    assert.equal(maintenanceClosed, true);
    const release = await acquireCodexWriter(f.options.dataDirectory);
    const reopened = new AccountPoolStore({ databasePath: join(f.options.dataDirectory, "account-pool.sqlite"),
      secretsDirectory: join(f.options.dataDirectory, "secrets") });
    assert.equal(reopened.readCredential("fixture").refreshToken, "new-synthetic");
    reopened.close(); release();
  } finally { finishRefresh(); abort.abort(); await inference; await f.close(); }
});

test("Headless core mode retains overlay stores, sender and unique owner across reconnect without stopping core", async () => {
  const f = await fixture();
  try {
    const before = await f.control.health();
    const a = await f.adapter(true);
    const initialized = await a.rpc("a", "initialize");
    assert.equal(initialized.capabilities.extensions["opencraft/bot-conversations"], undefined);
    assert.ok(a.engine.storageOutcomes.some(row => row.name === "opencraft-host-state" && row.outcome.appliedVersion === 14));
    assert.ok(!a.engine.storageOutcomes.some(row => row.name === "account-pool"), "core is the sole account owner");
    const { thread } = await a.rpc("a", "thread/start", { cwd: "/synthetic" });
    const sendId = "verified-send";
    await a.engine.sendWithContext(JSON.stringify({ id: sendId, method: "turn/start", params: {
      threadId: thread.id, clientUserMessageId: "verified-message", input: [{ type: "text", text: "synthetic" }],
    }, [LOGICAL_CLIENT_FIELD]: "a" }), { sender: { kind: "employee", loginName: "fixture" }, validUntil: Date.now() + 60000 });
    for (let n = 0; n < 200 && !a.frames.some(row => row.id === sendId); n++) await delay(10);
    assert.ok(a.frames.find(row => row.id === sendId)?.result);
    const { DatabaseSync } = await import("node:sqlite");
    const read = new DatabaseSync(join(f.options.dataDirectory, "opencraft-host-state.sqlite"), { readOnly: true });
    assert.match(String(read.prepare("SELECT sender_json FROM message_senders WHERE client_message_id='verified-message'").get()?.sender_json), /fixture/); read.close();
    await assert.rejects(f.adapter(true), /owned|locked/);
    await a.engine.close(); assert.deepEqual(await f.control.health(), before);
    const b = await f.adapter(true); await b.rpc("b", "initialize");
    const resumed = await b.rpc("b", "thread/resume", { threadId: thread.id }); assert.equal(resumed.thread.turns[0].status, "inProgress");
    await b.rpc("b", "fixture/complete", { threadId: thread.id });
    const completed = await b.rpc("b", "thread/read", { threadId: thread.id, includeTurns: true }); assert.equal(completed.thread.turns[0].status, "completed");
    assert.deepEqual(await f.control.health(), before);
    const accounts = await b.rpc("b", "opencraft/codex/accounts/list"); assert.ok(Array.isArray(accounts.accounts));
  } finally { await f.close(); }
});

test("Headless overlay restart restores active queue subscription, dispatches once after completion and fences unknown", async () => {
  const f = await fixture();
  try {
    const a = await f.adapter(true); await a.rpc("a", "initialize");
    const { thread } = await a.rpc("a", "thread/start", {});
    await a.rpc("a", "turn/start", { threadId: thread.id, clientUserMessageId: "original", input: [{ type: "text", text: "running" }] });
    await a.rpc("a", "thread/queue/add", { threadId: thread.id, clientUserMessageId: "next", input: [{ type: "text", text: "queued" }] });
    const unknown = await a.rpc("a", "thread/start", {});
    await a.rpc("a", "turn/start", { threadId: unknown.thread.id, clientUserMessageId: "other", input: [{ type: "text", text: "running" }] });
    await a.rpc("a", "thread/queue/add", { threadId: unknown.thread.id, clientUserMessageId: "unconfirmed", input: [{ type: "text", text: "must not replay" }] });
    await delay(50); await a.engine.close();
    const { OpenCraftHostStateDatabase } = await import("../../apps/opencraft-daemon/src/opencraft-host-state-database.js");
    const owner = new OpenCraftHostStateDatabase(f.options.dataDirectory);
    owner.database.prepare("UPDATE opencraft_host_queue SET state='unknown',target_turn_id='unknown' WHERE client_id='unconfirmed'").run(); owner.close();
    const b = await f.adapter(true); await b.rpc("b", "initialize");
    for (let n = 0; n < 200 && (await b.rpc("b", "fixture/subscribers", { threadId: thread.id })).count === 0; n++) await delay(10);
    assert.equal((await b.rpc("b", "fixture/subscribers", { threadId: thread.id })).count, 1);
    await b.rpc("b", "fixture/complete", { threadId: thread.id });
    let history: any;
    for (let n = 0; n < 200; n++) {
      history = await b.rpc("b", "thread/read", { threadId: thread.id, includeTurns: true });
      if (history.thread.turns.length === 2) break; await delay(10);
    }
    assert.equal(history.thread.turns.length, 2);
    assert.equal(history.thread.turns[1].items[0].clientId, "next");
    await delay(50);
    assert.equal((await b.rpc("b", "thread/read", { threadId: thread.id, includeTurns: true })).thread.turns.length, 2);
    const pending = await b.rpc("b", "thread/queue/list", { threadId: unknown.thread.id });
    assert.equal(pending.steering[0].clientUserMessageId, "unconfirmed");
    const { DatabaseSync } = await import("node:sqlite");
    const read = new DatabaseSync(join(f.options.dataDirectory, "opencraft-host-state.sqlite"), { readOnly: true });
    assert.equal(read.prepare("SELECT state FROM opencraft_host_queue WHERE client_id='unconfirmed'").get()?.state, "unknown"); read.close();
    assert.equal((await b.rpc("b", "thread/read", { threadId: unknown.thread.id, includeTurns: true })).thread.turns.length, 1);
  } finally { await f.close(); }
});

test("Headless restart restores native active Goal subscription before original turn completes", async () => {
  const f = await fixture();
  try {
    const a = await f.adapter(true); await a.rpc("a", "initialize");
    const { thread } = await a.rpc("a", "thread/start", {});
    await a.rpc("a", "thread/goal/set", { threadId: thread.id, objective: "synthetic goal", status: "active" });
    await a.rpc("a", "turn/start", { threadId: thread.id, input: [{ type: "text", text: "synthetic" }] });
    await a.engine.close();
    const b = await f.adapter(true); await b.rpc("b", "initialize");
    for (let n = 0; n < 200 && (await b.rpc("b", "fixture/subscribers", { threadId: thread.id })).count === 0; n++) await delay(10);
    assert.equal((await b.rpc("b", "fixture/subscribers", { threadId: thread.id })).count, 1);
    assert.equal((await b.rpc("b", "fixture/goalSetCount", { threadId: thread.id })).count, 1);
    await b.rpc("b", "fixture/complete", { threadId: thread.id });
    for (let n = 0; n < 200 && (await b.rpc("b", "fixture/goalSetCount", { threadId: thread.id })).count < 2; n++) await delay(10);
    assert.equal((await b.rpc("b", "fixture/goalSetCount", { threadId: thread.id })).count, 2);
  } finally { await f.close(); }
});

test("managed Headless initializes its queue owner without a browser and drains after the core turn completes", async () => {
  const f = await fixture(async options => ({ ...options, dataDirectory: join(options.runtimeDirectory, "headless/codex") }));
  let headless: any;
  try {
    const a = await f.adapter(true); await a.rpc("a", "initialize");
    const { thread } = await a.rpc("a", "thread/start", {});
    await a.rpc("a", "turn/start", { threadId: thread.id, clientUserMessageId: "original", input: [{ type: "text", text: "running" }] });
    await a.rpc("a", "thread/queue/add", { threadId: thread.id, clientUserMessageId: "without-view", input: [{ type: "text", text: "queued" }] });
    await delay(50); await a.engine.close();
    const webRoot = join(f.root, "web"); await mkdir(webRoot);
    await writeFile(join(webRoot, "index.html"), '<html><head></head><body>synthetic</body></html>');
    await writeFile(join(webRoot, "version.json"), JSON.stringify({ schemaVersion: 1, buildId: "headless-test", headlessServer: true, headlessHostId: "opencraft-server" }));
    const { startHeadlessServer } = await import("../../scripts/headless-server.mjs");
    headless = await startHeadlessServer({ dataDirectory: join(f.root, "headless"), webRoot, port: 0,
      codexCoreEndpoint: f.core.endpoint, codexCoreAuthToken: token,
      codexExecutable: "/external-core-only", runtimeDirectory: f.root,
      startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:1/rpc", close: async () => {} }),
    });
    // This inspector has no Headless View or overlay store and does not subscribe to the thread.
    const inspector = await f.adapter(); await inspector.rpc("inspect", "initialize");
    for (let n = 0; n < 200 && (await inspector.rpc("inspect", "fixture/subscribers", { threadId: thread.id })).count === 0; n++) await delay(10);
    assert.equal((await inspector.rpc("inspect", "fixture/subscribers", { threadId: thread.id })).count, 1);
    await inspector.rpc("inspect", "fixture/complete", { threadId: thread.id });
    let history: any;
    for (let n = 0; n < 200; n++) { history = await inspector.rpc("inspect", "thread/read", { threadId: thread.id, includeTurns: true }); if (history.thread.turns.length === 2) break; await delay(10); }
    assert.equal(history.thread.turns.length, 2); assert.equal(history.thread.turns[1].items[0].clientId, "without-view");
  } finally { await headless?.close(); await f.close(); }
});

test("conversation schedules declare Host capability, persist across overlay restart and submit once without a View", async () => {
  const f = await fixture();
  try {
    const a = await f.adapter(true);
    const initialized = await a.rpc("a", "initialize");
    assert.equal(initialized.capabilities.extensions["opencraft/conversation-schedules"].version, 1);
    const { thread } = await a.rpc("a", "thread/start", {});
    const plan = await a.rpc("a", "opencraft/schedules/save", { threadId: thread.id, expectedRevision: 0,
      prompt: "synthetic scheduled instruction", nextRunAt: Date.now() + 200, intervalMinutes: null, timeZone: "UTC" });
    assert.equal(plan.schedule.status, "active");
    const catalog = await a.rpc("a", "opencraft/schedules/list", {});
    assert.equal(catalog.schedules.find((value: any) => value.threadId === thread.id)?.status, "active");
    assert.equal(JSON.stringify(catalog).includes("synthetic scheduled instruction"), false);
    await a.engine.close();
    const b = await f.adapter(true); await b.rpc("b", "initialize");
    // Initialization is the managed service owner; no thread/view subscription required.
    let history: any;
    for (let n = 0; n < 400; n++) {
      history = await b.rpc("b", "thread/read", { threadId: thread.id, includeTurns: true });
      if (history.thread.turns.length) break;
      await delay(10);
    }
    assert.equal(history.thread.turns.length, 1);
    const clientId = history.thread.turns[0].items[0].clientId;
    assert.ok(clientId.startsWith(`schedule:${plan.schedule.id}:`));
    assert.equal(history.thread.turns[0].items[0].content[0].text, "[Scheduled task]\nsynthetic scheduled instruction");
    await b.engine.close();
    const c = await f.adapter(true); await c.rpc("c", "initialize");
    assert.equal((await c.rpc("c", "thread/read", { threadId: thread.id, includeTurns: true })).thread.turns.length, 1);
    assert.equal((await c.rpc("c", "opencraft/schedules/read", { threadId: thread.id })).runs.length, 1);
    const remote = await f.adapter(); const remoteInit = await remote.rpc("remote", "initialize");
    assert.equal(remoteInit.capabilities?.extensions?.["opencraft/conversation-schedules"], undefined);
  } finally { await f.close(); }
});

test('Actor collaboration survives Headless overlay restart while native Core retains the active Turn', async () => {
  const f = await fixture(async options => ({ ...options, dataDirectory: join(options.runtimeDirectory, 'headless/codex') }));
  let headless: any;
  try {
    const { ActorStore } = await import("../../packages/access-control/src/actors.js");
    const { Collaboration } = await import("../../packages/access-control/src/collaboration.js");
    const inspector = await f.adapter(); await inspector.rpc('inspect', 'initialize');
    const { thread } = await inspector.rpc('inspect', 'thread/start');
    await inspector.rpc('inspect', 'turn/start', { threadId: thread.id, clientUserMessageId: 'original', input: [] });
    const dataDirectory = join(f.root, 'headless'), store = new ActorStore(join(dataDirectory, 'actors.sqlite'));
    const a = store.createSession('source', 'operator'), b = store.createSession('target', 'operator');
    const credential = store.issueCredential(a.id, Date.now() + 60_000, 'operator');
    for (const action of ['message.send', 'execution.queue']) store.setGrant(a.id, b.id, action, true, 'operator');
    const seed = new Collaboration(join(dataDirectory, 'actor-collaboration.sqlite'), store, { hostId: "local-codex", validate: async () => {}, receipt: async () => null, add: async () => { throw new Error('unused'); }, steer: async () => {}, cancel: async () => false });
    await seed.bind(b.id, thread.id, 0, () => {}); await seed.close(); store.close();
    const webRoot = join(f.root, 'web'); await mkdir(webRoot);
    await writeFile(join(webRoot, 'index.html'), '<!doctype html>Actor overlay fixture');
    await writeFile(join(webRoot, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'actor-core-fixture', headlessServer: true, headlessHostId: 'opencraft-server' }));
    const { startHeadlessServer } = await import("../../scripts/headless-server.mjs");
    const options = { dataDirectory, webRoot, port: 0, codexCoreEndpoint: f.core.endpoint, codexCoreAuthToken: token,
      codexExecutable: '/external-core-only', runtimeDirectory: f.root,
      startAgentHost: async () => ({ websocketUrl: 'ws://127.0.0.1:1/rpc', async close() {} }) };
    const healthBefore = await f.control.health();
    headless = await startHeadlessServer(options);
    const call = (path: string, body?: any) => fetch(headless.url + '/__opencraft_actors/collaboration/' + path, {
      headers: { authorization: 'Bearer ' + credential.token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const response = await call('messages', { targetActorId: b.id, content: 'after current Turn', idempotencyKey: 'one', execution: { mode: 'queue' } });
    assert.equal(response.status, 200); const sent = await response.json() as any;
    let request: any;
    for (let i = 0; i < 150; i++) { request = (await (await call('requests?id=' + sent.requestId)).json() as any).request; if (request.state === 'queued') break; await delay(20); }
    assert.equal(request.state, 'queued');
    await headless.close(); headless = await startHeadlessServer(options);
    assert.deepEqual(await f.control.health(), healthBefore);
    await inspector.rpc('inspect', 'fixture/complete', { threadId: thread.id });
    for (let i = 0; i < 150; i++) { request = (await (await call('requests?id=' + sent.requestId)).json() as any).request; if (request.state === 'submitted') break; await delay(20); }
    assert.equal(request.state, 'submitted');
    const history = await inspector.rpc('inspect', 'thread/read', { threadId: thread.id, includeTurns: true });
    assert.equal(history.thread.turns.length, 2); assert.equal(history.thread.turns[1].items[0].clientId, 'actor-input:' + sent.requestId);
  } finally { await headless?.close(); await f.close(); }
});
