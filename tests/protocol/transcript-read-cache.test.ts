import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { TranscriptReadCache, type NativeTranscriptPort } from "@opencraft/native-history-node";
import { readUsageIncrement } from "../../apps/opencraft-daemon/src/token-usage-derived-source.js";
import { CodexNativeStorage } from "../../apps/opencraft-daemon/src/codex-native-storage.js";
import type { AppServerTurn } from "@opencraft/appserver-protocol";

const id = "thread-large";
const line = (turn: string) => JSON.stringify({ type: "turn_context", payload: { turn_id: turn, model: "model" }, timestamp: "2026-10-25T00:00:00Z" }) + "\n";
const turn = (n: number): AppServerTurn => ({ id: `turn-${n}`, status: "completed", items: [
  { id: `user-${n}`, type: "userMessage", content: [{ type: "text", text: `Question ${n}` }] },
  { id: `agent-${n}`, type: "agentMessage", text: `Answer ${n}` },
] });
async function fixture(t: test.TestContext, count = 601) {
  const root = await mkdtemp(join(tmpdir(), "oc-transcript-read-")), home = join(root, "native");
  await mkdir(home);
  const path = join(home, "rollout.jsonl"), source = Array.from({ length: count }, (_, n) => turn(n));
  await writeFile(path, source.map(t => line(t.id)).join(""));
  const calls: string[] = [];
  const port = { nativeHome: home,
    async readThread(threadId: string) { calls.push("thread/read"); return { id: threadId, path, turns: [], historyMode: "paginated" }; },
    async listTurns(threadId: string, cursor: string | null, limit: number) {
      assert.equal(threadId, id); calls.push("thread/turns/list");
      const offset = cursor === null ? 0 : Number(cursor), ordered = source.slice().reverse();
      return { data: structuredClone(ordered.slice(offset, offset + limit)), nextCursor: offset + limit < source.length ? String(offset + limit) : null };
    },
  };
  let cache = new TranscriptReadCache(root, port);
  t.after(async () => { await cache.close(); await rm(root, { recursive: true, force: true }); });
  return { root, home, path, source, calls, port, get cache() { return cache; },
    async reopen(schema?: number) { await cache.close(); cache = new TranscriptReadCache(root, port, { projectionSchema: schema }); },
    async query(sql: string) { const db = new DatabaseSync(join(root, "cache", "transcript-index.sqlite"), { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } },
  };
}

test("601 native Turns: tail and older pages are lossless; warm hit performs no native history/engine calls", async t => {
  const f = await fixture(t), before = await readFile(f.path);
  const first = await f.cache.read(id);
  assert.deepEqual(first.initialTurnsPage.data, f.source.slice(-10).reverse());
  const older = await f.cache.page(id, first.initialTurnsPage.nextCursor);
  assert.deepEqual(older.data, f.source.slice(-20, -10).reverse());
  f.calls.length = 0;
  for (let n = 0; n < 10; n++) assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, first.initialTurnsPage.data);
  assert.deepEqual(f.calls, Array(10).fill("thread/read"));
  assert.deepEqual(await readFile(f.path), before);
  assert.equal((await stat(f.cache.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.cache.directory, `${id}.turns.jsonl`))).mode & 0o777, 0o600);
});

test("ascending Turn pages use the same bounded transcript index", async t => {
  const f = await fixture(t, 25);
  await f.cache.read(id);
  const first = await f.cache.page(id, null, 4, undefined, "full", "asc");
  assert.deepEqual(first.data.map(turn => turn.id), ["turn-0", "turn-1", "turn-2", "turn-3"]);
  assert.match(first.nextCursor!, /^transcript-asc:/);
  const next = await f.cache.page(id, first.nextCursor, 4, undefined, "full", "asc");
  assert.deepEqual(next.data.map(turn => turn.id), ["turn-4", "turn-5", "turn-6", "turn-7"]);
});

test("aborted cache hydration does not wait for a prior native read", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-transcript-read-cancel-"));
  const controller = new AbortController();
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const port: NativeTranscriptPort = {
    async readThread(threadId) { return { id: threadId, path: "/missing", turns: [] }; },
    async listTurns() { await stalled; return { data: [], nextCursor: null }; },
  };
  const cache = new TranscriptReadCache(root, port);
  t.after(async () => { release(); await cache.close(); await rm(root, { recursive: true, force: true }); });
  const pending = cache.page("cancelled", null, 10, undefined, "full", "desc", controller.signal);
  controller.abort(new Error("reader closed"));
  await assert.rejects(pending, /reader closed|cancelled/);
});

