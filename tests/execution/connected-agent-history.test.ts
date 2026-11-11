import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ConnectedAgentHistory } from "../../apps/local-agent-host/src/connected-agent-history.js";
import { AcpEngine } from "../../plugins/acp-engine/src/index.js";

const id = "11111111-2222-3333-4444-555555555555";
async function fixture(t: test.TestContext, provider: "codex" | "cursor") {
  const home = await mkdtemp(join(tmpdir(), "connected-history-")), history = new ConnectedAgentHistory(provider, home);
  t.after(async () => { await history.close(); await rm(home, { recursive: true, force: true }); });
  return { home, history };
}
function records(turn: string, input: string, output: string, time = 1000) {
  const line = (payload: unknown) => JSON.stringify({ type: "event_msg", timestamp: new Date(time).toISOString(), payload }) + "\n";
  return line({ type: "task_started", turn_id: turn })
    + line({ type: "item_completed", turn_id: turn, item: { type: "UserMessage", id: `${turn}-u`, content: [{ type: "text", text: input, text_elements: [] }] } })
    + line({ type: "item_completed", turn_id: turn, item: { type: "CommandExecution", id: `${turn}-tool`, command: "ls", cwd: "/workspace", parsed_cmd: [], status: "completed", aggregated_output: "file.txt", exit_code: 0 } })
    + line({ type: "item_completed", turn_id: turn, item: { type: "AgentMessage", id: `${turn}-a`, content: [{ type: "Text", text: output }], phase: "final_answer" } })
    + line({ type: "task_complete", turn_id: turn });
}
async function codexSource(home: string) {
  await mkdir(join(home, "sessions")); const path = join(home, "sessions", `rollout-test-${id}.jsonl`);
  await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n"
    + JSON.stringify({ type: "response_item", payload: { type: "message", role: "system", content: "hidden instructions" } }) + "\n"
    + records("one", "你好", "第一轮") + records("two", "再问一次", "第二轮", 2000));
  return path;
}
const variable = (input: number): Buffer => { let n = BigInt(input); const bytes: number[] = []; do { const b = Number(n & 127n); n >>= 7n; bytes.push(b | (n ? 128 : 0)); } while (n); return Buffer.from(bytes); };
const field = (n: number, data: string | Buffer | number): Buffer => typeof data === "number" ? Buffer.concat([variable(n * 8), variable(data)])
  : (() => { const value = Buffer.from(data); return Buffer.concat([variable(n * 8 + 2), variable(value.length), value]); })();
async function cursorSource(home: string) {
  const directory = join(home, "acp-sessions", id); await mkdir(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "store.db"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)");
  const blob = (data: Buffer) => { const hash = createHash("sha256").update(data).digest(); db.prepare("INSERT OR IGNORE INTO blobs VALUES(?,?)").run(hash.toString("hex"), data); return hash; };
  const turn = (index: number) => {
    const user = blob(Buffer.concat([field(1, `Cursor 问题 ${index}`), field(2, `user-${index}`), field(25, index * 1000)]));
    const thought = blob(field(3, field(1, "reasoning"))), reply = blob(field(1, field(1, `Cursor 回复 ${index}`)));
    return blob(field(1, Buffer.concat([field(1, user), field(2, thought), field(2, reply), field(3, `turn-${index}`)])));
  };
  // Unreachable JSON prompts are intentionally present in the blob database.
  blob(Buffer.from(JSON.stringify({ role: "user", content: "must stay hidden" })));
  const shell = blob(field(2, Buffer.concat([field(1, blob(field(1, "ls"))), field(2, blob(Buffer.concat([field(1, "file.txt"), field(3, 0)])))])));
  const root = blob(Buffer.concat([field(1, blob(Buffer.from("system prompt"))), field(5, Buffer.concat([field(1, 1234), field(2, 200000)])), field(8, turn(1)), field(8, turn(2)), field(8, shell)]));
  db.prepare("INSERT INTO meta VALUES('0',?)").run(Buffer.from(JSON.stringify({ agentId: id, latestRootBlobId: root.toString("hex") })).toString("hex"));
  return db;
}

test("Codex read-only history restores messages/tools, stable pagination and appended turns", async t => {
  const f = await fixture(t, "codex"), path = await codexSource(f.home);
  const page = await f.history.read(id, { threadId: "public", limit: 1, itemsView: "full", sortDirection: "desc" });
  assert.equal(page.data[0].id, "two"); assert.equal(page.data[0].items[2].text, "第二轮"); assert.ok(page.nextCursor);
  const older = await f.history.read(id, { threadId: "public", limit: 1, cursor: page.nextCursor });
  assert.equal(older.data[0].id, "one"); assert.equal(older.nextCursor, null);
  const items = await f.history.items(id, { threadId: "public", turnId: "one", limit: 100, sortDirection: "asc" });
  assert.deepEqual(items.data.map((entry: any) => entry.item.type), ["userMessage", "commandExecution", "agentMessage"]);
  assert.equal(items.data[1].item.aggregatedOutput, "file.txt");
  const active = await f.history.snapshot(id, { threadId: "public", activeTurn: { id: "live-two", startedAtMs: 2000, status: "inProgress",
    items: [{ id: "live-user", type: "userMessage", content: [{ type: "text", text: "再问一次" }] }, { id: "live-answer", type: "agentMessage", text: "partial" }] } });
  assert.deepEqual(active.map(turn => turn.id), ["one", "live-two"], "refresh while streaming uses the live turn/item identities once");
  assert.equal(active.at(-1).items.at(-1).id, "live-answer");
  await assert.rejects(f.history.read(id, { threadId: "another", cursor: page.nextCursor }));
  await appendFile(path, records("three", "第三次", "第三轮", 3000));
  assert.deepEqual((await f.history.snapshot(id, { threadId: "public" })).map(turn => turn.id), ["one", "two", "three"]);
  assert.equal(JSON.stringify(await f.history.snapshot(id, {})).includes("hidden instructions"), false);
});

