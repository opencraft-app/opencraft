import assert from "node:assert/strict";
import test from "node:test";
import { HermesAppServerAdapter } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import { dispatchAppServerRequest } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol";
import type { HermesRpcClient } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/rpc-transport";
import type { AppServerTurn } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/types";

function harness() {
  let receive: (event: Record<string, unknown>) => void = () => {};
  const prompts: Record<string, unknown>[] = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  let respond: () => Promise<unknown> = async () => ({ ok: true });
  let steer: () => Promise<{ status: string }> = async () => ({ status: "accepted" });
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  let submit: () => Promise<{ status: string }> = async () => ({ status: "streaming" });
  const rpc: HermesRpcClient = {
    onEvent(listener) { receive = listener; return () => {}; },
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "clarify.respond") return await respond() as T;
      if (method === "session.steer") return await steer() as T;
      if (method === "session.create") return {
        session_id: "live", stored_session_id: "stored", messages: [],
        message_count: 0, running: false,
      } as T;
      if (method === "prompt.submit") {
        prompts.push(params as Record<string, unknown>);
        return await submit() as T;
      }
      throw new Error(`Unexpected RPC: ${method}`);
    },
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  adapter.subscribeNotification((method, params) => notifications.push({
    method, params: params as Record<string, unknown>,
  }));
  return {
    adapter, prompts, notifications, calls,
    setRespond(next: typeof respond) { respond = next; },
    setSteer(next: typeof steer) { steer = next; },
    setSubmit(next: typeof submit) { submit = next; },
    event(type: string, payload: Record<string, unknown> = {}) {
      receive({ session_id: "live", type, payload });
    },
    async start(text: string): Promise<AppServerTurn> {
      const result = await dispatchAppServerRequest(adapter, {
        id: text, method: "turn/start",
        params: { threadId: "stored", clientUserMessageId: `client-${text}`, input: [{ type: "text", text }] },
      }) as { turn: AppServerTurn };
      return result.turn;
    },
    turnIds(method: string) {
      return notifications.filter((n) => n.method === method).map((n) => (n.params.turn as AppServerTurn).id);
    },
  };
}

test("Clarify expiry releases only its request and waits for fresh idle to settle", async (t) => {
  const h = harness(); t.after(() => h.adapter.dispose());
  await h.adapter.startThread();
  const turn = await h.start("first");
  h.event("message.start");
  h.event("clarify.request", { request_id: "old", question: "Old?" });
  h.event("session.info", { running: false });
  h.event("clarify.request", { request_id: "new", question: "New?" });
  h.event("clarify.expire", { request_id: "old" });
  h.event("session.info", { running: false });
  assert.deepEqual(h.turnIds("turn/completed"), []);
  h.event("clarify.expire", { request_id: "new" });
  assert.deepEqual(h.turnIds("turn/completed"), [], "expiry is not Turn completion or permission to replay old idle");
  h.event("session.info", { running: false });
  assert.deepEqual(h.turnIds("turn/completed"), [turn.id]);
});

test("late answer receipt cannot clear a newer Clarify owner", async (t) => {
  const h = harness(); t.after(() => h.adapter.dispose());
  await h.adapter.startThread(); await h.start("first"); h.event("message.start");
  let requestId = "";
  h.adapter.subscribeServerRequest(request => { requestId = request.id; });
  h.event("clarify.request", { request_id: "old", question: "Old?" });
  let release!: () => void;
  h.setRespond(() => new Promise(resolve => { release = () => resolve({ ok: true }); }));
  const answering = h.adapter.respondServerRequest(requestId, { answers: { answer: { answers: ["Yes"] } } });
  h.event("clarify.request", { request_id: "new", question: "New?" });
  release(); await answering;
  h.event("session.info", { running: false });
  assert.deepEqual(h.turnIds("turn/completed"), []);
  h.event("clarify.expire", { request_id: "new" }); h.event("session.info", { running: false });
  assert.equal(h.turnIds("turn/completed").length, 1);
});

