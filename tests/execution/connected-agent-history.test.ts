import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink, readFile, stat } from "node:fs/promises";
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
  await indexHead(f.home, id, source);
  await assert.rejects(f.history.snapshot(id, {}), "index paths cannot escape configured native storage");
});


test("Codex project membership is read in the history Worker and recovers after malformed source metadata", async t => {
  const f = await fixture(t, "codex");
  assert.equal((await f.history.projects([{ id, cwd: "/workspace" }])).available, false);
  const source = join(f.home, ".codex-global-state.json");
  await writeFile(source, "invalid");
  await assert.rejects(f.history.projects([{ id, cwd: "/workspace" }]));
  await writeFile(source, JSON.stringify({ "local-projects": { project: { id: "project", name: "Source group", rootPaths: ["/workspace"] } }, "project-order": ["project"], "thread-project-assignments": { [id]: { projectKind: "local", projectId: "project" } } }));
  const result = await f.history.projects([{ id, cwd: "/somewhere/else" }]);
  assert.equal(result.available, true); assert.equal(result.groups[id]?.name, "Source group");
});

// Mirror only Codex's native index contract; these are not OpenCraft tables.
async function indexHead(home: string, nativeId: string, path: string) {
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  try { db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)"); db.prepare("INSERT INTO threads VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET rollout_path=excluded.rollout_path").run(nativeId, path); }
  finally { db.close(); }
}
const ordinalLines = (input: string, first = 0) => input.trimEnd().split("\n").map((line, index) => JSON.stringify({ ...JSON.parse(line), ordinal: first + index }) + "\n").join("");

test("Codex follows the current same-thread segment, retains its exact inherited prefix, and invalidates a cached old head", async t => {
  const f = await fixture(t, "codex"); await mkdir(join(f.home, "sessions"));
  const parent = join(f.home, "sessions", `rollout-original-${id}.jsonl`);
  const prefix = ordinalLines(JSON.stringify({ type: "session_meta", payload: { id, history_mode: "paginated" } }) + "\n" + records("first", "中文旧问题", "Original answer"));
  const cutoff = prefix.trimEnd().split("\n").length;
  const abandoned = ordinalLines(records("abandoned", "Old branch question", "Discarded branch answer"), cutoff);
  await writeFile(parent, prefix + abandoned); await indexHead(f.home, id, parent);
  assert.deepEqual((await f.history.snapshot(id, {})).map(turn => turn.id), ["first", "abandoned"]);
  const physical = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const head = join(f.home, "sessions", `rollout-new-${id}_${physical}.jsonl`);
  const header = JSON.stringify({ type: "session_meta", payload: { id, session_id: id, history_mode: "paginated", history_base: { thread_id: id, end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: cutoff } } }) + "\n";
  const continuation = ordinalLines(header + records("latest", "New question", "Friday answer", 2000), cutoff);
  await writeFile(head, continuation); await indexHead(f.home, id, head);
  const complete = await f.history.snapshot(id, {});
  assert.deepEqual(complete.map(turn => turn.id), ["first", "latest"]);
  assert.equal(JSON.stringify(complete).includes("Discarded branch answer"), false);
  const latest = await f.history.read(id, { threadId: "public", limit: 1, sortDirection: "desc" });
  assert.equal(latest.data[0].id, "latest"); assert.ok(latest.nextCursor);
  assert.equal((await f.history.read(id, { threadId: "public", limit: 1, sortDirection: "desc", cursor: latest.nextCursor })).data[0].id, "first");
  // The index is the head authority even if a newer-looking branch file exists.
  await indexHead(f.home, id, parent);
  assert.equal((await f.history.snapshot(id, {})).at(-1)?.id, "abandoned");
  await indexHead(f.home, id, head);
  await rm(head); await assert.rejects(f.history.snapshot(id, {}));
  await writeFile(head, continuation);
  assert.equal((await f.history.snapshot(id, {})).at(-1)?.id, "latest");
  // Without an index, an unambiguous lineage tip is used, never the first filename.
  await rm(join(f.home, "state_5.sqlite"));
  assert.deepEqual((await f.history.snapshot(id, {})).map(turn => turn.id), ["first", "latest"]);
});

