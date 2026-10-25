import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { CodexGenerationRegistry, type GenerationTicket } from "../../apps/codex-core/src/generation-registry.js";
import { CodexGenerationRouter, startGenerationSocket, type GenerationRuntimeDirectory } from "../../apps/codex-core/src/generation-router.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oc-gen-router-")), registry = new CodexGenerationRegistry(root);
  const servers: WebSocketServer[] = [], sockets: WebSocket[] = [];
  const threads = new Map<string, Map<string, any>>(), calls: { generation: string; method: string; params: any }[] = [];
  const holds = new Map<string, { method: string; entered: Promise<void>; release(): void }>();
  const replies: { generation: string; id: unknown; result: unknown }[] = [];
  for (const id of ["old", "new"]) {
    const directory = join(root, id); await mkdir(directory, { recursive: true, mode: 0o700 });
    const nativeSocket = join(directory, "native.sock"), server = new WebSocketServer({ path: "/", server: undefined, noServer: true });
    const http = (await import("node:http")).createServer(); http.on("upgrade", (r, s, h) => server.handleUpgrade(r, s, h, ws => server.emit("connection", ws)));
    await new Promise<void>(resolve => http.listen(nativeSocket, resolve)); servers.push(server);
    const table = new Map<string, any>(); threads.set(id, table);
    server.on("connection", ws => { sockets.push(ws); ws.on("message", async raw => {
      const m = JSON.parse(String(raw));
      if (!m.method && m.id !== undefined) { replies.push({ generation: id, id: m.id, result: m.result }); return; }
      if (m.id === undefined) return;
      const params = m.params ?? {}; calls.push({ generation: id, method: m.method, params });
      const gate = holds.get(id);
      if (gate?.method === m.method) { (gate as any).enteredResolve(); await (gate as any).done; holds.delete(id); }
      let result: any = {};
      if (m.method === "initialize") result = { userAgent: id };
      else if (m.method === "thread/start" || m.method === "thread/fork") {
        const tid = `${id}-${table.size + 1}`; const thread = { id: tid, createdAt: table.size + (id === "old" ? 1 : 100), updatedAt: table.size + (id === "old" ? 1 : 100), status: { type: "idle" }, turns: [] }; table.set(tid, thread); result = { thread }; ws.send(JSON.stringify({ method: "thread/started", params: { thread } }));
      } else if (m.method === "thread/read") {
        const thread = table.get(params.threadId);
        if (!thread) { ws.send(JSON.stringify({ id: m.id, error: { code: -32600, message: "Thread not found" } })); return; }
        result = { thread };
      } else if (m.method === "thread/list") {
        const all = [...table.values()].sort((a, b) => b.updatedAt - a.updatedAt), offset = Number(params.cursor ?? 0), size = params.limit ?? 100;
        result = { data: all.slice(offset, offset + size), nextCursor: offset + size < all.length ? String(offset + size) : null };
      } else if (m.method === "thread/loaded/list") result = { data: [...table.keys()] };
      else if (m.method === "fixture/approval") { ws.send(JSON.stringify({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: params.threadId, turnId: "turn" } })); }
      else if (m.method === "fixture/resolveApproval") { ws.send(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: params.threadId, requestId: 7 } })); }
      else if (m.method === "model/list") result = { data: [id] };
      else if (m.method === "turn/start") result = { turn: { id: `${id}-turn`, status: "inProgress" } };
      ws.send(JSON.stringify({ id: m.id, result }));
    }); });
    (server as any).closeHttp = () => new Promise<void>(resolve => http.close(() => resolve()));
    registry.register({ id, endpoint: join(directory, "control.sock"), runtimeDataDirectory: join(directory, "data"), executable: join(directory, "codex"), bundle: join(directory, "app-server.cjs"), node: process.execPath, cwd: root }); registry.ready(id);
  }
  registry.activate("old", 0);
  const runtime: GenerationRuntimeDirectory = { registry,
    async ensure(id) { return { protocolVersion: 1, pid: 1, codexPid: 2, dataDirectory: root, proxyBaseUrl: "http://127.0.0.1:1", nativeSocket: join(root, id, "native.sock") }; },
    admit(ticket: GenerationTicket) { assert.equal(registry.valid(ticket), true); return () => {}; }, observe() {}, };
  const router = new CodexGenerationRouter(runtime), listener = await startGenerationSocket(join(root, "router.sock"), router);
  const client = new WebSocket(`ws+unix://${join(root, "router.sock")}:/`), messages: any[] = [];
  client.on("message", raw => messages.push(JSON.parse(String(raw)))); await new Promise<void>(resolve => client.once("open", resolve));
  let sequence = 0;
  async function rpc(method: string, params: unknown = {}) {
    const id = ++sequence; client.send(JSON.stringify({ id, method, params }));
    for (let n = 0; n < 600; n++) { const row = messages.find(m => m.id === id && !m.method); if (row) { if (row.error) throw new Error(row.error.message); return row.result; } await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error("fixture RPC timeout");
  }
  await rpc("initialize", { clientInfo: { name: "test", version: "1" }, capabilities: { experimentalApi: true } });
  return { registry, client, messages, calls, replies, threads, rpc, crash(id: string) { for (const ws of servers[id === "old" ? 0 : 1]!.clients) ws.terminate(); },
    hold(id: string, method: string) {
      let enteredResolve!: () => void, finish!: () => void;
      const entered = new Promise<void>(resolve => { enteredResolve = resolve; }), done = new Promise<void>(resolve => { finish = resolve; });
      const value = { method, entered, enteredResolve, done, release: finish }; holds.set(id, value); return value;
    },
    async close() { for (const gate of holds.values()) gate.release(); client.terminate(); await listener.close(); for (const socket of sockets) socket.terminate(); for (const server of servers) { server.close(); await (server as any).closeHttp(); } registry.close(); await rm(root, { recursive: true, force: true }); } };
}

