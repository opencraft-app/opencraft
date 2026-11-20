import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionBotProfile } from "../src/adapters/local/bot-profile.mjs";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { createExecutionPorts } from "../src/runtime/execution-ports.mjs";
import { PlatformChannels } from "../src/application/platform-channels.mjs";
import { executePlatformRead } from "../src/application/platform-read.mjs";
import { assistantTools } from "../src/adapters/work-tools/assistant-tools.mjs";
const binding = {
  serverId: "s",
  botId: "b",
  assignmentId: "a",
  owner: { kind: "human", id: "h" },
};
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "platform-read-"));
  let mode = "success",
    epoch = "one",
    calls = 0;
  const port = {
    async authorize() {
      return { binding, epoch, expiresAt: Date.now() + 30000 };
    },
    async request(_b, _m, p) {
      calls++;
      if (mode === "revoke") epoch = "two";
      if (mode === "denied")
        throw Object.assign(Error("not visible"), { status: 403 });
      return {
        messages: [{ sequence: 5, messageId: "m", text: "hello" }],
        hasEarlier: !p.before,
      };
    },
  };
  const channels = new PlatformChannels(binding, port);
  const profile = provisionBotProfile(root, binding, {
    telemetry: { enabled: false },
  });
  const d = createLocalDomain(profile, null, { platformReads: channels });
  t.after(() => {
    d.uow.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    ...d,
    channels,
    mode: (v) => {
      mode = v;
    },
    calls: () => calls,
  };
}
function delegate(app, id) {
  app.reception.accept(id, { text: "查" });
  const t = app.reception.turn(id);
  app.reception.apply(t, {
    kind: "delegate",
    goal: "查找当前可见群里的历史对话，报告已查范围",
    completion: { output: "text" },
  });
  return app.workRecord(app.reception.turn(id).work_id);
}
test("delegated reads retain pagination evidence; report cannot replace host facts", async (t) => {
  const d = setup(t),
    work = delegate(d.app, "lookup"),
    snap = d.app.executions.snapshot(work);
  assert.ok(snap.delegation.tools.includes("platform_read"));
  const ports = createExecutionPorts(
    d.app,
    () => {},
    undefined,
    d.channels,
  ).toolsFor(work, snap);
  const tool = assistantTools({
    ports,
    snapshot: snap,
    onBoundaryError: (e) => {
      throw e;
    },
  }).find((t) => t.name === "platform_read");
  const result = JSON.parse(
    (
      await tool.execute(
        { name: "platform.groups.history", params: { channelId: "g" } },
        {},
      )
    ).output[0].text,
  );
  assert.equal(result.ok, true);
  assert.equal(result.coverage.next, 5);
  assert.equal(result.coverage.hasEarlier, true);
  assert.equal(result.data.messages[0].messageId, "m");
  const next = await ports.platformRead({
    name: "platform.groups.history",
    params: { channelId: "g", before: 5 },
  });
  assert.equal(next.coverage.next, null);
  assert.equal(d.calls(), 2);
  d.app.executions.report(work, "I did not have permission");
  const turn = d.app.reception.pending().find((t) => t.source_json);
  const report = d.app.reception.context(turn).report;
  assert.equal(report.platformReadEvidence.items.length, 2);
  assert.ok(report.platformReadEvidence.items.every((e) => e.ok));
  assert.equal(
    JSON.stringify(report.platformReadEvidence).includes("hello"),
    false,
  );
});
test("old grants do not inherit reads; binding changes and cancellation reject results", async (t) => {
  const d = setup(t);
  const resources = d.app.scope.resources;
  d.app.scope.resources = [];
  const old = delegate(d.app, "old");
  d.app.scope.resources = resources;
  const snapshot = d.app.executions.snapshot(old),
    ports = createExecutionPorts(
      d.app,
      () => {},
      undefined,
      d.channels,
    ).toolsFor(old, snapshot);
  assert.equal(
    assistantTools({ ports, snapshot }).some((t) => t.name === "platform_read"),
    false,
  );
  await assert.rejects(
    ports.platformRead({ name: "platform.groups.list", params: {} }),
    /outside/,
  );
  assert.equal(d.calls(), 0);
  const work = delegate(d.app, "new"),
    snap = d.app.executions.snapshot(work),
    current = createExecutionPorts(
      d.app,
      () => {},
      undefined,
      d.channels,
    ).toolsFor(work, snap);
  d.app.scope.resources = [];
  await assert.rejects(
    current.platformRead({ name: "platform.groups.list", params: {} }),
    /binding changed/,
  );
  d.app.scope.resources = resources;
  d.mode("revoke");
  const revoked = await current.platformRead({
    name: "platform.groups.list",
    params: {},
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.data, undefined);
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    current.platformRead(
      { name: "platform.groups.list", params: {} },
      c.signal,
    ),
    /abort/i,
  );
});
test("unavailable, denied, transport failure and empty page remain distinct; no arbitrary operations", async () => {
  const q = { name: "platform.groups.list", params: {} };
  assert.equal(
    (await executePlatformRead(null, q)).failure,
    "tool_unavailable",
  );
  assert.equal(
    (
      await executePlatformRead(
        {
          query: async () => {
            throw Object.assign(Error("x"), { status: 403 });
          },
        },
        q,
      )
    ).failure,
    "access_denied",
  );
  assert.equal(
    (
      await executePlatformRead(
        {
          query: async () => {
            throw Error("permission denied");
          },
        },
        q,
      )
    ).failure,
    "read_failed",
  );
  const empty = await executePlatformRead(
    { query: async () => ({ groups: [], nextCursor: null }) },
    q,
  );
  assert.equal(empty.ok, true);
  assert.equal(empty.coverage.scope, "returned-page");
  assert.equal(
    (
      await executePlatformRead(
        { query: async () => ({ text: "x".repeat(13000) }) },
        q,
      )
    ).failure,
    "result_too_large",
  );
  await assert.rejects(
    executePlatformRead(null, { name: "platform.groups.send", params: {} }),
    /Unsupported/,
  );
  await assert.rejects(
    executePlatformRead(null, { ...q, params: { owner: "another" } }),
    /Unknown/,
  );
});

