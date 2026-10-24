import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { CodexCoreReadIsolation } from "../../apps/opencraft-daemon/src/codex-core-read-isolation";
import { CodexCoreSocket } from "../../apps/opencraft-daemon/src/codex-core-socket";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";

async function fixture(run: (f: { reader: CodexCoreReadIsolation; main: CodexCoreSocket; statuses: string[]; requests: any[] }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "oc-history-fault-"));
  const path = join(root, "native.sock"), server = createServer(), wss = new WebSocketServer({ server });
  const requests: any[] = [], statuses: string[] = [];
  wss.on("connection", socket => socket.on("message", raw => {
    const message = JSON.parse(String(raw)); requests.push(message);
    if (message.id === undefined) return;
    if (message.params?.threadId === "slow") return;
    const result = message.params?.threadId === "huge" ? { text: "x".repeat(10_000) } : { data: [], nextCursor: null };
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  await new Promise<void>(resolve => server.listen(path, resolve));
  const health = async () => ({ nativeSocket: path });
  const reader = new CodexCoreReadIsolation(health, { maxPayload: 4096, concurrency: 2, queue: 2, timeoutMs: 250 });
  const main = new CodexCoreSocket({ health, message: () => undefined, status: value => statuses.push(value.state) });
  try { await main.connect(); await run({ reader, main, statuses, requests }); }
  finally { reader.close(); main.close(); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}

test("oversized history fails only that RPC; peer reads and subscription socket remain open", async () => {
  await fixture(async ({ reader, main, statuses, requests }) => {
    const [huge, peer] = await Promise.all([
      reader.read({ id: "huge-id", method: "thread/read", params: { threadId: "huge", includeTurns: true } }),
      reader.read({ id: "peer-id", method: "thread/turns/list", params: { threadId: "peer", limit: 1 } }),
    ]);
    assert.deepEqual(JSON.parse(huge), { id: "huge-id", error: { code: -32072, message: "History response is too large; use a smaller history page", data: { code: "HISTORY_RESPONSE_TOO_LARGE", retryable: false } } });
    assert.equal(JSON.parse(peer).id, "peer-id"); assert.equal(JSON.parse(peer).error, undefined);
    assert.equal(main.status.state, "open"); assert.deepEqual(statuses, ["connecting", "open"]);
    assert.equal(JSON.parse(await reader.read({ id: 3, method: "thread/read", params: { threadId: "later" } })).error, undefined);
    assert(!requests.some(r => ["thread/resume", "turn/start", "thread/unsubscribe"].includes(r.method)));
  });
});

test("timed out read and disposal release bounded queued reads without closing shared transport", async () => {
  await fixture(async ({ reader, main }) => {
    const first = reader.read({ id: 1, method: "thread/read", params: { threadId: "slow" } });
    const second = reader.read({ id: 2, method: "thread/read", params: { threadId: "slow" } });
    const third = reader.read({ id: 3, method: "thread/read", params: { threadId: "peer" } });
    assert.equal(JSON.parse(await first).error.data.code, "HISTORY_READ_UNAVAILABLE");
    assert.equal(JSON.parse(await third).error, undefined); await second;
    const pending = reader.read({ id: 4, method: "thread/read", params: { threadId: "slow" } });
    reader.close(); assert.equal(JSON.parse(await pending).id, 4);
    assert.equal(main.status.state, "open");
  });
});

test("Host subscription/status checks request no history and schedule inspection uses bounded turn metadata", async () => {
  const adapter: any = Object.create(CodexEngineAdapter.prototype), calls: any[] = [];
  adapter.nativeCore = {}; adapter.nativeSubscribedThreads = new Set();
  adapter.requestPhysical = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { status: { type: "idle" } } };
    if (method === "thread/resume") { assert.equal(params.excludeTurns, true); return {}; }
    if (!params.cursor) return { data: [{ id: "recent", status: "completed" }], nextCursor: "older" };
    return { data: [{ id: "target", status: "failed" }], nextCursor: null };
  };
  assert.equal(await adapter.queueThreadIsIdle("long"), true);
  assert.equal((await adapter.findScheduledTurn("long", "target")).status, "failed");
  assert(calls.filter(c => c.method === "thread/read").every(c => c.params.includeTurns === false));
  assert(calls.filter(c => c.method === "thread/turns/list").every(c => c.params.limit === 100 && c.params.itemsView === "notLoaded"));
});
