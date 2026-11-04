import assert from "node:assert/strict";
import {zstdDecompressSync} from "node:zlib";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AppServerRpcError } from "@opencraft/appserver-client";
import WebSocket from "ws";
import { AccountPoolStore, acquireCodexWriter, CodexCoreControlClient } from "@opencraft/account-pool-host";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { startCodexCore, type CodexCoreOptions } from "../../apps/codex-core/src/main.js";
import { startCodexAppServer } from "../../apps/codex-core/src/app-server.js";
import { resolveStoreMigrations } from "@opencraft/sqlite-node";
import { OPENCRAFT_HOST_STATE_MIGRATIONS } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.js";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { DatabaseSync } from "node:sqlite";
import { ExecutionEnvironmentRuntime } from "../../scripts/execution-environment.js";
import { EmployeeGitVaultStore } from "../../scripts/employee-git-vault-store.js";
import { observeNativeExecutionProcess } from "../../apps/opencraft-daemon/src/native-execution-origin.js";

// macOS Unix-domain sockets have a small pathname limit. Keep fixture paths
// short and canonical, matching the identity returned by the runtime owner.
const temporaryDirectory = realpathSync(process.platform === "darwin" ? "/tmp" : tmpdir());
const token = "synthetic-core-token-".repeat(3);

