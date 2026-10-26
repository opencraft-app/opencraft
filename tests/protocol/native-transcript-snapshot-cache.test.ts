import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeNativeTranscriptFiles, TranscriptReadCache } from "@opencraft/native-history-node";
import { createPiTranscriptCache } from "../../plugins/pi-engine/src/read-history.js";
import { DshAppServerAdapter } from "../../apps/local-agent-host/src/dsh-appserver-adapter.js";
import type { AppServerTurn } from "@opencraft/appserver-protocol";

const turn = (n: number): AppServerTurn => ({ id: `turn-${n}`, status: "completed", items: [
  { id: `reply-${n}`, type: "agentMessage", text: `Answer ${n}` },
] });

test("Pi snapshot cache observes SQLite WAL commits, pages without snapshots on hits, and rebuilds disposable data", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-transcript-cache-"));
  const file = join(root, "pi_test.sqlite"), writer = new DatabaseSync(file);
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE turns(n INTEGER PRIMARY KEY)");
  for (let n = 0; n < 21; n++) writer.prepare("INSERT INTO turns VALUES(?)").run(n);
  let reads = 0;
  const options = { directory: root, dataDirectory: root,
    async readThread(id: string) { return { id, turns: [], historyMode: "paginated" as const }; },
    async readTurns() { reads++; const db = new DatabaseSync(file, { readOnly: true });
      try { return db.prepare("SELECT n FROM turns ORDER BY n").all().map(row => turn(Number(row.n))); }
      finally { db.close(); }
    },
  };
  let cache = createPiTranscriptCache(options);
  t.after(async () => { await cache.close(); writer.close(); await rm(root, { recursive: true, force: true }); });
  const first = await cache.read("pi_test");
  assert.deepEqual(first.initialTurnsPage.data.map(t => t.id), Array.from({ length: 10 }, (_, n) => `turn-${20 - n}`));
  assert.equal(reads, 1);
  const older = await cache.page("pi_test", first.initialTurnsPage.nextCursor);
  assert.equal(older.data[0]!.id, "turn-10"); assert.equal(reads, 1);
  const before = await readFile(file);
  await cache.read("pi_test"); assert.equal(reads, 1); assert.deepEqual(await readFile(file), before);
  writer.prepare("INSERT INTO turns VALUES(21)").run();
  assert.equal((await cache.read("pi_test")).initialTurnsPage.data[0]!.id, "turn-21"); assert.equal(reads, 2);
  assert.equal((await cache.page("pi_test", first.initialTurnsPage.nextCursor)).data[0]!.id, "turn-10",
    "appending a native Turn must preserve the older-page cursor");
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.equal((await cache.page("pi_test", first.initialTurnsPage.nextCursor)).data[0]!.id, "turn-10",
    "a WAL checkpoint must not invalidate the logical history prefix");
  assert.equal(reads, 3);
  await writeFile(join(root, "cache", "transcripts", "pi_test.turns.jsonl"), "damaged");
  assert.equal((await cache.read("pi_test")).initialTurnsPage.data[0]!.id, "turn-21"); assert.equal(reads, 4);
  await rm(join(root, "cache", "transcripts"), { recursive: true });
  assert.equal((await cache.read("pi_test")).initialTurnsPage.data[0]!.id, "turn-21"); assert.equal(reads, 5);
  await rm(join(root, "cache"), { recursive: true });
  assert.equal((await cache.read("pi_test")).initialTurnsPage.data[0]!.id, "turn-21"); assert.equal(reads, 6);
  await cache.close();
  cache = new TranscriptReadCache(root, {
    readThread: options.readThread,
    observeSnapshotSource: () => observeNativeTranscriptFiles(root, [file, `${file}-wal`], JSON.stringify(["pi", root, "pi_test"])),
    async listTurns(_id, cursor, limit) { const turns = (await options.readTurns()).reverse(), offset = Number(cursor ?? 0);
      return { data: turns.slice(offset, offset + limit), nextCursor: offset + limit < turns.length ? String(offset + limit) : null };
    },
  }, { projectionSchema: 2 });
  assert.equal((await cache.read("pi_test")).initialTurnsPage.data[0]!.id, "turn-21");
  assert.equal(reads, 7);
});