test("Cursor reads the ordered native graph without exposing unrelated prompt blobs; failures are retryable", async t => {
  const f = await fixture(t, "cursor"), db = await cursorSource(f.home); t.after(() => db.close());
  const turns = await f.history.snapshot(id, {});
  assert.equal(turns.length, 3); assert.equal(turns[0].items[0].content[0].text, "Cursor 问题 1");
  assert.equal(turns[1].items.at(-1).text, "Cursor 回复 2"); assert.equal(turns[0].items[1].type, "reasoning");
  assert.equal(JSON.stringify(turns).includes("must stay hidden"), false);
  assert.equal(turns[2].items[0].source, "userShell"); assert.equal(turns[2].items[0].aggregatedOutput, "file.txt");
  const usage = await f.history.usage(id);
  assert.deepEqual(usage.context, { usedTokens: 1234, limitTokens: 200000 });
  assert.equal(usage.total, null); assert.equal(usage.last, null);
  const page = await f.history.read(id, { threadId: "cursor_public", limit: 1, sortDirection: "asc", itemsView: "notLoaded" });
  assert.deepEqual(page.data[0].items, []); assert.ok(page.nextCursor);
  const missing = Buffer.from(JSON.stringify({ agentId: id, latestRootBlobId: "a".repeat(64) })).toString("hex");
  const original = db.prepare("SELECT value FROM meta").get() as { value: string };
  db.prepare("UPDATE meta SET value=?").run(missing);
  await assert.rejects(f.history.snapshot(id, {}), /Could not read/);
  db.prepare("UPDATE meta SET value=?").run(original.value);
  assert.equal((await f.history.snapshot(id, {})).length, 3);
});

test("Codex usage selects the latest cumulative native record without summing repeated snapshots", async t => {
  const f = await fixture(t, "codex"), path = await codexSource(f.home);
  assert.equal(await f.history.usage(id), null);
  const line = (total: number, last: number) => JSON.stringify({ timestamp: new Date(5000).toISOString(), type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { total_tokens: total, input_tokens: total - 5, output_tokens: 5, cached_input_tokens: 200, reasoning_output_tokens: 2 },
    last_token_usage: { total_tokens: last }, model_context_window: 10000,
  } } }) + "\n";
  await appendFile(path, line(300, 250) + line(450, 150) + line(450, 150));
  const usage = await f.history.usage(id);
  assert.equal(usage.total.totalTokens, 450); assert.equal(usage.total.cachedInputTokens, 200);
  assert.equal(usage.last.inputTokens, null); assert.deepEqual(usage.context, { usedTokens: 150, limitTokens: 10000 });
  assert.equal(usage.observedAt, 5000);
  await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: "another-session" } }) + "\n" + line(900, 100));
  await assert.rejects(f.history.usage(id), /Could not read/, "usage cannot borrow counts from a different native identity");
});

test("a restored ACP reader never resumes native execution or accepts a caller's forged live turn", async t => {
  const f = await fixture(t, "codex"); await codexSource(f.home);
  const options = { command: process.execPath, args: [resolve("tests/fixtures/acp-engine-peer.mjs")], cwd: f.home,
    dataDirectory: join(f.home, "engine"), env: { ACP_TEST_NATIVE_ID: id } };
  const engine = new AcpEngine(options), { thread } = await engine.request("thread/start", {}, { notify() {}, async request() {} }); await engine.close();
  const cold = new AcpEngine({ ...options, history: f.history }); t.after(() => cold.close());
  const response = await cold.request("thread/read", { threadId: thread.id, initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" } }, { notify() {}, async request() {} });
  assert.equal(response.initialTurnsPage.data.length, 2);
  assert.equal(response.thread.historyMode, "paginated");
  const forged = await cold.request("thread/turns/list", { threadId: thread.id, activeTurn: { id: "forged", status: "inProgress", items: [] } }, { notify() {}, async request() {} });
  assert.ok(!forged.data.some((turn: any) => turn.id === "forged")); assert.equal(cold.processIds.length, 0);
  const legacy = await cold.request("thread/read", { threadId: thread.id, includeTurns: true }, { notify() {}, async request() {} });
  assert.equal(legacy.thread.turns.length, 2); await cold.close();
});

test("history rejects missing identities and escaping sources instead of inventing an empty conversation", async t => {
  const f = await fixture(t, "codex");
  await assert.rejects(f.history.snapshot("../outside", {})); await assert.rejects(f.history.snapshot(id, {}));
  const outside = await mkdtemp(join(tmpdir(), "outside-history-")); t.after(() => rm(outside, { recursive: true, force: true }));
  const source = await codexSource(outside); await mkdir(join(f.home, "sessions"));
  await symlink(source, join(f.home, "sessions", `rollout-test-${id}.jsonl`));
  await assert.rejects(f.history.snapshot(id, {}));
});
