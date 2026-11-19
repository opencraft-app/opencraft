import assert from "node:assert/strict";
import test from "node:test";
import { TencentOaController } from "../../plugins/tencentoa/src/controller";
import { identityValidUntil, TENCENTOA_CLOCK_SKEW_MS } from "../../plugins/tencentoa/src/contract";

const employee = (expiresAt = Date.now() + 60_000) => ({ provider: "tencentoa", subject: "123", displayName: "display-only",
  attributes: { loginName: "employee.fixture" }, expiresAt });
const reply = (principal: unknown = employee(), role: unknown = "member") => new Response(JSON.stringify({ principal, role }));

/** Model Safari 16.6 in this test process without changing production code. */
function withoutAbortSignalHelpers(t: { after(callback: () => void): void }): void {
  const saved = new Map<string, PropertyDescriptor>();
  for (const name of ["any", "timeout"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, name);
    if (!descriptor) continue;
    saved.set(name, descriptor);
    Object.defineProperty(AbortSignal, name, { ...descriptor, value: undefined });
  }
  t.after(() => {
    for (const [name, descriptor] of saved) Object.defineProperty(AbortSignal, name, descriptor);
  });
}

test("missing product route reads the existing authenticated access session without extending expiry or newer AbortSignal helpers", async t => {
  withoutAbortSignalHelpers(t);
  const expiry = Date.now() + 60_000; const calls: string[] = [];
  const controller = new TencentOaController((async (url, options) => {
    calls.push(String(url)); assert.equal(options?.credentials, "same-origin"); assert.equal(options?.cache, "no-store"); assert.equal(options?.redirect, "error");
    return String(url) === "/__opencraft_enterprise_identity/session" ? new Response("", { status: 404 }) : reply(employee(expiry));
  }) as typeof fetch);
  t.after(() => controller.dispose()); await controller.refresh();
  assert.deepEqual(calls, ["/__opencraft_enterprise_identity/session", "/__opencraft_access/session"]);
  assert.equal(controller.getSession().status, "authenticated");
  const identity = controller.getSnapshot().identity!;
  assert.equal(identity.loginName, "employee.fixture"); assert.equal(identity.staffId, "123");
  assert.equal(identityValidUntil(identity), expiry);
  assert.equal(Date.parse(identity.expiresAt), expiry - TENCENTOA_CLOCK_SKEW_MS);
});

test("404 fallback shares the original ten-second request budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  let calls = 0;
  const controller = new TencentOaController((async (_url, options) => {
    calls++;
    if (calls === 1) return new Promise<Response>(resolve => setTimeout(() => resolve(new Response("", { status: 404 })), 4_000));
    return new Promise<Response>((_resolve, reject) => {
      const signal = options?.signal as AbortSignal;
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch);
  t.after(() => controller.dispose());
  const operation = controller.refresh();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(4_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2, "the product route 404 starts the core fallback after four seconds");
  assert.equal(controller.getSnapshot().phase, "loading");
  t.mock.timers.tick(5_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getSnapshot().phase, "loading", "9,999ms is still inside the original budget");
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getSnapshot().phase, "error", "10,000ms must end the shared budget");
  await operation;
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.diagnostic?.endpoint, "/__opencraft_access/session");
  assert.equal(snapshot.diagnostic?.failureKind, "timeout");
  assert.equal(snapshot.diagnostic?.errorName, "TimeoutError");
});

test("fallback diagnostic reports the actual core endpoint", async t => {
  const controller = new TencentOaController((async url => String(url) === "/__opencraft_enterprise_identity/session"
    ? new Response("", { status: 404 })
    : new Response(JSON.stringify({ principal: null, role: null }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch);
  t.after(() => controller.dispose());
  await controller.refresh();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.available, true); assert.equal(snapshot.phase, "ready"); assert.equal(snapshot.identity, null);
  assert.equal(snapshot.diagnostic?.failureKind, "unauthenticated");
  assert.equal(snapshot.diagnostic?.endpoint, "/__opencraft_access/session");
  assert.equal(snapshot.diagnostic?.httpStatus, 401);
  assert.equal(snapshot.diagnostic?.serverDiagnostic, null);
});
test("native denial never tries an alternative identity source", async t => {
  for (const status of [401, 403, 500]) {
    let calls = 0;
    const controller = new TencentOaController((async () => { calls++; return new Response("", { status }); }) as typeof fetch);
    t.after(() => controller.dispose()); await controller.refresh();
    assert.equal(calls, 1); assert.equal(controller.getSession().status, "anonymous");
  }
});

test("core denial, missing endpoint and a revoked membership clear the previous identity", async t => {
  for (const result of [() => new Response("", { status: 401 }), () => new Response("", { status: 403 }),
    () => new Response("", { status: 404 }), () => reply(employee(), null), () => reply(null, null)]) {
    let next = () => reply();
    const controller = new TencentOaController((async url => String(url) === "/__opencraft_enterprise_identity/session" ? new Response("", { status: 404 }) : next()) as typeof fetch);
    t.after(() => controller.dispose()); await controller.refresh(); assert.equal(controller.getSession().status, "authenticated");
    next = result; await controller.refresh(); assert.equal(controller.getSession().status, "anonymous"); assert.equal(controller.getSnapshot().identity, null);
  }
});

test("core projection accepts only the provider's employee attributes, valid subject and current lifetime", async t => {
  for (const [principal, role] of [
    [{ ...employee(), provider: "oidc" }, "member"], [employee(Date.now() - 1), "member"],
    [{ ...employee(), attributes: {} }, "member"], [{ ...employee(), subject: "not-a-staff-id" }, "admin"],
    [{ ...employee(), attributes: { loginName: "<script>" } }, "member"], [employee(), "owner"],
  ] as const) {
    const controller = new TencentOaController((async url => String(url) === "/__opencraft_enterprise_identity/session" ? new Response("", { status: 404 }) : reply(principal, role)) as typeof fetch);
    t.after(() => controller.dispose()); await controller.refresh(); assert.equal(controller.getSession().status, "anonymous");
  }
});

test("a late core response cannot overwrite a newer employee or survive cancellation", async t => {
  const pending: Array<(response: Response) => void> = [];
  const controller = new TencentOaController((async url => String(url) === "/__opencraft_enterprise_identity/session" ? new Response("", { status: 404 }) : new Promise<Response>(resolve => pending.push(resolve))) as typeof fetch);
  t.after(() => controller.dispose());
  const first = controller.refresh(); await new Promise(resolve => setImmediate(resolve));
  const second = controller.refresh(); await new Promise(resolve => setImmediate(resolve));
  pending[1]!(reply({ ...employee(), attributes: { loginName: "new.employee" } })); await second;
  pending[0]!(reply({ ...employee(), attributes: { loginName: "old.employee" } })); await first;
  assert.equal(controller.getSnapshot().identity?.loginName, "new.employee");
  const third = controller.signIn(); await new Promise(resolve => setImmediate(resolve)); await controller.cancelSignIn();
  pending[2]!(reply({ ...employee(), attributes: { loginName: "cancelled.employee" } }));
  assert.deepEqual(await third, { status: "cancelled" }); assert.equal(controller.getSnapshot().identity?.loginName, "new.employee");
  const fourth = controller.refresh(); await new Promise(resolve => setImmediate(resolve)); controller.dispose(); pending[3]!(reply()); await fourth;
  assert.equal(controller.getSession().status, "anonymous"); assert.equal(controller.getSnapshot().identity, null);
});
