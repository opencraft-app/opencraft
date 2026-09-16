import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { AuthenticationService, AuthenticationFlowService,
  type AuthenticationResult, type AuthenticationSession, type AuthenticationFlowRequest } from "../packages/workbench-runtime/src/index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const request = (owner = "footer"): AuthenticationFlowRequest => ({ providerId: "test", owner, reason: "account-entry", presentation: "dialog" });

async function fixture() {
  const ctx = new Context();
  const authFiber = ctx.plugin(AuthenticationService); await authFiber;
  const flowFiber = ctx.plugin(AuthenticationFlowService); await flowFiber;
  const listeners = new Set<() => void>();
  let session: AuthenticationSession = { status: "anonymous", epoch: 0 };
  let cancellations = 0;
  const attempts: ReturnType<typeof deferred<AuthenticationResult>>[] = [];
  const choices: (string | undefined)[] = [];
  const provider = { id: "test", getSession: () => session,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    signIn: (optionId?: string) => { choices.push(optionId); const attempt = deferred<AuthenticationResult>(); attempts.push(attempt); return attempt.promise; },
    cancelSignIn: async () => { cancellations++; },
  };
  const unregister = ctx.authentication.register("extension-1", provider);
  return { ctx, flows: ctx.authenticationFlows, attempts, choices, listeners, unregister, provider,
    cancellations: () => cancellations,
    install: () => { session = { status: "authenticated", epoch: session.epoch + 1 }; listeners.forEach(fn => fn()); return session.epoch; },
    dispose: async () => { await flowFiber.dispose(); await authFiber.dispose(); },
  };
}

test("restoration is silent; explicit same-account login completes every time", async () => {
  const f = await fixture();
  f.install(); assert.equal(f.flows.getSnapshot(), null);
  for (let n = 0; n < 2; n++) {
    const id = f.flows.open(request());
    const operation = f.flows.submit(id);
    const epoch = f.install();
    assert.equal(f.flows.getSnapshot()?.phase, "pending", "account change alone must not close UI");
    f.attempts[n]!.resolve({ status: "authenticated", epoch });
    assert.deepEqual(await operation, { status: "authenticated", epoch });
    assert.equal(f.flows.getSnapshot(), null);
  }
  await f.dispose();
});

test("submit is single-flight and transport errors stay in the same prompt", async () => {
  const f = await fixture(); const id = f.flows.open(request());
  const first = f.flows.submit(id), second = f.flows.submit(id);
  assert.equal(first, second); assert.equal(f.attempts.length, 1);
  f.attempts[0]!.reject(new Error("sensitive callback details"));
  assert.equal((await first).status, "error");
  assert.equal(f.flows.getSnapshot()?.id, id);
  assert.equal(f.flows.getSnapshot()?.phase, "error");
  assert.doesNotMatch(f.flows.getSnapshot()!.error!, /sensitive/);
  const retry = f.flows.submit(id);
  f.attempts[1]!.resolve({ status: "authenticated", epoch: f.install() });
  assert.equal((await retry).status, "authenticated"); await f.dispose();
});

test("cancellation and supersession cannot close or complete a newer flow", async () => {
  const f = await fixture();
  const firstId = f.flows.open(request("first")), first = f.flows.submit(firstId);
  const nextId = f.flows.open(request("next")), next = f.flows.submit(nextId);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.cancellations(), 1); assert.equal(f.attempts.length, 2);
  f.attempts[0]!.resolve({ status: "authenticated", epoch: f.install() });
  assert.equal((await first).status, "abandoned");
  assert.equal(f.flows.getSnapshot()?.id, nextId);
  f.flows.cancel(firstId); assert.equal(f.flows.getSnapshot()?.id, nextId);
  f.attempts[1]!.resolve({ status: "authenticated", epoch: f.install() });
  assert.equal((await next).status, "authenticated"); await f.dispose();
});

test("leaving the feature revokes continuation without discarding a valid global session", async () => {
  const f = await fixture(); const id = f.flows.open({ ...request(), presentation: "inline", reason: "environment-create" });
  const operation = f.flows.submit(id);
  f.flows.abandon(id); assert.equal(f.cancellations(), 0);
  f.attempts[0]!.resolve({ status: "authenticated", epoch: f.install() });
  assert.equal((await operation).status, "abandoned");
  assert.equal(f.ctx.authentication.getSession("test")?.status, "authenticated");
  assert.equal(f.flows.getSnapshot(), null); await f.dispose();
});

test("provider removal retires subscriptions and a replacement cannot inherit old completion", async () => {
  const f = await fixture(); const id = f.flows.open(request()), pending = f.flows.submit(id);
  f.unregister(); assert.equal(f.flows.getSnapshot(), null); assert.equal(f.listeners.size, 0);
  const replacement = f.ctx.authentication.register("extension-2", f.provider);
  f.unregister(); assert.ok(f.ctx.authentication.getSession("test"));
  f.attempts[0]!.resolve({ status: "authenticated", epoch: f.install() });
  assert.equal((await pending).status, "abandoned");
  replacement(); await f.dispose();
});

test("Cordis disposal cancels the active interaction and retires the capability", async () => {
  const f = await fixture(); const id = f.flows.open(request()), pending = f.flows.submit(id);
  await f.dispose();
  assert.equal(f.listeners.size, 0); assert.equal(f.flows.getSnapshot(), null);
  assert.throws(() => f.flows.open(request()), /disposed/);
  f.attempts[0]!.resolve({ status: "cancelled" });
  assert.equal((await pending).status, "abandoned");
});

test("Web redirect is not successful login and does not fire a continuation", async () => {
  const f = await fixture(); const id = f.flows.open(request()), operation = f.flows.submit(id);
  f.attempts[0]!.resolve({ status: "redirecting" });
  assert.equal((await operation).status, "redirecting");
  assert.equal(f.flows.getSnapshot()?.phase, "pending"); await f.dispose();
});

test("success from an obsolete session epoch is cancelled", async () => {
  const f = await fixture(); const id = f.flows.open(request()), operation = f.flows.submit(id);
  const epoch = f.install(); f.install();
  f.attempts[0]!.resolve({ status: "authenticated", epoch });
  assert.equal((await operation).status, "cancelled"); await f.dispose();
});

test("menu option belongs to its flow; a changed option retires the old attempt before handoff", async () => {
  const f = await fixture();
  const first = f.flows.open({ ...request(), presentation: "menu", optionId: "cn" });
  const pending = f.flows.submit(first);
  const next = f.flows.open({ ...request(), presentation: "menu", optionId: "intl" });
  assert.notEqual(first, next);
  const replacement = f.flows.submit(next);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.choices, ["cn", "intl"]);
  assert.equal(f.cancellations(), 1);
  f.attempts[0]!.resolve({ status: "cancelled" });
  assert.equal((await pending).status, "abandoned");
  f.attempts[1]!.resolve({ status: "authenticated", epoch: f.install() });
  assert.equal((await replacement).status, "authenticated");
  await f.dispose();
});