// Opt-in stock-native boundary. The isolated fixture has no real credentials.
for(const explicitSettings of [false,true])test(`stock Native restart preserves first input settings (explicit=${explicitSettings})`, {
  skip: !process.env.OPENCRAFT_TEST_NATIVE_CLI,
}, async () => {
  let modelPosts = 0;const requestedSettings:unknown[]=[];
  const f = await fixture(async options => ({ ...options,
    executable: process.env.OPENCRAFT_TEST_NATIVE_CLI!, spawnAppServer: undefined,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (init?.method !== "POST" || !url.pathname.endsWith("/responses")) return Response.json({ plan_type: "pro" });
      modelPosts++;const raw=typeof init?.body==='string'?Buffer.from(init.body):Buffer.from(init?.body as Uint8Array);const request=JSON.parse((raw.readUInt32LE(0)===0xfd2fb528?zstdDecompressSync(raw):raw).toString());requestedSettings.push({model:request.model,effort:request.reasoning?.effort});
      const item = { type: "message", id: "msg_stock_first", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "OK", annotations: [] }] };
      const response = { id: "resp_stock_first", object: "response", status: "in_progress", output: [] };
      const events = [{ type: "response.created", response },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "OK" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { ...response, status: "completed", output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    },
  }));
  let replacement: Awaited<ReturnType<typeof startCodexCore>> | undefined;
  const initialization = { clientInfo: { name: "stock-empty-restart", version: "1" }, capabilities: { experimentalApi: true } };
  try {
    const a = await f.adapter(true); await a.rpc("browser", "initialize", initialization);
    await mkdir(f.options.nativeCodexHomeDirectory!, { recursive: true });
    const access = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "stock-fixture" },
    })).toString("base64url")}.synthetic`;
    await writeFile(join(f.options.nativeCodexHomeDirectory!, "auth.json"), JSON.stringify({ auth_mode: "chatgpt",
      tokens: { access_token: access, refresh_token: "synthetic", account_id: "stock-fixture" } }));
    await a.rpc("browser", "opencraft/codex/accounts/import");
    const { thread } = await a.rpc("browser", "thread/start", { cwd: f.root, ephemeral: false, model: explicitSettings?"gpt-6.1-sol":"gpt-5.3-codex",...(explicitSettings?{config:{model_reasoning_effort:"medium"}}:{}) });
    assert.ok(existsSync(thread.path), "the Native allocation must survive restart before any client history read");
    const oldNative = (await f.control.health()).codexPid;
    const beforeRestart = await a.rpc("browser", "thread/read", { threadId: thread.id, includeTurns: true });
    assert.deepEqual(beforeRestart.thread.turns, []);
    await a.engine.close(); await f.core.close();
    replacement = await startCodexCore(f.options);
    assert.notEqual((await f.control.health()).codexPid, oldNative);
    const b = await f.adapter(true); await b.rpc("browser", "initialize", initialization);
    const restored = await b.rpc("browser", "thread/resume", { threadId: thread.id, excludeTurns: true });
    assert.equal(restored.thread.id, thread.id);
    const started = await b.rpc("browser", "turn/start", { threadId: thread.id, clientUserMessageId: "stock-first-after-restart",...(explicitSettings?{model:"gpt-6.1-sol",effort:"medium"}:{}),
      input: [{ type: "text", text: "synthetic first input" }] });
    assert.equal(typeof started.turn.id, "string");
    for (let n = 0; n < 500 && !b.frames.some(frame => frame.method === "turn/completed" && frame.params.turn.id === started.turn.id); n++) await delay(10);
    const completed = b.frames.find(frame => frame.method === "turn/completed" && frame.params.turn.id === started.turn.id);
    assert.equal(completed?.params.threadId, thread.id);
    assert.equal(completed?.params.turn.status, "completed");
    assert.equal(b.frames.filter(frame => frame.method === "turn/started" && frame.params.turn.id === started.turn.id).length, 1);
    assert.equal(modelPosts, 1, "the first input must reach the synthetic upstream exactly once");
    if(explicitSettings){assert.deepEqual(requestedSettings,[{model:'gpt-6.1-sol',effort:'medium'}]);const read=await b.rpc('browser','thread/read',{threadId:thread.id,includeTurns:false});assert.equal(read.thread.model,'gpt-6.1-sol');assert.equal(read.thread.reasoningEffort,'medium');}
  } finally { await replacement?.close(); await f.close(); }
});

test("standalone Core records the real native process on execution leases across Host replacement", async () => {
  const f = await fixture();
  try {
    const a = await f.adapter(true);
    const initialized = await a.rpc("employee", "initialize");
    assert.deepEqual(initialized.capabilities.extensions["opencraft/execution-engines"], { version: 1, defaultEngine: "codex", providers: [] });
    const { thread } = await a.rpc("employee", "thread/start", {});
    await a.rpc("employee", "turn/start", { threadId: thread.id, clientUserMessageId: "standalone-input", input: [{ type: "text", text: "synthetic" }] });
    const native = await observeNativeExecutionProcess((await f.control.health()).codexPid);
    const read = () => {
      const db = new DatabaseSync(join(f.options.dataDirectory, "opencraft-host-state.sqlite"), { readOnly: true });
      try { return db.prepare("SELECT engine_incarnation FROM execution_leases WHERE input_id=?").get("standalone-input")?.engine_incarnation; }
      finally { db.close(); }
    };
    assert.equal(read(), native.incarnation);
    await a.engine.close();
    const b = await f.adapter(true); await b.rpc("employee", "initialize");
    await b.rpc("employee", "thread/read", { threadId: thread.id, includeTurns: true });
    assert.equal(read(), native.incarnation);
    assert.equal((await f.control.health()).codexPid, native.pid);
  } finally { await f.close(); }
});

for (const overlays of [false, true]) test(`admission rejection diagnostics survive Host restart without recording input (overlays=${overlays})`, async () => {
  const f = await fixture(), audit = join(f.root, "admission-audit.jsonl"), client = "audit-client";
  const a = await f.adapter(overlays, entry => {
    if (entry.event === "codex-admission-rejected") appendFileSync(audit, JSON.stringify(entry) + "\n");
  });
  const flag = join(overlays ? f.options.dataDirectory : join(f.root, "forbidden"), "codex-admission.paused");
  const threadId = "11111111-1111-7111-8111-111111111111", content = "synthetic-private-content-must-not-be-logged";
  try {
    await a.rpc(client, "initialize");
    await mkdir(join(flag, ".."), { recursive: true }); await writeFile(flag, "maintenance\n");
    for (const [method, params] of [
      ["turn/start", { threadId, input: [{ type: "text", text: content }] }],
      ["thread/goal/set", { threadId, objective: content }],
      ["thread/start", { input: [{ type: "text", text: content }] }],
      ["turn/start", { threadId: content, input: [] }],
    ] as const) await assert.rejects(a.rpc(client, method, params), /temporarily unavailable/);
    assert.equal((await a.rpc(client, "opencraft/codex/maintenance/read")).rejectedAdmissions, 4);
    const rows = readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.rejectedAdmissions), [1, 2, 3, 4]);
    assert.deepEqual(rows.map(row => row.threadId), [threadId, threadId, null, null]);
    assert.ok(rows.every(row => row.clientId === client && row.reason === "maintenance" && Number.isFinite(Date.parse(row.at))));
    assert.equal(readFileSync(audit, "utf8").includes(content), false);
    await a.engine.close();
    const b = await f.adapter(overlays); await b.rpc(client, "initialize");
    assert.equal((await b.rpc(client, "opencraft/codex/maintenance/read")).rejectedAdmissions, 0);
    assert.equal(readFileSync(audit, "utf8").trim().split("\n").length, 4);
  } finally { await rm(flag, { force: true }); await f.close(); }
});

test("a diagnostic sink failure does not admit work or suppress the maintenance error", async () => {
  const f = await fixture(), a = await f.adapter(true, entry => {
    if (entry.event === "codex-admission-rejected") throw new Error("synthetic unavailable sink");
  });
  const flag = join(f.options.dataDirectory, "codex-admission.paused");
  try {
    await a.rpc("audit", "initialize"); await writeFile(flag, "maintenance\n");
    await assert.rejects(a.rpc("audit", "thread/start"), /temporarily unavailable/);
    assert.equal((await a.rpc("audit", "thread/list")).data.length, 0);
    assert.equal((await a.rpc("audit", "opencraft/codex/maintenance/read")).rejectedAdmissions, 1);
  } finally { await rm(flag, { force: true }); await f.close(); }
});

for (const overlays of [false, true]) test(`maintenance rejects new Codex inputs while existing work and reads continue (overlays=${overlays})`, async () => {
  const f = await fixture();
  const a = await f.adapter(overlays);
  const client = "maintenance";
  const directory = overlays ? f.options.dataDirectory : join(f.root, "forbidden");
  const flag = join(directory, "codex-admission.paused");
  try {
    const initialized = await a.rpc(client, "initialize");
    assert.equal(initialized.capabilities.extensions["opencraft.codex-maintenance"].version, 1);
    const { thread } = await a.rpc(client, "thread/start", {});
    await a.rpc(client, "turn/start", { threadId: thread.id, clientUserMessageId: "accepted", input: [{ type: "text", text: "finish once" }] });
    await a.rpc(client, "thread/goal/set", { threadId: thread.id, status: "active" });
    await mkdir(directory, { recursive: true }); await writeFile(flag, "maintenance\n", { mode: 0o600 });
    assert.equal((await a.rpc(client, "opencraft/codex/maintenance/read")).paused, true);
    for (const method of ["thread/start", "thread/fork", "turn/start", "thread/queue/add", "thread/goal/set", "command/exec", "process/spawn", "thread/shellCommand"]) {
      await assert.rejects(a.rpc(client, method, { threadId: thread.id, input: [{ type: "text", text: "must not execute" }] }), /temporarily unavailable/);
    }
    assert.equal((await a.rpc(client, "thread/goal/set", { threadId: thread.id, status: "paused" })).goal.status, "paused");
    await assert.rejects(a.rpc(client, "thread/goal/set", { threadId: thread.id, status: "paused", objective: "a different task" }), /temporarily unavailable/);
    assert.equal((await a.rpc(client, "thread/goal/set", { threadId: thread.id, status: "complete" })).goal.status, "complete");
    assert.equal((await a.rpc(client, "thread/read", { threadId: thread.id })).thread.turns.length, 1);
    await a.rpc(client, "fixture/complete", { threadId: thread.id });
    assert.equal((await a.rpc(client, "thread/read", { threadId: thread.id })).thread.status.type, "idle");
    await rm(flag);
    assert.equal((await a.rpc(client, "opencraft/codex/maintenance/read")).paused, false);
    await a.rpc(client, "turn/start", { threadId: thread.id, clientUserMessageId: "after", input: [{ type: "text", text: "start after maintenance" }] });
    assert.equal((await a.rpc(client, "thread/read", { threadId: thread.id })).thread.turns.length, 2);
  } finally { await rm(flag, { force: true }); await f.close(); }
});

test("maintenance observes submissions accepted before the fence and defers new schedule admissions", async () => {
  const f = await fixture();
  const a = await f.adapter(true), client = "maintenance";
  const flag = join(f.options.dataDirectory, "codex-admission.paused");
  try {
    await a.rpc(client, "initialize");
    const { thread } = await a.rpc(client, "thread/start", {});
    await a.rpc(client, "fixture/holdNextTurn");
    await a.rpc(client, "fixture/holdNextRead", { untilRelease: true });
    const admitted = a.rpc(client, "thread/queue/add", { threadId: thread.id, clientUserMessageId: "before-fence", input: [{ type: "text", text: "accepted before maintenance" }] });
    admitted.catch(() => {});
    for (let n = 0; n < 100 && !(await a.rpc(client, "fixture/readPending")).count; n++) await delay(5);
    await writeFile(flag, "maintenance\n", { mode: 0o600 });
    assert.ok((await a.rpc(client, "opencraft/codex/maintenance/read")).pendingAdmissions > 0);
    await a.rpc(client, "fixture/releaseReads");
    await admitted;
    for (let n = 0; n < 200 && (await a.rpc(client, "thread/read", { threadId: thread.id })).thread.turns.length === 0; n++) await delay(5);
    assert.equal((await a.rpc(client, "thread/read", { threadId: thread.id })).thread.turns.length, 1);
    assert.equal((await a.rpc(client, "opencraft/codex/maintenance/read")).pendingAdmissions, 1);
    await a.rpc(client, "fixture/releaseTurns");
    for (let n = 0; n < 200 && (await a.rpc(client, "opencraft/codex/maintenance/read")).pendingAdmissions; n++) await delay(10);
    assert.equal((await a.rpc(client, "opencraft/codex/maintenance/read")).pendingAdmissions, 0);
    await a.rpc(client, "fixture/complete", { threadId: thread.id });
    const scheduled = await (a.engine as any).scheduleExecutionPort().submit({
      id: "maintenance-schedule", threadId: thread.id, scheduleId: "paused", scheduledAt: 1,
      permissions: "opencraft:permission-mode:full", state: "submitting", turnId: null, updatedAt: 1,
    }, "do not admit during maintenance", () => true);
    assert.equal(scheduled.state, "waiting");
    assert.equal((await a.rpc(client, "thread/queue/list", { threadId: thread.id })).data.length, 0);
  } finally { await rm(flag, { force: true }); await f.close(); }
});

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

test("split account Core restarts with stable launch credentials while the independent runtime survives", async () => {
  const root = await mkdtemp(join(temporaryDirectory, "oc-core-split-"));
  const reservation = createTcpServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const options: CodexCoreOptions = { endpoint: join(root, "accounts/control.sock"), appServerEndpoint: join(root, "execution/control.sock"),
    authToken: token, executable: process.execPath, runtimeDirectory: root, dataDirectory: join(root, "data"),
    nativeCodexHomeDirectory: join(root, "native"), proxyPort: port, fetch: async () => Response.json({ plan_type: "pro" }) };
  let core = await startCodexCore(options);
  const client = new CodexCoreControlClient(options.endpoint, token);
  let runtime: Awaited<ReturnType<typeof startCodexAppServer>> | undefined;
  try {
    const launch = await client.appServerLaunch();
    await assert.rejects(new CodexCoreControlClient(options.endpoint, "wrong").appServerLaunch(), /authentication failed/);
    await assert.rejects(client.health(), /unavailable/);
    runtime = await startCodexAppServer({ ...options, endpoint: options.appServerEndpoint!, coreEndpoint: options.endpoint,
      spawnAppServer: ({ args, cwd, env }) => spawn(process.execPath,
        [new URL("../fixtures/fake-codex-unix-appserver.mjs", import.meta.url).pathname, args[2]!.slice("unix://".length)],
        { cwd, env, stdio: ["pipe", "pipe", "pipe"] }) });
    const before = await client.health();
    const { CodexNativeCoreTransport } = await import("../../apps/opencraft-daemon/src/codex-native-core-transport.js");
    const host = new CodexNativeCoreTransport(options.endpoint, token);
    try {
      await host.connect();
      assert.equal(host.executionIncarnation, (await observeNativeExecutionProcess(before.codexPid)).incarnation);
    } finally { await host.close(); }
    await assert.rejects(acquireCodexWriter(options.dataDirectory), /already owned/);
    await core.close();
    // Account failure must not own, signal or remove the native runtime/socket.
    assert.equal((await new CodexCoreControlClient(options.appServerEndpoint!, token).health()).codexPid, before.codexPid);
    await assert.rejects(acquireCodexWriter(options.dataDirectory), /already owned/);
    core = await startCodexCore(options);
    assert.equal((await client.health()).codexPid, before.codexPid);
    assert.deepEqual(await client.appServerLaunch(), launch);
    assert.deepEqual(await client.accountRequest("opencraft/codex/accounts/list", {}), { accounts: [] });
    await runtime.close(); runtime = undefined;
    await assert.rejects(client.health(), /unavailable/);
  } finally { await runtime?.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test("two generation runtimes have independent HOME writers and share one account Core", async () => {
  const root = await mkdtemp(join(temporaryDirectory, "oc-core-generations-"));
  const reservation = createTcpServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const options: CodexCoreOptions = { endpoint: join(root, "accounts/control.sock"), appServerEndpoint: join(root, "g0/control.sock"),
    authToken: token, executable: process.execPath, runtimeDirectory: root, dataDirectory: join(root, "accounts-data"),
    nativeCodexHomeDirectory: join(root, "native"), proxyPort: port, fetch: async () => Response.json({ plan_type: "pro" }) };
  let core = await startCodexCore(options);
  const runtimes: Awaited<ReturnType<typeof startCodexAppServer>>[] = [];
  const launch = new CodexCoreControlClient(options.endpoint, token);
  const create = (id: string, runtimeDataDirectory = join(root, id, "data")) => startCodexAppServer({ ...options,
    endpoint: join(root, id, "control.sock"), coreEndpoint: options.endpoint, runtimeDataDirectory,
    spawnAppServer: ({ args, cwd, env }) => spawn(process.execPath,
      [new URL("../fixtures/fake-codex-unix-appserver.mjs", import.meta.url).pathname, args[2]!.slice("unix://".length)],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] }) });
  try {
    runtimes.push(await create("g0"), await create("g1"));
    const readers = ["g0", "g1"].map(id => new CodexCoreControlClient(join(root, id, "control.sock"), token));
    const before = await Promise.all(readers.map(client => client.appServerHealth()));
    assert.notEqual(before[0]!.codexPid, before[1]!.codexPid);
    assert.notEqual(before[0]!.codexHome, before[1]!.codexHome);
    for (const h of before) {
      assert.equal(h.dataDirectory, options.dataDirectory);
      assert.equal(h.proxyBaseUrl, `http://127.0.0.1:${port}`);
      await assert.rejects(acquireCodexWriter(h.runtimeDataDirectory!, "runtime"), /already owned/);
      assert.ok((await stat(h.nativeSocket)).isSocket(), "public endpoint is a real socket across mount namespaces");
      const connection = new WebSocket(`ws+unix://${h.nativeSocket}:/`);
      await new Promise<void>((resolve, reject) => { connection.once("open", resolve); connection.once("error", reject); });
      const initialized = new Promise<any>(resolve => connection.once("message", raw => resolve(JSON.parse(String(raw)))));
      connection.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "relay-test", version: "1" } } }));
      assert.ok((await initialized).result); connection.terminate();
    }
    await assert.rejects(create("duplicate", before[0]!.runtimeDataDirectory), /already owned/);
    const initialLaunch = await launch.appServerLaunch();
    await core.close();
    assert.deepEqual(await Promise.all(readers.map(client => client.appServerHealth())), before);
    core = await startCodexCore(options);
    assert.deepEqual(await launch.appServerLaunch(), initialLaunch);
    assert.deepEqual(await launch.accountRequest("opencraft/codex/accounts/list", {}), { accounts: [] });
  } finally { for (const runtime of runtimes.reverse()) await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test("proxy drain continues serving other Turns until its long response reaches an idle point", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let baseUrl = "", hostToken = "", modelRequests = 0;
  const f = await fixture(async options => {
    const store = new AccountPoolStore({ databasePath: join(options.dataDirectory, "account-pool.sqlite"), secretsDirectory: join(options.dataDirectory, "secrets") });
    store.addAccount({ id: "drain", provider: "codex", label: "drain", upstreamAccountId: "drain", priority: 0, enabled: true },
      { accessToken: "synthetic-drain", refreshToken: null, expiresAt: null }); store.close();
    return { ...options, fetch: async input => {
      if (String(input).includes("/wham/usage")) return Response.json({ plan_type: "pro" });
      if (++modelRequests > 1) return new Response("other Turn completed");
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller; controller.enqueue(new TextEncoder().encode("long response"));
      } }));
    }, spawnAppServer(input) {
      const setting = input.args.find(arg => arg.startsWith("model_providers.opencraft-account-pool.base_url="))!;
      baseUrl = JSON.parse(setting.slice(setting.indexOf("=") + 1)); hostToken = input.env.OPENCRAFT_CODEX_POOL_AUTH_TOKEN!;
      return options.spawnAppServer!(input);
    } };
  });
  const request = () => fetch(`${baseUrl}/responses`, { method: "POST", headers: {
    "x-opencraft-account-pool-token": hostToken, "content-type": "application/json",
  }, body: '{"model":"synthetic","input":[]}' });
  try {
    const first = await request(), body = first.text();
    let closed = false; const closing = f.core.close().then(() => { closed = true; });
    await delay(80);
    assert.equal(await (await request()).text(), "other Turn completed");
    assert.equal(closed, false);
    stream.close(); assert.equal(await body, "long response"); await closing;
    assert.equal(modelRequests, 2);
  } finally { try { stream.close(); } catch {} await f.close(); }
});

