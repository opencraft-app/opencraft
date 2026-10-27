import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

// The authorization-expiry tests mock timers. Keep this test-only deadlock
// deadline on the real clock; successful closure resolves without a delay.
const scheduleCloseDeadline = globalThis.setTimeout;
const cancelCloseDeadline = globalThis.clearTimeout;

import {
  AccountPoolStore,
  CodexDeviceLoginService,
  createManagedCodexRefresh,
  type CodexMaintenanceClient,
} from "../../packages/account-pool-host/src/index.js";

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

class FakeMaintenanceClient implements CodexMaintenanceClient {
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  requests: Array<{ method: string; params: unknown }> = [];
  closed = false;
  private resolveClosed!: () => void;
  readonly whenClosed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
  constructor(private readonly respond: (method: string, params: unknown) => Promise<unknown>) {}
  request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    return this.respond(method, params) as Promise<T>;
  }
  subscribeNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  emit(method: string, params: unknown): void { for (const listener of this.listeners) listener(method, params); }
  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    this.resolveClosed();
  }
}

test("completed Codex device login imports one account without returning tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-auth-"));
  try {
    const store = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    let profile = "";
    const client = new FakeMaintenanceClient(async method => {
      if (method === "account/login/start") return { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.test/codex/device", userCode: "ABCD-1234" };
      throw new Error(`Unexpected ${method}`);
    });
    const service = new CodexDeviceLoginService({
      store,
      loginRoot: join(root, "login"),
      createClient: async codexHome => { profile = codexHome; return client; },
    });
    const started = await service.start();
    assert.equal(started.userCode, "ABCD-1234");
    assert.equal((await service.poll(started.sessionId)).status, "pending");
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const idToken = jwt({
      email: "user@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "chatgpt-account-a" },
    });
    await writeFile(join(profile, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { access_token: jwt({ exp: 20_000 }), refresh_token: "refresh-a", id_token: idToken, account_id: "chatgpt-account-a" },
      last_refresh: new Date().toISOString(),
    }), { mode: 0o600 });
    client.emit("account/login/completed", { loginId: "login-1", success: true, error: null });
    const completed = await service.poll(started.sessionId);
    assert.equal(completed.status, "complete");
    assert.doesNotMatch(JSON.stringify(completed), /refresh-a|access_token/);
    assert.equal(store.listAccounts()[0]?.label, "user@example.com");
    assert.equal(store.listAccountStates()[0]?.email, "user@example.com");
    assert.equal(client.closed, true);
    await service.dispose();
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed Codex refresh round-trips one account through an isolated auth profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-refresh-"));
  try {
    const refreshedIdToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "chatgpt-account-a" } });
    const refresh = createManagedCodexRefresh({
      refreshRoot: join(root, "refresh"),
      createClient: async codexHome => new FakeMaintenanceClient(async (method, params) => {
        assert.equal(method, "account/read");
        assert.deepEqual(params, { refreshToken: true });
        await writeFile(join(codexHome, "auth.json"), JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: { access_token: jwt({ exp: 30_000 }), refresh_token: "refresh-new", id_token: refreshedIdToken, account_id: "chatgpt-account-a" },
          last_refresh: new Date().toISOString(),
        }), { mode: 0o600 });
        return { account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true };
      }),
    });
    const result = await refresh(
      { id: "account-a", provider: "codex", label: "A", upstreamAccountId: "chatgpt-account-a", priority: 1, enabled: true, createdAt: 1 },
      { accessToken: jwt({ exp: 10_000 }), refreshToken: "refresh-old", idToken: refreshedIdToken, expiresAt: 10_000 },
      "expired",
    );
    assert.equal(result.refreshToken, "refresh-new");
    assert.equal(result.expiresAt, 30_000_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing native Codex login imports explicitly without modifying its auth file", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-codex-import-"));
  const nativeHome = join(root, "native-codex");
  try {
    const store = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    const accessToken = jwt({ exp: 20_000, email: "native@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "chatgpt-native" } });
    await mkdir(nativeHome, { recursive: true, mode: 0o700 });
    const original = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: accessToken, refresh_token: "refresh-native", account_id: "chatgpt-native" },
    });
    await writeFile(join(nativeHome, "auth.json"), original, { mode: 0o600 });
    const service = new CodexDeviceLoginService({
      store,
      loginRoot: join(root, "login"),
      createClient: async () => { throw new Error("import must not start a maintenance AppServer"); },
    });
    const imported = await service.importFrom(nativeHome);
    assert.equal(imported.label, "native@example.com");
    assert.equal(store.listAccountStates()[0]?.email, "native@example.com");
    assert.equal(await readFile(join(nativeHome, "auth.json"), "utf8"), original);
    assert.doesNotMatch(JSON.stringify(imported), /refresh-native|accessToken/);
    await service.dispose();
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function deviceLoginFixture(t: TestContext, options: { early?: boolean; now?: () => number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "opencraft-device-background-"));
  const store = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  let profile = "";
  let imported = 0;
  const writeCredential = () => writeFile(join(profile, "auth.json"), JSON.stringify({ tokens: {
    access_token: jwt({ exp: 20_000 }), refresh_token: "synthetic-refresh",
    account_id: "background-account", id_token: jwt({ email: "mobile@example.test" }),
  } }), { mode: 0o600 });
  const complete = () => client.emit("account/login/completed", { loginId: "background-login", success: true });
  const client = new FakeMaintenanceClient(async method => {
    if (method === "account/login/start") {
      if (options.early) { await writeCredential(); complete(); }
      return { type: "chatgptDeviceCode", loginId: "background-login", verificationUrl: "https://auth.openai.test/codex/device", userCode: "TEST-1234" };
    }
    if (method === "account/login/cancel") { complete(); return { status: "cancelled" }; }
    throw new Error(`Unexpected ${method}`);
  });
  const service = new CodexDeviceLoginService({ store, loginRoot: join(root, "login"),
    createClient: async home => { profile = home; return client; }, now: options.now,
    onAccountImported: () => { imported++; },
  });
  t.after(async () => { await service.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, service, client, writeCredential, complete, imported: () => imported };
}

