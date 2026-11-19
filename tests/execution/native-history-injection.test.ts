import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ConnectedAgentHistory } from "../../apps/local-agent-host/src/connected-agent-history";
import { projectPiSnapshot } from "../../plugins/pi-engine/src/projection";
import { PiEngine, piModel } from "../../plugins/pi-engine/src/index";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { randomUUID } from "node:crypto";

const fixture = (name: string) => readFile(resolve("tests/fixtures/native-history", name), "utf8");
const sessionId = (provider: "claude-code" | "codebuddy") => provider === "claude-code"
  ? "11111111-2222-3333-4444-555555555555" : "01a1e0a0-054f-74c5-a198-15e1cfaad776";
const cwd = "/workspace";
const projectDirectory = (provider: "claude-code" | "codebuddy") => provider === "claude-code" ? "-workspace" : "workspace";
async function historyFixture(t: test.TestContext, provider: "claude-code" | "codebuddy" | "codex") {
  const home = await mkdtemp(join(tmpdir(), "native-injection-"));
  const history = new ConnectedAgentHistory(provider, home);
  t.after(async () => { await history.close(); await rm(home, { recursive: true, force: true }); });
  return { home, history };
}
const assertNoInternalPath = (value: unknown) => {
  assert.doesNotMatch(JSON.stringify(value), /connected-execution-cli|opencraft-preview\/data/u);
};

test("Claude Code and CodeBuddy projections drop only the generated CLI note from real transcripts", async t => {
  for (const provider of ["claude-code", "codebuddy"] as const) {
    const f = await historyFixture(t, provider), id = sessionId(provider);
    const directory = join(f.home, "projects", projectDirectory(provider));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${id}.jsonl`), await fixture(`${provider}-thread-cli.jsonl`));
    const page = await f.history.read(id, { threadId: "public", cwd, limit: 10, itemsView: "full", sortDirection: "asc" });
    assert.equal(page.data.length, 2, provider);
    assert.deepEqual(page.data.map(turn => turn.items[0].content.map((block: any) => block.text)),
      [["查一下旧会话"], ["再查一次"]], provider);
    assertNoInternalPath(page.data);
  }
});

test("Codex projections drop the generated CLI note from both native record shapes", async t => {
  const f = await historyFixture(t, "codex"), id = "01a1e00d-caec-7b23-b85f-0c4e3ac6fb6d";
  await mkdir(join(f.home, "sessions"), { recursive: true });
  await writeFile(join(f.home, "sessions", `rollout-test-${id}.jsonl`), await fixture("codex-thread-cli.jsonl"));
  const page = await f.history.read(id, { threadId: "public", cwd, limit: 10, itemsView: "full", sortDirection: "asc" });
  assert.equal(page.data.length, 2);
  assert.deepEqual(page.data.map(turn => turn.items[0].content.map((block: any) => block.text)),
    [["查一下旧会话"], ["再查一次"]]);
  assertNoInternalPath(page.data);
});

test("Pi projects the original input and strips the note from native fallback entries", async t => {
  const data = JSON.parse(await fixture("pi-opencraft-input.json"));
  const snapshot = (entry: any) => ({
    entries: [{ ...entry, conversationId: 1, head: null, commitSeq: 1 }],
    submissions: [], tasks: new Map(), agent: {}, live: {}, usage: { models: {}, tools: {} },
    inbox: [], queue: { items: [], paused: false }, shell: { records: [], paused: false }, privateCalls: { calls: {} },
  });
  const session = { id: "pi_11111111-2222-3333-4444-555555555555", cwd: "/workspace", tools: [] };
  const real = projectPiSnapshot(session, snapshot(data.entry) as any);
  assert.equal(real.length, 1);
  assert.deepEqual(real[0].items[0].content.map((block: any) => block.text), ["查一下旧会话"]);
  const fallback = projectPiSnapshot(session, snapshot(data.nativeUserEntry) as any);
  assert.equal(fallback.length, 1);
  assert.deepEqual(fallback[0].items[0].content.map((block: any) => block.text), ["查一下旧会话"]);
  assertNoInternalPath(real); assertNoInternalPath(fallback);
});

test("Pi removes a truncated generated note from a persisted thread label", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-label-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const id = `pi_${randomUUID()}`, now = Math.floor(Date.now() / 1000);
  const preview = "Remember this unique verification passphrase: HANDOFF-4148F7808CE63489. Reply exactly STORED. Do not use tools or change files.\nOpenCraft execution-scoped thread CLI: '/data/code/opencraft/.runtime/ma";
  await writeFile(join(directory, `${id}.json`), JSON.stringify({ format: "pi-durable-1", id, cwd: directory,
    model: piModel("faux", "faux-1"), name: null, preview, createdAt: now, updatedAt: now, archived: false, tools: [] }));
  const faux = fauxProvider({}); faux.setResponses([]); const models = createModels(); models.setProvider(faux.provider);
  const engine = new PiEngine({ directory, cwd: directory, models }); t.after(() => engine.close());
  const page = await engine.request("thread/list", { limit: 10 }, { notify() {}, async request() { throw new Error("Unexpected tool"); } });
  assert.equal(page.data[0].preview, "Remember this unique verification passphrase: HANDOFF-4148F7808CE63489. Reply exactly STORED. Do not use tools or change files.");
});
