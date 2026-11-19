import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ModelGatewayStore, meteredModelRequest, ModelGatewayUsageReceipt } from "@opencraft/account-pool-host";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { allocateTurnTokens } from "../../apps/opencraft-daemon/src/token-usage-allocation.js";
import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
const model = "configured/alice-key/model-a";
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "conversation-model-")),
    path = join(root, "gateway.sqlite"),
    store = new ModelGatewayStore(path);
  for (const actor of ["alice", "bob"])
    store.configure(actor, { monthlyTokens: 10000, requestTokens: 100, concurrency: 8 }, 0, "admin");
  store.prepareContribution("alice-key", "alice", "approved");
  store.contributionState("alice-key", "alice", "shared");
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, path, store };
}
const execution = (id: string, authorizer = "bob", selected = model) => ({
  id,
  authorizer,
  executor: null,
  model: selected,
  expiresAt: Date.now() + 60000,
});

test("creator model grant survives restart, stays Thread-scoped, and never becomes catalog/team permission", async (t) => {
  const { store, path } = await fixture(t);
  store.bindConversationModel("shared", "alice", model);
  assert.equal(store.canUse("alice-key", "bob"), false);
  const peer = new ModelGatewayStore(path);
  t.after(() => peer.close());
  peer.beginExecution("shared", execution("bob-turn"));
  const r = peer.reserve("shared", model, "turn-b");
  peer.dispatched(r.id, model);
  peer.finish(r.id, 12);
  assert.equal(peer.execution("shared")?.authorizer, "bob");
  assert.equal(peer.requests("bob")[0]?.key_owner, "alice");
  assert.equal(peer.requests("bob")[0]?.turn, "turn-b");
  assert.throws(() => peer.beginExecution("other", execution("foreign-turn")), /personal_key_forbidden/);
  assert.throws(() => peer.bindConversationModel("shared", "bob", model), /personal_key_forbidden/);
  assert.deepEqual(peer.conversationModel("shared"), { creator: "alice", provider: "alice-key", revision: 0 });
  assert.equal(
    allocateTurnTokens([{ provider: "configured", model, totalTokens: "12" }], ["alice", "bob"]).actors[1]?.totalTokens,
    "6",
  );
});

test("model changes and lookups cannot transfer the creator grant; new Turns retain their own input authority", async (t) => {
  const { store } = await fixture(t);
  store.bindConversationModel("shared", "alice", model);
  store.bindConversationModel("shared", "alice", model);
  store.beginExecution("shared", execution("one"));
  const a = store.reserve("shared", model, "turn-1");
  store.dispatched(a.id, model);
  store.finish(a.id, 8);
  store.finishedExecution("shared", "turn-1");
  store.beginExecution("shared", execution("two", "alice"));
  const b = store.reserve("shared", model, "turn-2");
  store.dispatched(b.id, model);
  store.finish(b.id, 5);
  assert.equal(store.requests("bob")[0]?.turn, "turn-1");
  assert.equal(store.requests("alice")[0]?.turn, "turn-2");
  assert.throws(() => store.reserve("shared", model, "turn-1"), /execution_changed/);
  store.prepareContribution("other-key", "alice", "approved");
  store.contributionState("other-key", "alice", "shared");
  assert.throws(
    () => store.beginExecution("foreign", execution("steal", "bob", "configured/other-key/model-a")),
    /personal_key_forbidden/,
  );
  assert.throws(
    () => store.bindConversationModel("shared", "alice", "configured/other-key/model-a"),
    /conversation_model_changed/,
  );
});

test("withdrawal and grant revision changes fence actual dispatch, not just catalog/admission", async (t) => {
  const { store } = await fixture(t);
  store.bindConversationModel("shared", "alice", model);
  store.beginExecution("shared", execution("one"));
  const r = store.reserve("shared", model, "turn-1");
  store.contributionState("alice-key", "alice", "withdrawn");
  assert.throws(() => store.dispatched(r.id, model), /personal_key_forbidden/);
  store.finish(r.id, null);
  assert.equal(store.summary("bob").heldTokens, 0);
});