test("cancelling a queued reader preserves its predecessor's serialization barrier", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-transcript-queue-cancel-"));
  let release!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const cache = new TranscriptReadCache(root, {
    async readThread(id) { return { id, turns: [] }; },
    async listTurns() { if (++calls === 1) { entered(); await gate; } return { data: [], nextCursor: null }; },
  });
  t.after(async () => { release(); await cache.close(); await rm(root, { recursive: true, force: true }); });
  const first = cache.page("same", null);
  await ready;
  const controller = new AbortController();
  const cancelled = cache.page("same", null, 10, undefined, "full", "desc", controller.signal);
  controller.abort(new Error("queued reader left"));
  await assert.rejects(cancelled, /queued reader left/);
  const third = cache.page("same", null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, "a cancelled waiter must not let the next writer overtake its predecessor");
  release(); await Promise.all([first, third]); assert.equal(calls, 2);
});

test("cancelling an in-flight native read lets its successor finish and fences the late reply", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-transcript-flight-cancel-"));
  let release!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const cache = new TranscriptReadCache(root, {
    async readThread(id) { return { id, turns: [] }; },
    async listTurns() {
      if (++calls === 1) { entered(); await gate; return { data: [turn(1)], nextCursor: null }; }
      return { data: [turn(2)], nextCursor: null };
    },
  });
  t.after(async () => { release(); await cache.close(); await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const first = cache.page("same", null, 10, undefined, "full", "desc", controller.signal);
  await ready;
  controller.abort(new Error("active reader left"));
  await assert.rejects(first, /active reader left/);
  assert.equal((await cache.page("same", null)).data[0]!.id, "turn-2");
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await cache.page("same", null)).data[0]!.id, "turn-2");
});

test("schema change and deleting the whole cache directory both reconstruct native content", async t => {
  const f = await fixture(t, 20);
  const expected = (await f.cache.read(id)).initialTurnsPage.data;
  await mkdir(join(f.cache.directory, `${id}.blobs`));
  await writeFile(join(f.cache.directory, `${id}.blobs`, "orphan.blob"), "discard");
  await f.reopen(2);
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, expected);
  const file = join(f.cache.directory, `${id}.turns.jsonl`);
  const validJsonCorruption = (await readFile(file, "utf8")).replace("Question", "Tampered");
  await writeFile(file, validJsonCorruption);
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, expected);
  assert.equal((await f.query("SELECT projection_schema_version FROM opencraft_cache_meta"))[0]!.projection_schema_version, 2);
  await assert.rejects(stat(join(f.cache.directory, `${id}.blobs`, "orphan.blob")), { code: "ENOENT" });
  await rm(join(f.root, "cache"), { recursive: true });
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, expected);
  await rm(f.cache.directory, { recursive: true });
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, expected);
});

test("corrupt cached JSON and missing blobs are repaired without touching native history", async t => {
  const f = await fixture(t, 3);
  f.source[2]!.items = [{ id: "cmd", type: "commandExecution", aggregatedOutput: "tool body\n".repeat(600) }];
  const expected = (await f.cache.read(id)).initialTurnsPage.data;
  const original = await readFile(f.path);
  await writeFile(join(f.cache.directory, `${id}.turns.jsonl`), "broken");
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, expected);
  const blobs = await readdir(join(f.cache.directory, `${id}.blobs`));
  assert.equal(blobs.length, 1);
  await rm(join(f.cache.directory, `${id}.blobs`, blobs[0]!));
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, expected);
  assert.deepEqual(await readFile(f.path), original);
});

