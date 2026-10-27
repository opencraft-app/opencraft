import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexThreadTitles } from "../../apps/opencraft-daemon/src/codex-thread-titles.js";

type Row = Record<string, any>;
function harness(options: { timeout?: number; output?: string; models?: string[]; failed?: boolean; pending?: boolean } = {}) {
  const calls: { method: string; params: Row }[] = [], changed: Row[] = [];
  const names = new Map<string, string>();
  let sequence = 0, failures = 0, active = 0, peak = 0;
  const titles = new CodexThreadTitles({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: { id: params.threadId, name: names.get(params.threadId as string) ?? null } };
      if (method === "model/list") return { data: (options.models ?? ["gpt-6-luna"]).map(model => ({ model })) };
      if (method === "thread/start") {
        const id = `temp-${++sequence}`;
        titles.observeResult(method, params, { thread: { id, ephemeral: true } });
        return { thread: { id } };
      }
      if (method === "turn/start") {
        active++; peak = Math.max(peak, active);
        if (!options.pending) setImmediate(() => complete(params.threadId as string, options.failed ? "failed" : "completed"));
        return { turn: { id: `turn-${params.threadId}` } };
      }
      if (method === "thread/name/set") {
        names.set(params.threadId as string, params.name as string);
        titles.observeResult(method, params, {});
        titles.notification("thread/name/updated", { threadId: params.threadId, threadName: params.name });
      }
      if (method === "thread/unsubscribe") active--;
      return {};
    },
    serialize: async (_id, work) => work(),
    changed: (threadId, name) => changed.push({ threadId, name }),
    failed: () => { failures++; },
  }, options.timeout ?? 300);
  function complete(id: string, status = "completed") {
    assert.equal(titles.notification("item/completed", { threadId: id, turnId: `turn-${id}`, item: { type: "agentMessage", text: options.output ?? '{"title":"修复中文会话标题。"}' } }), true);
    assert.equal(titles.notification("turn/completed", { threadId: id, turn: { id: `turn-${id}`, status } }), true);
  }
  function create(id = "main", params: Row = {}, thread: Row = {}) {
    titles.observeResult("thread/start", params, { thread: { id, cwd: "/private/project", ...thread } });
  }
  function accepted(id = "main", input: unknown[] = [{ type: "text", text: "修复中文会话的自动标题" }]) {
    titles.observeResult("turn/start", { threadId: id, input }, { turn: { id: `user-${id}` } });
  }
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 100 && !predicate(); i++) await delay(5);
    assert.ok(predicate(), JSON.stringify(calls));
  }
  return { titles, names, create, accepted, complete, until, calls, changed, failures: () => failures, peak: () => peak };
}

test("first accepted input uses a private structured AppServer turn and persists a localized title once", async () => {
  const h = harness();
  try {
    h.create(); h.accepted(); h.accepted();
    await h.until(() => h.changed.length === 1);
    assert.equal(h.names.get("main"), "修复中文会话标题");
    assert.equal(h.calls.filter(x => x.method === "thread/start").length, 1);
    const start = h.calls.find(x => x.method === "thread/start")!.params;
    assert.equal(start.ephemeral, true); assert.equal(start.model, "gpt-6-luna");
    assert.equal(start.cwd, null); assert.equal(start.sandbox, "read-only");
    assert.equal(start.config.project_doc_max_bytes, 0);
    const turn = h.calls.find(x => x.method === "turn/start")!.params;
    assert.equal(turn.threadId, "temp-1"); assert.equal(turn.outputSchema.additionalProperties, false);
    assert.ok(turn.input[0].text.includes("修复中文会话的自动标题"));
    await h.until(() => h.calls.some(x => x.method === "thread/unsubscribe"));
    assert.equal(h.calls.some(x => x.method === "turn/interrupt"), false);
  } finally { h.titles.close(); }
});