test("a scope revision change cannot reactivate an old private conversation grant", async (t) => {
  const { store } = await fixture(t);
  store.bindConversationModel("shared", "alice", model);
  store.setScope("alice-key", "alice", "team", 0);
  store.setScope("alice-key", "alice", "personal", 1);
  assert.throws(() => store.beginExecution("shared", execution("one")), /personal_key_forbidden/);
});

test("creator personal cap still applies when another authorized member supplies input", async (t) => {
  const { store } = await fixture(t);
  store.bindConversationModel("shared", "alice", model);
  store.setPersonalLimit("alice", 50, 0);
  store.beginExecution("shared", execution("one"));
  assert.throws(() => store.reserve("shared", model, "turn-1"), /budget_exhausted/);
});

test("per-call receipts retain Turn, actual credential, and nullable cache counters without double settlement", async (t) => {
  const { store, path } = await fixture(t);
  store.bindConversationModel("shared", "alice", model);
  store.beginExecution("shared", execution("one"));
  const receipt = {
    id: "response-1",
    status: "completed",
    usage: {
      input_tokens: 20,
      output_tokens: 7,
      total_tokens: 27,
      input_tokens_details: { cached_tokens: 12, cache_write_tokens: 4 },
    },
  };
  const result = await meteredModelRequest({
    path,
    thread: "shared",
    turn: "turn-1",
    model,
    signal: new AbortController().signal,
    send: async (dispatch) => {
      dispatch(model);
      return Response.json(receipt);
    },
  });
  await result.text();
  const row = store.requests("bob")[0]!;
  assert.equal(row.turn, "turn-1");
  assert.equal(row.credential, model);
  assert.equal(row.key_owner, "alice");
  assert.equal(row.actual, 27);
  assert.equal(row.input_tokens, 20);
  assert.equal(row.output_tokens, 7);
  assert.equal(row.cache_read_tokens, 12);
  assert.equal(row.cache_write_tokens, 4);
  store.finish(String(row.id), 27, { inputTokens: 20, outputTokens: 7, cacheReadTokens: 12, cacheWriteTokens: 4 });
  assert.equal(store.summary("bob").usedTokens, 27);
  const observer = new ModelGatewayUsageReceipt(false);
  observer.push(new TextEncoder().encode(JSON.stringify({ ...receipt, usage: { input_tokens: 3, output_tokens: 2 } })));
  observer.end();
  assert.deepEqual(observer.counts, { inputTokens: 3, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      db.prepare("select count(*) n from gateway_requests where thread=? and turn=?").get("shared", "turn-1")?.n,
      1,
    );
  } finally {
    db.close();
  }
});

