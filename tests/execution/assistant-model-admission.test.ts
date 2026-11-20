import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  AssistantModelAdmission,
  ModelAdmissionDeferred,
  retryAfterTime,
} from "../../apps/local-agent-host/src/model-config/assistant-admission.js";
import { createAssistantModelGateway } from "../../apps/local-agent-host/src/model-config/assistant-gateway.js";
// @ts-expect-error Independent assistant ES module.
import { CodexStructuredHarness } from "../../apps/personal-assistant/src/adapters/codex/structured-harness.mjs";
const ref = { providerId: "test", modelId: "synthetic" },
  signal = () => AbortSignal.timeout(3000),
  context = (owner: string, purpose: any = "reception", s = signal()) => ({
    owner,
    purpose,
    signal: s,
    observe: () => {},
  });
const resolved = {
  baseUrl: "https://example.invalid/v1",
  model: "synthetic",
  protocol: "openai-responses" as const,
  quotaKey: "shared",
  apiKey: "synthetic-secret",
};
const limited = (after = "0.02") =>
  Response.json(
    { error: { message: "synthetic busy" } },
    { status: 429, headers: { "retry-after": after } },
  );
const body = { model: "synthetic", input: "hello", stream: false };
const post = (
  c: { baseUrl: string; apiKey: string },
  v = body,
  signal?: AbortSignal,
) =>
  fetch(c.baseUrl + "/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer " + c.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(v),
    signal,
  });
