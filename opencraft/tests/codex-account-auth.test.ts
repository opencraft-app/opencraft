import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AccountPoolStore,
  CodexDeviceLoginService,
  createManagedCodexRefresh,
  type CodexMaintenanceClient,
} from "../packages/account-pool-host/src/index.js";

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

class FakeMaintenanceClient implements CodexMaintenanceClient {
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  requests: Array<{ method: string; params: unknown }> = [];
  closed = false;
  constructor(private readonly respond: (method: string, params: unknown) => Promise<unknown>) {}
  request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    return this.respond(method, params) as Promise<T>;
  }
  subscribeNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  emit(method: string, params: unknown): void { for (const listener of this.listeners) listener(method, params); }
  async close(): Promise<void> { this.closed = true; this.listeners.clear(); }
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