test("manual rename wins against an in-flight title and only its temporary turn is interrupted", async () => {
  const h = harness({ pending: true });
  try {
    h.create(); h.accepted();
    await h.until(() => h.calls.some(x => x.method === "turn/start"));
    h.titles.invalidate("main"); h.names.set("main", "手动命名");
    await h.until(() => h.calls.some(x => x.method === "thread/unsubscribe"));
    assert.equal(h.names.get("main"), "手动命名"); assert.equal(h.changed.length, 0);
    assert.deepEqual(h.calls.filter(x => x.method === "turn/interrupt").map(x => x.params.threadId), ["temp-1"]);
  } finally { h.titles.close(); }
});

test("a title from another native client arriving during inference is preserved", async () => {
  const h = harness({ pending: true });
  try {
    h.create(); h.accepted(); await h.until(() => h.calls.some(x => x.method === "turn/start"));
    h.names.set("main", "Native title"); h.complete("temp-1");
    await h.until(() => h.calls.some(x => x.method === "thread/unsubscribe"));
    assert.equal(h.names.get("main"), "Native title"); assert.equal(h.changed.length, 0);
  } finally { h.titles.close(); }
});

test("existing, forked, named and ephemeral Threads are not retrospectively titled", async () => {
  const h = harness();
  try {
    h.accepted("existing");
    h.titles.observeResult("thread/fork", {}, { thread: { id: "fork" } }); h.accepted("fork");
    h.create("named", {}, { name: "User supplied" }); h.accepted("named");
    h.create("ephemeral", { ephemeral: true }); h.accepted("ephemeral");
    h.create("empty"); h.accepted("empty", [{ type: "image", url: "image" }]);
    await delay(10); assert.equal(h.calls.length, 0);
    h.accepted("empty"); await h.until(() => h.changed.length === 1);
  } finally { h.titles.close(); }
});

for (const options of [{ models: [] }, { output: "invalid JSON" }, { output: '{"title":""}' }, { failed: true }]) {
  test(`no usable title preserves preview without a native rename: ${JSON.stringify(options)}`, async () => {
    const h = harness(options);
    try {
      h.create(); h.accepted(); await delay(30);
      assert.equal(h.calls.some(x => x.method === "thread/name/set"), false);
      assert.equal(h.changed.length, 0);
    } finally { h.titles.close(); }
  });
}

test("timeout and Host disposal clean up temporary turns without modifying the main Thread", async () => {
  for (const close of [false, true]) {
    const h = harness({ pending: true, timeout: 30 });
    h.create(); h.accepted(); await h.until(() => h.calls.some(x => x.method === "turn/start"));
    if (close) h.titles.close();
    await h.until(() => h.calls.some(x => x.method === "thread/unsubscribe"));
    assert.equal(h.changed.length, 0);
    assert.deepEqual(h.calls.filter(x => x.method === "turn/interrupt").map(x => x.params.threadId), ["temp-1"]);
    h.titles.close();
  }
});

test("generation concurrency is bounded and queued invalidation prevents a later inference", async () => {
  const h = harness({ pending: true, timeout: 1000 });
  try {
    for (let i = 0; i < 5; i++) { h.create(`main-${i}`); h.accepted(`main-${i}`); }
    await h.until(() => h.calls.filter(x => x.method === "turn/start").length === 2);
    h.titles.invalidate("main-2");
    h.complete("temp-1"); h.complete("temp-2");
    await h.until(() => h.calls.filter(x => x.method === "turn/start").length === 4);
    h.complete("temp-3"); h.complete("temp-4");
    await h.until(() => h.changed.length === 4);
    assert.equal(h.peak(), 2); assert.equal(h.names.has("main-2"), false);
  } finally { h.titles.close(); }
});

test("English output is normalized and bounded by Unicode characters", async () => {
  const h = harness({ output: JSON.stringify({ title: '  "Fix   automatic conversation naming across all projects!"  ' }), models: ["gpt-5.4-mini"] });
  try {
    h.create(); h.accepted(); await h.until(() => h.changed.length === 1);
    assert.ok(Array.from(h.changed[0].name).length <= 36);
    assert.ok(h.changed[0].name.startsWith("Fix automatic conversation"));
    assert.equal(h.calls.find(x => x.method === "thread/start")?.params.model, "gpt-5.4-mini");
  } finally { h.titles.close(); }
});
