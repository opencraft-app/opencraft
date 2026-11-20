import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, createServer } from "node:http";
import { AccountPoolStore, AccountCredentialRefreshManager, CodexSubscriptionService, CodexCoreControlClient,
  CodexAccountOperationError, accountFailure, classifyAccountFailure, logAccountFailure, parseAccountFailure } from "../../packages/account-pool-host/src/index.js";
import { startSplitCodexCore } from "../../apps/codex-core/src/split-core.js";
import { accountFailureFromRpc, accountFeedbackStatus, refreshFailureResolved } from "../../plugins/builtin-agents/src/codex-accounts/diagnostics.js";
import type { CodexAccountView } from "../../packages/appserver-protocol/src/codex-accounts.js";

async function pool() {
  const root = await mkdtemp(join(tmpdir(), "account-diagnostics-"));
  const store = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  store.addAccount({ id: "a", provider: "codex", upstreamAccountId: "upstream-a", label: "Synthetic", priority: 0, enabled: true, createdAt: 1 },
    { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() - 1_000 });
  return { root, store, account: store.getAccount("a"), async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("expired or rejected unchanged renewal never clears authorization failure", async () => {
  for (const reason of ["expired", "unauthorized"] as const) {
    const f = await pool();
    try {
      const secret = f.store.readCredential("a");
      if (reason === "unauthorized") { secret.expiresAt = Date.now() + 3_600_000; f.store.replaceCredential("a", secret); }
      f.store.markAccountError("a", "authorization-rejected");
      const refresh = new AccountCredentialRefreshManager({ store: f.store, refresh: async () => secret });
      await assert.rejects(refresh.resolve(f.account, secret, reason), (e: unknown) => e instanceof CodexAccountOperationError && e.diagnostic.code === "renewal-incomplete");
      assert.equal(f.store.listAccountStates()[0]!.status, "error");
      assert.equal(f.store.readCredential("a").accessToken, secret.accessToken);
      assert.equal(f.store.accountMaintenance("a")?.failure?.code, "renewal-incomplete");
    } finally { await f.close(); }
  }
});

test("a fresh local credential waits for provider acceptance before showing recovery", async () => {
  const f = await pool();
  try {
    f.store.markAccountError("a", "authorization-rejected");
    const old = f.store.readCredential("a"), fresh = { ...old, accessToken: "synthetic-fresh", expiresAt: Date.now() + 3_600_000 };
    const refresh = new AccountCredentialRefreshManager({ store: f.store, refresh: async () => fresh });
    await refresh.resolve(f.account, old, "expired");
    assert.equal(f.store.listAccountStates()[0]!.status, "error");
    assert.equal(f.store.accountMaintenance("a")?.state, "unverified");
    const usage = new CodexSubscriptionService({ store: f.store, resolveCredential: (a, s, r) => refresh.resolve(a, s, r),
      fetch: async () => Response.json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 48, reset_after_seconds: 300, limit_window_seconds: 604800 } } }) });
    await usage.refreshAccount("a");
    assert.equal(f.store.listAccountStates()[0]!.status, "ready");
    assert.equal(f.store.accountMaintenance("a")?.state, "ok");
    assert.ok(f.store.accountMaintenance("a")!.lastSuccessAt);
  } finally { await f.close(); }
});

test("late renewal cannot overwrite a newer explicit credential", async () => {
  const f = await pool();
  try {
    const old = f.store.readCredential("a"); let complete!: (v: typeof old) => void;
    const refresh = new AccountCredentialRefreshManager({ store: f.store, refresh: () => new Promise(r => { complete = r; }) });
    const result = refresh.resolve(f.account, old, "expired");
    const newer = { ...old, accessToken: "synthetic-login-newer", expiresAt: Date.now() + 3_600_000 };
    f.store.replaceCredential("a", newer);
    complete({ ...newer, accessToken: "synthetic-late-old-flight" });
    assert.equal((await result).accessToken, newer.accessToken);
    assert.equal(f.store.readCredential("a").accessToken, newer.accessToken);
  } finally { await f.close(); }
});