test("runtime bootstrap waits for delayed Core, cancels cleanly and fails permanent authentication errors", async () => {
  const root = await mkdtemp(join(temporaryDirectory, "oc-core-bootstrap-"));
  const endpoint = join(root, "accounts/control.sock"), appServerEndpoint = join(root, "execution/control.sock");
  const options = { endpoint: appServerEndpoint, coreEndpoint: endpoint, authToken: token, dataDirectory: join(root, "data"),
    runtimeDirectory: root, executable: process.execPath, waitForCore: true,
    spawnAppServer: ({ args, cwd, env }: Parameters<NonNullable<CodexCoreOptions["spawnAppServer"]>>[0]) => spawn(process.execPath,
      [new URL("../fixtures/fake-codex-unix-appserver.mjs", import.meta.url).pathname, args[2]!.slice("unix://".length)],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] }) };
  let core: Awaited<ReturnType<typeof startCodexCore>> | undefined, runtime: Awaited<ReturnType<typeof startCodexAppServer>> | undefined;
  const abort = new AbortController();
  try {
    const cancelled = assert.rejects(startCodexAppServer({ ...options, signal: abort.signal }), /abort/i);
    await delay(50); abort.abort(); await cancelled;
    const reservation = createTcpServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as import("node:net").AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const waiting = startCodexAppServer(options);
    await delay(800);
    core = await startCodexCore({ ...options, endpoint, appServerEndpoint, proxyPort: port,
      nativeCodexHomeDirectory: join(root, "native"), fetch: async () => Response.json({ plan_type: "pro" }) });
    runtime = await waiting;
    assert.ok((await new CodexCoreControlClient(endpoint, token).health()).codexPid);
    await runtime.close(); runtime = undefined;
    await assert.rejects(startCodexAppServer({ ...options, authToken: "wrong-private-token".repeat(3) }), /authentication failed/);
  } finally { abort.abort(); await runtime?.close(); await core?.close(); await rm(root, { recursive: true, force: true }); }
});
async function fixture(configure?: (options: CodexCoreOptions) => Promise<CodexCoreOptions>) {
  const root = await mkdtemp(join(temporaryDirectory, "oc-core-test-"));
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
  if (options.appServerEndpoint && !options.proxyPort) {
    const reservation = createTcpServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as import("node:net").AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    options = { ...options, proxyPort: port };
  }
  const core = await startCodexCore(options);
  const runtime = options.appServerEndpoint ? await startCodexAppServer({ ...options, endpoint: options.appServerEndpoint, coreEndpoint: options.endpoint }) : undefined;
  const control = new CodexCoreControlClient(core.endpoint, token);
  const adapters: CodexEngineAdapter[] = [];
  async function adapter(overlays = false, logDiagnostic: (event: Record<string, unknown>) => void = () => undefined, overrides: Partial<ConstructorParameters<typeof CodexEngineAdapter>[0]> = {}) {
    const engine = new CodexEngineAdapter({ ...options, coreEndpoint: core.endpoint, coreAuthToken: token,
      // Remote mode must not touch any local account store or spawn a child.
      dataDirectory: overlays ? options.dataDirectory : join(root, "forbidden"),
      coreHostOverlays: overlays, logDiagnostic, ...overrides,
      spawnAppServer: () => { throw new Error("Remote mode spawned a writer"); } });
    adapters.push(engine);
    const frames: any[] = [];
    engine.subscribeMessage(frame => frames.push(JSON.parse(frame)));
    await engine.connect();
    let sequence = 0;
    async function rpc(client: string, method: string, params: object = {}, context?: Parameters<CodexEngineAdapter["sendWithContext"]>[1]) {
      const id = ++sequence;
      const frame = JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client });
      if (context) await engine.sendWithContext(frame, context); else await engine.send(frame);
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
    await runtime?.close(); await core.close(); await rm(root, { recursive: true, force: true });
  } };
}