test("DSH cached read and older pages never activate an Agent, and native appends preserve cursors", async t => {
  const root = await mkdtemp(join(tmpdir(), "dsh-transcript-cache-")), file = join(root, "session.jsonl");
  await writeFile(file, "native log\n");
  const events: any[] = [], calls: string[] = [];
  const appendTurn = (turn: number) => {
    const push = (type: string, data: any) => events.push({ event: { type, data, seq: events.length, time: 1000 } });
    push("turn/start", { turn });
    push("user/message", { source: { kind: "user" }, content: [{ type: "text", text: `question-${turn}` }] });
    push("assistant/message", { turn, message: { content: [{ type: "text", text: `reply-${turn}` }] } });
    push("turn/end", { turn, reason: { kind: "completed" } });
  };
  for (let n = 1; n <= 21; n++) appendTurn(n);
  const adapter = new DshAppServerAdapter({ async call(method: string, params: any) {
    calls.push(method); assert.equal(method, "session.history");
    const rows = events.filter(entry => params.beforeSeq === undefined || entry.event.seq < params.beforeSeq);
    return { events: rows.slice(-50), hasMore: rows.length > 50 };
  } } as any);
  (adapter as any).summaries.set("s", { sessionId: "s", running: false, blank: false, cwd: root, updatedAt: 1 });
  adapter.setThreadEngine({ resume: async () => { throw new Error("History must stay cold"); },
    create: async () => {}, fork: async () => {}, inject: async () => {}, release: async () => {} });
  adapter.setTranscriptCache(root, () => observeNativeTranscriptFiles(root, [file], "dsh-test"));
  t.after(async () => { await adapter.close(); await rm(root, { recursive: true, force: true }); });
  const read = () => adapter.dispatch("thread/read", { threadId: "s", initialTurnsPage: { limit: 10 } }) as Promise<any>;
  const first = await read(); assert.equal(first.initialTurnsPage.data[0].id, "dsh-turn-s-21");
  calls.length = 0;
  const older: any = await adapter.dispatch("thread/turns/list", { threadId: "s", cursor: first.initialTurnsPage.nextCursor, limit: 10 });
  assert.equal(older.data[0].id, "dsh-turn-s-11");
  await read(); assert.deepEqual(calls, []);
  appendTurn(22); await appendFile(file, "another turn\n");
  assert.equal((await read()).initialTurnsPage.data[0].id, "dsh-turn-s-22");
  assert.ok(calls.length > 0);
  const continued: any = await adapter.dispatch("thread/turns/list", { threadId: "s", cursor: first.initialTurnsPage.nextCursor, limit: 10 });
  assert.equal(continued.data[0].id, "dsh-turn-s-11");
  const original = await readFile(file);
  await rm(join(root, "cache"), { recursive: true });
  assert.equal((await read()).initialTurnsPage.data[0].id, "dsh-turn-s-22");
  assert.deepEqual(await readFile(file), original);
});

test("snapshot append and live tail updates keep stable ordinals; prefix rewrite, deletion and source replacement expire cursors", async t => {
  const root = await mkdtemp(join(tmpdir(), "snapshot-stable-prefix-")), file = join(root, "native.jsonl");
  await writeFile(file, "native\n");
  const turns = Array.from({ length: 25 }, (_, n) => turn(n));
  turns[24] = { id: "turn-24", status: "inProgress", items: [{ id: "tool", type: "commandExecution", aggregatedOutput: "old".repeat(1000) }] };
  const cache = new TranscriptReadCache(root, {
    async readThread(id) { return { id, turns: [], historyMode: "paginated" }; },
    observeSnapshotSource: () => observeNativeTranscriptFiles(root, [file], "native-snapshot"),
    async listTurns(_id, cursor, limit) {
      const descending = structuredClone(turns).reverse(), offset = Number(cursor ?? 0);
      return { data: descending.slice(offset, offset + limit), nextCursor: offset + limit < descending.length ? String(offset + limit) : null };
    },
  });
  t.after(async () => { await cache.close(); await rm(root, { recursive: true, force: true }); });
  const first = await cache.read("snapshot"), cursor = first.initialTurnsPage.nextCursor;
  const oldPage = (await cache.page("snapshot", cursor)).data;
  const index = new DatabaseSync(join(root, "cache", "transcript-index.sqlite"), { readOnly: true });
  const prefix = () => index.prepare("SELECT turn_seq,byte_offset FROM opencraft_turn_offset_index WHERE turn_id='turn-0'").get();
  const before = prefix();
  turns[24]!.items[0]!.aggregatedOutput = "new".repeat(1000); await appendFile(file, "tail update\n");
  assert.deepEqual((await cache.page("snapshot", cursor)).data, oldPage);
  assert.deepEqual(prefix(), before, "an untouched historical prefix must keep its index entries");
  turns[24]!.status = "completed"; turns.push(turn(25)); await appendFile(file, "tail completed and append\n");
  assert.deepEqual((await cache.page("snapshot", cursor)).data, oldPage);
  assert.equal((await cache.read("snapshot")).initialTurnsPage.data[0]!.id, "turn-25");
  assert.deepEqual(prefix(), before);
  turns[2]!.items = [{ id: "rewrite", type: "agentMessage", text: "rewritten historical prefix" }];
  await appendFile(file, "prefix rewrite\n");
  await assert.rejects(cache.page("snapshot", cursor), /page expired/);
  const rewritten = await cache.read("snapshot"), nextCursor = rewritten.initialTurnsPage.nextCursor;
  turns.shift(); await appendFile(file, "deleted oldest Turn\n");
  await assert.rejects(cache.page("snapshot", nextCursor), /page expired/);
  const beforeReplacement = await cache.read("snapshot");
  await writeFile(`${file}.replacement`, "replacement native source\n"); await rename(`${file}.replacement`, file);
  await assert.rejects(cache.page("snapshot", beforeReplacement.initialTurnsPage.nextCursor), /page expired/);
  index.close();
});

test("snapshot file observations enforce the native root for database and WAL companions", async t => {
  const root = await mkdtemp(join(tmpdir(), "snapshot-path-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); await mkdir(home);
  const file = join(home, "native.sqlite"), outside = join(root, "foreign.sqlite");
  await writeFile(file, "native"); await writeFile(outside, "foreign");
  await assert.rejects(observeNativeTranscriptFiles(home, [outside], "foreign"), /outside native home/);
  await assert.rejects(observeNativeTranscriptFiles(home, [file, outside], "foreign-wal"), /outside native home/);
  const source = await observeNativeTranscriptFiles(home, [file, `${file}-wal`], "native");
  await source.validate();
});