test("typed steer skips Clarify on the owning gateway without waiting for the skip receipt", async (t) => {
  const h = harness(); t.after(() => h.adapter.dispose());
  await h.adapter.startThread(); const turn = await h.start("first"); h.event("message.start");
  h.event("clarify.request", { request_id: "q", question: "Choose?" });
  h.setRespond(() => new Promise(() => {}));
  await h.adapter.steerTurn(
    "stored",
    turn.id,
    [{ type: "text", text: "Do this instead" }],
    "client-steer",
  );
  assert.deepEqual(h.calls.slice(-2), [
    { method: "clarify.respond", params: { request_id: "q", answer: "" } },
    { method: "session.steer", params: { session_id: "live", text: "Do this instead" } },
  ]);
  const accepted = h.notifications.find((notification) =>
    notification.method === "item/completed"
    && (notification.params.item as AppServerTurn["items"][number] | undefined)?.type === "userMessage"
    && (notification.params.item as AppServerTurn["items"][number] | undefined)?.clientId === "client-steer"
  );
  assert.ok(accepted, "Gateway admission must publish an authoritative user-message identity");
  assert.equal(h.turnIds("turn/completed").length, 0);
});

test("steer rejects an obsolete expected Turn without touching Hermes", async (t) => {
  const h = harness(); t.after(() => h.adapter.dispose());
  await h.adapter.startThread(); await h.start("first"); h.event("message.start");
  const steerCallsBefore = h.calls.filter((call) => call.method === "session.steer").length;
  await assert.rejects(
    h.adapter.steerTurn(
      "stored",
      "obsolete-turn",
      [{ type: "text", text: "Do this instead" }],
      "client-obsolete",
    ),
    (error: unknown) => {
      const candidate = error as { domainData?: { code?: string; actualTurnId?: string } };
      return candidate.domainData?.code === "EXPECTED_TURN_MISMATCH"
        && candidate.domainData.actualTurnId !== undefined;
    },
  );
  assert.equal(
    h.calls.filter((call) => call.method === "session.steer").length,
    steerCallsBefore,
  );
});

test("steer racing Turn completion is restored as one paused follow-up", async (t) => {
  const h = harness(); t.after(() => h.adapter.dispose());
  await h.adapter.startThread(); const turn = await h.start("first"); h.event("message.start");
  let release!: () => void;
  h.setSteer(() => new Promise((resolve) => {
    release = () => resolve({ status: "accepted" });
  }));
  const steering = h.adapter.steerTurn(
    "stored",
    turn.id,
    [{ type: "text", text: "Do this instead" }],
    "client-racing-steer",
  );
  while (h.calls.at(-1)?.method !== "session.steer") await new Promise((resolve) => setImmediate(resolve));
  h.event("message.complete", { text: "Already done" });
  h.event("session.info", { running: false });
  release();
  assert.deepEqual(await steering, { turnId: turn.id, disposition: "queued" });
  const queue = h.adapter.listQueuedSubmissions("stored", null, null).data;
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.clientUserMessageId, "client-racing-steer");
  assert.match(queue[0]?.pausedReason ?? "", /Run ended/);
  assert.equal(
    h.notifications.filter((notification) =>
      notification.method === "item/completed"
      && (notification.params.item as AppServerTurn["items"][number] | undefined)?.clientId === "client-racing-steer"
    ).length,
    0,
    "a completed Turn must not receive a manufactured steering acknowledgement",
  );
});