test("native routing keeps old work and accepted creations on their generation across atomic activation", async () => {
  const f = await fixture();
  try {
    const old = await f.rpc("thread/start");
    const held = f.hold("old", "thread/start"), accepted = f.rpc("thread/start"); await held.entered;
    f.registry.activate("new", 1); held.release();
    const admittedThread = (await accepted).thread; assert.match(admittedThread.id, /^old-/);
    assert.equal(f.registry.route(admittedThread.id)!.admissionEpoch, 1, "early Thread-started notification cannot stamp the new default epoch");
    const next = await f.rpc("thread/start"); assert.match(next.thread.id, /^new-/);
    await f.rpc("turn/start", { threadId: old.thread.id }); await f.rpc("turn/start", { threadId: next.thread.id });
    assert.deepEqual(f.calls.filter(c => c.method === "turn/start").map(c => c.generation), ["old", "new"]);
    assert.equal((await f.rpc("thread/read", { threadId: old.thread.id })).thread.id, old.thread.id);
  } finally { await f.close(); }
});

test("directory pages merge native ordering and resume existing unmapped Threads on the owning generation", async () => {
  const f = await fixture();
  try {
    await f.rpc("thread/start"); await f.rpc("thread/start"); f.registry.activate("new", 1);
    await f.rpc("thread/start"); await f.rpc("thread/start");
    const first = await f.rpc("thread/list", { limit: 2 }); assert.deepEqual(first.data.map((r: any) => r.id), ["new-2", "new-1"]);
    const second = await f.rpc("thread/list", { limit: 2, cursor: first.nextCursor }); assert.deepEqual(second.data.map((r: any) => r.id), ["old-2", "old-1"]); assert.equal(second.nextCursor, null);
    f.threads.get("old")!.set("historical", { id: "historical", updatedAt: 0, createdAt: 0, status: { type: "idle" } });
    await f.rpc("turn/start", { threadId: "historical" }); assert.equal(f.calls.filter(c => c.method === "turn/start").at(-1)!.generation, "old");
  } finally { await f.close(); }
});