test("background usage failure keeps auth/quota facts and emits bounded private-safe diagnostics", async t => {
  const f = await pool(), logs: string[] = [];
  t.mock.method(console, "warn", (...values: unknown[]) => logs.push(values.map(String).join(" ")));
  try {
    f.store.replaceCredential("a", { accessToken: "synthetic-access", refreshToken: null, expiresAt: null });
    f.store.observeQuota("a", { utilization: 0.48, resetAt: null });
    const before = f.store.listAccountStates()[0];
    const usage = new CodexSubscriptionService({ store: f.store, resolveCredential: async (_, s) => s,
      fetch: async () => { throw new TypeError("Bearer synthetic-secret /private/auth.json person@example.test", { cause: { code: "CERT_HAS_EXPIRED" } }); } });
    await usage.refreshAll();
    assert.equal(f.store.listAccountStates()[0]!.status, "ready");
    assert.deepEqual(f.store.listAccountStates()[0], before);
    assert.equal(f.store.accountMaintenance("a")?.failure?.reason, "tls");
    assert.equal(accountFeedbackStatus({ enabled: true, status: "ready", maintenance: f.store.accountMaintenance("a") } as CodexAccountView), "held");
    assert.ok(logs.join().includes('"stage":"usage"'));
    assert.ok(logs.join().includes('"reason":"tls"'));
    assert.doesNotMatch(logs.join(), /synthetic-secret|private\/auth|person@example|Bearer/);
  } finally { await f.close(); }
});

test("provider rejection, throttling, malformed JSON and timeout keep different safe classifications", async () => {
  for (const [status, code, retryable] of [[401, "authorization-rejected", false], [403, "authorization-rejected", false], [429, "upstream-unavailable", true], [503, "upstream-unavailable", true]] as const) {
    const f = await pool();
    try {
      const usage = new CodexSubscriptionService({ store: f.store, resolveCredential: async (_, s) => s, fetch: async () => new Response("secret provider body", { status }) });
      await assert.rejects(usage.refreshAccount("a"), (e: unknown) => e instanceof CodexAccountOperationError && e.diagnostic.code === code && e.diagnostic.retryable === retryable && e.diagnostic.httpStatus === status);
      assert.doesNotMatch(JSON.stringify(f.store.accountMaintenance("a")), /secret provider body/);
    } finally { await f.close(); }
  }
  const f = await pool();
  try {
    const usage = new CodexSubscriptionService({ store: f.store, resolveCredential: async (_, s) => s, fetch: async () => new Response("<html>private upstream</html>") });
    await assert.rejects(usage.refreshAccount("a"));
    assert.equal(f.store.accountMaintenance("a")?.failure?.reason, "invalid-response");
    assert.equal(classifyAccountFailure(new DOMException("secret", "TimeoutError"), "renewal").diagnostic.code, "request-timeout");
  } finally { await f.close(); }
});

test("diagnostic transport and logs project safe fields only", t => {
  const logs: unknown[][] = []; t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  const failure = accountFailure("service-unavailable", "operation", true).diagnostic;
  const projection = parseAccountFailure({ ...failure, secret: "never-copy-this", message: "raw private path" });
  assert.deepEqual(projection, failure);
  assert.equal(parseAccountFailure({ ...failure, diagnosticId: "Bearer-secret" }), null);
  assert.equal(parseAccountFailure({ ...failure, reason: "secret arbitrary reason" }), null);
  logAccountFailure(new CodexAccountOperationError(failure), { operation: "opencraft/codex/accounts/Bearer-secret", accountId: "person@example.test" });
  assert.doesNotMatch(JSON.stringify(logs), /Bearer-secret|person@example/);
  assert.deepEqual(accountFailureFromRpc({ data: { codexAccountFailure: { ...failure, secret: "never-copy-this" } } }), failure);
});

