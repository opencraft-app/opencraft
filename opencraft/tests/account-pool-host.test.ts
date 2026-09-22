import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AccountPoolStore,
  CodexSubscriptionService,
  CodexCredentialRefreshManager,
  CodexAccountPoolProxy,
  createCodexAccountPoolLaunch,
  startCodexAccountPoolServer,
} from "../packages/account-pool-host/src/index.js";

test("Codex thread affinity survives AccountPool restart while its account remains eligible", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  const databasePath = join(root, "pool.sqlite");
  const secretsDirectory = join(root, "secrets");
  try {
    const first = new AccountPoolStore({ databasePath, secretsDirectory });
    first.addAccount({
      id: "account-a",
      provider: "codex",
      label: "A",
      upstreamAccountId: "chatgpt-a",
      priority: 1,
      enabled: true,
    }, { accessToken: "access-a", refreshToken: "refresh-a", expiresAt: null });
    first.addAccount({
      id: "account-b",
      provider: "codex",
      label: "B",
      upstreamAccountId: "chatgpt-b",
      priority: 2,
      enabled: true,
    }, { accessToken: "access-b", refreshToken: "refresh-b", expiresAt: null });

    const selected = first.select({ provider: "codex", hostId: "local", affinityId: "thread-1" });
    assert.equal(selected.account.id, "account-a");
    selected.accept();
    first.close();

    const restored = new AccountPoolStore({ databasePath, secretsDirectory });
    assert.equal(restored.select({ provider: "codex", hostId: "local", affinityId: "thread-1" }).account.id, "account-a");
    restored.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exhausted pinned account advances the same thread to the next eligible account", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  try {
    const pool = new AccountPoolStore({
      databasePath: join(root, "pool.sqlite"),
      secretsDirectory: join(root, "secrets"),
    });
    for (const [id, priority] of [["account-a", 1], ["account-b", 2]] as const) {
      pool.addAccount({
        id,
        provider: "codex",
        label: id,
        upstreamAccountId: `chatgpt-${id}`,
        priority,
        enabled: true,
      }, { accessToken: `access-${id}`, refreshToken: null, expiresAt: null });
    }
    const first = pool.select({ provider: "codex", hostId: "local", affinityId: "thread-1" });
    first.accept();
    pool.observeQuota("account-a", { utilization: 1, resetAt: Date.now() + 60_000 });
    const fallback = pool.select({ provider: "codex", hostId: "local", affinityId: "thread-1" });
    assert.equal(fallback.account.id, "account-b");
    fallback.accept();
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "thread-1" }).account.id, "account-b");
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex account cursor advances after the current account and does not jump back to recovered priority", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  let now = 1_000_000;
  try {
    const pool = new AccountPoolStore({
      databasePath: join(root, "pool.sqlite"),
      secretsDirectory: join(root, "secrets"),
      now: () => now,
    });
    for (const [id, priority] of [["account-a", 1], ["account-b", 2], ["account-c", 3]] as const) {
      pool.addAccount({ id, provider: "codex", label: id, upstreamAccountId: `chatgpt-${id}`, priority, enabled: true },
        { accessToken: `access-${id}`, refreshToken: null, expiresAt: null });
    }

    const first = pool.select({ provider: "codex", hostId: "local", affinityId: "thread-a" });
    assert.equal(first.account.id, "account-a");
    first.accept();
    pool.observeQuota("account-a", { utilization: 1, resetAt: now + 60_000 });
    const second = pool.select({ provider: "codex", hostId: "local", affinityId: "thread-b" });
    assert.equal(second.account.id, "account-b");
    second.accept();

    now += 60_001;
    pool.observeQuota("account-b", { utilization: 1, resetAt: now + 60_000 });
    const third = pool.select({ provider: "codex", hostId: "local", affinityId: "thread-c" });
    assert.equal(third.account.id, "account-c", "the provider cursor must advance after B instead of jumping back to recovered A");
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex thread affinity expires after the configured idle TTL", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  let now = 1_000;
  try {
    const pool = new AccountPoolStore({
      databasePath: join(root, "pool.sqlite"),
      secretsDirectory: join(root, "secrets"),
      now: () => now,
      affinityIdleTtlMs: 100,
    });
    for (const [id, priority] of [["account-a", 1], ["account-b", 2]] as const) {
      pool.addAccount({ id, provider: "codex", label: id, upstreamAccountId: `chatgpt-${id}`, priority, enabled: true },
        { accessToken: `access-${id}`, refreshToken: null, expiresAt: null });
    }
    const pinned = pool.select({ provider: "codex", hostId: "local", affinityId: "thread-pinned" });
    pinned.accept();
    pool.observeQuota("account-a", { utilization: 1, resetAt: now + 50 });
    const fallback = pool.select({ provider: "codex", hostId: "local", affinityId: "thread-fallback" });
    assert.equal(fallback.account.id, "account-b");
    fallback.accept();

    now += 51;
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "thread-pinned" }).account.id, "account-a");
    now += 50;
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "thread-pinned" }).account.id, "account-b");
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex thread affinity retains only the configured most-recent bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  let now = 1_000;
  try {
    const pool = new AccountPoolStore({
      databasePath: join(root, "pool.sqlite"),
      secretsDirectory: join(root, "secrets"),
      now: () => now,
      maxAffinityBindings: 2,
    });
    for (const [id, priority] of [["account-a", 1], ["account-b", 2]] as const) {
      pool.addAccount({ id, provider: "codex", label: id, upstreamAccountId: `chatgpt-${id}`, priority, enabled: true },
        { accessToken: `access-${id}`, refreshToken: null, expiresAt: null });
    }
    const oldest = pool.select({ provider: "codex", hostId: "local", affinityId: "thread-oldest" });
    oldest.accept();
    pool.observeQuota("account-a", { utilization: 1, resetAt: now + 10 });
    const fallback = pool.select({ provider: "codex", hostId: "local", affinityId: "thread-second" });
    fallback.accept();
    now += 11;
    const newest = pool.select({ provider: "codex", hostId: "local", affinityId: "thread-newest" });
    newest.accept();

    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "thread-oldest" }).account.id, "account-b");
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex launch exposes only the virtual provider route and Host token", () => {
  const launch = createCodexAccountPoolLaunch({
    baseUrl: "http://127.0.0.1:43123",
    hostToken: "host-scoped-token",
  });
  assert.equal(launch.env.OPENCRAFT_CODEX_POOL_AUTH_TOKEN, "host-scoped-token");
  assert.ok(launch.args.includes('model_provider="opencraft-account-pool"'));
  assert.ok(launch.args.some(value => value.includes("http://127.0.0.1:43123/v1")));
  assert.doesNotMatch(JSON.stringify(launch.args), /host-scoped-token|account-a|access-a/);
});