async function untilClosed(client: FakeMaintenanceClient) {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.whenClosed,
      new Promise<never>((_, reject) => {
        deadline = scheduleCloseDeadline(() => reject(new Error("native maintenance worker did not close")), 5_000);
      }),
    ]);
  } finally {
    if (deadline !== undefined) cancelCloseDeadline(deadline);
  }
  assert.equal(client.closed, true, "native maintenance worker must close without browser polling");
}

test("authorization persists without browser polls; duplicate completion and late polls are idempotent", async t => {
  let now = 1_000;
  const f = await deviceLoginFixture(t, { now: () => now });
  const started = await f.service.start();
  await f.writeCredential();
  f.complete(); f.complete();
  await untilClosed(f.client);
  assert.equal(f.store.listAccounts().length, 1);
  assert.equal(f.imported(), 1);
  now += 11 * 60_000; // The original page returns after its former local deadline.
  const results = await Promise.all(Array.from({ length: 8 }, () => f.service.poll(started.sessionId)));
  assert.ok(results.every(result => result.status === "complete"));
  assert.equal(f.imported(), 1);
  assert.equal(f.store.listAccounts().length, 1);
  await f.service.dispose();
  await assert.rejects(readFile(join(f.root, "login", started.sessionId, "auth.json")), { code: "ENOENT" });
});

test("completion arriving before the start reply still imports without a poll", async t => {
  const f = await deviceLoginFixture(t, { early: true });
  const started = await f.service.start();
  await untilClosed(f.client);
  assert.equal(f.store.listAccounts().length, 1);
  assert.equal((await f.service.poll(started.sessionId)).status, "complete");
});

test("cancel wins before completion, including synchronous native cancel notifications", async t => {
  const f = await deviceLoginFixture(t);
  const started = await f.service.start();
  await f.writeCredential();
  assert.equal(await f.service.cancel(started.sessionId), true);
  f.complete();
  assert.equal(f.store.listAccounts().length, 0);
  assert.deepEqual(await f.service.poll(started.sessionId), { status: "error", message: "Login cancelled." });
});

test("received completion wins over cancel and dispose waits for its durable import", async t => {
  const f = await deviceLoginFixture(t);
  const started = await f.service.start();
  await f.writeCredential();
  f.complete();
  const [cancelled] = await Promise.all([f.service.cancel(started.sessionId), f.service.dispose()]);
  assert.equal(cancelled, false);
  assert.equal(f.store.listAccounts().length, 1);
  assert.equal(f.client.closed, true);
  await assert.rejects(f.service.start(), /closing/);
});

test("an abandoned pending login expires and cleans itself without client polling", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await deviceLoginFixture(t);
  const started = await f.service.start();
  t.mock.timers.tick(10 * 60_000);
  await untilClosed(f.client);
  assert.equal(f.store.listAccounts().length, 0);
  assert.deepEqual(await f.service.poll(started.sessionId), { status: "error", message: "Code expired, start again." });
});