test("core owns accounts and PID across independent daemon clients and zero connections", async () => {
  const f = await fixture();
  try {
    const before = await f.control.health();
    assert.equal(await f.control.generationDirectory("legacy-thread"), null, "combined Core needs no new endpoint for legacy compatibility");
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
    assert.equal(initialized.capabilities.extensions["vela/bot-conversations"], undefined);
    assert.ok(a.engine.storageOutcomes.some(row => row.name === "opencraft-host-state" && row.outcome.appliedVersion === resolveStoreMigrations("opencraft-host-state-database", OPENCRAFT_HOST_STATE_MIGRATIONS).at(-1)!.version));
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

for (const overlays of [false, true]) test(`Read-only Core observers receive live events without owning native execution (overlays=${overlays})`, async () => {
  const f = await fixture();
  const a = await f.adapter(overlays);
  try {
    await a.rpc("writer", "initialize");
    const initialized = await a.rpc("reader", "initialize");
    assert.equal(initialized.capabilities.extensions["opencraft/read-history"].version, 1);
    const { thread } = await a.rpc("writer", "thread/start");
    await a.rpc("reader", "thread/read", { threadId: thread.id, watch: true, includeTurns: false });
    await a.rpc("writer", "fixture/publish", { threadId: thread.id, delta: "observed" });
    await delay(30);
    assert.ok(a.frames.some(frame => frame.method === "item/agentMessage/delta" && frame[LOGICAL_CLIENT_FIELD] === "reader"));
    await a.rpc("reader", "thread/unsubscribe", { threadId: thread.id });
    const start = a.frames.length;
    await a.rpc("writer", "fixture/publish", { threadId: thread.id, delta: "writer only" });
    await delay(30);
    assert.equal(a.frames.slice(start).some(frame => frame.method === "item/agentMessage/delta" && frame[LOGICAL_CLIENT_FIELD] === "reader"), false);
    assert.ok(a.frames.slice(start).some(frame => frame.method === "item/agentMessage/delta" && frame[LOGICAL_CLIENT_FIELD] === "writer"));
  } finally { await f.close(); }
});

test("Core reconnect before the first client caches its successful handshake for the first View", async () => {
  const f = await fixture();
  let opens = 0;
  const initialized = new Set<number>(), listeners = new Set<(frame: string) => void>();
  const engine = new CodexEngineAdapter({ ...f.options, coreEndpoint: f.core.endpoint, coreAuthToken: token,
    coreHostOverlays: true, logDiagnostic: () => {}, decorateNativeTransport: native => ({
      get status() { return native.status; }, connect: signal => native.connect(signal), close: () => native.close(),
      subscribeMessage: listener => { listeners.add(listener); const stop = native.subscribeMessage(listener); return () => { listeners.delete(listener); stop(); }; },
      subscribeStatus: listener => native.subscribeStatus(status => { if (status.state === "open") opens++; listener(status); }),
      send: async frame => {
        const message = JSON.parse(frame);
        if (message.method === "initialize") {
          if (initialized.has(opens)) {
            for (const listener of listeners) listener(JSON.stringify({ id: message.id, error: { code: -32080, message: "Routing connection is already initialized" } }));
            return;
          }
          initialized.add(opens);
        }
        await native.send(frame);
      },
    }) });
  let replacement: Awaited<ReturnType<typeof startCodexCore>> | undefined;
  const frames: any[] = []; engine.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  try {
    await engine.connect();
    await f.core.close(); replacement = await startCodexCore(f.options);
    for (let n = 0; n < 600 && !(opens >= 2 && (engine as any).physicalInitialized && engine.status.state === "open"); n++) await delay(10);
    assert.ok(opens >= 2);
    await engine.send(JSON.stringify({ id: "first-view", method: "initialize", params: {}, [LOGICAL_CLIENT_FIELD]: "first-view" }));
    for (let n = 0; n < 100 && !frames.some(frame => frame.id === "first-view"); n++) await delay(10);
    const reply = frames.find(frame => frame.id === "first-view");
    assert.ok(reply?.result, "a recovered physical connection must not receive a duplicate initialize from the first View");
    assert.equal(reply.result.capabilities.extensions["opencraft/read-history"].itemDetails, true);
  } finally { await engine.close(); await replacement?.close(); await f.close(); }
});

for (const overlays of [false, true]) test(`directory readers learn a committed creation without opening its Thread (overlays=${overlays})`, async () => {
  const f = await fixture();
  try {
    const a = await f.adapter(overlays);
    await a.rpc("creator", "initialize"); await a.rpc("directory-reader", "initialize");
    const before = await a.rpc("directory-reader", "thread/list", {});
    const { thread } = await a.rpc("creator", "thread/start", { cwd: "/synthetic", ephemeral: false });
    const events = () => a.frames.filter(frame => frame.method === "opencraft/thread-catalog/changed"
      && frame[LOGICAL_CLIENT_FIELD] === "directory-reader" && frame.params.change?.type === "upsert"
      && frame.params.change.thread.id === thread.id);
    assert.equal(events().length, 0, "allocation is not a durable catalog entry");
    await a.rpc("creator", "turn/start", { threadId: thread.id, clientUserMessageId: "catalog-creation", input: [] });
    assert.equal(events().length, 1, "native acceptance publishes independently of Thread subscriptions");
    assert.deepEqual(events()[0].params.change.thread.turns, []);
    assert.equal((await a.rpc("directory-reader", "thread/list", {})).data.length, before.data.length + 1);
  } finally { await f.close(); }
});

for (const emptyHistoryUnsupported of [false, true]) test(`a never-dispatched creation keeps its native route and events through Host replacement without a history resume (unsupported=${emptyHistoryUnsupported})`, async () => {
  const f = await fixture(async options => ({ ...options,
    appServerEndpoint: join(options.runtimeDirectory, "execution/control.sock"),
    spawnAppServer: ({ args, cwd, env }) => spawn(process.execPath,
      [new URL("../fixtures/fake-codex-unix-appserver.mjs", import.meta.url).pathname, args[2]!.slice("unix://".length)],
      { cwd, env: { ...env, FAKE_REQUIRE_DURABLE_RESUME: "1", ...(emptyHistoryUnsupported ? { FAKE_EMPTY_HISTORY_UNSUPPORTED: "1" } : {}) }, stdio: ["pipe", "pipe", "pipe"] }),
  }));
  const { ProvisionalThreads } = await import("../../apps/opencraft-daemon/src/provisional-threads.js");
  try {
    const a = await f.adapter(true); await a.rpc("browser", "initialize");
    const { thread } = await a.rpc("browser", "thread/start", {});
    const pid = (await f.control.health()).codexPid;
    await a.engine.close();
    const b = await f.adapter(true); await b.rpc("browser", "initialize");
    const restored = await b.rpc("browser", "thread/resume", { threadId: thread.id, excludeTurns: true });
    assert.equal(restored.thread.id, thread.id);
    assert.equal(restored.thread.creationPhase, "created");
    const read = await b.rpc("browser", "thread/read", { threadId: thread.id, watch: true, initialTurnsPage: { limit: 10 } });
    assert.deepEqual(read.initialTurnsPage.data, []);
    const receipt = await b.rpc("browser", "turn/start", { threadId: thread.id, clientUserMessageId: "first-input", input: [{ type: "text", text: "synthetic-first" }] });
    assert.ok(receipt.turn.id);
    assert.equal((await b.rpc("browser", "fixture/subscribers", { threadId: thread.id })).count, 1);
    await b.rpc("browser", "fixture/publish", { threadId: thread.id, delta: "recovered-progress" });
    await b.rpc("browser", "fixture/complete", { threadId: thread.id });
    assert.ok(b.frames.some(frame => frame.method === "item/agentMessage/delta" && frame.params.delta === "recovered-progress"));
    assert.ok(b.frames.some(frame => frame.method === "turn/completed" && frame.params.turn.id === receipt.turn.id));
    const history = await b.rpc("browser", "thread/read", { threadId: thread.id, includeTurns: true });
    assert.equal(history.thread.turns.length, 1);
    assert.equal(history.thread.turns[0].items[0].clientId, "first-input");
    assert.equal(history.thread.creationPhase, undefined, "accepted input cannot be represented by the empty creation snapshot");
    assert.equal((await f.control.health()).codexPid, pid);
    await b.engine.close();
    const facts = new ProvisionalThreads(f.options.dataDirectory);
    try { assert.equal(facts.get(thread.id)?.phase, "accepted"); assert.equal(facts.get(thread.id)?.turnId, receipt.turn.id); }
    finally { facts.close(); }
  } finally { await f.close(); }
});

for (const routingOnly of [false, true]) test(`Core refuses empty creation recovery without callbacks (routing-only=${routingOnly})`, async () => {
  const f = await fixture(async options => ({ ...options,
    spawnAppServer: ({ args, cwd, env }) => spawn(process.execPath,
      [new URL("../fixtures/fake-codex-unix-appserver.mjs", import.meta.url).pathname, args[2]!.slice("unix://".length)],
      { cwd, env: { ...env, FAKE_REQUIRE_DURABLE_RESUME: "1" }, stdio: ["pipe", "pipe", "pipe"] }),
  }));
  try {
    const a = await f.adapter(true); await a.rpc("browser", "initialize");
    const { thread } = await a.rpc("browser", "thread/start");
    await a.engine.close();
    const b = await f.adapter(true); await b.rpc("browser", "initialize");
    if (routingOnly) {
      // Real transport distinguishes routing advertisement from callbackReady.
      // A router may still point at a legacy APP with no retained lane.
      const native = (b.engine as any).nativeCore;
      assert.equal(native.supportsOrchestration, false);
      native.routed = true;
      assert.equal(native.supportsOrchestrationRouting, true);
    }
    await assert.rejects(b.rpc("browser", "thread/resume", { threadId: thread.id }), /当前连接无法恢复空会话/);
    assert.equal((await b.rpc("browser", "thread/read", { threadId: thread.id, includeTurns: true })).thread.turns.length, 0);
    assert.equal((await b.rpc("browser", "fixture/subscribers", { threadId: thread.id })).count, 0);
  } finally { await f.close(); }
});

test("a lost first-Turn acknowledgement never turns attempted input into an empty conversation", async () => {
  const f = await fixture();
  try {
    const a = await f.adapter(true); await a.rpc("browser", "initialize");
    const { thread } = await a.rpc("browser", "thread/start", {});
    await a.rpc("browser", "fixture/holdNextTurn");
    const pending = a.rpc("browser", "turn/start", { threadId: thread.id, clientUserMessageId: "uncertain-first", input: [{ type: "text", text: "synthetic" }] }).catch(() => undefined);
    for (let i = 0; i < 100; i++) {
      const read = await a.rpc("reader", "initialize").then(() => a.rpc("reader", "thread/read", { threadId: thread.id, includeTurns: true }));
      if (read.thread.turns.length) break;
      await delay(5);
    }
    await a.engine.close();
    const b = await f.adapter(true); await b.rpc("browser", "initialize");
    const read = await b.rpc("browser", "thread/read", { threadId: thread.id, includeTurns: true });
    assert.equal(read.thread.creationPhase, undefined);
    assert.equal(read.thread.turns.length, 1);
    assert.equal(read.thread.turns[0].items[0].clientId, "uncertain-first");
    await assert.rejects(b.rpc("browser", "thread/read", { threadId: "no-creation-evidence", initialTurnsPage: { limit: 10 } }),
      "an unknown missing history cannot acquire a synthetic empty snapshot");
    await pending;
  } finally { await f.close(); }
});


for (const scopeChange of ["none", "account", "project", "unknown", "no-mcp"] as const) test(`an empty environment provider restores MCP without a history resume (scope=${scopeChange})`, async () => {
  const f = await fixture(async options => ({ ...options, appServerEndpoint: join(options.runtimeDirectory, "execution/control.sock"),
    spawnAppServer: ({ args, cwd, env }) => spawn(process.execPath,
      [new URL("../fixtures/fake-codex-unix-appserver.mjs", import.meta.url).pathname, args[2]!.slice("unix://".length)],
      { cwd, env: { ...env, FAKE_REQUIRE_DURABLE_RESUME: "1", FAKE_UNLOAD_ON_UNSUBSCRIBE: "1" }, stdio: ["pipe", "pipe", "pipe"] }),
  }));
  const vault = new EmployeeGitVaultStore(f.root), runtime = new ExecutionEnvironmentRuntime(f.root, vault);
  const methods: string[] = []; let restored = 0; const bound = new Set<string>(), hosts: CodexEngineAdapter[] = [];
  const reservation = () => ({ configuration: { url: "http://127.0.0.1:1/mcp" }, bindThread() {}, bind(threadId: string, inputId: string, executionId: string) { bound.add(JSON.stringify([threadId, inputId, executionId])); }, cancel() {} });
  const options = { dataDirectory: join(f.root, "codex"), executionEnvironment: runtime,
    ...(scopeChange === "no-mcp" ? {} : { sessionMcp: () => ({ url: "http://127.0.0.1:1/mcp" }), createSessionMcp: reservation,
    restoreSessionMcp: () => { restored++; return reservation(); } }),
    decorateNativeTransport(transport: import("../../apps/opencraft-daemon/src/codex-native-core-transport.js").CodexNativeCoreTransport) {
      const send = transport.send.bind(transport); transport.send = frame => { methods.push(JSON.parse(frame).method); return send(frame); }; return transport;
    },
  };
  const context = { sender: { kind: "employee" as const, loginName: "alice" }, executionPrincipal: { provider: "employee", subject: "alice" }, validUntil: Date.now() + 60_000 };
  try {
    const a = await f.adapter(true, () => {}, options); hosts.push(a.engine); await a.rpc("browser", "initialize", {}, context);
    const { thread } = await a.rpc("browser", "thread/start", {}, context);
    await a.engine.close();
    const b = await f.adapter(true, () => {}, options); hosts.push(b.engine); await b.rpc("browser", "initialize", {}, context);
    await b.rpc("browser", "thread/resume", { threadId: thread.id, excludeTurns: true }, context);
    methods.length = 0;
    if (scopeChange !== "none" && scopeChange !== "no-mcp") {
      if (scopeChange === "project") runtime.bind("local-codex", thread.id, "another-project");
      if (scopeChange === "unknown") {
        const db = new DatabaseSync(join(options.dataDirectory, "thread-creations.sqlite"));
        try { db.prepare("UPDATE thread_creations SET environment_owner=NULL WHERE thread_id=?").run(thread.id); } finally { db.close(); }
      }
      const changedContext = scopeChange === "account" ? { ...context,
        sender: { kind: "employee" as const, loginName: "bob" }, executionPrincipal: { provider: "employee", subject: "bob" } } : context;
      await assert.rejects(b.rpc("browser", "turn/start", { threadId: thread.id, clientUserMessageId: "changed-scope", input: [{ type: "text", text: "must not reach native" }] }, changedContext), /input was not sent/);
      assert.equal(bound.size, 0, "unverified environment ownership cannot bind the credential");
      assert.equal(methods.includes("turn/start"), false);
      assert.equal(methods.includes("thread/resume"), false);
      if (scopeChange === "unknown") return;
      if (scopeChange === "project") runtime.bind("local-codex", thread.id, null);
    }
    const ack = await b.rpc("browser", "turn/start", { threadId: thread.id, clientUserMessageId: "env-restored-first", input: [{ type: "text", text: "one synthetic input" }] }, context);
    assert.ok(ack.turn.id);
    assert.equal(restored, scopeChange === "no-mcp" ? 0 : 1); assert.equal(bound.size, scopeChange === "no-mcp" ? 0 : 1);
    assert.equal(methods.includes("thread/resume"), false, "the first input cannot require nonexistent native history");
    assert.equal(methods.filter(method => method === "turn/start").length, 1);
    const read = await b.rpc("browser", "thread/read", { threadId: thread.id, includeTurns: true }, context);
    assert.equal(read.thread.turns.length, 1);
    await b.rpc("browser", "fixture/publish", { threadId: thread.id, delta: "restored-with-environment" });
    await b.rpc("browser", "fixture/complete", { threadId: thread.id });
    assert.ok(b.frames.some(frame => frame.method === "item/agentMessage/delta" && frame.params.delta === "restored-with-environment"));
    assert.ok(b.frames.some(frame => frame.method === "turn/completed" && frame.params.turn.id === ack.turn.id));
    methods.length = 0;
    const second = await b.rpc("browser", "turn/start", { threadId: thread.id, clientUserMessageId: "env-next", input: [{ type: "text", text: "next synthetic input" }] }, context);
    assert.notEqual(second.turn.id, ack.turn.id);
    assert.ok(methods.includes("thread/resume"), "a later execution refreshes the native environment after the preserved first snapshot");
    assert.equal(methods.filter(method => method === "turn/start").length, 1);
    const final = await b.rpc("browser", "thread/read", { threadId: thread.id, includeTurns: true }, context);
    assert.deepEqual(final.thread.turns.map((turn: any) => turn.items[0].clientId), ["env-restored-first", "env-next"]);
    await b.rpc("browser", "fixture/complete", { threadId: thread.id });
  } finally { await Promise.all(hosts.map(host => host.close())); runtime.close(); vault.close(); await f.close(); }
});


test("creation storage upgrades v1 without inventing an environment owner", async () => {
  const root = await mkdtemp(join(temporaryDirectory, "oc-creation-v1-"));
  const { openManagedDatabase, createSchemaValidator } = await import("@opencraft/sqlite-node");
  const { ProvisionalThreads } = await import("../../apps/opencraft-daemon/src/provisional-threads.js");
  const v1 = `CREATE TABLE thread_creations (
  thread_id TEXT PRIMARY KEY, result_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('created','attempted','accepted','persisted')),
  input_id TEXT, turn_id TEXT
) STRICT;`;
  try {
    const old = openManagedDatabase({ path: join(root, "thread-creations.sqlite"), legacyPolicy: "reject",
      migrations: [{ version: 1, name: "thread-creation-lifecycle", sql: v1 }], validateSchema: createSchemaValidator(v1) });
    old.database.prepare("INSERT INTO thread_creations VALUES(?,?,'created',NULL,NULL)").run("legacy", JSON.stringify({ thread: { id: "legacy", turns: [] } })); old.database.close();
    let current = new ProvisionalThreads(root);
    assert.equal(current.get("legacy")?.phase, "created"); assert.equal(current.get("legacy")?.environmentOwner, null);
    current.created("new", { thread: { id: "new", turns: [] } }, "synthetic-owner-fingerprint"); current.close();
    current = new ProvisionalThreads(root);
    try { assert.equal(current.get("new")?.environmentOwner, "synthetic-owner-fingerprint");
      assert.deepEqual(current.get("new")?.result, { thread: { id: "new", turns: [] } }); }
    finally { current.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const state of ["created", "active-peer", "persisted", "attempted", "unloaded", "other-error", "checkpoint-failed", "checkpoint-wrong-id"] as const) test(`unsupported empty native history requires positive creation evidence (${state})`, async () => {
  const root = await mkdtemp(join(temporaryDirectory, "oc-empty-history-"));
  const { ProvisionalThreads } = await import("../../apps/opencraft-daemon/src/provisional-threads.js");
  const store = new ProvisionalThreads(root);
  const path = join(root, "rollout.jsonl");
  const thread = { id: "new", turns: [], path, status: { type: state === "active-peer" ? "active" : "idle" } };
  store.created("new", { thread });
  if (state === "attempted") store.attempted("new", "uncertain-input");
  if (state === "persisted") await writeFile(path, "existing history");
  const calls: string[] = [];
  const adapter: any = Object.create(CodexEngineAdapter.prototype);
  Object.assign(adapter, { provisionalThreads: store, async requestPhysical(method: string, params: any) {
    calls.push(method);
    if (method === "thread/loaded/list") return { data: state === "unloaded" && calls.length > 1 ? [] : ["new"] };
    if (params.includeTurns && (state === "created" || state === "checkpoint-wrong-id"))
      await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: state === "created" ? "new" : "other" } }) + "\n");
    if (state === "other-error" || params.includeTurns) throw new AppServerRpcError({code: state === "other-error" ? -32000 : -32601, message: "list_turns is not supported yet"});
    return { thread };
  } });
  try {
    if (["other-error", "checkpoint-failed", "checkpoint-wrong-id"].includes(state)) await assert.rejects(adapter.provisionalResult("new"), /list_turns/);
    else {
      if (state === "active-peer" || state === "persisted") {
        await assert.rejects(adapter.provisionalResult("new"), /list_turns/);
        return;
      }
      const result = await adapter.provisionalResult("new");
      assert.equal(result?.thread.creationPhase ?? null, state === "created" ? "created" : null);
      if (state === "attempted") assert.deepEqual(calls, [], "uncertain input must not be reclassified from history reads");
      if (state === "persisted") assert.equal(store.get("new")?.phase, "persisted");
    }
  } finally { store.close(); await rm(root, {recursive:true,force:true}); }
});

test('Native acknowledged root retains its ID when post-ACK materialization fails',async()=>{
 const f=await fixture();
 try{
  const a=await f.adapter(true);await a.rpc('human','initialize');
  // Fail the outer Host persistence observation after the real Core/Native ACK.
  (a.engine as any).materializeCreation=async()=>{throw Error('synthetic persistence observation failed');};
  await assert.rejects(a.rpc('human','thread/start',{cwd:f.root}),/Could not create this conversation/);
  const response=a.frames.find(frame=>frame.error?.message==='Could not create this conversation');
  assert.equal(response.error.data.resultUnknown,true);assert.equal(typeof response.error.data.threadId,'string');
  const read=await a.rpc('human','thread/read',{threadId:response.error.data.threadId,includeTurns:false});
  assert.equal(read.thread.id,response.error.data.threadId);
 }finally{await f.close();}
});

test('stock Native exact final pages cross the real Core without starting another model call',{
 skip:!process.env.OPENCRAFT_TEST_NATIVE_CLI,timeout:60000,
},async()=>{
 const final='🦉'.repeat(5001);let posts=0;
 const f=await fixture(async options=>({...options,executable:process.env.OPENCRAFT_TEST_NATIVE_CLI!,spawnAppServer:undefined,
  fetch:async(input,init)=>{
   const url=new URL(input instanceof Request?input.url:String(input));
   if(init?.method!=='POST'||!url.pathname.endsWith('/responses'))return Response.json({plan_type:'pro'});
   posts++;const item={type:'message',id:'msg_exact',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:final,annotations:[]}]};
   const response={id:'resp_exact',object:'response',status:'in_progress',output:[]};
   const events=[{type:'response.created',response},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:final},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
   return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  }}));
 try{
  const a=await f.adapter(true);await a.rpc('human','initialize',{clientInfo:{name:'isolated-exact',version:'1'},capabilities:{experimentalApi:true}});
  await mkdir(f.options.nativeCodexHomeDirectory!,{recursive:true});
  const synthetic=`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,'https://api.openai.com/auth':{chatgpt_account_id:'stock-fixture'}})).toString('base64url')}.synthetic`;
  await writeFile(join(f.options.nativeCodexHomeDirectory!,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:synthetic,refresh_token:'synthetic',account_id:'stock-fixture'}}));
  await a.rpc('human','opencraft/codex/accounts/import');
  const {thread}=await a.rpc('human','thread/start',{cwd:f.root,ephemeral:false,model:'gpt-5.3-codex'});
  const start=await a.rpc('human','turn/start',{threadId:thread.id,clientUserMessageId:'exact-stock-input',input:[{type:'text',text:'synthetic exact input'}]});
  for(let n=0;n<500&&!a.frames.some(m=>m.method==='turn/completed'&&m.params.turn.id===start.turn.id);n++)await delay(10);
  assert.equal(a.frames.find(m=>m.method==='turn/completed'&&m.params.turn.id===start.turn.id)?.params.turn.status,'completed');
  let cursor:string|null=null,text='',last:any;
  do {last=await a.rpc('human','opencraft/turn-result/read',{threadId:thread.id,turnId:start.turn.id,output:true,cursor});
   assert.equal(last.turnId,start.turn.id);assert.equal(last.matched,true);assert.equal(last.finalUnavailable,false);assert.ok(Array.from(last.entries[0].text).length<=2000);
   text+=last.entries[0].text;cursor=last.nextCursor;
  }while(cursor);
  assert.equal(last.complete,true);assert.equal(text,final);assert.equal(posts,1);
  const configuration=await a.rpc('human','opencraft/turn-configuration/read',{threadId:thread.id,turnId:start.turn.id});
  assert.equal(configuration.status,'observed');assert.equal(configuration.scope,'turn-first-recorded-context');
  assert.equal(configuration.model,'gpt-5.3-codex');assert.equal(configuration.turnId,start.turn.id);assert.equal(configuration.initiality,'start-boundary-observed');
  assert.equal(typeof configuration.recordedAt,'string');assert.equal(posts,1,'configuration read cannot start another model call');
  const unknown=await a.rpc('human','opencraft/turn-result/read',{threadId:thread.id,turnId:'missing',output:true,cursor:null});assert.equal(unknown.matched,false);assert.equal(unknown.complete,false);assert.equal(posts,1);
 }finally{await f.close();}
});