async function until(f: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!f()) {
    if (Date.now() > deadline) throw Error("condition timed out");
    await pause(5);
  }
}
test("Retry-After seconds and HTTP-date are lower bounds and never shortened", () => {
  const now = Date.UTC(2026, 10, 11);
  assert.equal(retryAfterTime("90", now), now + 90000);
  assert.equal(
    retryAfterTime(new Date(now + 90000).toUTCString(), now),
    now + 90000,
  );
  assert.equal(retryAfterTime("garbage", now), undefined);
  assert.equal(retryAfterTime("-2", now), undefined);
});
test("one connection shares capacity across owners; queues cancel and foreground wins", async () => {
  const a = new AssistantModelAdmission({ idleGraceMs: 0 });
  const release = await a.acquire("same", context("a", "execution"));
  const order: string[] = [];
  const bg = a.acquire("same", context("a", "memory-propose")).then((r) => {
    order.push("bg");
    r();
  });
  const foreground = a.acquire("same", context("b")).then((r) => {
    order.push("user");
    r();
  });
  const controller = new AbortController(),
    canceled = a.acquire("same", context("c", "reception", controller.signal));
  controller.abort();
  await assert.rejects(canceled);
  release();
  await Promise.all([bg, foreground]);
  assert.deepEqual(order, ["user", "bg"]);
  a.close();
});
test("shared cooldown defers memory without shortening a long server wait; different resources remain independent", async () => {
  let now = 1000;
  const a = new AssistantModelAdmission({
    now: () => now,
    random: () => 0,
    idleGraceMs: 0,
  });
  assert.equal(a.cooldown("same", "90"), 91000);
  await assert.rejects(
    a.acquire("same", context("a", "memory-verify")),
    (e) => e instanceof ModelAdmissionDeferred && e.retryAt === 91000,
  );
  await assert.rejects(
    a.acquire("same", { ...context("b"), deadlineAt: 2000 }),
    (e) => e instanceof ModelAdmissionDeferred,
  );
  const release = await a.acquire("other", context("b"));
  release();
  now = 91001;
  const r = await a.acquire("same", context("a"));
  r();
  a.close();
});
test("cooldown detaches queued memory; closing rejects waiters and releases timers", async () => {
  const a = new AssistantModelAdmission();
  const release = await a.acquire("same", context("a"));
  const bg = a.acquire("same", context("a", "memory-propose"));
  a.cooldown("same", "90");
  await assert.rejects(bg, ModelAdmissionDeferred);
  const waiting = a.acquire("same", context("b"));
  a.close();
  await assert.rejects(waiting);
  release();
});
test("429→200 retries only rejected HTTP requests; bound scope token cannot access another owner route", async (t) => {
  let calls = 0;
  const g = createAssistantModelGateway(async () => resolved, {
    fetch: async () =>
      ++calls === 1 ? limited() : Response.json({ ok: true }),
    requestTimeoutMs: 1000,
  });
  t.after(() => g.close());
  const c = await g.connection(ref, { scope: "a", purpose: "reception" }),
    d = await g.connection(ref, { scope: "b", purpose: "reception" });
  const wrong = await post({ ...d, apiKey: c.apiKey });
  assert.equal(wrong.status, 401);
  const r = await post(c);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(calls, 2);
});
test("cooldown longer than budget returns immediately; background makes one attempt; quota is not retried", async (t) => {
  let calls = 0;
  const g = createAssistantModelGateway(async () => resolved, {
    fetch: async () => {
      calls++;
      return limited("90");
    },
    requestTimeoutMs: 1000,
  });
  t.after(() => g.close());
  const c = await g.connection(ref, { scope: "a" }),
    start = Date.now(),
    r = await post(c);
  assert.equal(r.status, 429);
  assert.ok(Date.now() - start < 900);
  await r.text();
  assert.equal(calls, 1);
  const bg = await post(
    await g.connection(ref, { scope: "b", purpose: "memory-propose" }),
  );
  assert.equal(bg.status, 429);
  await bg.text();
  assert.equal(calls, 1);
  const q = createAssistantModelGateway(async () => resolved, {
    fetch: async () => {
      calls++;
      return Response.json(
        { error: { code: "insufficient_quota" } },
        { status: 429 },
      );
    },
  });
  t.after(() => q.close());
  const qr = await post(await q.connection(ref, { scope: "q" }));
  assert.equal(qr.status, 429);
  await qr.text();
  assert.equal(calls, 2);
  assert.equal(q.failure("q", "reception")?.kind, "quota_exhausted");
});
test("attempts bounded at three, rejected400 never retried, retry rechecks current authorization", async (t) => {
  let calls = 0,
    valid = true,
    authorized = 0;
  const g = createAssistantModelGateway(async () => resolved, {
    fetch: async () => {
      calls++;
      return limited("0.01");
    },
    requestTimeoutMs: 1000,
  });
  t.after(() => g.close());
  const c = await g.connection(ref, {
    scope: "a",
    authorize: async () => {
      authorized++;
      if (!valid) throw Error("revoked");
    },
  });
  const r = await post(c);
  assert.equal(r.status, 429);
  await r.text();
  assert.equal(calls, 3);
  assert.ok(authorized >= 6);
  valid = false;
  const denied = await post(c);
  await denied.text();
  assert.equal(calls, 3);
  let badCalls = 0;
  const bad = createAssistantModelGateway(async () => resolved, {
    fetch: async () => {
      badCalls++;
      return Response.json(
        { error: { message: "invalid schema" } },
        { status: 400 },
      );
    },
  });
  t.after(() => bad.close());
  const badResponse = await post(await bad.connection(ref));
  assert.equal(badResponse.status, 400);
  await badResponse.text();
  assert.equal(badCalls, 1);
});
test("cancel during shared wait makes no extra provider request and clears activity", async (t) => {
  let calls = 0;
  const g = createAssistantModelGateway(async () => resolved, {
    fetch: async () => {
      calls++;
      return limited("0.3");
    },
    requestTimeoutMs: 2000,
  });
  t.after(() => g.close());
  const c = await g.connection(ref, { scope: "a" }),
    abort = new AbortController();
  const task = post(c, body, abort.signal);
  await until(() => g.activity("a")?.reason === "rate_limit");
  abort.abort();
  await assert.rejects(task);
  await pause(350);
  assert.equal(calls, 1);
  assert.equal(g.activity("a"), undefined);
});
test("stream holds its permit until consumed or disconnected; no retry after content", async (t) => {
  let calls = 0;
  const g = createAssistantModelGateway(async () => resolved, {
    fetch: async () => {
      calls++;
      return calls === 1
        ? new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("first"));
              },
            }),
          )
        : Response.json({ ok: true });
    },
    requestTimeoutMs: 1000,
  });
  t.after(() => g.close());
  const c = await g.connection(ref, { scope: "a" }),
    d = await g.connection(ref, { scope: "b" }),
    r = await post(c);
  assert.equal(
    new TextDecoder().decode((await r.body!.getReader().read()).value),
    "first",
  );
  let arrived = false;
  const second = post(d).then(async (x) => {
    arrived = true;
    await x.text();
  });
  await pause(40);
  assert.equal(calls, 1);
  assert.equal(arrived, false);
  await g.close();
  await Promise.allSettled([second]);
  assert.equal(calls, 1);
});
const binary =
  "/opt/opencraft/runtime/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