test("invalid completed credentials produce a stable error and release the worker", async t => {
  const f = await deviceLoginFixture(t);
  const started = await f.service.start();
  f.complete();
  await untilClosed(f.client);
  const result = await f.service.poll(started.sessionId);
  assert.equal(result.status, "error");
  assert.deepEqual(await f.service.poll(started.sessionId), result);
  assert.equal(f.store.listAccounts().length, 0);
});


async function legacyProfileFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "opencraft-legacy-device-"));
  const store = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  const loginRoot = join(root, "login");
  const profile = join(loginRoot, "completed-before-restart");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const auth = JSON.stringify({ tokens: { access_token: jwt({ exp: 20_000 }), refresh_token: "synthetic-legacy-refresh",
    account_id: "legacy-account", id_token: jwt({ email: "legacy@example.test" }) } });
  await writeFile(join(profile, "auth.json"), auth, { mode: 0o600 });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const create = () => new CodexDeviceLoginService({ store, loginRoot,
    createClient: async () => { throw new Error("Recovery must not restart authorization"); } });
  return { root, store, loginRoot, profile, auth, create };
}

test("startup recovers completed authorization before cleaning old isolated profiles", async t => {
  const f = await legacyProfileFixture(t);
  // Repeated snapshots and an unfinished flow cannot create duplicate accounts.
  await mkdir(join(f.loginRoot, "duplicate"));
  await writeFile(join(f.loginRoot, "duplicate", "auth.json"), f.auth);
  await mkdir(join(f.loginRoot, "unfinished"));
  const service = f.create();
  await service.ready();
  assert.equal(f.store.listAccounts().length, 1);
  assert.equal(f.store.listAccountStates()[0]?.email, "legacy@example.test");
  assert.doesNotMatch(JSON.stringify(f.store.listAccounts()), /synthetic-legacy-refresh/);
  assert.deepEqual(await readdir(f.loginRoot), []);
  await service.dispose();
});

test("a failed recovery commit preserves completed authorization for a later retry", async t => {
  const f = await legacyProfileFixture(t);
  const original = f.store.addAccount;
  f.store.addAccount = () => { throw new Error("Synthetic storage unavailable"); };
  const failed = f.create();
  await assert.rejects(failed.ready(), /storage unavailable/);
  assert.equal(await readFile(join(f.profile, "auth.json"), "utf8"), f.auth);
  await failed.dispose();
  f.store.addAccount = original;
  const retry = f.create();
  await retry.ready();
  assert.equal(f.store.listAccounts().length, 1);
  await retry.dispose();
});

test("a malformed or incomplete legacy auth file never creates a usable account", async t => {
  const f = await legacyProfileFixture(t);
  await writeFile(join(f.profile, "auth.json"), JSON.stringify({ tokens: { access_token: "incomplete" } }));
  const service = f.create();
  await service.ready();
  assert.equal(f.store.listAccounts().length, 0);
  await service.dispose();
});


test("legacy recovery preserves an account's newer configured credential and enablement", async t => {
  const f = await legacyProfileFixture(t);
  f.store.addAccount({ id: "current", provider: "codex", label: "Current", upstreamAccountId: "legacy-account", priority: 1, enabled: false },
    { accessToken: "synthetic-current-access", refreshToken: "synthetic-current-refresh", expiresAt: null });
  const service = f.create();
  await service.ready();
  assert.equal(f.store.readCredential("current").refreshToken, "synthetic-current-refresh");
  assert.equal(f.store.listAccounts()[0]?.enabled, false);
  assert.equal(f.store.listAccounts()[0]?.label, "Current");
  await service.dispose();
});

test("duplicate legacy profiles recover the latest authorization for a missing account", async t => {
  const f = await legacyProfileFixture(t);
  await utimes(join(f.profile, "auth.json"), new Date(1_000), new Date(1_000));
  const newer = join(f.loginRoot, "newer"); await mkdir(newer);
  await writeFile(join(newer, "auth.json"), f.auth.replace("synthetic-legacy-refresh", "synthetic-newest-refresh"));
  await utimes(join(newer, "auth.json"), new Date(2_000), new Date(2_000));
  const service = f.create(); await service.ready();
  assert.equal(f.store.listAccounts().length, 1);
  assert.equal(f.store.readCredential(f.store.listAccounts()[0]!.id).refreshToken, "synthetic-newest-refresh");
  await service.dispose();
});