test('exact stop crosses the real Core callback transport and leaves other native Turns live',async()=>{
 const f=await fixture();try{
  const a=await f.adapter(true,()=>{},{collaboration:{serverId:'synthetic-server',started(){},continued(){},authorize(){},async command(){return {};},async tool(){return null;}} as any});await a.rpc('employee','initialize');
  const first=(await a.rpc('employee','thread/start',{cwd:f.root})).thread.id;
  const second=(await a.rpc('employee','thread/start',{cwd:f.root})).thread.id;
  const target=(await a.rpc('employee','turn/start',{threadId:first,input:[]})).turn.id;
  const other=(await a.rpc('employee','turn/start',{threadId:second,input:[]})).turn.id;
  let current=true;const trusted={sender:null,actorContext:{actorId:'synthetic-human',generation:1,credentialId:null,expiresAt:Date.now()+60000},resourceOwner:{id:'synthetic-auth',assertCurrent(){assert.equal(current,true);}}};
  const result=await a.rpc('employee','opencraft/conversation/stop',{threadId:first,expectedTurnId:target},trusted);
  assert.equal(result.requestState,'acknowledged');assert.equal(result.observation.turnState,'interrupted');
  const stoppedDb=new DatabaseSync(join(f.options.dataDirectory!,'interrupted-turn-recovery.sqlite'),{readOnly:true});
  const stopped=JSON.parse(String(stoppedDb.prepare('SELECT value FROM interrupted_turns WHERE thread_id=?').get(first)!.value));stoppedDb.close();
  assert.equal(stopped.turnId,target);assert.equal(stopped.state,'handled');assert.equal(stopped.handledReason,'user_stop');
  const live=await a.rpc('employee','opencraft/conversation/stop-observe',{threadId:second,expectedTurnId:other},trusted);assert.equal(live.turnState,'inProgress');
  await assert.rejects(a.rpc('employee','opencraft/conversation/stop',{threadId:second,expectedTurnId:target},trusted));
  const race=(await a.rpc('employee','thread/start',{cwd:f.root})).thread.id;
  const prior=(await a.rpc('employee','turn/start',{threadId:race,input:[]})).turn.id;
  await a.rpc('employee','fixture/replaceAfterHeaders',{threadId:race});
  try {const raced=await a.rpc('employee','opencraft/conversation/stop',{threadId:race,expectedTurnId:prior},trusted);assert.equal(raced.requestState,'unknown');}
  catch(error){assert.match(String(error),/Conversation control unavailable/);}
  const after=await a.rpc('employee','opencraft/conversation/stop-observe',{threadId:race,expectedTurnId:prior},trusted);
  assert.notEqual(after.activeTurnId,prior);assert.ok(after.activeTurnId);const racedCount=await a.rpc('employee','fixture/interruptCount',{threadId:race});assert.ok(racedCount.count<=1);if(racedCount.count)assert.equal(racedCount.targetTurnId,prior);
  const recoveryDb=new DatabaseSync(join(f.options.dataDirectory!,'interrupted-turn-recovery.sqlite'),{readOnly:true});
  const recovery=JSON.parse(String(recoveryDb.prepare('SELECT value FROM interrupted_turns WHERE thread_id=?').get(race)!.value));recoveryDb.close();assert.equal(recovery.turnId,after.activeTurnId);assert.equal(recovery.state,'running');
  current=false;await assert.rejects(a.rpc('employee','opencraft/conversation/stop',{threadId:second,expectedTurnId:other},trusted));
 }finally{await f.close();}
});