test("Pi proposal correction keeps original confirmation context and settles only once; exhaustion is typed", async (t) => {
  const { ReceptionModel } = await import(
    "../src/adapters/models/reception-model.mjs"
  );
  const { ReceptionPlanner } = await import(
    "../src/application/reception/planner.mjs"
  );
  const { ReceptionCoordinator } = await import(
    "../src/runtime/reception-coordinator.mjs"
  );
  const { createModels, fauxProvider, fauxAssistantMessage } = await import(
    "@earendil-works/pi-ai"
  );
  const d = setup(t),
    models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 100000 });
  models.setProvider(faux.provider);
  const model = new ReceptionModel({
    configured: {
      mode: "model",
      models,
      model: { provider: "faux", modelId: "faux-1" },
    },
  });
  const planner = new ReceptionPlanner(model, d.app.receptionQueries);
  const coordinator = new ReceptionCoordinator(d.app.reception, planner);
  d.app.reception.accept("ask", { text: "查我和你在哪些群聊过" });
  d.app.reception.apply(d.app.reception.turn("ask"), {
    kind: "reply",
    text: "可以查当前可见群",
  });
  d.app.reception.accept("confirm", { text: "查" });
  const turn = d.app.reception.turn("confirm");
  assert.deepEqual(d.app.reception.context(turn).capabilities.delegationTools, [
    "platform_read",
  ]);
  let corrections = 0;
  faux.setResponses([
    fauxAssistantMessage(JSON.stringify({ kind: "delegate", goal: "  " })),
    async (transcript) => {
      corrections++;
      const input = JSON.parse(
        transcript.messages.findLast((m) => m.role === "user").content,
      );
      assert.equal(input.text, "查");
      assert.equal(input.validationFeedback.code, "text_constraint");
      assert.equal(d.app.status().works.length, 0);
      return fauxAssistantMessage(
        JSON.stringify({
          kind: "delegate",
          goal: "查询当前可见群内的既往对话并报告范围",
          completion: { output: "text" },
        }),
      );
    },
  ]);
  await coordinator.process(turn, new AbortController().signal);
  assert.equal(corrections, 1);
  assert.equal(d.app.status().works.length, 1);
  await coordinator.process(turn, new AbortController().signal);
  assert.equal(d.app.status().works.length, 1);
  d.app.reception.accept("bad", { text: "再查一次" });
  faux.setResponses([
    fauxAssistantMessage('{"kind":"delegate","goal":""}'),
    fauxAssistantMessage('{"kind":"delegate","goal":""}'),
  ]);
  await coordinator.process(
    d.app.reception.turn("bad"),
    new AbortController().signal,
  );
  assert.equal(d.app.reception.turn("bad").status, "blocked");
  assert.equal(d.app.status().works.length, 1);
  assert.match(
    d.app.history.view().messages.at(-1).text,
    /自动纠正.*尚未开始执行/,
  );
  const event = d.uow.db
    .prepare(
      "SELECT data FROM event WHERE kind='reception.blocked' ORDER BY seq DESC LIMIT 1",
    )
    .get();
  assert.equal(JSON.parse(event.data).proposalFailure.code, "text_constraint");
});
