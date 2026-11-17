import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ConnectedAgentHistory } from "../../apps/local-agent-host/src/connected-agent-history.js";
import { AcpEngine } from "../../plugins/acp-engine/src/index.js";
import { CodeBuddyIdeHistory } from "../../apps/local-agent-host/src/codebuddy-ide-history.js";
import { NativeCliSessions, readCodeBuddyHistory } from "../../apps/local-agent-host/src/native-cli-sessions.js";
import { canImportAgentHistory } from "../../apps/workbench-web/src/components/history-import-agents.js";

const id = "11111111-2222-4333-8444-555555555555", other = "22222222-2222-4333-8444-555555555555";
const client = { notify() {}, async request() { throw new Error("No model input during discovery"); } };
async function root(t: test.TestContext) { const path = await mkdtemp(join(tmpdir(), "native-agent-import-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
test("Pi imports a terminal-owned session, reads cold history, and resumes that exact native file without a prompt", async t => {
  const path = await mkdtemp(join(tmpdir(), "native-pi-import-")), native = join(path, "pi", "sessions", "project"), privateDir = join(path, "private"); await mkdir(native, { recursive: true }); await mkdir(privateDir);
  const file = join(native, `2026-11-17_${id}.jsonl`);
  await writeFile(file, jsonl([{ type: "session", version: 3, id, cwd: path, timestamp: "2026-11-17T00:00:00Z" },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: [{ type: "text", text: "Native question" }] } },
    { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: "Native answer" }], stopReason: "stop" } },
    { type: "session_info", id: "name", parentId: "a", name: "Terminal title" }]));
  const empty = join(native, `2026-11-17_${other}.jsonl`);
  await writeFile(empty, jsonl([{ type: "session", version: 3, id: other, cwd: path, timestamp: "2026-11-17T00:00:00Z" }]));
  const before = await readFile(file), history = new ConnectedAgentHistory("pi-cli", privateDir, undefined, [join(path, "pi", "sessions")]);
  const trace = join(path, "calls"); const options = { id: "pi-cli" as const, protocol: "pi-rpc" as const, threadNamespace: "picli_", command: process.execPath,
    args: [resolve("tests/fixtures/pi-cli-peer.mjs"), "--session-dir", privateDir], cwd: path, dataDirectory: join(path, "ledger"), env: { PI_TEST_TRACE: trace }, history };
  const engine = new AcpEngine(options); t.after(async () => { await engine.close(); await rm(path, { recursive: true, force: true }); });
  const page = await engine.discoverNativeSessions(); assert.equal(page.sessions[0]?.title, "Terminal title");
  assert.equal(page.sessions.length, 1, "empty model discovery sessions are not conversations to import");
  assert.equal(await history.sessionPath(other), await realpath(empty), "an attested empty native session remains resumable");
  const imported = await engine.importNativeSession(page.sessions[0]!); assert.equal(imported.id, "picli_" + id); assert.equal(engine.processId, null);
  const read = await engine.request("thread/read", { threadId: imported.id, initialTurnsPage: { limit: 1, itemsView: "full", sortDirection: "desc" } }, client);
  assert.equal(read.initialTurnsPage.data[0].items.at(-1).text, "Native answer");
  await engine.request("thread/resume", { threadId: imported.id }, client);
  assert.equal((await readFile(trace, "utf8")).includes('"type":"prompt"'), false);
  assert.equal(await history.sessionPath(id), await realpath(file)); assert.deepEqual(await readFile(file), before);
});
test("Claude uses the official SDK in the history Worker, preserves native tools and does not start a CLI", async t => {
  const path = await root(t), project = join(path, "projects", "-workspace"); await mkdir(project, { recursive: true });
  const file = join(project, `${id}.jsonl`), row = (uuid: string, parentUuid: string | null, type: string, content: unknown) => ({ uuid, parentUuid, sessionId: id, cwd: "/workspace", type, timestamp: "2026-11-17T00:00:00Z", message: { role: type, content } });
  await writeFile(file, jsonl([row("u", null, "user", [{ type: "text", text: "Native Claude prompt" }]), row("a", "u", "assistant", [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "pwd" } }]), row("r", "a", "user", [{ type: "tool_result", tool_use_id: "tool", content: "full native output" }]), row("b", "r", "assistant", [{ type: "text", text: "Native Claude answer" }]), { type: "custom-title", customTitle: "Claude title", sessionId: id }]));
  const before = await readFile(file), history = new ConnectedAgentHistory("claude-code", path); t.after(() => history.close());
  const page = await history.directory(); assert.equal(page.sessions[0]?.sessionId, id); assert.equal(page.sessions[0]?.title, "Claude title");
  const turns = await history.read(id, { limit: 10, itemsView: "full", sortDirection: "asc" });
  assert.equal(turns.data.length, 1); assert.ok(turns.data[0].items.some((item: any) => item.type === "mcpToolCall" && item.result.content[0].text === "full native output"));
  assert.equal(turns.data[0].items.at(-1).text, "Native Claude answer"); assert.deepEqual(await readFile(file), before);
  await assert.rejects(history.read(other, {}), /saved agent conversation/);
});
test("CodeBuddy CLI directory excludes subagents, reads the selected native branch and refuses path escapes", async t => {
  const path = await root(t), project = join(path, "project"); await mkdir(project);
  const file = join(project, `${id}.jsonl`);
  const rows = [{ type: "session-meta", id: "meta", sessionId: id, cwd: path, timestamp: 1794881577000 },
    { type: "message", id: "u", parentId: null, role: "user", cwd: path, content: [{ type: "input_text", text: "Question" }] },
    { type: "message", id: "old", parentId: "u", role: "assistant", content: [{ type: "output_text", text: "Wrong branch" }] },
    { type: "message", id: "a", parentId: "u", role: "assistant", content: [{ type: "output_text", text: "Selected branch" }] }, { type: "custom-title", customTitle: "Buddy title" }];
  await writeFile(file, jsonl(rows)); await mkdir(join(project, id, "subagents"), { recursive: true }); await writeFile(join(project, id, "subagents", `${other}.jsonl`), jsonl(rows));
  const sessions = new NativeCliSessions("codebuddy", [path]); assert.equal((await sessions.directory()).sessions.length, 1);
  assert.equal((await sessions.directory()).sessions[0].title, "Buddy title");
  assert.equal((await readCodeBuddyHistory(file))[0].items.at(-1).text, "Selected branch");
  const history = new ConnectedAgentHistory("codebuddy", path); t.after(() => history.close()); assert.equal((await history.read(id, { limit: 1, itemsView: "full" })).data.length, 1);
  await assert.rejects(sessions.resolve("../../private"), /identity/);
  const outside = await root(t); await writeFile(join(outside, `${other}.jsonl`), jsonl(rows)); await symlink(outside, join(project, "linked"));
  assert.equal((await sessions.directory()).sessions.length, 1);
});
test("a CodeBuddy import resumes its native identity in the original process workspace; changed metadata cannot wake a peer", async t => {
  const path = await mkdtemp(join(tmpdir(), "buddy-import-cwd-")), project = join(path, "projects", "original"); await mkdir(project, { recursive: true });
  const file = join(project, `${id}.jsonl`), record = { type: "message", id: "u", role: "user", cwd: project, content: [{ type: "input_text", text: "Existing prompt" }] };
  await writeFile(file, jsonl([record]));
  const trace = join(path, "trace"), engine = new AcpEngine({ id: "codebuddy", command: process.execPath,
    args: [resolve("tests/fixtures/acp-engine-peer.mjs")], cwd: path, dataDirectory: join(path, "ledger"),
    env: { ACP_TEST_TRACE: trace, ACP_TEST_TRACE_CWD: "1" }, history: new ConnectedAgentHistory("codebuddy", join(path, "projects")) });
  t.after(async () => { await engine.close(); await rm(path, { recursive: true, force: true }); });
  const entry = (await engine.discoverNativeSessions()).sessions[0]!, imported = await engine.importNativeSession(entry);
  assert.equal(engine.processId, null);
  await writeFile(file, jsonl([{ ...record, cwd: path }]));
  await assert.rejects(engine.request("thread/resume", { threadId: imported.id }, client), /saved agent conversation/);
  assert.equal(engine.processId, null);
  await writeFile(file, jsonl([record]));
  await engine.request("thread/resume", { threadId: imported.id }, client);
  const calls = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const resumed = calls.find(call => call.method === "session/resume");
  assert.equal(resumed.sessionId, id); assert.equal(resumed.cwd, await realpath(project));
  assert.equal(calls.some(call => call.method === "session/prompt"), false);
});
test("IDE import stays in the connected account/project and preserves original messages", async t => {
  const path = await root(t), scope = { userId: "account-a", cwd: "/workspace/project", currentSessionId: id };
  const folder = join(path, scope.userId, "CodeBuddy", scope.userId, "history", createHash("md5").update(scope.cwd).digest("hex"));
  await mkdir(join(folder, id, "messages"), { recursive: true });
  await writeFile(join(folder, "index.json"), JSON.stringify({ conversations: [{ id, name: "IDE conversation", createdAt: "2026-11-17T00:00:00Z" }], current: id }));
  await writeFile(join(folder, id, "index.json"), JSON.stringify({ messages: [{ id: "u" }, { id: "a" }], requests: [{ id: "request", messages: ["u", "a"] }] }));
  for (const [key, role, text] of [["u", "user", "IDE question"], ["a", "assistant", "IDE answer"]]) await writeFile(join(folder, id, "messages", `${key}.json`), JSON.stringify({ id: key, role, message: JSON.stringify({ role, content: [{ type: "text", text }] }) }));
  const history = new CodeBuddyIdeHistory(path); assert.equal((await history.directory(scope)).sessions[0].cwd, scope.cwd);
  assert.equal((await history.read(scope, id))[0].items.at(-1).text, "IDE answer");
  assert.equal((await history.directory({ ...scope, userId: "account-b" })).sessions.length, 0);
  await assert.rejects(history.read(scope, id, "/another"), /original IDE project/);
  const worker = new ConnectedAgentHistory("codebuddy-ide", path, undefined, [], async () => scope); t.after(() => worker.close());
  await worker.validateResume(id, scope.cwd); await assert.rejects(worker.validateResume(other, scope.cwd), /saved agent conversation/);
});
test("a new Host's history declaration controls every native Agent; old Hosts retain only their implemented imports", () => {
  for (const id of ["codex", "cursor", "claude", "codebuddy", "codebuddy-ide", "pi"] as const) {
    assert.equal(canImportAgentHistory({ id, installed: true, authenticated: true, historyImport: true } as any), true);
    assert.equal(canImportAgentHistory({ id, installed: true, historyImport: false } as any), false);
    assert.equal(canImportAgentHistory({ id, installed: true } as any), id === "codex" || id === "cursor");
  }
});