test("Codex proxy authenticates the Host and injects only the selected account credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  try {
    const pool = new AccountPoolStore({
      databasePath: join(root, "pool.sqlite"),
      secretsDirectory: join(root, "secrets"),
    });
    pool.addAccount({
      id: "account-a",
      provider: "codex",
      label: "A",
      upstreamAccountId: "chatgpt-a",
      priority: 1,
      enabled: true,
    }, { accessToken: "access-a", refreshToken: null, expiresAt: null });
    const hostToken = pool.issueHostToken("local");
    const upstream: Array<{ url: string; authorization: string | null; accountId: string | null; leaked: string | null }> = [];
    const proxy = new CodexAccountPoolProxy({
      store: pool,
      upstreamBaseUrl: "https://chatgpt.example.test/backend-api/codex",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        upstream.push({
          url: String(input),
          authorization: headers.get("authorization"),
          accountId: headers.get("chatgpt-account-id"),
          leaked: headers.get("x-untrusted-secret"),
        });
        return Response.json({ ok: true }, { headers: { "x-codex-primary-used-percent": "10" } });
      },
    });
    const request = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "thread-id": "thread-1",
        "x-opencraft-account-pool-token": hostToken,
        authorization: "Bearer must-not-pass-through",
        "x-untrusted-secret": "must-not-pass-through",
      },
      body: JSON.stringify({ model: "gpt-test", input: [] }),
    });
    const response = await proxy.handle(request);
    assert.equal(response.status, 200);
    assert.deepEqual(upstream, [{
      url: "https://chatgpt.example.test/backend-api/codex/v1/responses",
      authorization: "Bearer access-a",
      accountId: "chatgpt-a",
      leaked: null,
    }]);
    assert.equal((await proxy.handle(new Request("http://127.0.0.1/v1/models", {
      headers: { "x-opencraft-account-pool-token": "wrong" },
    }))).status, 401);
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a short hold preserves pinned thread affinity while a new thread can advance", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  let now = 1_000_000;
  try {
    const pool = new AccountPoolStore({
      databasePath: join(root, "pool.sqlite"),
      secretsDirectory: join(root, "secrets"),
      now: () => now,
    });
    for (const [id, priority] of [["account-a", 1], ["account-b", 2]] as const) {
      pool.addAccount({ id, provider: "codex", label: id, upstreamAccountId: `chatgpt-${id}`, priority, enabled: true },
        { accessToken: `access-${id}`, refreshToken: null, expiresAt: null });
    }
    const pinned = pool.select({ provider: "codex", hostId: "local", affinityId: "thread-pinned" });
    pinned.accept();
    pool.observeQuota("account-a", { utilization: 0.1, resetAt: null, heldUntil: now + 60_000 });
    const token = pool.issueHostToken("local");
    const used: string[] = [];
    const proxy = new CodexAccountPoolProxy({
      store: pool,
      upstreamBaseUrl: "https://chatgpt.example.test/backend-api/codex",
      fetch: async (_input, init) => {
        used.push(new Headers(init?.headers).get("chatgpt-account-id") ?? "");
        return Response.json({ ok: true });
      },
    });
    const send = (threadId: string) => proxy.handle(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": threadId, "x-opencraft-account-pool-token": token },
      body: JSON.stringify({ model: "gpt-test", input: [] }),
    }));
    const held = await send("thread-pinned");
    assert.equal(held.status, 429);
    assert.equal(held.headers.get("retry-after"), "60");
    assert.deepEqual(used, []);
    assert.equal((await send("thread-new")).status, 200);
    assert.deepEqual(used, ["chatgpt-account-b"]);
    now += 60_001;
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "thread-pinned" }).account.id, "account-a");
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pre-success quota rejection advances to the next account and pins it", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  try {
    const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    for (const [id, priority] of [["account-a", 1], ["account-b", 2]] as const) {
      pool.addAccount({ id, provider: "codex", label: id, upstreamAccountId: `chatgpt-${id}`, priority, enabled: true },
        { accessToken: `access-${id}`, refreshToken: null, expiresAt: null });
    }
    const token = pool.issueHostToken("local");
    const attempts: string[] = [];
    const proxy = new CodexAccountPoolProxy({
      store: pool,
      upstreamBaseUrl: "https://chatgpt.example.test/backend-api/codex",
      fetch: async (_input, init) => {
        const id = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
        attempts.push(id);
        return id === "chatgpt-account-a"
          ? Response.json({ error: "quota" }, { status: 429, headers: { "x-codex-secondary-used-percent": "100" } })
          : Response.json({ ok: true }, { status: 200, headers: { "x-codex-primary-used-percent": "20" } });
      },
    });
    const response = await proxy.handle(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "thread-1", "x-opencraft-account-pool-token": token },
      body: JSON.stringify({ model: "gpt-test", input: [] }),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(attempts, ["chatgpt-account-a", "chatgpt-account-b"]);
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "thread-1" }).account.id, "account-b");
    assert.throws(() => pool.select({
      provider: "codex",
      hostId: "local",
      affinityId: "thread-new",
      excludeAccountIds: new Set(["account-b"]),
    }), /eligible/i);
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("account management projections never expose credentials and secret files stay private", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  const secretsDirectory = join(root, "secrets");
  try {
    const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory });
    pool.addAccount({
      id: "account-a",
      provider: "codex",
      label: "A",
      upstreamAccountId: "chatgpt-a",
      priority: 1,
      enabled: true,
    }, { accessToken: "access-private", refreshToken: "refresh-private", expiresAt: null });
    const projection = pool.listAccounts();
    assert.deepEqual(projection, [{
      id: "account-a",
      provider: "codex",
      label: "A",
      upstreamAccountId: "chatgpt-a",
      priority: 1,
      enabled: true,
      credentialConfigured: true,
    }]);
    assert.doesNotMatch(JSON.stringify(projection), /access-private|refresh-private/);
    assert.equal((await stat(secretsDirectory)).mode & 0o777, 0o700);
    const accountFile = (await readdir(secretsDirectory)).find(name => name.startsWith("account-"));
    assert.ok(accountFile);
    assert.equal((await stat(join(secretsDirectory, accountFile))).mode & 0o777, 0o600);
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("complete reorder and enable state control new account selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  try {
    const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    for (const [id, priority] of [["account-a", 1], ["account-b", 2]] as const) {
      pool.addAccount({ id, provider: "codex", label: id, upstreamAccountId: `chatgpt-${id}`, priority, enabled: true },
        { accessToken: `access-${id}`, refreshToken: null, expiresAt: null });
    }
    pool.reorder("codex", ["account-b", "account-a"]);
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "thread-1" }).account.id, "account-b");
    pool.setEnabled("account-b", false);
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "thread-2" }).account.id, "account-a");
    assert.throws(() => pool.reorder("codex", ["account-a"]), /every account/i);
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loopback server exposes the proxy over a bounded local HTTP endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  try {
    const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    pool.addAccount({ id: "account-a", provider: "codex", label: "A", upstreamAccountId: "chatgpt-a", priority: 1, enabled: true },
      { accessToken: "access-a", refreshToken: null, expiresAt: null });
    const token = pool.issueHostToken("local");
    const server = await startCodexAccountPoolServer({
      proxy: new CodexAccountPoolProxy({
        store: pool,
        upstreamBaseUrl: "https://chatgpt.example.test/backend-api/codex",
        fetch: async () => Response.json({ data: [{ id: "gpt-test" }] }),
      }),
    });
    try {
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
      const response = await fetch(`${server.url}/v1/models`, { headers: { "x-opencraft-account-pool-token": token } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { data: [{ id: "gpt-test" }] });
    } finally {
      await server.close();
    }
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pre-success authentication rejection marks the account unhealthy and advances", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  try {
    const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    for (const [id, priority] of [["account-a", 1], ["account-b", 2]] as const) {
      pool.addAccount({ id, provider: "codex", label: id, upstreamAccountId: `chatgpt-${id}`, priority, enabled: true },
        { accessToken: `access-${id}`, refreshToken: null, expiresAt: null });
    }
    const token = pool.issueHostToken("local");
    const attempts: string[] = [];
    const proxy = new CodexAccountPoolProxy({
      store: pool,
      upstreamBaseUrl: "https://chatgpt.example.test/backend-api/codex",
      fetch: async (_input, init) => {
        const id = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
        attempts.push(id);
        return id === "chatgpt-account-a" ? Response.json({ error: "unauthorized" }, { status: 401 }) : Response.json({ ok: true });
      },
    });
    const response = await proxy.handle(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "thread-auth", "x-opencraft-account-pool-token": token },
      body: JSON.stringify({ model: "gpt-test", input: [] }),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(attempts, ["chatgpt-account-a", "chatgpt-account-b"]);
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "thread-next" }).account.id, "account-b");
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a duplicate account add cannot replace or remove the committed credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  try {
    const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    const account = { id: "account-a", provider: "codex" as const, label: "A", upstreamAccountId: "chatgpt-a", priority: 1, enabled: true };
    pool.addAccount(account, { accessToken: "access-original", refreshToken: null, expiresAt: null });
    assert.throws(() => pool.addAccount(account, { accessToken: "access-replacement", refreshToken: null, expiresAt: null }));
    const token = pool.issueHostToken("local");
    let authorization = "";
    const proxy = new CodexAccountPoolProxy({
      store: pool,
      upstreamBaseUrl: "https://chatgpt.example.test/backend-api/codex",
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({ ok: true });
      },
    });
    assert.equal((await proxy.handle(new Request("http://127.0.0.1/v1/models", {
      headers: { "x-opencraft-account-pool-token": token },
    }))).status, 200);
    assert.equal(authorization, "Bearer access-original");
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child affinity inherits its parent without crossing Host identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  try {
    const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    for (const [id, priority] of [["account-a", 1], ["account-b", 2]] as const) {
      pool.addAccount({ id, provider: "codex", label: id, upstreamAccountId: `chatgpt-${id}`, priority, enabled: true },
        { accessToken: `access-${id}`, refreshToken: null, expiresAt: null });
    }
    const parent = pool.select({ provider: "codex", hostId: "host-a", affinityId: "parent" });
    assert.equal(parent.account.id, "account-a");
    parent.accept();
    pool.setEnabled("account-a", false);
    const other = pool.select({ provider: "codex", hostId: "host-a", affinityId: "other" });
    assert.equal(other.account.id, "account-b");
    other.accept();
    pool.setEnabled("account-a", true);
    assert.equal(pool.select({ provider: "codex", hostId: "host-a", affinityId: "child", parentAffinityId: "parent" }).account.id, "account-a");
    assert.equal(pool.select({ provider: "codex", hostId: "host-b", affinityId: "parent" }).account.id, "account-b");
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacing a rejected credential clears only that account error and restores eligibility", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  try {
    const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    pool.addAccount({ id: "account-a", provider: "codex", label: "A", upstreamAccountId: "chatgpt-a", priority: 1, enabled: true },
      { accessToken: "access-old", refreshToken: null, expiresAt: null });
    pool.markAccountError("account-a", "authorization-rejected");
    assert.throws(() => pool.select({ provider: "codex", hostId: "local", affinityId: "thread-1" }), /eligible/i);
    pool.replaceCredential("account-a", { accessToken: "access-new", refreshToken: "refresh-new", expiresAt: null });
    const recovered = pool.select({ provider: "codex", hostId: "local", affinityId: "thread-1" });
    assert.equal(recovered.account.id, "account-a");
    assert.equal(recovered.secret.accessToken, "access-new");
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an authentication rejection without a fallback remains an authentication error", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  try {
    const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    pool.addAccount({ id: "account-a", provider: "codex", label: "A", upstreamAccountId: "chatgpt-a", priority: 1, enabled: true },
      { accessToken: "access-a", refreshToken: null, expiresAt: null });
    const token = pool.issueHostToken("local");
    const proxy = new CodexAccountPoolProxy({
      store: pool,
      upstreamBaseUrl: "https://chatgpt.example.test/backend-api/codex",
      fetch: async () => Response.json({ upstream: "must-not-be-forwarded" }, { status: 401 }),
    });
    const response = await proxy.handle(new Request("http://127.0.0.1/v1/models", {
      headers: { "x-opencraft-account-pool-token": token },
    }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { message: "Codex account authentication failed" } });
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired Codex credentials refresh single-flight before concurrent requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  let refreshCalls = 0;
  try {
    const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets"), now: () => 10_000 });
    const account = pool.addAccount({ id: "account-a", provider: "codex", label: "A", upstreamAccountId: "chatgpt-a", priority: 1, enabled: true },
      { accessToken: "access-old", refreshToken: "refresh-a", expiresAt: 9_000 });
    const manager = new CodexCredentialRefreshManager({
      store: pool,
      now: () => 10_000,
      refresh: async () => {
        refreshCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { accessToken: "access-new", refreshToken: "refresh-b", expiresAt: 20_000 };
      },
    });
    const current = pool.select({ provider: "codex", hostId: "local", affinityId: "thread" }).secret;
    const [left, right] = await Promise.all([
      manager.resolve(account, current, "expired"),
      manager.resolve(account, current, "expired"),
    ]);
    assert.equal(refreshCalls, 1);
    assert.equal(left.accessToken, "access-new");
    assert.equal(right.accessToken, "access-new");
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "next" }).secret.accessToken, "access-new");
    const reconciled = await manager.resolve(account, current, "unauthorized");
    assert.equal(reconciled.accessToken, "access-new");
    assert.equal(refreshCalls, 1, "a stale 401 must reuse the credential another request already refreshed");
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex proxy retries one 401 on the same account with a refreshed credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  try {
    const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    pool.addAccount({ id: "account-a", provider: "codex", label: "A", upstreamAccountId: "chatgpt-a", priority: 1, enabled: true },
      { accessToken: "access-old", refreshToken: "refresh-a", expiresAt: null });
    const token = pool.issueHostToken("local");
    const authorizations: string[] = [];
    const proxy = new CodexAccountPoolProxy({
      store: pool,
      upstreamBaseUrl: "https://chatgpt.example.test/backend-api/codex",
      resolveCredential: async (_account, secret, reason) => {
        assert.equal(reason, "unauthorized");
        assert.equal(secret.accessToken, "access-old");
        return { accessToken: "access-new", refreshToken: "refresh-b", expiresAt: null };
      },
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        authorizations.push(authorization);
        return Response.json({}, { status: authorization === "Bearer access-old" ? 401 : 200 });
      },
    });
    const response = await proxy.handle(new Request("http://127.0.0.1/v1/models", { headers: { "x-opencraft-account-pool-token": token } }));
    assert.equal(response.status, 200);
    assert.deepEqual(authorizations, ["Bearer access-old", "Bearer access-new"]);
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex subscription refresh records plan and limit windows without exposing credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  const now = 2_000_000;
  try {
    const pool = new AccountPoolStore({
      databasePath: join(root, "pool.sqlite"),
      secretsDirectory: join(root, "secrets"),
      now: () => now,
    });
    pool.addAccount({
      id: "account-a",
      provider: "codex",
      label: "person@example.test",
      upstreamAccountId: "chatgpt-a",
      priority: 1,
      enabled: true,
    }, { accessToken: "access-private", refreshToken: "refresh-private", expiresAt: now + 60_000 });
    let requests = 0;
    const usage = new CodexSubscriptionService({
      store: pool,
      now: () => now,
      resolveCredential: async (_account, secret) => secret,
      fetch: async (_input, init) => {
        requests += 1;
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer access-private");
        assert.equal(headers.get("chatgpt-account-id"), "chatgpt-a");
        return Response.json({
          plan_type: "pro",
          rate_limit: {
            primary_window: { used_percent: 25, reset_after_seconds: 120, limit_window_seconds: 18_000 },
            secondary_window: { used_percent: 70, reset_at: 3_000, limit_window_seconds: 604_800 },
          },
        });
      },
    });
    await Promise.all([usage.refreshAccount("account-a"), usage.refreshAccount("account-a")]);
    assert.equal(requests, 1, "concurrent usage refreshes should share one flight");
    assert.deepEqual(pool.listAccountStates(), [{
      accountId: "account-a",
      email: null,
      subscriptionType: "pro",
      rateLimitTier: null,
      lastUsedAt: null,
      lastUsedHostId: null,
      observedAt: now,
      heldUntil: null,
      error: null,
      limitWindows: [
        { slot: "primary", windowMinutes: 300, utilization: 0.25, resetAt: now + 120_000, status: "allowed", observedAt: now, source: "usage" },
        { slot: "secondary", windowMinutes: 10_080, utilization: 0.7, resetAt: 3_000_000, status: "allowed", observedAt: now, source: "usage" },
      ],
      status: "ready",
    }]);
    assert.doesNotMatch(JSON.stringify(pool.listAccountStates()), /access-private|refresh-private/);
    await usage.dispose();
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing account-pool databases migrate subscription columns without losing accounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  const databasePath = join(root, "pool.sqlite");
  const secretsDirectory = join(root, "secrets");
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE pool_accounts (
      id TEXT PRIMARY KEY,provider TEXT NOT NULL,label TEXT NOT NULL,upstream_account_id TEXT NOT NULL,
      priority INTEGER NOT NULL,enabled INTEGER NOT NULL,created_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO pool_accounts VALUES('account-a','codex','A','chatgpt-a',1,1,1000);`);
    legacy.close();
    const pool = new AccountPoolStore({ databasePath, secretsDirectory, now: () => 2_000 });
    assert.equal(pool.listAccounts()[0]?.id, "account-a");
    assert.deepEqual(pool.listAccountStates()[0], {
      accountId: "account-a", email: null, subscriptionType: null, rateLimitTier: null,
      lastUsedAt: null, lastUsedHostId: null, observedAt: null, heldUntil: null, error: null,
      limitWindows: [], status: "ready",
    });
    pool.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
