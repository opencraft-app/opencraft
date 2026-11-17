import test from "node:test";
import assert from "node:assert/strict";
import { ConnectedAgentHost } from "../../apps/local-agent-host/src/connected-agents.js";
import { AcpEngine } from "../../plugins/acp-engine/src/index.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function catalogFixture(inputModalities?: string[]) {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let probes = 0, creates = 0;
  const forwarded: { method: string; params: any }[] = [];
  const onboarding = { async status() { probes++; await blocked; return { agents: [{ id: "cursor", authenticated: true }] }; } };
  const host = new ConnectedAgentHost(onboarding as never, "/unused", "/workspace", {} as never);
  for (const id of ["codex", "cursor", "claude-code", "codebuddy"]) {
    (host as any).engines.set(id, {
      ownsModel: (model: string) => model.startsWith(id + ":"),
      async request(method: string, params: any) {
        forwarded.push({ method, params });
        if (method === "model/list") return { data: id === "codex" ? [{ id: "codex:one", displayName: "One", ...(inputModalities ? { inputModalities } : {}) }] : [] };
        if (method === "thread/start") { creates++; throw new Error("Synthetic unavailable peer"); }
        return {};
      }, async close() {},
    });
  }
  return { host, release, probes: () => probes, creates: () => creates, forwarded };
}

test("persisted model declarations return while an unrelated CLI login probe is blocked", async () => {
  const f = catalogFixture();
  try {
    const models = await f.host.models();
    assert.deepEqual(models.map(m => m.id), ["codex:one"]);
    assert.deepEqual(models[0].inputModalities, ["text"], "old declarations do not invent image support");
    assert.equal(f.probes(), 1); assert.equal(f.creates(), 0);
    const again = await f.host.models();
    assert.deepEqual(again.map(m => m.id), ["codex:one"]);
    assert.equal(f.probes(), 1, "concurrent reads share background discovery");
  } finally { f.release(); await f.host.close(); }
});
test("connected Agent catalog preserves negotiated image input through the saved-model projection", async () => {
  const f = catalogFixture(["text", "image"]);
  try {
    assert.deepEqual((await f.host.models("codex_thread"))[0].inputModalities, ["text", "image"]);
    assert.equal(f.creates(), 0);
  } finally { f.release(); await f.host.close(); }
});
test("current Agent declarations supersede the Host's earlier cached input modalities without creating a session", async () => {
  const modalities = ["text"], f = catalogFixture(modalities);
  try {
    assert.deepEqual((await f.host.models())[0].inputModalities, ["text"]);
    modalities.push("image");
    assert.deepEqual((await f.host.models())[0].inputModalities, ["text", "image"]);
    assert.equal(f.creates(), 0);
  } finally { f.release(); await f.host.close(); }
});
test("a native conversation catalog excludes other Agent and API model identities", async () => {
  const f = catalogFixture();
  try {
    assert.deepEqual((await f.host.models("cursor_thread")).map(m => m.id), []);
    assert.deepEqual((await f.host.models("codex_thread")).map(m => m.id), ["codex:one"]);
  } finally { f.release(); await f.host.close(); }
});

test("an imported Codex source reads its own current model capabilities instead of the default source cache", async () => {
  const f = catalogFixture(["text"]);
  try {
    await f.host.models();
    const sourceId = "ded37448630ace2d13b6d686";
    (f.host as any).sourceBindingsLoad = Promise.resolve();
    (f.host as any).sourceHomes.set(sourceId, "/isolated-source");
    let image = true;
    (f.host as any).engines.set(`source:${sourceId}`, { async request() { return { data: [{ id: "codex:one", displayName: "One", inputModalities: image ? ["text", "image"] : ["text"] }] }; }, async close() {} });
    const threadId = `codex_source_${sourceId}_existing`;
    assert.deepEqual((await f.host.models(threadId))[0].inputModalities, ["text", "image"]);
    image = false;
    assert.deepEqual((await f.host.models(threadId))[0].inputModalities, ["text"], "a newer source declaration is read without retaining the earlier positive value");
    assert.deepEqual((await f.host.models())[0].inputModalities, ["text"], "source capabilities cannot leak into the default account");
    assert.equal(f.creates(), 0);
  } finally { f.release(); await f.host.close(); }
});

test("a cold imported source negotiates missing input capabilities without creating or resuming a session", async () => {
  const f = catalogFixture(["text"]), root = await mkdtemp(join(tmpdir(), "source-capabilities-"));
  const sourceId = "ded37448630ace2d13b6d686", prefix = `codex_source_${sourceId}_`, threadId = prefix + "existing";
  try {
    const directory = join(root, "data"), trace = join(root, "trace"); await mkdir(directory);
    await writeFile(join(directory, threadId + ".json"), JSON.stringify({ schemaVersion: 1, id: threadId, nativeId: "native-existing", cwd: root,
      model: "codex:one", name: "Existing", createdAt: 1, updatedAt: 1, tools: [], archived: false, receipts: {}, modelCatalog: [{ id: "codex:one", name: "One" }] }));
    const engine = new AcpEngine({ id: "codex", threadNamespace: prefix, command: process.execPath, args: [resolve("tests/fixtures/acp-engine-peer.mjs")],
      cwd: root, dataDirectory: directory, env: { ACP_TEST_IMAGES: "1", ACP_TEST_TRACE: trace } });
    (f.host as any).sourceBindingsLoad = Promise.resolve(); (f.host as any).sourceHomes.set(sourceId, root);
    (f.host as any).engines.set(`source:${sourceId}`, engine);
    assert.deepEqual((await f.host.models(threadId))[0].inputModalities, ["text"], "cold data stays conservative until negotiation completes");
    const deadline = Date.now() + 4000;
    while (!engine.hasInputCapabilities && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(engine.hasInputCapabilities, true);
    assert.deepEqual((await f.host.models(threadId))[0].inputModalities, ["text", "image"]);
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.method), ["initialize"]);
  } finally { f.release(); await f.host.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy unqualified model IDs are normalized only when the owning Agent declared that exact model", async () => {
  const f = catalogFixture();
  try {
    await f.host.dispatch("turn/start", { threadId: "codex_thread", model: "one", input: [] });
    assert.equal(f.forwarded.find(call => call.method === "turn/start")?.params.model, "codex:one");
    await f.host.dispatch("turn/start", { threadId: "codex_thread", model: "other:one", input: [] });
    assert.equal(f.forwarded.filter(call => call.method === "turn/start").at(-1)?.params.model, "other:one", "an explicit other Agent is never silently relabeled");
  } finally { f.release(); await f.host.close(); }
});