test("server requests from different generations retain their original identities and response destination", async () => {
  const f = await fixture();
  try {
    const a = await f.rpc("thread/start"); f.registry.activate("new", 1); const b = await f.rpc("thread/start");
    await f.rpc("fixture/approval", { threadId: a.thread.id }); await f.rpc("fixture/approval", { threadId: b.thread.id });
    const requests = f.messages.filter(m => m.method === "item/commandExecution/requestApproval");
    assert.equal(requests.length, 2); assert.notEqual(requests[0].id, requests[1].id);
    f.client.send(JSON.stringify({ id: requests[1].id, result: { decision: "accept" } }));
    f.client.send(JSON.stringify({ id: requests[0].id, result: { decision: "decline" } }));
    for (let n = 0; n < 100 && f.replies.length < 2; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(f.replies.map(r => [r.generation, r.id, (r.result as any).decision]), [["new", 7, "accept"], ["old", 7, "decline"]]);
  } finally { await f.close(); }
});

test("late global responses are fenced by admission epoch while old Thread responses remain valid", async () => {
  const f = await fixture();
  try {
    const thread = await f.rpc("thread/start"); const gate = f.hold("old", "model/list"), pending = f.rpc("model/list");
    const rejected = assert.rejects(pending, /admission changed/); await gate.entered; f.registry.activate("new", 1); gate.release(); await rejected;
    assert.equal((await f.rpc("thread/read", { threadId: thread.thread.id })).thread.id, thread.thread.id);
  } finally { await f.close(); }
});


test("connection-scoped terminal handles stay on their original generation and reject active reuse", async () => {
  const f = await fixture();
  try {
    await f.rpc("process/spawn", { processHandle: "terminal", command: ["synthetic-shell"], cwd: "/synthetic" });
    f.registry.activate("new", 1);
    await assert.rejects(f.rpc("process/spawn", { processHandle: "terminal", command: ["synthetic-shell"] }), /already active/);
    await f.rpc("process/writeStdin", { processHandle: "terminal", bytes: "c3ludGhldGlj" });
    await f.rpc("process/spawn", { processHandle: "new-terminal", command: ["synthetic-shell"], cwd: "/synthetic" });
    assert.deepEqual(f.calls.filter(c => c.method.startsWith("process/")).map(c => [c.method, c.generation]), [["process/spawn", "old"], ["process/writeStdin", "old"], ["process/spawn", "new"]]);
  } finally { await f.close(); }
});

test("a late Thread response from an obsolete runtime incarnation cannot enter the live connection", async () => {
  const f = await fixture();
  try {
    const thread = await f.rpc("thread/start"); f.registry.activate("new", 1);
    const gate = f.hold("old", "thread/read"), pending = f.rpc("thread/read", { threadId: thread.thread.id });
    const rejected = assert.rejects(pending, /Stale generation/); await gate.entered;
    f.registry.runtimeChanged("old"); gate.release(); await rejected;
    assert.equal(f.client.readyState, WebSocket.OPEN);
    assert.match((await f.rpc("thread/start")).thread.id, /^new-/);
  } finally { await f.close(); }
});


test("a generation disconnect leaves other tasks connected and releases only its terminal leases", async () => {
  const f = await fixture();
  try {
    const old = await f.rpc("thread/start"); await f.rpc("process/spawn", { processHandle: "terminal", command: ["synthetic"] });
    f.registry.activate("new", 1); const fresh = await f.rpc("thread/start");
    await f.rpc("fixture/approval", { threadId: old.thread.id }); f.crash("old");
    for (let n = 0; n < 200 && !f.messages.some(m => m.method === "opencraft/codex/generation/lost"); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.client.readyState, WebSocket.OPEN);
    assert.equal((await f.rpc("thread/read", { threadId: fresh.thread.id })).thread.id, fresh.thread.id);
    await f.rpc("process/spawn", { processHandle: "terminal", command: ["synthetic"] });
    assert.equal(f.calls.filter(c => c.method === "process/spawn").at(-1)!.generation, "new");
    assert.ok(f.messages.some(m => m.method === "serverRequest/resolved"));
  } finally { await f.close(); }
});


test("Native approval cancellation resolves the public identity and releases its retirement lease", async () => {
  const f = await fixture();
  try {
    const old = await f.rpc("thread/start"); await f.rpc("fixture/approval", { threadId: old.thread.id });
    const request = f.messages.find(m => m.method === "item/commandExecution/requestApproval"); assert.ok(request);
    await f.rpc("fixture/resolveApproval", { threadId: old.thread.id });
    const resolved = f.messages.find(m => m.method === "serverRequest/resolved"); assert.equal(resolved.params.requestId, request.id);
    f.client.send(JSON.stringify({ id: request.id, result: { decision: "accept" } })); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.replies.length, 0, "a cancelled request cannot later reply to Native");
  } finally { await f.close(); }
});