test("append catches up from the shared rollout cursor and updates only a dirty native suffix", async t => {
  const f = await fixture(t);
  await f.cache.read(id); f.calls.length = 0;
  f.source.push(turn(601));
  await appendFile(f.path, line("turn-601"));
  const latest = await f.cache.read(id);
  assert.deepEqual(latest.initialTurnsPage.data, f.source.slice(-10).reverse());
  assert.equal(f.calls.filter(m => m === "thread/turns/list").length, 1);
  assert.equal((await f.query("SELECT total_turns FROM opencraft_cache_meta"))[0]!.total_turns, 602);
  const bytes = (await stat(f.path)).size;
  await appendFile(f.path, '{"type":"turn_context","payload":');
  await f.cache.read(id);
  assert.equal((await f.query("SELECT source_cursor FROM opencraft_cache_meta"))[0]!.source_cursor, bytes);
  await appendFile(f.path, '{"turn_id":"turn-602"}}\n'); f.source.push(turn(602));
  assert.equal((await f.cache.read(id)).initialTurnsPage.data[0]!.id, "turn-602");
});

test("native replacement/rollback reconstructs and discards former cold outputs", async t => {
  const f = await fixture(t, 3);
  f.source[2]!.items = [{ id: "tool", type: "commandExecution", aggregatedOutput: "old output".repeat(500) }];
  await f.cache.read(id);
  f.source.splice(1);
  await rm(f.path); await writeFile(f.path, line("turn-0"));
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, f.source);
  await assert.rejects(stat(join(f.cache.directory, `${id}.blobs`)), { code: "ENOENT" });
});

test("overwriting a Turn deletes only blobs with no remaining Turn references", async t => {
  const f = await fixture(t, 2), output = "shared".repeat(400), sha = createHash("sha256").update(output).digest("hex");
  for (const row of f.source) row.items = [{ id: row.id, type: "commandExecution", aggregatedOutput: output }];
  await f.cache.read(id);
  const blob = join(f.cache.directory, `${id}.blobs`, `${sha}.blob`);
  f.source[1]!.items = []; await appendFile(f.path, line("turn-1")); await f.cache.read(id);
  await stat(blob);
  f.source[0]!.items = []; await appendFile(f.path, line("turn-0")); await f.cache.read(id);
  await assert.rejects(stat(blob), { code: "ENOENT" });
  await f.cache.invalidate(id);
  await assert.rejects(stat(join(f.cache.directory, `${id}.turns.jsonl`)), { code: "ENOENT" });
  assert.equal((await f.query("SELECT count(*) AS n FROM opencraft_cache_meta"))[0]!.n, 0);
});

test("usage reader retains metering only while sharing the transcript byte cursor", async t => {
  const f = await fixture(t, 1);
  await appendFile(f.path, JSON.stringify({ type: "response_item", payload: { type: "message", content: "conversation body" } }) + "\n");
  const result = await readUsageIncrement({ path: f.path, nativeHome: f.home, threadId: id, cursor: 0, identity: null });
  assert.equal(result.cursor, (await stat(f.path)).size);
  assert.equal(JSON.stringify(result).includes("conversation body"), false);
  assert.equal(result.events.length, 1);
});

test("large native pages shrink their read budget without Resume or lost Turns", async t => {
  const f = await fixture(t, 501), native = f.port.listTurns;
  f.port.listTurns = async (thread, cursor, limit) => {
    if (limit > 25) throw new Error("decoded message length too large");
    return native(thread, cursor, limit);
  };
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, f.source.slice(-10).reverse());
  assert.equal((await f.query("SELECT total_turns FROM opencraft_cache_meta"))[0]!.total_turns, 501);
});

test("cold structured MCP outputs retain their native shape and unchanged Turns do not append duplicates", async t => {
  const f = await fixture(t, 1);
  f.source[0]!.items = [{ id: "mcp", type: "mcpToolCall", result: { content: [{ type: "text", text: "response".repeat(900) }] } }];
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, f.source);
  const path = join(f.cache.directory, `${id}.turns.jsonl`), size = (await stat(path)).size;
  await appendFile(f.path, line("turn-0"));
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, f.source);
  assert.equal((await stat(path)).size, size);
});

test("an unreadable disposable index is rebuilt without changing native history", async t => {
  const f = await fixture(t, 12), expected = (await f.cache.read(id)).initialTurnsPage.data;
  const source = await readFile(f.path);
  await f.cache.close();
  await writeFile(join(f.root, "cache", "transcript-index.sqlite"), "not a SQLite database");
  await f.reopen();
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, expected);
  assert.deepEqual(await readFile(f.path), source);
});