test("Codex rejects split-record/ordinal cutoffs and ancestry cycles rather than silently returning old history", async t => {
  const f = await fixture(t, "codex"); await mkdir(join(f.home, "sessions"));
  const root = join(f.home, "sessions", `rollout-root-${id}.jsonl`);
  const prefix = ordinalLines(JSON.stringify({ type: "session_meta", payload: { id } }) + "\n" + records("first", "before", "answer"));
  await writeFile(root, prefix);
  const ordinal = prefix.trimEnd().split("\n").length, physical = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const head = join(f.home, "sessions", `rollout-head-${id}_${physical}.jsonl`);
  const writeHead = (bytes: number, count: number) => writeFile(head, ordinalLines(JSON.stringify({ type: "session_meta", payload: { id, history_base: { thread_id: id, end_byte_offset: bytes, end_ordinal_exclusive: count } } }) + "\n" + records("next", "after", "answer"), count));
  await writeHead(Buffer.byteLength(prefix) - 1, ordinal); await indexHead(f.home, id, head);
  await assert.rejects(f.history.snapshot(id, {}));
  await writeHead(Buffer.byteLength(prefix), ordinal + 1); await assert.rejects(f.history.snapshot(id, {}));
  await writeHead(Buffer.byteLength(prefix), ordinal);
  await appendFile(root, "discarded-invalid-tail\n");
  assert.deepEqual((await f.history.snapshot(id, {})).map(turn => turn.id), ["first", "next"]);
  const last = JSON.stringify({ timestamp: new Date(3000).toISOString(), ordinal: ordinal + 6, type: "event_msg", payload: { type: "task_complete", turn_id: "next" } }) + "\n";
  await appendFile(head, last.slice(0, 12));
  assert.deepEqual((await f.history.snapshot(id, {})).map(turn => turn.id), ["first", "next"], "uncommitted final record is not projected");
  await appendFile(head, last.slice(12));
  assert.equal((await f.history.snapshot(id, {})).at(-1)?.completedAtMs, 3000);
  // A self-reference must not hang, recurse forever, or substitute another file.
  await writeFile(head, ordinalLines(JSON.stringify({ type: "session_meta", payload: { id, history_base: { thread_id: physical, end_byte_offset: 1, end_ordinal_exclusive: 1 } } }) + "\n", 1));
  await assert.rejects(f.history.snapshot(id, {}));
});

test("a Turn can cross multiple Codex segments without losing its input or duplicating replayed Items", async t => {
  const f = await fixture(t, "codex"); await mkdir(join(f.home, "sessions"));
  const line = (payload: unknown) => JSON.stringify({ timestamp: new Date(1000).toISOString(), type: "event_msg", payload }) + "\n";
  const input = { type: "UserMessage", id: "one-u", content: [{ type: "text", text: "original input" }] };
  const root = join(f.home, "sessions", `rollout-root-${id}.jsonl`);
  const prefix = ordinalLines(JSON.stringify({ type: "session_meta", payload: { id } }) + "\n" + line({ type: "task_started", turn_id: "one" }) + line({ type: "item_completed", turn_id: "one", item: input }));
  await writeFile(root, prefix);
  const midId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", endId = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
  const mid = join(f.home, "sessions", `rollout-mid-${id}_${midId}.jsonl`);
  const header = (physical: string, bytes: number, ordinal: number) => JSON.stringify({ type: "session_meta", payload: { id, history_base: { thread_id: physical, end_byte_offset: bytes, end_ordinal_exclusive: ordinal } } }) + "\n";
  const suffix = ordinalLines(header(id, Buffer.byteLength(prefix), 3) + line({ type: "item_completed", turn_id: "one", item: input })
    + line({ type: "item_completed", turn_id: "one", item: { type: "AgentMessage", id: "one-a", content: [{ type: "text", text: "continued answer" }] } }) + line({ type: "task_complete", turn_id: "one" }), 3);
  await writeFile(mid, suffix);
  const head = join(f.home, "sessions", `rollout-head-${id}_${endId}.jsonl`);
  await writeFile(head, ordinalLines(header(midId, Buffer.byteLength(suffix), 7) + records("two", "next input", "latest answer", 2000), 7));
  await indexHead(f.home, id, head);
  const turns = await f.history.snapshot(id, {});
  assert.deepEqual(turns.map(turn => turn.id), ["one", "two"]);
  assert.deepEqual(turns[0].items.map((item: any) => item.id), ["one-u", "one-a"]);
  assert.equal(turns[0].status, "completed"); assert.equal(turns[0].items[1].text, "continued answer");
});


for (const provider of ["codex", "cursor"] as const) test(`${provider} context export runs in the history Worker, retains ordered text and structured tools without modifying the native source`, async t => {
  const { home } = await fixture(t, provider);
  const source = provider === "codex" ? await codexSource(home) : await cursorSource(home);
  const output = join(home, "private-context");
  const reader = new ConnectedAgentHistory(provider, home, output);
  t.after(() => reader.close());
  const original = provider === "codex" ? await readFile(source!, "utf8") : null;
  const exported = await reader.export(id, { threadId: provider + "_source", title: "Project continuation", cwd: "/workspace" });
  assert.equal(exported.sourceThreadId, provider + "_source");
  assert.ok(exported.turnCount > 0);
  const text = await readFile(exported.transcriptPath, "utf8");
  const archive = (await readFile(exported.archivePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(archive.length, exported.turnCount);
  assert.match(text, /Project continuation/); assert.match(text, /### User/); assert.match(text, /### Assistant/);
  assert.doesNotMatch(text, /hidden instructions/);
  assert.ok(archive.some(turn => turn.items.some((item: any) => ["commandExecution", "dynamicToolCall"].includes(item.type))));
  if (process.platform !== "win32") assert.equal((await stat(exported.transcriptPath)).mode & 0o777, 0o600);
  if (provider === "codex") assert.equal(await readFile(source!, "utf8"), original);
  const untitled = await reader.export(id, { threadId: provider + "_source", title: null, cwd: "/workspace" });
  assert.equal(untitled.title, null, "missing native titles remain missing for the client's localized fallback");
});
