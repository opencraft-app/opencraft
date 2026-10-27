import assert from "node:assert/strict";
import test from "node:test";
import { createCordisAppServerClient, JsonRpcAppServerClient, type AppServerClient, type ServerRequestResponseContext } from "@opencraft/appserver-client";
import { executionChannelsFixture, flush } from "./fixtures/execution-channels";

import { generateHandlerChaos, parseHandlerTrace, simulateHandlerRegistration, type HandlerChaosEvent, type HandlerChaosMutant } from "./fixtures/handler-registration-chaos";
import { ChaosViolation, shrinkChaosFailure } from "./fixtures/recovery-chaos";

const method = "item/tool/requestUserInput";
const answer = (value: string) => ({ answers: { choice: { answers: [value] } } });
function response(f: ReturnType<typeof executionChannelsFixture>, id: string) {
  return (f.replies as { id: string; result?: unknown; error?: { code: number } }[]).find(r => r.id === id);
}
for (const facade of [false, true]) {
  const label = facade ? "Cordis" : "raw Client";
  async function fixture(run: (client: AppServerClient, f: ReturnType<typeof executionChannelsFixture>) => Promise<void>) {
    const f = executionChannelsFixture(), cordis = facade ? await createCordisAppServerClient({ hostId: "handlers", transport: f.transport }) : null;
    const client: AppServerClient = cordis?.client ?? new JsonRpcAppServerClient({ hostId: "handlers", transport: f.transport });
    await client.connect({ clientInfo: { name: "handler-registration", version: "1" } });
    try { await run(client, f); }
    finally { if (cordis) await cordis.dispose(); else await client.close(); }
  }

  for (const removeFirst of [false, true]) test(`${label}: stale handler cleanup preserves same-function successor (${removeFirst ? "after removal" : "direct replacement"})`, async () => {
    await fixture(async (client, f) => {
      let calls = 0;
      const handler = () => { calls++; return answer("current"); };
      const old = client.handleServerRequest(method, handler);
      if (removeFirst) old();
      const current = client.handleServerRequest(method, handler);
      old(); old(); f.question("current"); await flush();
      assert.equal(calls, 1); assert.deepEqual(response(f, "current")?.result, answer("current"));
      current(); f.question("removed"); await flush();
      assert.equal(calls, 1); assert.equal(response(f, "removed")?.error?.code, -32601);
      assert.equal(f.reads, 0); assert.equal(f.activations, 0);
    });
  });

  test(`${label}: method replacement preserves a different callback and its bare receiver`, async () => {
    await fixture(async (client, f) => {
      const receivers: unknown[] = [];
      const old = client.handleServerRequest(method, () => { throw Error("retired callback entered"); });
      client.handleServerRequest(method, function(this: unknown) { receivers.push(this); return answer("new"); });
      old(); f.question("new"); await flush();
      assert.deepEqual(receivers, [undefined]); assert.deepEqual(response(f, "new")?.result, answer("new"));
    });
  });

  for (const replacement of [false, true]) test(`${label}: registration retirement does not cancel an admitted response (${replacement ? "replacement" : "unsubscribe"})`, async () => {
    await fixture(async (client, f) => {
      let complete!: (value: unknown) => void, context!: ServerRequestResponseContext;
      const old = client.handleServerRequest(method, (_p, _r, c) => {
        context = c; return new Promise(resolve => { complete = resolve; });
      });
      f.question("admitted"); await flush(); assert.ok(context); assert.equal(f.replies.length, 0);
      if (replacement) client.handleServerRequest(method, () => answer("successor"));
      old(); assert.equal(context.signal.aborted, false, "a registration token does not own a native response context");
      f.question("later"); await flush();
      if (replacement) assert.deepEqual(response(f, "later")?.result, answer("successor"));
      else assert.equal(response(f, "later")?.error?.code, -32601);
      complete(answer("admitted")); await flush();
      assert.deepEqual(response(f, "admitted")?.result, answer("admitted"));
      assert.equal(f.replies.length, 2, "each wire request has its own result and at most one response");
    });
  });

  test(`${label}: a held interceptor admits the current handler when next is called`, async () => {
    await fixture(async (client, f) => {
      let proceed!: () => Promise<unknown>, oldCalls = 0, newCalls = 0;
      client.interceptServerRequest((_r, next) => new Promise((resolve, reject) => { proceed = () => next().then(resolve, reject); }));
      const old = client.handleServerRequest(method, () => { oldCalls++; return answer("old"); });
      f.question("held"); await flush();
      client.handleServerRequest(method, () => { newCalls++; return answer("new"); }); old();
      await proceed(); await flush();
      assert.equal(oldCalls, 0); assert.equal(newCalls, 1); assert.deepEqual(response(f, "held")?.result, answer("new"));
    });
  });

  test(`${label}: physical close still retires the admitted response independently of registration`, async () => {
    await fixture(async (client, f) => {
      let complete!: (value: unknown) => void, context!: ServerRequestResponseContext;
      const old = client.handleServerRequest(method, (_p, _r, c) => {
        context = c; return new Promise(resolve => { complete = resolve; });
      });
      f.question("lost"); await flush();
      client.handleServerRequest(method, () => answer("new")); old();
      await client.close(); assert.equal(context.signal.aborted, true);
      complete(answer("late")); await flush(); assert.equal(f.replies.length, 0);
    });
  });
}


// The oracle observes real handlers, native response contexts and wire replies.
test("handler chaos corpus preserves registration and admitted response owners", async () => {
  for (let seed = 0; seed < 24; seed++) await simulateHandlerRegistration(generateHandlerChaos(seed, 120));
});
for (const [mutant, rule, types] of [
  ["stale-token", "HANDLER_ADMISSION", ["register-a", "old-token", "question"]],
  ["retarget-result", "HANDLER_REPLY_OWNER", ["question", "register-b", "resolve-one"]],
  ["cancel-admitted", "HANDLER_CONTEXT_OWNERSHIP", ["question", "current-token"]],
] as const) test(`handler chaos rejects ${mutant} at its exact rule and replays normally`, async () => {
  const trace: HandlerChaosEvent[] = types.map(type => ({ type }));
  await assert.rejects(simulateHandlerRegistration(trace, { mutant }), (e: unknown) => e instanceof ChaosViolation && e.rule === rule && !e.cleanupFailure);
  const minimal = await shrinkChaosFailure(trace, rule, events => simulateHandlerRegistration(events, { mutant: mutant as HandlerChaosMutant }));
  assert.ok(minimal.length <= trace.length); await simulateHandlerRegistration(minimal);
});
test("closed handler chaos needs no healthy native suffix to expose registration-owned cancellation", async () => {
  const trace = parseHandlerTrace([{ type: "question" }, { type: "current-token" }, { type: "close" }]);
  await assert.rejects(simulateHandlerRegistration(trace, { mutant: "cancel-admitted" }), (e: unknown) => e instanceof ChaosViolation && e.rule === "HANDLER_CONTEXT_OWNERSHIP" && !e.cleanupFailure);
  await simulateHandlerRegistration(trace);
});
test("the healthy handler suffix does not manufacture an outstanding result crossing registration owners", async () => {
  await simulateHandlerRegistration([], { mutant: "retarget-result" });
});
test("handler traces reject unknown events and non-array inputs", () => {
  assert.throws(() => parseHandlerTrace([{ type: "invented" }])); assert.throws(() => parseHandlerTrace({}));
});