test("a damaged index cannot allocate beyond the transcript file and reconstructs its page", async t => {
  const f = await fixture(t, 12), expected = (await f.cache.read(id)).initialTurnsPage.data;
  const database = new DatabaseSync(join(f.root, "cache", "transcript-index.sqlite"));
  try { database.prepare("UPDATE opencraft_turn_offset_index SET byte_length=? WHERE turn_id=?").run(Number.MAX_SAFE_INTEGER, "turn-11"); }
  finally { database.close(); }
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, expected);
});

test("invalidating during a native rebuild fences its result and leaves no derived bodies", async t => {
  const f = await fixture(t, 12), original = await readFile(f.path);
  const list = f.port.listTurns;
  let release!: () => void, enter!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  f.port.listTurns = async (...args) => { enter(); await held; return list(...args); };
  const reading = f.cache.read(id); const rejected = assert.rejects(reading, /invalidated/);
  await entered;
  const cleanup = f.cache.invalidate(id); release();
  await rejected; await cleanup;
  assert.equal((await f.query("SELECT count(*) AS n FROM opencraft_cache_meta"))[0]!.n, 0);
  await assert.rejects(stat(join(f.cache.directory, `${id}.turns.jsonl`)), { code: "ENOENT" });
  assert.deepEqual(await readFile(f.path), original);
});

test("history in two registered HOMEs stays readable after default activation and cache restart", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-transcript-generations-"));
  const entries = new Map<string, { home: string; path: string; turns: AppServerTurn[] }>();
  for (const [threadId, count] of [["old-thread", 3], ["new-thread", 4]] as const) {
    const home = join(root, threadId); await mkdir(home);
    const path = join(home, "rollout.jsonl"), turns = Array.from({ length: count }, (_, i) => turn(i));
    await writeFile(path, turns.map(t => line(t.id)).join("")); entries.set(threadId, { home, path, turns });
  }
  let epoch = 1;
  const storage = new CodexNativeStorage({ async generationDirectory(threadId?: string) {
    return { protocolVersion: 1, routingEpoch: "owner", admissionEpoch: epoch,
      homes: [...entries].map(([generationId, entry]) => ({ generationId, codexHome: entry.home, incarnation: 1 })),
      route: threadId && entries.has(threadId) ? { threadId, generationId: threadId } : null };
  } }, () => entries.get("old-thread")!.home);
  const port: NativeTranscriptPort = {
    nativeHome: entries.get("old-thread")!.home,
    resolveSource: (threadId, path) => storage.resolve(threadId, path),
    readThread: async threadId => ({ id: threadId, path: entries.get(threadId)!.path, turns: [] }),
    listTurns: async (threadId, cursor, limit) => {
      const turns = entries.get(threadId)!.turns.slice().reverse(), start = Number(cursor ?? 0);
      return { data: turns.slice(start, start + limit), nextCursor: start + limit < turns.length ? String(start + limit) : null };
    },
  };
  let cache = new TranscriptReadCache(root, port);
  t.after(async () => { await cache.close(); await rm(root, { recursive: true, force: true }); });
  for (const [threadId, entry] of entries) assert.deepEqual((await cache.read(threadId)).initialTurnsPage.data, entry.turns.slice().reverse());
  epoch++;
  await cache.close(); cache = new TranscriptReadCache(root, port);
  for (const [threadId, entry] of entries) assert.deepEqual((await cache.read(threadId)).initialTurnsPage.data, entry.turns.slice().reverse());
});

test("a warm cache never bypasses a changed HOME boundary", async t => {
  const f = await fixture(t, 3); await f.cache.read(id);
  f.port.nativeHome = join(f.root, "other"); await mkdir(f.port.nativeHome);
  await assert.rejects(f.cache.read(id), /outside native home/);
});

test("late cached replies are rejected after routing owner replacement", async t => {
  const f = await fixture(t, 20); let epoch = 1, held = false;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  (f.port as NativeTranscriptPort).resolveSource = async () => {
    const captured = epoch;
    return { nativeHome: f.home, key: String(captured), validate: async () => {
      if (held) { enter(); await gate; }
      if (epoch !== captured) throw new Error("Native storage owner changed during read");
    } };
  };
  const first = await f.cache.read(id); held = true;
  const reading = f.cache.read(id), rejected = assert.rejects(reading, /owner changed/);
  await entered; epoch++; held = false; release(); await rejected;
  f.source.push(turn(20)); await appendFile(f.path, line("turn-20"));
  await assert.rejects(f.cache.page(id, first.initialTurnsPage.nextCursor), /expired/);
  assert.deepEqual((await f.cache.read(id)).initialTurnsPage.data, f.source.slice(-10).reverse());
});