test("standalone command control stays on the accepted generation and successful mutations are never made retryable", async () => {
  const f = await fixture();
  try {
    const held = f.hold("old", "command/exec"), command = f.rpc("command/exec", { processId: "shell", command: ["synthetic"] }); await held.entered;
    f.registry.activate("new", 1);
    await f.rpc("command/exec/write", { processId: "shell", deltaBase64: "eA==" });
    await f.rpc("command/exec/resize", { processId: "shell", size: { rows: 24, cols: 80 } });
    await assert.rejects(f.rpc("command/exec", { processId: "shell", command: ["must-not-run"] }), /already active/);
    await f.rpc("command/exec/terminate", { processId: "shell" }); held.release(); assert.deepEqual(await command, {});
    assert.ok(f.calls.filter(c => c.method.startsWith("command/exec")).every(c => c.generation === "old"));
    const writing = f.hold("new", "config/value/write"), mutation = f.rpc("config/value/write", { keyPath: "synthetic", value: 1 }); await writing.entered;
    f.registry.activate("old", 2); writing.release(); assert.deepEqual(await mutation, {});
    assert.equal(f.calls.filter(c => c.method === "config/value/write").length, 1);
  } finally { await f.close(); }
});

test("path fork follows the actual source HOME and rejects a conflicting Thread ID", async () => {
  const f = await fixture();
  try {
    const source = await f.rpc("thread/start"), path = join(f.registry.get("old")!.runtimeDataDirectory, "runtime", "source.jsonl");
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: source.thread.id } }) + "\n");
    f.registry.activate("new", 1); const fresh = await f.rpc("thread/start");
    const fork = await f.rpc("thread/fork", { threadId: "", path }); assert.match(fork.thread.id, /^old-/);
    await assert.rejects(f.rpc("thread/fork", { threadId: fresh.thread.id, path }), /disagree/);
    assert.equal(f.calls.filter(c => c.method === "thread/fork").length, 1);
  } finally { await f.close(); }
});


test("incarnation replacement expires old command/terminal/approval leases and observes loss without closing the front", async () => {
  const f = await fixture();
  try {
    const thread = await f.rpc("thread/start"); await f.rpc("fixture/approval", { threadId: thread.thread.id });
    const request = f.messages.find(m => m.method === "item/commandExecution/requestApproval");
    await f.rpc("process/spawn", { processHandle: "terminal", command: ["synthetic"] });
    const held = f.hold("old", "command/exec"), running = f.rpc("command/exec", { processId: "command", command: ["synthetic"] });
    const rejected = assert.rejects(running, /unconfirmed/); await held.entered;
    f.registry.runtimeChanged("old"); await f.rpc("thread/read", { threadId: thread.thread.id }); await rejected; held.release();
    assert.ok(f.messages.some(m => m.method === "serverRequest/resolved" && m.params.requestId === request.id));
    assert.ok(f.messages.some(m => m.method === "opencraft/codex/generation/lost" && m.__opencraftGeneration.incarnation === 2));
    await f.rpc("process/spawn", { processHandle: "terminal", command: ["synthetic"] });
    await f.rpc("command/exec", { processId: "command", command: ["synthetic"] }); assert.equal(f.client.readyState, WebSocket.OPEN);
  } finally { await f.close(); }
});

test("successful delete without a notification removes only the cold-history requirement", async () => {
  const f = await fixture();
  try {
    const thread = await f.rpc("thread/start"); await f.rpc("thread/delete", { threadId: thread.thread.id });
    assert.equal(f.registry.route(thread.thread.id)!.generationId, "old"); assert.equal(f.registry.durableThreadIds("old").includes(thread.thread.id), false);
  } finally { await f.close(); }
});