function context(actorId: string): TransportSubmissionContext {
  return {
    sender: null,
    actorContext: { actorId, generation: 1, credentialId: null, expiresAt: Date.now() + 60000 },
    validUntil: Date.now() + 60000,
  };
}
async function adapterFixture(t: test.TestContext) {
  const f = await fixture(t),
    previous = process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
  process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = f.path;
  const listeners = new Set<(frame: string) => void>(),
    frames: any[] = [],
    sent: any[] = [];
  const transport = {
    status: { state: "open" as const },
    async connect() {},
    async close() {},
    subscribeStatus() {
      return () => {};
    },
    subscribeMessage(fn: (frame: string) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async send(raw: string) {
      const j = JSON.parse(raw);
      sent.push(j);
      if (j.id === undefined) return;
      let result: any = {};
      if (j.method === "initialize") result = { capabilities: {} };
      if (["thread/start", "thread/fork", "thread/resume", "thread/read"].includes(j.method))
        result = {
          thread: {
            id: j.method === "thread/start" ? "created" : j.method === "thread/fork" ? "forked" : j.params.threadId,
            status: { type: "idle" },
            turns: [],
            model: j.params.model ?? model,
          },
          model: j.params.model ?? model,
        };
      if (j.method === "turn/start") result = { turn: { id: "native-turn", status: "inProgress" } };
      queueMicrotask(() => {
        for (const fn of listeners) fn(JSON.stringify({ id: j.id, result }));
      });
    },
  };
  const adapter = new CodexEngineAdapter({
    kind: "remote",
    transport,
    modelActor: (c) => ({ id: c.actorId, kind: "human" }),
    logDiagnostic: () => {},
  });
  adapter.subscribeMessage((raw) => frames.push(JSON.parse(raw)));
  await adapter.connect();
  let sequence = 0;
  const rpc = async (method: string, params: any = {}, caller = context("alice")) => {
    const id = ++sequence;
    await adapter.sendWithContext(JSON.stringify({ id, method, params, __opencraftClient: "reader" }), caller);
    for (let n = 0; n < 200; n++) {
      const response = frames.find((x) => x.id === id);
      if (response) return response;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw Error("timeout " + method);
  };
  t.after(async () => {
    await adapter.close();
    if (previous === undefined) delete process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
    else process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = previous;
  });
  await rpc("initialize");
  return { ...f, adapter, rpc, sent };
}

test("actual adapter binds and executes without statistics enabled, never from supplied JSON or reopening", async (t) => {
  const f = await adapterFixture(t);
  const created = await f.rpc("thread/start", { model, creator: "bob" });
  assert.ok(created.result, JSON.stringify(created.error));
  assert.deepEqual(f.store.conversationModel("created"), { creator: "alice", provider: "alice-key", revision: 0 });
  await f.rpc("thread/resume", { threadId: "created", model, creator: "bob" }, context("bob"));
  assert.equal(f.store.conversationModel("created")?.creator, "alice");
  const started = await f.rpc(
    "turn/start",
    { threadId: "created", input: [{ type: "text", text: "synthetic" }], clientUserMessageId: "bob-message", model },
    context("bob"),
  );
  assert.ok(started.result, JSON.stringify(started.error));
  assert.equal(f.store.execution("created")?.authorizer, "bob");
  assert.equal(f.store.canUse("alice-key", "bob"), false);
});

test("foreign personal-key fork cannot manufacture a new creator grant or claim a safe-to-replay rejection", async (t) => {
  const f = await adapterFixture(t);
  await f.rpc("thread/start", { model });
  const fork = await f.rpc("thread/fork", { threadId: "created", model, creator: "alice" }, context("bob"));
  assert.equal(fork.error?.data?.resultUnknown, true);
  assert.equal(fork.error?.data?.threadId, "forked");
  assert.equal(f.store.conversationModel("forked"), null);
  assert.equal(f.sent.filter((x) => x.method === "thread/fork").length, 1);
});

test("a revoked creation admission cannot publish a model credential grant", async (t) => {
  const f = await adapterFixture(t);
  const caller = {
    ...context("alice"),
    resourceOwner: {
      id: "fixture",
      assertCurrent() {
        throw Error("private diagnostic must not escape");
      },
    },
  };
  const result = await f.rpc("thread/start", { model }, caller);
  assert.ok(result.error);
  assert.equal(f.store.conversationModel("created"), null);
  assert.equal(JSON.stringify(result).includes("private diagnostic"), false);
});

test("unattributed historical requests stay unassigned to a Turn rather than borrowing the latest one", async (t) => {
  const { store } = await fixture(t);
  store.bind("legacy", "alice");
  const r = store.reserve("legacy", model);
  store.dispatched(r.id, model);
  store.finish(r.id, 3);
  assert.equal(store.requests("alice")[0]?.turn, null);
  assert.equal(store.conversationModel("legacy"), null);
});

test("an explicitly delegated Bot child inherits the model route but not catalog rights or a fresh creator grant", async (t) => {
  const { store } = await fixture(t);
  store.bindConversationModel("shared", "alice", model);
  const root = { ...execution("root"), expiresAt: Date.now() + 60000 };
  store.beginExecution("shared", root);
  store.beginExecution("child", { ...execution("child"), expiresAt: root.expiresAt, parent: "root" });
  assert.equal(store.conversationModel("child"), null);
  const r = store.reserve("child", model, "child-turn");
  store.dispatched(r.id, model);
  store.finish(r.id, 5);
  assert.equal(store.requests("bob")[0]?.key_owner, "alice");
  assert.equal(store.canUse("alice-key", "bob"), false);
  store.beginExecution("grandchild", { ...execution("grandchild"), expiresAt: root.expiresAt, parent: "child" });
  const late = store.reserve("grandchild", model, "grandchild-turn");
  store.endExecution("shared", "root", true);
  assert.throws(() => store.dispatched(late.id, model), /execution_expired/);
  store.finish(late.id, null);
});