test("bounded first page carries full history count", async t => {
  const f = await fixture(t, 601);
  const first = await f.cache.read(id, 10);
  assert.equal(first.initialTurnsPage.totalTurnCount, 601);
  assert.equal(first.thread.historyTurnCount, 601);
  assert.equal(first.initialTurnsPage.data.length, 10);
  assert.equal((await f.cache.page(id, first.initialTurnsPage.nextCursor, 10)).totalTurnCount, 601);
});

test("read diagnostics separate a held metadata read from the cache and isolate queued callers", async t => {
  const f = await fixture(t, 12);
  await f.cache.read(id);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = f.port.readThread;
  f.port.readThread = async threadId => { await held; return original(threadId); };
  const phases: Array<[string, number]> = [];
  const reading = f.cache.read(id, 10, undefined, "full", undefined, (phase, ms) => { phases.push([phase, ms]); });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(phases, [], "unsettled native metadata is not mislabeled as a cache hit");
  release();
  await reading;
  const values = Object.fromEntries(phases);
  assert(values.metadata >= 25);
  assert(values.queue >= 0 && values.reconcile >= 0 && values.page >= 0);
  assert.equal(f.calls.filter(call => call === "thread/turns/list").length, 1, "diagnostics add no native history reads");
  // A failed observer cannot change the lossless result or leave the read blocked.
  const result = await f.cache.read(id, 10, undefined, "full", undefined, () => { throw new Error("observer failure"); });
  assert.deepEqual(result.initialTurnsPage.data, f.source.slice(-10).reverse());
});

test("a concurrent open attributes predecessor hydration to queue time", async t => {
  const f = await fixture(t, 12);
  await f.cache.read(id);
  f.source.push(turn(12)); await appendFile(f.path, line("turn-12"));
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = f.port.listTurns;
  f.port.listTurns = async (...args) => { entered(); await held; return original(...args); };
  const first = f.cache.read(id); await started;
  const phases: Array<[string, number]> = [];
  const second = f.cache.read(id, 10, undefined, "full", undefined, (phase, ms) => { phases.push([phase, ms]); });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert(phases.some(([phase]) => phase === "metadata"));
  assert(!phases.some(([phase]) => phase === "queue"));
  release(); await first;
  const result = await second;
  assert(Object.fromEntries(phases).queue >= 25);
  assert.equal(result.initialTurnsPage.data[0]!.id, "turn-12");
  assert.equal(f.calls.filter(call => call === "thread/turns/list").length, 2, "the queued open reuses the validated cache");
});

for (const count of [35, 95]) test(`a small append does not hydrate unchanged native Turns (${count} Turns); old dirty boundaries remain lossless`, async t => {
  const f = await fixture(t, count);
  let hydrated = 0;
  const original = f.port.listTurns;
  f.port.listTurns = async (...args) => { const page = await original(...args); hydrated += page.data.length; return page; };
  const first = await f.cache.read(id, 5), olderCursor = first.initialTurnsPage.nextCursor;
  hydrated = 0;
  f.source.push(turn(count)); await appendFile(f.path, line(`turn-${count}`));
  const updated = await f.cache.read(id, 5);
  assert.equal(updated.initialTurnsPage.data[0]!.id, `turn-${count}`);
  assert(hydrated <= 10, `small append rehydrated ${hydrated} Turns for a five-Turn display`);
  assert.deepEqual((await f.cache.page(id, olderCursor, 5)).data, f.source.slice(count - 10, count - 5).reverse());
  hydrated = 0;
  f.source[5]!.items.push({ id: "late-old-item", type: "agentMessage", text: "Late durable change" });
  await appendFile(f.path, line("turn-5"));
  await f.cache.read(id, 5);
  assert(hydrated > 10, "a dirty older Turn must continue beyond the first native page");
  const all: AppServerTurn[] = [];
  let cursor: string | null = null;
  do { const page = await f.cache.page(id, cursor, 10); all.push(...page.data); cursor = page.nextCursor; } while (cursor !== null);
  assert.deepEqual(all, f.source.slice().reverse(), "smaller native pages preserve old changed and unchanged Turns");
});
