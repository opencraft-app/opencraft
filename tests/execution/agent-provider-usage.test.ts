import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentProviderUsageService, codexQuota, cursorQuota } from "../../apps/local-agent-host/src/agent-provider-usage.js";
import type { OnboardingDeps } from "../../apps/local-agent-host/src/agent-onboarding.js";

const codex = { plan_type: "pro", rate_limit: { primary_window: { used_percent: 23, limit_window_seconds: 18000, reset_at: 2000 } } };
const cursor = { planUsage: { totalPercentUsed: 12 }, billingCycleEnd: "2000000", spendLimitUsage: { overallLimit: "10000", overallUsed: "2500", limitType: "team" } };
const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function setup(t: test.TestContext, fetcher: typeof fetch, now = () => 1000) {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-"));
  const credentials = async (account = "account-a", token = "fixture-token") => writeFile(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, account_id: account } }));
  await credentials(); await mkdir(join(home, "cursor")); await writeFile(join(home, "cursor/auth.json"), JSON.stringify({ accessToken: "cursor-fixture-token" }));
  const deps: OnboardingDeps = { homedir: home, env: { CODEX_HOME: home, XDG_CONFIG_HOME: home }, exists: async () => true, cursorVersions: async () => [],
    exec: async () => ({ code: 0, stdout: "cursor-fixture-token", stderr: "" }), spawn: () => { throw new Error("usage must not start an agent"); } };
  const service = new AgentProviderUsageService(deps, fetcher, now);
  t.after(async () => { service.close(); await rm(home, { force: true, recursive: true }); });
  return { service, credentials };
}

test("native quota normalization keeps window units, spend cents and missing values distinct", () => {
  const c = codexQuota(codex, 1000);
  assert.equal(c.windows[0].durationMinutes, 300); assert.equal(c.windows[0].resetsAt, 2000000);
  const u = cursorQuota(cursor, { planInfo: { planName: "Team" } }, 1000);
  assert.equal(u.plan, "Team"); assert.equal(u.windows[1].usedPercent, 25);
  assert.deepEqual(u.windows[1].cost, { usedCents: 2500, limitCents: 10000, currency: "USD" });
  assert.equal(u.windows[1].scope, "team");
  assert.equal(u.windows[0].resetsAt, 2000000);
  assert.deepEqual(cursorQuota({ planUsage: {} }, {}, 1000).windows, []);
  assert.deepEqual(codexQuota({ rate_limit: {} }, 1000).windows, []);
  assert.throws(() => codexQuota({}, 1000)); assert.throws(() => cursorQuota({}, {}, 1000));
});

test("usage reads are single-flight, bounded by TTL, and use native endpoints without returning credentials", async t => {
  const gate = deferred<Response>(); const calls: { url: string; init: RequestInit }[] = [];
  let clock = 1000;
  const f = await setup(t, (async (url, init) => { calls.push({ url: String(url), init: init! }); return calls.length === 1 ? gate.promise : Response.json(codex); }) as typeof fetch, () => clock);
  const a = f.service.read("codex"), b = f.service.read("codex", true);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls.length, 1);
  gate.resolve(Response.json(codex)); const [first, second] = await Promise.all([a, b]); assert.deepEqual(first, second);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal((calls[0].init.headers as Record<string, string>)["ChatGPT-Account-ID"], "account-a");
  assert.equal(calls[0].init.redirect, "error"); assert.ok(calls[0].init.signal);
  assert.ok(!JSON.stringify(first).includes("fixture-token")); assert.ok(!JSON.stringify(first).includes("account-a"));
  clock += 30000; await f.service.read("codex"); assert.equal(calls.length, 1);
  await f.service.read("codex", true); assert.equal(calls.length, 2);
  clock += 60001; await f.service.read("codex"); assert.equal(calls.length, 3);
});

test("Cursor reads both dashboard resources and never starts inference", async t => {
  const calls: string[] = [];
  const f = await setup(t, (async (url, init) => {
    calls.push(String(url)); assert.equal(init?.method, "POST"); assert.equal(init?.body, "{}");
    return Response.json(String(url).endsWith("GetPlanInfo") ? { planInfo: { planName: "Team" } } : cursor);
  }) as typeof fetch);
  const result = await f.service.read("cursor"); assert.equal(result.status, "ok"); assert.equal(result.windows.length, 2);
  assert.deepEqual(calls.sort(), ["GetCurrentPeriodUsage", "GetPlanInfo"].map(method => `https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`).sort());
});

test("transient failure retains same-account data but expiry invalidates the success cache", async t => {
  let mode = "ok", calls = 0;
  const f = await setup(t, (async () => { calls++; if (mode === "throw") throw new Error("offline"); return mode === "expired" ? new Response("", { status: 401 }) : Response.json(codex); }) as typeof fetch);
  const first = await f.service.read("codex"); mode = "throw";
  const cached = await f.service.read("codex", true); assert.equal(cached.status, "unavailable"); assert.deepEqual(cached.windows, first.windows); assert.equal(cached.observedAt, first.observedAt);
  mode = "expired"; assert.equal((await f.service.read("codex", true)).status, "expired");
  assert.equal((await f.service.read("codex")).status, "expired"); assert.equal(calls, 4);
});

test("account changes suppress late successful and failed responses; close aborts in-flight reads", async t => {
  let gate = deferred<Response>(), started = deferred<void>();
  const f = await setup(t, (async (_url, init) => { started.resolve(); init?.signal?.addEventListener("abort", () => gate.reject(new Error("closed")), { once: true }); return gate.promise; }) as typeof fetch);
  const first = f.service.read("codex"); await started.promise; await f.credentials("account-b"); gate.resolve(Response.json(codex));
  assert.equal((await first).windows.length, 0);
  gate = deferred<Response>(); started = deferred<void>(); const second = f.service.read("codex"); await started.promise;
  gate.resolve(Response.json(codex)); await second;
  gate = deferred<Response>(); started = deferred<void>(); const failed = f.service.read("codex", true); await started.promise; await f.credentials("account-c"); gate.reject(new Error("offline"));
  assert.equal((await failed).windows.length, 0, "a failed response cannot restore the previous account's cached quota");
  gate = deferred<Response>(); started = deferred<void>(); const pending = f.service.read("codex"); await started.promise; f.service.close();
  assert.equal((await pending).windows.length, 0); assert.equal((await f.service.read("codex")).status, "unavailable");
});