test("failed answer retains ownership and late tool completion cannot release a newer question", async (t) => {
  const h = harness(); t.after(() => h.adapter.dispose());
  await h.adapter.startThread(); await h.start("first"); h.event("message.start");
  let requestId = "";
  h.adapter.subscribeServerRequest(request => { requestId = request.id; });
  h.event("tool.start", { tool_id: "old-tool", name: "clarify" });
  h.event("clarify.request", { request_id: "old", question: "Old?" });
  h.setRespond(async () => { throw new Error("Disconnected"); });
  await assert.rejects(h.adapter.respondServerRequest(requestId, {}), /Disconnected/);
  h.event("session.info", { running: false });
  assert.equal(h.turnIds("turn/completed").length, 0);
  h.event("tool.start", { tool_id: "new-tool", name: "clarify" });
  h.event("clarify.request", { request_id: "new", question: "New?" });
  h.event("tool.complete", { tool_id: "old-tool", name: "clarify", result: "Expired" });
  h.event("session.info", { running: false });
  assert.equal(h.turnIds("turn/completed").length, 0);
  h.event("tool.complete", { tool_id: "new-tool", name: "clarify", result: "Answered elsewhere" });
  assert.equal(h.turnIds("turn/completed").length, 0);
  h.event("session.info", { running: false });
  assert.equal(h.turnIds("turn/completed").length, 1);
});

for (const disposition of ["streaming", "queued"] as const) {
  for (const beforeReceipt of [false, true]) {
    test(`completed Turn admits follow-up despite busy heartbeat: ${disposition}, frames before receipt=${beforeReceipt}`, async (t) => {
      const h = harness();
      t.after(() => h.adapter.dispose());
      await h.adapter.startThread();
      const first = await h.start("first");
      h.event("message.start");
      h.event("message.complete", { text: "first answer" });
      h.event("session.info", { running: true });
      const stream = () => {
        if (beforeReceipt || disposition === "queued") {
          h.event("session.info", { running: true }); // previous process, not a new Turn
          h.event("message.complete", { text: "late previous answer" });
          h.event("session.info", { running: false });
        }
        h.event("message.start");
        h.event("message.delta", { text: "second answer" });
        h.event("message.complete", { text: "second answer" });
      };
      h.setSubmit(async () => {
        if (beforeReceipt) stream();
        return { status: disposition };
      });
      const second = await h.start("second");
      if (!beforeReceipt) {
        if (disposition === "queued") assert.deepEqual(h.turnIds("turn/started"), [first.id]);
        stream();
      }
      assert.equal(h.prompts.length, 2);
      assert.ok(h.prompts.every((p) => p.queued === true));
      assert.deepEqual(h.turnIds("turn/started"), [first.id, second.id]);
      assert.deepEqual(h.turnIds("turn/completed"), [first.id, second.id]);
      const completed = h.notifications.filter((n) => n.method === "turn/completed");
      const final = completed[1]!.params.turn as AppServerTurn;
      assert.equal(final.items.find((item) => item.type === "agentMessage")?.text, "second answer");
      assert.equal(final.items.find((item) => item.type === "userMessage")?.clientId, "client-second");
    });
  }
}

test("a genuinely unfinished Turn still owns ordinary turn/start admission", async (t) => {
  const h = harness();
  t.after(() => h.adapter.dispose());
  await h.adapter.startThread();
  await h.start("first");
  await assert.rejects(h.start("second"), /already running/);
  assert.equal(h.prompts.length, 1);
});

test("server-accepted pending Turn prevents another ordinary turn/start", async (t) => {
  const h = harness();
  t.after(() => h.adapter.dispose());
  await h.adapter.startThread();
  await h.start("first");
  h.event("message.complete", { text: "first answer" });
  h.event("session.info", { running: true });
  h.setSubmit(async () => ({ status: "queued" }));
  await h.start("second");
  await assert.rejects(h.start("third"), /already running/);
  assert.equal(h.prompts.length, 2);
});

test("failed physical admission does not fabricate an owner or prevent retry", async (t) => {
  const h = harness();
  t.after(() => h.adapter.dispose());
  await h.adapter.startThread();
  const first = await h.start("first");
  h.event("message.complete", { text: "first answer" });
  h.event("session.info", { running: true });
  h.setSubmit(async () => { throw new Error("admission failed"); });
  await assert.rejects(h.start("second"), /admission failed/);
  assert.deepEqual(h.turnIds("turn/started"), [first.id]);
  h.setSubmit(async () => ({ status: "streaming" }));
  const retry = await h.start("second");
  h.event("message.start");
  h.event("message.complete", { text: "retry answer" });
  assert.deepEqual(h.turnIds("turn/completed"), [first.id, retry.id]);
});