function sse(text: string, n: number) {
  return new Response(
    [
      { type: "response.created", response: { id: "r" + n } },
      {
        type: "response.output_item.done",
        item: {
          id: "m" + n,
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "r" + n,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]
      .map((e) => "data: " + JSON.stringify(e) + "\n\n")
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
test(
  "real Codex routing and parameters survive independent429s without repeating successful stages",
  { skip: !existsSync(binary), timeout: 15000 },
  async (t) => {
    const counts = { routing: 0, parameters: 0 };
    const g = createAssistantModelGateway(async () => resolved, {
      fetch: async (_u, init) => {
        const p = JSON.parse(init!.body as string),
          phase = p.text.format.schema.properties.operations
            ? "routing"
            : "parameters";
        counts[phase]++;
        return counts[phase] === 1
          ? limited("0.01")
          : sse(
              JSON.stringify(
                phase === "routing"
                  ? { operations: ["reply"] }
                  : { proposal: { kind: "reply", text: "OK" } },
              ),
              counts[phase],
            );
      },
      requestTimeoutMs: 2000,
    });
    const harness = new CodexStructuredHarness(
      {
        binary,
        managed: true,
        providerId: ref.providerId,
        modelId: ref.modelId,
      },
      {
        resolveModel: (_c: any, ctx: any) =>
          g.connection(ref, { scope: "native", purpose: ctx.purpose }),
      },
    );
    t.after(async () => {
      await harness.close();
      await g.close();
    });
    const answer = await harness.complete({
      kind: "reception",
      instruction: "Reply to hello.",
      input: { text: "hello" },
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(JSON.parse(answer.content[0].text).text, "OK");
    assert.deepEqual(counts, { routing: 2, parameters: 2 });
  },
);

test('revocation during retry delay never dispatches another HTTP call',async t=>{
 let calls=0,valid=true;const g=createAssistantModelGateway(async()=>resolved,{fetch:async()=>{calls++;return limited('0.15');},requestTimeoutMs:1000});t.after(()=>g.close());const c=await g.connection(ref,{scope:'revoked',authorize:async()=>{if(!valid)throw Error('revoked');}});const r=post(c);await until(()=>g.activity('revoked')?.reason==='rate_limit');valid=false;const response=await r;await response.text();assert.equal(calls,1);assert.equal(response.status,503);
});
test('a credential rotation is re-resolved at dispatch; a held response is fenced after revoke',async t=>{
 let key='first',valid=true;const sent:string[]=[],started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const g=createAssistantModelGateway(async()=>({...resolved,apiKey:key}),{fetch:async(_u,init)=>{sent.push(new Headers(init?.headers).get('authorization')!);if(sent.length===1)return limited('0.15');started.resolve();await release.promise;return Response.json({ok:true});},requestTimeoutMs:1000});t.after(()=>g.close());const c=await g.connection(ref,{scope:'rotated',authorize:async()=>{if(!valid)throw Error('revoked');}}),response=post(c);await until(()=>g.activity('rotated')?.reason==='rate_limit');key='second';await started.promise;valid=false;release.resolve();const r=await response;assert.equal(r.status,503);await r.text();assert.deepEqual(sent,['Bearer first','Bearer second']);
});