test('stock Native precise interrupt observes a local-stub Turn without external inference', {skip:!process.env.OPENCRAFT_TEST_NATIVE_CLI},async()=>{
 let posts=0,stream:ReadableStreamDefaultController<Uint8Array>|undefined;
 const f=await fixture(async options=>({...options,executable:process.env.OPENCRAFT_TEST_NATIVE_CLI!,spawnAppServer:undefined,fetch:async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(init?.method!=='POST'||!url.pathname.endsWith('/responses'))return Response.json({plan_type:'pro'});
  posts++;return new Response(new ReadableStream<Uint8Array>({start(controller){stream=controller;controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.created',response:{id:'synthetic-stop-response',object:'response',status:'in_progress',output:[]}})+'\n\n'));}}),{headers:{'content-type':'text/event-stream'}});
 }}));
 try{
  const a=await f.adapter(true,()=>{},{collaboration:{serverId:'synthetic-server',started(){},continued(){},authorize(){},async command(){return {};},async tool(){return null;}} as any});
  await a.rpc('employee','initialize',{clientInfo:{name:'stock-stop',version:'1'},capabilities:{experimentalApi:true}});
  await mkdir(f.options.nativeCodexHomeDirectory!,{recursive:true});
  const access=`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-stop'}})).toString('base64url')}.synthetic`;
  await writeFile(join(f.options.nativeCodexHomeDirectory!,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:access,refresh_token:'synthetic',account_id:'synthetic-stop'}}));
  await a.rpc('employee','opencraft/codex/accounts/import');
  const {thread}=await a.rpc('employee','thread/start',{cwd:f.root,model:'gpt-6.1-sol'});
  const {turn}=await a.rpc('employee','turn/start',{threadId:thread.id,input:[{type:'text',text:'Synthetic local stop probe'}]});
  const trusted={sender:null,actorContext:{actorId:'synthetic-human',generation:1,credentialId:null,expiresAt:Date.now()+60000},resourceOwner:{id:'synthetic-auth',assertCurrent(){}}};
  const observed=await a.rpc('employee','opencraft/conversation/stop-observe',{threadId:thread.id,expectedTurnId:turn.id},trusted);assert.equal(observed.turnState,'inProgress');
  const result=await a.rpc('employee','opencraft/conversation/stop',{threadId:thread.id,expectedTurnId:turn.id},trusted);assert.equal(result.requestState,'acknowledged');
  let final=result.observation;for(let i=0;i<20&&final.turnState!=='interrupted';i++){await delay(50);final=await a.rpc('employee','opencraft/conversation/stop-observe',{threadId:thread.id,expectedTurnId:turn.id},trusted);}
  assert.equal(final.turnState,'interrupted');assert.ok(posts<=1,'no replay');
 }finally{try{stream?.close();}catch{}await f.close();}
});

for(const failure of ['missing','read-failure','unavailable-model'] as const)test(`explicit settings cannot silently reach Native defaults (${failure})`,async()=>{
 const f=await fixture();let reads=0;
 try{
  const input={available:()=>true,settingsAvailable:()=>failure!=='missing',mode:()=> 'queue' as const,authorize:()=>true,...(failure==='missing'?{}:{settings(){reads++;if(failure==='read-failure')throw Error('synthetic settings storage unavailable');return {model:'missing-from-native-catalog',reasoningEffort:'medium'};}})};
  const a=await f.adapter(true,()=>{},{collaborationInput:input});const init=await a.rpc('human','initialize');assert.equal(init.capabilities.extensions['opencraft/thread-queue'].modelSettings,failure!=='missing');
  const {thread}=await a.rpc('human','thread/start',{cwd:f.root});const inputId='actor-input:synthetic-request';
  (a.engine as any).executionLeases.capture(thread.id,inputId,{principal:{provider:'synthetic',subject:'verified'},ownership:'human'});
  const queued=await a.rpc('human','thread/queue/add',{threadId:thread.id,clientUserMessageId:inputId,input:[{type:'text',text:'synthetic'}]},{sender:null,collaborationRequestId:'synthetic-request'});
  await assert.rejects(a.rpc('human','thread/queue/start',{threadId:thread.id,queuedSubmissionId:queued.queuedSubmission.id},{sender:null,collaborationRequestId:'synthetic-request'}));
  const read=await a.rpc('human','thread/read',{threadId:thread.id,includeTurns:true});assert.deepEqual(read.thread.turns,[],'no Native Turn may consume default settings after failed explicit lookup');
  if(failure!=='missing')assert.ok(reads>0);
 }finally{await f.close();}
 });

for(const overlays of [false,true]) test(`structured human response retains trusted scope across real Core routing (overlays=${overlays})`,async()=>{
 const f=await fixture();
 try {
  const a=await f.adapter(overlays);await a.rpc('browser','initialize');
  const {thread}=await a.rpc('browser','thread/start',{cwd:f.root});
  await a.rpc('browser','fixture/emitInteraction',{threadId:thread.id});
  await a.rpc('human-cli','initialize',{capabilities:{extensions:{'opencraft/shared-interactions':{version:1}}}});
  let admitted=true;
  const context={sender:null,interactionScope:{threadId:thread.id,respond:true},resourceOwner:{id:'synthetic-hub',assertCurrent(){if(!admitted)throw Error('revoked human');}}};
  const snapshot=await a.rpc('human-cli','opencraft/interactions/read',{threadId:thread.id},context);
  assert.equal(snapshot.requests.length,1);
  const submission={threadId:thread.id,interactionId:snapshot.requests[0].id,submissionId:'synthetic-human',expectedEpoch:snapshot.epoch,expectedRevision:snapshot.revision,response:{decision:'accept'}};
  await assert.rejects(a.rpc('human-cli','opencraft/interactions/respond',submission,{...context,interactionScope:{threadId:thread.id,respond:false}}));
  admitted=false;await assert.rejects(a.rpc('human-cli','opencraft/interactions/respond',submission,context));admitted=true;
  const receipt=await a.rpc('human-cli','opencraft/interactions/respond',submission,context);
  assert.equal(receipt.disposition,'submitted');
  const replies=await a.rpc('browser','fixture/interactionReplies');
  assert.equal(replies.data.length,1);assert.deepEqual(replies.data[0].result,{decision:'accept'});
 } finally {await f.close();}
});

for(const overlays of [false,true]) test(`Hub employee interaction crosses initialized AppHost and real Core without message attribution (overlays=${overlays})`,async()=>{
 const f=await fixture();let hub:any,host:any,actors:any,database:any;
 try {
  const a=await f.adapter(overlays);await a.rpc('browser','initialize');
  const {thread}=await a.rpc('browser','thread/start',{cwd:f.root});await a.rpc('browser','fixture/emitInteraction',{threadId:thread.id});
  const {AppHostServer}=await import('../../packages/app-host-server/src/index');
  const {createRoutedConversationExecution}=await import('../../scripts/conversation-execution.mjs');
  const {Collaboration}=await import('../../packages/access-control/src/collaboration');
  const {ActorStore}=await import('../../packages/access-control/src/actors');
  const {openServerDatabase}=await import('../../packages/storage-node/src/server/index');
  database=await openServerDatabase(join(f.root,'hub'));actors=new ActorStore(database);
  const human=actors.resolveHuman({provider:'synthetic',subject:'employee',displayName:'Employee',expiresAt:Date.now()+60000});
  host=new AppHostServer({hostId:'hub',logicalClientRouting:true,physicalHostLifetime:'server',hostDefinitions:[{hostId:'local-codex',label:'Codex'}],createTransport:()=>a.engine});
  const port=createRoutedConversationExecution(()=>host,{machineId:'fixture',engines:[],getInputs:async()=>null});
  hub=new Collaboration(database,actors,port);
  const ref={serverId:'server:fixture:codex',threadId:thread.id};
  const snapshot=await hub.command(human,{action:'interactions',reference:ref});assert.equal(snapshot.interactions.length,1);
  const result=await hub.command(human,{action:'respondInteraction',reference:ref,interactionId:snapshot.interactions[0].id,submissionId:'employee-answer',expectedEpoch:snapshot.epoch,expectedRevision:snapshot.revision,response:{decision:'accept'}},
   {submission:{sender:{kind:'employee',loginName:'synthetic.employee'},actorContext:human}});
  assert.equal(result.disposition,'submitted');assert.equal(result.executionState,'unknown');
  assert.equal((await a.rpc('browser','fixture/interactionReplies')).data.length,1);
 } finally {await hub?.close();await host?.close();actors?.close();await database?.close();await f.close();}
});


test("sandbox execution loss invalidates APP health and admission while Router history survives, then observes recovery without restarting", async () => {
  const root = await mkdtemp(join(temporaryDirectory, "oc-exec-health-"));
  const reservation = createTcpServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const options: CodexCoreOptions = { endpoint: join(root, "accounts/control.sock"), appServerEndpoint: join(root, "execution/control.sock"),
    authToken: token, executable: process.execPath, runtimeDirectory: root, dataDirectory: join(root, "data"),
    nativeCodexHomeDirectory: join(root, "native"), proxyPort: port, fetch: async () => Response.json({ plan_type: "pro" }) };
  const configuration = join(root, "sandbox.json");
  await writeFile(configuration, JSON.stringify({ schemaVersion: 1, backend: { id: "remote-test", options: {} }, pool: { idPrefix: "test" }, environment: {mode: "selected", names: []} }), {mode: 0o600});
  const core = await startCodexCore(options);
  let runtime: Awaited<ReturnType<typeof startCodexAppServer>> | undefined;
  let socket: WebSocket | undefined, launches = 0;
  let routing: Awaited<ReturnType<typeof import("../../apps/codex-core/src/generation-router.js")["startGenerationSocket"]>> | undefined;
  let routingRuntime: import("../../apps/codex-core/src/generation-runtime.js").CodexGenerationRuntime | undefined;
  try {
    runtime = await startCodexAppServer({...options, endpoint: options.appServerEndpoint!, coreEndpoint: options.endpoint,
      executionSandbox: {configuration, runner: join(root, "sandbox-command.mjs")},
      spawnAppServer: ({args, cwd, env}) => { launches++; return spawn(process.execPath,
        [new URL("../fixtures/fake-codex-unix-appserver.mjs", import.meta.url).pathname, args[2]!.slice("unix://".length)], {cwd, env, stdio: ["pipe", "pipe", "pipe"]}); }});
    const health = new CodexCoreControlClient(options.appServerEndpoint!, token);
    const before = await health.health();
    const {SystemdGenerationSupervisor} = await import("../../apps/codex-core/src/generation-supervisor.js");
    const {CodexGenerationRuntime} = await import("../../apps/codex-core/src/generation-runtime.js");
    const {CodexGenerationRouter, startGenerationSocket} = await import("../../apps/codex-core/src/generation-router.js");
    const supervisor = new SystemdGenerationSupervisor({registryDirectory: join(root, "router"), coreEndpoint: options.endpoint,
      dataDirectory: options.dataDirectory, tokenFile: join(root, "unused-token"), token, scope: "system"});
    routingRuntime = new CodexGenerationRuntime({directory: join(root, "router"), dataDirectory: options.dataDirectory,
      proxyBaseUrl: (before as any).proxyBaseUrl, requireHostUsage: false, replaceRetiredHome: async () => {}, supervisor: {
        start: g => supervisor.start(g), inspect: g => supervisor.inspect(g),
        identify: async () => ({ownerPid: process.pid, nativePid: before.codexPid, ownerStart: "1", nativeStart: "1", cliSha256: "fixed", cliVersion: "codex-cli 0.162.1"}),
        async stop() {}, async discardUnready() {}, async processesQuiet() {return false;},
      }});
    const generation = await routingRuntime.prepare({id: "existing", endpoint: options.appServerEndpoint!, runtimeDataDirectory: options.dataDirectory,
      executable: process.execPath, node: process.execPath, bundle: process.execPath, cwd: root}, true);
    routingRuntime.registry.activate(generation.id, routingRuntime.registry.epoch());
    const routerPath = join(root, "router-native.sock");
    routing = await startGenerationSocket(routerPath, new CodexGenerationRouter(routingRuntime));
    socket = new WebSocket(`ws+unix://${routerPath}:/`);
    await new Promise<void>((resolve, reject) => {socket!.once("open", resolve); socket!.once("error", reject);});
    const {nativeOwnerRequest} = await import("../../apps/codex-core/src/native-process.js");
    const request = async (peer: WebSocket, method: string, params: unknown) => {
      try {return await nativeOwnerRequest(peer, method, params);}
      catch (cause) {throw new Error(`Fixture request failed: ${method}`, {cause});}
    };
    await request(socket, "initialize", {clientInfo: {name: "fixture", version: "1"}, capabilities: {experimentalApi: true}});
    const created = await request(socket, "thread/start", {cwd: root}) as any;
    assert.ok(await routingRuntime.inspectHealth("existing"));
    for (const status of ["disconnected", "pending", "unknown", "unexpected-status", null]) {
      await request(socket, "fixture/executionStatus", {status});
      if (status === "disconnected") {
        await delay(1_050); // Expire Router readiness cache after loss.
        await assert.rejects(routingRuntime.activate("existing", routingRuntime.registry.epoch()));
        await assert.rejects(routingRuntime.preparation("existing"));
      }
      await assert.rejects(routingRuntime.inspectHealth("existing"));
      await assert.rejects(health.health(), /unavailable/i);
      await assert.rejects(request(socket, "thread/start", {cwd: root}));
      await assert.rejects(request(socket, "turn/start", {threadId: "missing", cwd: root}));
      await assert.rejects(request(socket, "turn/steer", {threadId: "missing", input: []}));
      await request(socket, "thread/list", {});
      const history = await request(socket, "thread/read", {threadId: created.thread.id}) as any;
      assert.equal(history.thread.id, created.thread.id);
    }
    await request(socket, "fixture/executionStatus", {status: "timeout"});
    await assert.rejects(health.health(), /unavailable/i);
    assert.ok(await health.appServerHealth("native"));
    assert.ok(await routingRuntime.ensure("existing", false, true));
    await request(socket, "fixture/executionStatus", {status: "ready"});
    assert.equal((await health.health()).codexPid, before.codexPid);
    assert.ok(await request(socket, "thread/start", {cwd: root}));
    assert.equal(launches, 1);
    await runtime.close("SIGTERM"); runtime = undefined;
    const text = await readFile(join(root, "data/runtime/exec-server-lifecycle.jsonl"), "utf8");
    assert.equal(text.includes("SYNTHETIC_SECRET_NATIVE_DETAIL"), false);
    const events = text.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(events.some(e => e.event === "environment-status" && e.status === "disconnected"));
    assert.ok(events.some(e => e.event === "owner-stop" && e.reason === "SIGTERM"));
  } finally {socket?.terminate(); await routing?.close(); await routingRuntime?.close(); await runtime?.close(); await core.close(); await rm(root, {recursive: true, force: true});}
});


for (const overlays of [false, true]) test(`cached history admits passive interactions before native reconciliation (overlays=${overlays})`, async () => {
  const { openServerDatabase } = await import("@opencraft/storage-node/server");
  const { ConversationHistory } = await import("../../packages/app-host-server/src/conversation-history.js");
  const { ConversationHistoryTransport } = await import("../../packages/app-host-server/src/conversation-history-transport.js");
  const f = await fixture();
  const a = await f.adapter(overlays);
  const database = await openServerDatabase(join(f.root, "history-cache"));
  const history = new ConversationHistory(database.database, "local-codex");
  let allowed = true;
  const { MachineIdentityTransport } = await import("../../apps/opencraft-daemon/src/machine-transport.js");
  const { McpAppsTransport } = await import("../../packages/mcp-apps/src/transport.js");
  const { McpAppsService } = await import("../../packages/mcp-apps/src/server.js");
  const { ModelPolicyTransport } = await import("../../packages/model-usage-policy/src/transport.js");
  const apps = new McpAppsService(join(f.root, "mcp-apps.sqlite"));
  const decorated = new ModelPolicyTransport(new McpAppsTransport(new MachineIdentityTransport(null, "Codex", () => a.engine), apps), join(f.root, "model-policy.json"));
  const { ExecutionEnvironmentTransport } = await import("../../scripts/execution-environment-transport.js");
  const { ExecutionEnvironmentRuntime } = await import("../../scripts/execution-environment.js");
  const { EmployeeGitVaultStore } = await import("../../scripts/employee-git-vault-store.js");
  const environment = new ExecutionEnvironmentRuntime(join(f.root, "environment"), new EmployeeGitVaultStore(join(f.root, "environment")), true);
  const transport = new ConversationHistoryTransport(new ExecutionEnvironmentTransport(decorated, environment, "local-codex"), history, undefined, 100, undefined, () => allowed);
  const frames: any[] = [];
  transport.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  let sequence = 0;
  const rpc = async (clientId: string, method: string, params: object = {}) => {
    const id = `cached-reader:${++sequence}`;
    await transport.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
    for (let n = 0; n < 300; n++) {
      const reply = frames.find(frame => frame.id === id && frame[LOGICAL_CLIENT_FIELD] === clientId);
      if (reply) return reply;
      await delay(10);
    }
    throw Error(`No cached reader response: ${method}`);
  };
  const initialize = { capabilities: { extensions: { "opencraft/shared-interactions": { version: 1 } } } };
  try {
    const initialized = await a.rpc("writer", "initialize", initialize);
    const { thread } = await a.rpc("writer", "thread/start");
    history.importResult("initialize", {}, initialized, 0);
    history.importResult("thread/read", { threadId: thread.id, includeTurns: true }, { thread }, 0);
    await a.rpc("writer", "fixture/holdNextRead", { untilRelease: true });
    await transport.connect();
    assert.ok((await rpc("reader", "initialize", initialize)).result);
    assert.ok((await rpc("reader", "thread/read", { threadId: thread.id, includeTurns: false, watch: true })).result);
    const read = await rpc("reader", "opencraft/interactions/read", { threadId: thread.id });
    assert.equal(read.error, undefined, "cached watch must admit interaction snapshots before a native read ACK");
    assert.deepEqual(read.result.requests, []);
    await a.rpc("writer", "fixture/emitInteraction", { threadId: thread.id });
    for (let n = 0; n < 100 && !frames.some(frame => frame.method === "opencraft/interactions/changed"
      && frame[LOGICAL_CLIENT_FIELD] === "reader" && frame.params.requests.length === 1); n++) await delay(10);
    assert.ok(frames.some(frame => frame.method === "opencraft/interactions/changed"
      && frame[LOGICAL_CLIENT_FIELD] === "reader" && frame.params.requests.length === 1), "passive reader receives pending approvals");
    assert.equal((await rpc("reader", "opencraft/interactions/read", { threadId: "foreign" })).error.code, 403);
    await rpc("stranger", "initialize", initialize);
    assert.equal((await rpc("stranger", "opencraft/interactions/read", { threadId: thread.id })).error.code, 403);
    await a.rpc("writer", "fixture/releaseReads");
    const nativeReadAck = () => a.frames.some(frame => frame[LOGICAL_CLIENT_FIELD] === "reader"
      && String(frame.id).startsWith("conversation-read:") && frame.result?.thread?.id === thread.id);
    for (let n = 0; n < 100 && !nativeReadAck(); n++) await delay(10);
    assert.ok(nativeReadAck(), "revocation is checked after the native watched read has succeeded");
    allowed = false;
    assert.ok((await rpc("reader", "opencraft/interactions/read", { threadId: thread.id })).error, "revoked history access cannot read interactions");
    const start = frames.length;
    await a.rpc("writer", "fixture/emitInteraction", { threadId: thread.id });
    await delay(30);
    assert.equal(frames.slice(start).some(frame => frame.method === "opencraft/interactions/changed"
      && frame[LOGICAL_CLIENT_FIELD] === "reader"), false, "revoked readers receive no approvals");
    allowed = true;
    await rpc("reader", "thread/unsubscribe", { threadId: thread.id });
    await a.rpc("writer", "fixture/releaseReads");
    await delay(30);
    assert.equal((await rpc("reader", "opencraft/interactions/read", { threadId: thread.id })).error.code, 403, "a late native read ACK cannot revive an unsubscribed reader");
    await transport.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: "reader" }));
    await rpc("reader", "initialize", initialize);
    assert.equal((await rpc("reader", "opencraft/interactions/read", { threadId: thread.id })).error.code, 403, "reusing a logical lane cannot revive its old watch");
  } finally {
    await a.rpc("writer", "fixture/releaseReads").catch(() => undefined);
    await transport.close(); environment.close(); apps.close(); await database.close(); await f.close();
  }
});