test("only a newer confirmed refresh clears refresh feedback; mutations remain visible", () => {
  const failure = accountFailure("request-timeout", "usage", true).diagnostic;
  const account = { enabled: true, status: "ready", maintenance: { state: "ok", checkedAt: failure.occurredAt + 1, lastSuccessAt: failure.occurredAt + 1 } } as CodexAccountView;
  const error = { action: "refresh", failure, baselineSuccessAt: failure.occurredAt - 1, adminRequired: false };
  assert.equal(refreshFailureResolved(error, account), true);
  assert.equal(refreshFailureResolved({ ...error, action: "remove" }, account), false);
  assert.equal(refreshFailureResolved({ ...error, adminRequired: true }, account), false);
  assert.equal(refreshFailureResolved(error, { ...account, maintenance: undefined }), false);
  assert.equal(refreshFailureResolved(error, { ...account, maintenance: { state: "ok", checkedAt: 1, lastSuccessAt: 1 } }), false);
  assert.equal(accountFeedbackStatus({ ...account, maintenance: { state: "checking", checkedAt: 1, lastSuccessAt: 1 } }), "held");
});

test("real split Core distinguishes service failure, invalid input and a fenced owner without leaking causes or replaying", async t => {
  const root = await mkdtemp(join(tmpdir(), "account-core-diagnostic-"));
  const data = join(root, "data"), endpoint = join(root, "core.sock"), token = "synthetic-control-token";
  const store = new AccountPoolStore({ databasePath: join(data, "account-pool.sqlite"), secretsDirectory: join(data, "secrets") });
  store.addAccount({ id: "a", provider: "codex", label: "Synthetic", upstreamAccountId: "upstream-a", enabled: true, priority: 0, createdAt: 1 }, { accessToken: "synthetic", refreshToken: null, expiresAt: null }); store.close();
  const reserve = createServer(); await new Promise<void>(r => reserve.listen(0, "127.0.0.1", r)); const port = (reserve.address() as { port: number }).port; await new Promise<void>(r => reserve.close(() => r()));
  let calls = 0; const logs: string[] = []; t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args.map(String).join(" ")));
  const core = await startSplitCodexCore({ dataDirectory: data, endpoint, appServerEndpoint: join(root, "unused.sock"), authToken: token, executable: process.execPath,
    proxyPort: port, runtimeDirectory: root, nativeCodexHomeDirectory: join(root, "native"), fetch: async () => { calls++; return new Response("private-provider-body", { status: 503 }); } } as any);
  const rpc = (method: string, path: string, body?: unknown) => new Promise<{ status: number; value: any }>((resolve, reject) => {
    const q = request({ socketPath: endpoint, method, path, headers: { authorization: `Bearer ${token}` } }, res => {
      let raw = ""; res.on("data", b => raw += b); res.on("end", () => resolve({ status: res.statusCode!, value: JSON.parse(raw) }));
    }); q.on("error", reject); q.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    const client = new CodexCoreControlClient(endpoint, token), before = calls;
    await assert.rejects(client.accountRequest("opencraft/codex/accounts/refresh", { accountId: "a" }), (e: unknown) => e instanceof CodexAccountOperationError && e.diagnostic.code === "upstream-unavailable" && e.diagnostic.httpStatus === 503);
    assert.equal(calls - before, 1, "the control client does not replay the operation");
    const bad = await rpc("POST", "/accounts", { method: "bad", params: {} }); assert.equal(bad.status, 400); assert.equal(bad.value.diagnostic.code, "invalid-request");
    const unsupported = await rpc("POST", "/accounts", { method: "opencraft/codex/accounts/unknown", params: {} }); assert.equal(unsupported.value.diagnostic.code, "invalid-request");
    const state = (await rpc("GET", "/owner-handoff")).value.handoff;
    const stat = (await readFile(`/proc/${process.pid}/stat`, "utf8")).split(") ").at(-1)!.split(" ");
    const operatorLease = { version: 1, id: "diagnostic-test", ttlMs: 30000,
      controller: { pid: process.pid, startTime: stat[19], bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() } };
    const fence = await rpc("POST", "/owner-handoff", { action: "fence", operatorLease, expectedOwner: state.owner, expectedEpoch: state.epoch, operationId: "test", fence: "test-fence" }); assert.equal(fence.status, 200);
    const fenced = await rpc("POST", "/accounts", { method: "opencraft/codex/accounts/list", params: {} }); assert.equal(fenced.status, 503); assert.equal(fenced.value.diagnostic.code, "admission-fenced");
    assert.doesNotMatch(logs.join(), /private-provider-body|synthetic-control-token|Invalid or fenced/);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});
