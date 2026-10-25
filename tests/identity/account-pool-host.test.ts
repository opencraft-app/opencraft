import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, rm, stat, readFile, writeFile, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AccountPoolStore,
  CodexSubscriptionService,
  AccountCredentialRefreshManager,
  CodexAccountPoolProxy,
  createCodexAccountPoolLaunch,
  startCodexAccountPoolServer,
  readCodexAuthFile,
} from "../../packages/account-pool-host/src/index.js";

test("shared auth references follow atomic owner rotation without copying or refreshing tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-shared-auth-"));
  const path = join(root, "auth.json"), link = join(root, "shared-auth.json");
  const auth = (token: string, accountId = "shared-account") => JSON.stringify({ auth_mode: "chatgpt",
    tokens: { access_token: token, refresh_token: "owner-refresh-only", account_id: accountId } });
  const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  try {
    await writeFile(path, auth("access-before")); await symlink(path, link);
    const reference = { kind: "codex-auth-file" as const, path: link };
    pool.addAccount({ id: "shared", provider: "codex", label: "Shared", upstreamAccountId: "shared-account", priority: 1, enabled: true }, reference);
    const record = await readFile(join(root, "secrets/account-shared.json"), "utf8");
    assert.deepEqual(JSON.parse(record), reference);
    assert.doesNotMatch(record, /access-before|owner-refresh-only/);
    const selected = pool.select({ provider: "codex", hostId: "local", affinityId: "thread" });
    assert.equal(selected.secret.accessToken, "access-before");
    assert.equal(selected.secret.refreshToken, null);
    let refreshes = 0;
    const refresh = new AccountCredentialRefreshManager({ store: pool, refresh: async () => { refreshes++; throw new Error("must not refresh external credentials"); } });
    await writeFile(path + ".new", auth("access-after")); await rename(path + ".new", path);
    assert.equal((await refresh.resolve(selected.account, selected.secret, "unauthorized")).accessToken, "access-after");
    const current = pool.readCredential("shared");
    await assert.rejects(refresh.resolve(selected.account, current, "unauthorized"), /external owner/);
    assert.equal(refreshes, 0);
    assert.throws(() => pool.replaceCredential("shared", { accessToken: "copied", refreshToken: null, expiresAt: null }), /external owner/);
    await writeFile(path + ".new", auth("different-user-token", "different-account")); await rename(path + ".new", path);
    assert.throws(() => pool.readCredential("shared"), /unavailable or do not match/);
    await rm(path);
    assert.throws(() => pool.readCredential("shared"), /unavailable or do not match/);
    pool.removeAccount("shared");
    assert.deepEqual(pool.listAccounts(), []);
    // Removing a reference never deletes the owner's source (recreate to prove it).
    await writeFile(path, auth("still-owned"));
    pool.addAccount({ id: "again", provider: "codex", label: "Shared", upstreamAccountId: "shared-account", priority: 1, enabled: true }, reference);
    pool.removeAccount("again"); assert.equal(JSON.parse(await readFile(path, "utf8")).tokens.access_token, "still-owned");
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});

test("expired or malformed shared credentials fail closed without invoking managed refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-shared-expiry-"));
  const path = join(root, "auth.json"), reference = { kind: "codex-auth-file" as const, path };
  const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  try {
    const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
    await writeFile(path, JSON.stringify({ tokens: { access_token: expired, account_id: "account" } }));
    pool.addAccount({ id: "shared", provider: "codex", label: "Shared", upstreamAccountId: "account", priority: 1, enabled: true }, reference);
    const refresh = new AccountCredentialRefreshManager({ store: pool, refresh: async () => { assert.fail("external refresh must not run"); } });
    await assert.rejects(refresh.resolve(pool.getAccount("shared"), pool.readCredential("shared"), "expired"), /external owner/);
    await writeFile(path, '{"tokens":"private-invalid-payload"');
    assert.throws(() => readCodexAuthFile(reference), error => error instanceof Error && !error.message.includes("private-invalid-payload"));
    assert.throws(() => pool.addAccount({ id: "bad", provider: "codex", label: "Bad", upstreamAccountId: "account", priority: 1, enabled: true }, { ...reference, path: "relative-auth.json" }), /Invalid shared/);
    assert.equal(pool.listAccounts().length, 1);
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});

test("the inference proxy rereads shared credentials for every request and never uses a missing source", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-shared-proxy-"));
  const path = join(root, "auth.json");
  const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  try {
    const save = (token: string) => writeFile(path, JSON.stringify({ tokens: { account_id: "shared", access_token: token } }));
    await save("first");
    pool.addAccount({ id: "external", provider: "codex", label: "Shared", upstreamAccountId: "shared", priority: 1, enabled: true }, { kind: "codex-auth-file", path });
    const token = pool.issueHostToken("test"), seen: (string | null)[] = [];
    let rotateOnNext = false;
    const refresh = new AccountCredentialRefreshManager({ store: pool, refresh: async () => { assert.fail("external owner refresh only"); } });
    const proxy = new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: "https://codex.example.test",
      resolveCredential: (account, secret, reason) => refresh.resolve(account, secret, reason), fetch: async (_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      if (rotateOnNext) { rotateOnNext = false; await save("third"); return new Response(null, { status: 401 }); }
      return Response.json({ ok: true });
    } });
    const request = () => new Request("http://127.0.0.1/v1/responses", { method: "POST",
      headers: { "x-opencraft-account-pool-token": token, "content-type": "application/json" }, body: '{"model":"test","input":[]}' });
    assert.equal((await proxy.handle(request())).status, 200);
    await save("second"); assert.equal((await proxy.handle(request())).status, 200);
    rotateOnNext = true; assert.equal((await proxy.handle(request())).status, 200);
    assert.equal(JSON.parse(await readFile(join(root, "secrets/account-external.json"), "utf8")).kind, "codex-auth-file");
    await rm(path); assert.notEqual((await proxy.handle(request())).status, 200);
    assert.deepEqual(seen, ["Bearer first", "Bearer second", "Bearer second", "Bearer third"]);
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function startLocalServer(server: Server): Promise<{ readonly url: string; close(): Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local test server did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function captureUnhandledProcessErrors(): { assertNone(): void; dispose(): void } {
  const errors: unknown[] = [];
  const onUncaught = (error: Error) => errors.push(error);
  const onUnhandled = (reason: unknown) => errors.push(reason);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  return {
    assertNone: () => assert.equal(errors.length, 0, `unexpected process errors: ${errors.map(error => String(error)).join(", ")}`),
    dispose: () => {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
    },
  };
}

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
    now += 101;
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "new-after-idle" }).account.id, "account-a");
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

test("native external auth uses only an ephemeral local broker credential", () => {
  const launch = createCodexAccountPoolLaunch({ baseUrl: "http://127.0.0.1:43123", hostToken: "local-host-secret" });
  assert.equal(launch.auth.type, "chatgptAuthTokens");
  assert.equal(launch.auth.chatgptAccountId, "opencraft-account-pool");
  const [header, body, signature] = launch.auth.accessToken.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "HS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(body!, "base64url").toString()), {
    iss: "opencraft-account-pool", aud: "http://127.0.0.1:43123/v1", sub: "local-codex",
  });
  assert.ok(signature);
  assert.doesNotMatch(JSON.stringify(launch.auth), /local-host-secret|refresh_token|chatgpt_plan_type/);
  assert.ok(launch.args.includes('chatgpt_base_url="http://127.0.0.1:43123"'));
});

test("native image routes retain Host/thread affinity and independent image quota without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-image-pool-"));
  const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  try {
    for (const id of ["a", "b"]) pool.addAccount({ id, provider: "codex", label: id, upstreamAccountId: id, priority: 1, enabled: true },
      { accessToken: `oauth-${id}`, refreshToken: null, idToken: null, expiresAt: null });
    const hostA = pool.issueHostToken("host-a"), hostB = pool.issueHostToken("host-b");
    const calls: { path: string; account: string | null }[] = [];
    let imageStatus = 200;
    const proxy = new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: "https://codex.example.test/backend-api/codex", fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, account: new Headers(init?.headers).get("authorization") });
      return Response.json(path.includes("/images/") ? { image: true } : {}, { status: path.includes("/images/") ? imageStatus : 200 });
    } });
    const response = (host: string, threadId: string, turnId: string) => proxy.handle(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "x-opencraft-account-pool-token": host,
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) }, body: "{}" }));
    const image = (host: string, turnId: string, operation = "generations") => proxy.handle(new Request(`http://localhost/v1/images/${operation}`, {
      method: "POST", headers: { "x-opencraft-account-pool-token": host, "x-codex-image-turn-id": turnId }, body: '{"model":"gpt-image-2"}' }));
    assert.equal((await image(hostA, "unknown")).status, 409);
    assert.equal((await image("invalid", "turn-a")).status, 401);
    await response(hostA, "thread-a", "turn-a");
    await response(hostA, "thread-b", "turn-b");
    assert.equal((await image(hostB, "turn-a")).status, 409);
    assert.equal((await image(hostA, "turn-a")).status, 200);
    assert.equal((await image(hostA, "turn-b", "edits")).status, 200);
    assert.equal(calls[0]!.account, calls[2]!.account);
    assert.equal(calls[1]!.account, calls[3]!.account);
    assert.notEqual(calls[0]!.account, calls[1]!.account);
    assert.equal(calls[2]!.path, "/backend-api/codex/images/generations");
    assert.equal(calls[3]!.path, "/backend-api/codex/images/edits");
    for (const status of [429, 401, 503]) {
      imageStatus = status;
      const before = calls.length;
      assert.equal((await image(hostA, "turn-a")).status, status);
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1)!.account, calls[0]!.account);
    }
    // An image quota failure must leave text inference on its original account.
    await response(hostA, "thread-a", "turn-next");
    assert.equal(calls.at(-1)!.account, calls[0]!.account);
    assert.equal((await proxy.handle(new Request("http://localhost/v1/images/delete", { method: "POST" }))).status, 404);
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});

test("native hosted MCP uses broker auth and the calling Thread account without replaying tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-native-mcp-pool-"));
  const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  try {
    for (const [id, priority] of [["a", 1], ["b", 2]] as const) pool.addAccount({
      id, provider: "codex", label: id, upstreamAccountId: id, priority, enabled: true,
    }, { accessToken: `oauth-${id}`, refreshToken: null, expiresAt: null });
    const token = pool.issueHostToken("local-codex");
    const launch = createCodexAccountPoolLaunch({ baseUrl: "http://127.0.0.1:43123", hostToken: token });
    const calls: { path: string; account: string | null; headers: Headers }[] = [];
    let status = 200;
    const proxy = new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: "https://codex.example.test/backend-api/codex",
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ path: String(url), account: headers.get("chatgpt-account-id"), headers });
        return Response.json({ result: { tools: [] } }, { status });
      } });
    const inference = (thread: string) => proxy.handle(new Request("http://127.0.0.1:43123/v1/responses", {
      method: "POST", headers: { "x-opencraft-account-pool-token": token, "thread-id": thread }, body: "{}",
    }));
    const mcp = (bearer: string, thread?: string) => proxy.handle(new Request("http://127.0.0.1:43123/api/codex/ps/mcp", {
      method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18", "x-openai-product-sku": "codex" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: thread ? "tools/call" : "tools/list",
        params: thread ? { name: "fixture", _meta: { threadId: thread } } : {} }),
    }));
    assert.equal((await mcp("forged")).status, 401);
    const wrongAudience = createCodexAccountPoolLaunch({ baseUrl: "http://127.0.0.1:43124", hostToken: token });
    assert.equal((await mcp(wrongAudience.auth.accessToken)).status, 401);
    assert.equal(calls.length, 0);
    await inference("thread-a");
    assert.equal((await mcp(launch.auth.accessToken)).status, 200);
    await inference("thread-b");
    assert.equal((await mcp(launch.auth.accessToken, "thread-a")).status, 200);
    assert.equal(calls.at(-1)!.account, "a");
    assert.equal(calls.at(-1)!.path, "https://codex.example.test/backend-api/ps/mcp");
    assert.equal(calls.at(-1)!.headers.get("authorization"), "Bearer oauth-a");
    assert.equal(calls.at(-1)!.headers.get("x-opencraft-account-pool-token"), null);
    assert.equal(calls.at(-1)!.headers.get("mcp-protocol-version"), "2025-06-18");
    assert.equal(calls.at(-1)!.headers.get("x-openai-product-sku"), "codex");
    assert.equal((await mcp(launch.auth.accessToken, "thread-b")).status, 200);
    assert.equal(calls.at(-1)!.account, "b");
    status = 429;
    const before = calls.length;
    assert.equal((await mcp(launch.auth.accessToken, "thread-a")).status, 429);
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1)!.account, "a");
    assert.equal((await proxy.handle(new Request("http://127.0.0.1:43123/api/codex/arbitrary", { method: "POST" }))).status, 404);
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
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
    }, { accessToken: "access-a", refreshToken: null, expiresAt: null, idToken: "id-token-must-not-be-used" });
    const hostToken = pool.issueHostToken("local");
    const upstream: Array<{ url: string; authorization: string | null; accountId: string | null; leaked: string | null; headers: Record<string, string> }> = [];
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
          headers: Object.fromEntries(headers),
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
        "chatgpt-account-id": "inbound-account-must-not-pass-through",
        cookie: "inbound-cookie-must-not-pass-through",
        originator: "opencraft",
        "user-agent": "opencraft/1 (Codex 0.162.1)",
        accept: "text/event-stream",
        "openai-beta": "responses=experimental",
        session_id: "session-1",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-1" }),
      },
      body: JSON.stringify({ model: "gpt-test", input: [] }),
    });
    const response = await proxy.handle(request);
    assert.equal(response.status, 200);
    assert.deepEqual(upstream, [{
      url: "https://chatgpt.example.test/backend-api/codex/responses",
      authorization: "Bearer access-a",
      accountId: "chatgpt-a",
      leaked: null,
      headers: {
        accept: "text/event-stream",
        authorization: "Bearer access-a",
        "chatgpt-account-id": "chatgpt-a",
        "content-type": "application/json",
        "openai-beta": "responses=experimental",
        originator: "opencraft",
        session_id: "session-1",
        "thread-id": "thread-1",
        "user-agent": "opencraft/1 (Codex 0.162.1)",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-1" }),
      },
    }]);
    assert.equal((await proxy.handle(new Request("http://127.0.0.1/v1/models?client_version=test", {
      headers: { "x-opencraft-account-pool-token": hostToken },
    }))).status, 200);
    assert.equal(upstream[1]?.url, "https://chatgpt.example.test/backend-api/codex/models?client_version=test");
    await proxy.handle(new Request("http://127.0.0.1/v1/models", {
      headers: { "x-opencraft-account-pool-token": hostToken },
    }));
    assert.equal(upstream[2]?.url, "https://chatgpt.example.test/backend-api/codex/models");
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

test("a body-only usage rejection switches accounts but temporary rate limiting does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-quota-body-"));
  const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  try {
    for (const [id, priority] of [["a", 1], ["b", 2]] as const) pool.addAccount({
      id, provider: "codex", label: id, upstreamAccountId: id, priority, enabled: true,
    }, { accessToken: `oauth-${id}`, refreshToken: null, expiresAt: null });
    const token = pool.issueHostToken("local");
    let errorType = "rate_limit_exceeded";
    const proxy = new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: "https://codex.example.test/backend-api/codex",
      fetch: async (_url, init) => new Headers(init?.headers).get("chatgpt-account-id") === "a"
        ? Response.json({ error: { type: errorType } }, { status: 429 })
        : Response.json({ account: "b" }) });
    const request = () => proxy.handle(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { "x-opencraft-account-pool-token": token, "thread-id": "same-thread" }, body: "{}",
    }));
    const temporary = await request();
    assert.equal(temporary.status, 429);
    assert.deepEqual(await temporary.json(), { error: { type: "rate_limit_exceeded" } });
    errorType = "usage_limit_reached";
    const exhausted = await request();
    assert.equal(exhausted.status, 200);
    assert.deepEqual(await exhausted.json(), { account: "b" });
    assert.deepEqual(await (await request()).json(), { account: "b" });
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});

test("a pre-header transport timeout is surfaced without replaying the request", async () => {
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
        const error = new TypeError("fetch failed") as TypeError & { cause: Error & { code: string } };
        error.cause = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
        throw error;
      },
    });
    await assert.rejects(proxy.handle(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "thread-timeout", "x-opencraft-account-pool-token": token },
      body: JSON.stringify({ model: "gpt-test", input: [] }),
    })), /fetch failed/);
    assert.deepEqual(attempts, ["chatgpt-account-a"]);
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "thread-timeout" }).account.id, "account-a");
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
      allowCredits: false,
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

test("loopback Codex proxy accepts 128 MiB and rejects larger requests without forwarding", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-limit-"));
  const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  pool.addAccount({ id: "account-a", provider: "codex", label: "A", upstreamAccountId: "chatgpt-a", priority: 1, enabled: true },
    { accessToken: "fixture-access", refreshToken: null, expiresAt: null });
  const token = pool.issueHostToken("local");
  let upstreamCalls = 0;
  const server = await startCodexAccountPoolServer({
    proxy: new CodexAccountPoolProxy({
      store: pool,
      upstreamBaseUrl: "https://chatgpt.example.test/backend-api/codex",
      fetch: async (_input, init) => {
        upstreamCalls++;
        return Response.json({ bytes: init?.body ? (init.body as Uint8Array).byteLength : 0 });
      },
    }),
  });
  try {
    const acceptedBytes = 128 * 1024 * 1024;
    const accepted = await fetch(`${server.url}/v1/responses`, {
      method: "POST",
      headers: { "x-opencraft-account-pool-token": token },
      body: "x".repeat(acceptedBytes),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { bytes: acceptedBytes });

    const rejected = await fetch(`${server.url}/v1/responses`, {
      method: "POST",
      headers: { "x-opencraft-account-pool-token": token },
      body: "x".repeat(128 * 1024 * 1024 + 1),
    });
    assert.equal(rejected.status, 413);
    assert.deepEqual(await rejected.json(), { error: { message: "Request too large" } });
    assert.equal(upstreamCalls, 1);

    const next = await fetch(`${server.url}/v1/models`, { headers: { "x-opencraft-account-pool-token": token } });
    assert.equal(next.status, 200);
    assert.deepEqual(await next.json(), { bytes: 0 });
    assert.equal(upstreamCalls, 2);
  } finally {
    await server.close();
    pool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("disconnecting a streaming Account Pool client does not crash the server", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-disconnect-"));
  const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  pool.addAccount({ id: "account-a", provider: "codex", label: "A", upstreamAccountId: "chatgpt-a", priority: 1, enabled: true },
    { accessToken: "fixture-access", refreshToken: null, expiresAt: null });
  const token = pool.issueHostToken("local");
  let upstreamAborts = 0;
  let calls = 0;
  const server = await startCodexAccountPoolServer({
    proxy: new CodexAccountPoolProxy({
      store: pool,
      upstreamBaseUrl: "https://chatgpt.example.test/backend-api/codex",
      fetch: async (_input, init) => {
        if (++calls > 1) return Response.json({ ok: true });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("data: first\n\n"));
            init?.signal?.addEventListener("abort", () => {
              upstreamAborts++;
              controller.error(init.signal?.reason);
            }, { once: true });
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    }),
  });
  try {
    const clientAbort = new AbortController();
    const first = await fetch(`${server.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "thread-disconnect", "x-opencraft-account-pool-token": token },
      body: JSON.stringify({ model: "gpt-test", input: [] }),
      signal: clientAbort.signal,
    });
    assert.equal(first.status, 200);
    await first.body?.getReader().read();
    clientAbort.abort();
    const next = await fetch(`${server.url}/v1/models`, { headers: { "x-opencraft-account-pool-token": token } });
    assert.equal(next.status, 200);
    assert.deepEqual(await next.json(), { ok: true });
    assert.equal(upstreamAborts, 1);
  } finally {
    await server.close();
    pool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a client disconnect aborts an in-flight upstream stream without crashing the account pool server", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  const firstUpstreamChunk = deferred<void>();
  const upstreamClosed = deferred<void>();
  const upstream = await startLocalServer(createServer((incoming, outgoing) => {
    if (incoming.url === "/backend-api/codex/models") {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ data: [{ id: "gpt-test" }] }));
      return;
    }
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.write("data: first\n\n");
    firstUpstreamChunk.resolve();
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) upstreamClosed.resolve();
    });
  }));
  const processErrors = captureUnhandledProcessErrors();
  let server: Awaited<ReturnType<typeof startCodexAccountPoolServer>> | undefined;
  let pool: AccountPoolStore | undefined;
  const controller = new AbortController();
  try {
    pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    pool.addAccount({ id: "account-a", provider: "codex", label: "A", upstreamAccountId: "chatgpt-a", priority: 1, enabled: true },
      { accessToken: "access-a", refreshToken: null, expiresAt: null });
    const token = pool.issueHostToken("local");
    server = await startCodexAccountPoolServer({
      proxy: new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: `${upstream.url}/backend-api/codex` }),
    });
    const response = await fetch(`${server.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencraft-account-pool-token": token },
      body: JSON.stringify({ model: "gpt-test", input: [] }),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    await firstUpstreamChunk.promise;
    assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n");
    controller.abort();
    await assert.rejects(reader.read());
    await within(upstreamClosed.promise, "upstream stream was not closed after the client disconnected");

    const followUp = await fetch(`${server.url}/v1/models`, { headers: { "x-opencraft-account-pool-token": token } });
    assert.equal(followUp.status, 200);
    assert.deepEqual(await followUp.json(), { data: [{ id: "gpt-test" }] });
    processErrors.assertNone();
  } finally {
    controller.abort();
    await server?.close();
    await upstream.close();
    processErrors.dispose();
    pool?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an upstream stream failure interrupts the client connection without crashing the account pool server", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-"));
  const failUpstream = deferred<void>();
  let responseCount = 0;
  const upstream = await startLocalServer(createServer((incoming, outgoing) => {
    if (incoming.url === "/backend-api/codex/models") {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ data: [{ id: "gpt-test" }] }));
      return;
    }
    responseCount += 1;
    outgoing.writeHead(200, { "content-type": "text/event-stream", "content-length": "100" });
    outgoing.write("data: first\n\n");
    void failUpstream.promise.then(() => outgoing.destroy());
  }));
  const processErrors = captureUnhandledProcessErrors();
  let server: Awaited<ReturnType<typeof startCodexAccountPoolServer>> | undefined;
  let pool: AccountPoolStore | undefined;
  try {
    pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    pool.addAccount({ id: "account-a", provider: "codex", label: "A", upstreamAccountId: "chatgpt-a", priority: 1, enabled: true },
      { accessToken: "access-a", refreshToken: null, expiresAt: null });
    const token = pool.issueHostToken("local");
    server = await startCodexAccountPoolServer({
      proxy: new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: `${upstream.url}/backend-api/codex` }),
    });
    const response = await fetch(`${server.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencraft-account-pool-token": token },
      body: JSON.stringify({ model: "gpt-test", input: [] }),
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n");
    failUpstream.resolve();
    await assert.rejects(reader.read());

    const followUp = await fetch(`${server.url}/v1/models`, { headers: { "x-opencraft-account-pool-token": token } });
    assert.equal(followUp.status, 200);
    assert.deepEqual(await followUp.json(), { data: [{ id: "gpt-test" }] });
    assert.equal(responseCount, 1);
    processErrors.assertNone();
  } finally {
    failUpstream.resolve();
    await server?.close();
    await upstream.close();
    processErrors.dispose();
    pool?.close();
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
    assert.equal(pool.select({ provider: "codex", hostId: "host-a", affinityId: "unrelated" }).account.id, "account-a");
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
    const manager = new AccountCredentialRefreshManager({
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
      resetCredits: null,
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
    try {
      assert.equal(pool.listAccounts()[0]?.id, "account-a");
      assert.deepEqual(pool.listAccountStates()[0], {
        accountId: "account-a", email: null, subscriptionType: null, rateLimitTier: null, resetCredits: null,
        lastUsedAt: null, lastUsedHostId: null, observedAt: null, heldUntil: null, error: null,
        limitWindows: [], status: "ready",
      });
      assert.equal(pool.outcome.status, "migrated");
      assert.ok(pool.outcome.backupPath);
      const backup = new DatabaseSync(pool.outcome.backupPath!);
      try {
        assert.equal(backup.prepare("SELECT id FROM pool_accounts").get()?.id, "account-a");
        assert.equal(backup.prepare("PRAGMA table_info(pool_accounts)").all().length, 7);
      } finally { backup.close(); }
    } finally { pool.close(); }
    const again = new AccountPoolStore({ databasePath, secretsDirectory, now: () => 2_000 });
    try {
      assert.equal(again.outcome.status, "up-to-date");
      assert.equal(again.outcome.backupPath, undefined);
      assert.equal(again.listAccounts()[0]?.id, "account-a");
    } finally { again.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("known pre-ledger AccountPool tables retain account metadata, affinity, active account and quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-legacy-relations-"));
  const databasePath = join(root, "pool.sqlite");
  const secretsDirectory = join(root, "secrets");
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE pool_accounts (
        id TEXT PRIMARY KEY,provider TEXT NOT NULL,label TEXT NOT NULL,upstream_account_id TEXT NOT NULL,
        priority INTEGER NOT NULL,enabled INTEGER NOT NULL,created_at INTEGER NOT NULL,
        email TEXT,subscription_type TEXT,rate_limit_tier TEXT,last_used_at INTEGER,last_used_host_id TEXT
      ) STRICT;
      CREATE TABLE pool_affinity (
        affinity_key TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES pool_accounts(id) ON DELETE CASCADE,
        last_used_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE pool_active_account (
        provider TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES pool_accounts(id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE pool_quota (
        account_id TEXT PRIMARY KEY REFERENCES pool_accounts(id) ON DELETE CASCADE,
        utilization REAL,reset_at INTEGER,held_until INTEGER,error TEXT,observed_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO pool_accounts VALUES('account-a','codex','A','chatgpt-a',3,1,1000,'a@example.test','pro','tier-a',1900,'host-a');
      INSERT INTO pool_accounts VALUES('account-b','codex','B','chatgpt-b',1,1,1100,NULL,NULL,NULL,NULL,NULL);
      INSERT INTO pool_affinity VALUES('retained-affinity','account-a',1900);
      INSERT INTO pool_active_account VALUES('codex','account-a');
      INSERT INTO pool_quota VALUES('account-a',0.4,8000,5000,'retained-quota-error',1800);
    `);
    legacy.close();
    const pool = new AccountPoolStore({ databasePath, secretsDirectory, now: () => 2_000 });
    try {
      assert.equal(pool.outcome.status, "migrated");
      assert.deepEqual(pool.listAccounts().map(account => account.id), ["account-b", "account-a"]);
      assert.deepEqual(pool.listAccounts().map(account => account.allowCredits), [true, true], "existing accounts retain credit behavior");
      assert.deepEqual(pool.listAccountStates().find(state => state.accountId === "account-a"), {
        accountId: "account-a", email: "a@example.test", subscriptionType: "pro", rateLimitTier: "tier-a", resetCredits: null,
        lastUsedAt: 1900, lastUsedHostId: "host-a", observedAt: 1800, heldUntil: 5000,
        error: "retained-quota-error", limitWindows: [], status: "error",
      });
    } finally { pool.close(); }
    const reader = new DatabaseSync(databasePath);
    try {
      assert.deepEqual({ ...reader.prepare("SELECT * FROM pool_affinity").get() }, {
        affinity_key: "retained-affinity", account_id: "account-a", last_used_at: 1900,
      });
      assert.equal(reader.prepare("SELECT account_id FROM pool_active_account WHERE provider='codex'").get()?.account_id, "account-a");
      assert.equal(reader.prepare("SELECT limit_windows_json FROM pool_quota").get()?.limit_windows_json, "[]");
      assert.equal(reader.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n, 3);
    } finally { reader.close(); }
    const again = new AccountPoolStore({ databasePath, secretsDirectory, now: () => 2_000 });
    try {
      assert.equal(again.outcome.status, "up-to-date");
      assert.equal(again.listAccountStates().find(state => state.accountId === "account-a")?.heldUntil, 5000);
    } finally { again.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown legacy account-pool schema is moved aside with backups and leaves empty database", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-legacy-missing-"));
  const databasePath = join(root, "pool.sqlite");
  const secretsDirectory = join(root, "secrets");
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE pool_accounts (
      id TEXT PRIMARY KEY,provider TEXT NOT NULL,label TEXT NOT NULL,upstream_account_id TEXT NOT NULL,
      priority INTEGER NOT NULL,enabled INTEGER NOT NULL,created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE unknown_owner_data (id TEXT PRIMARY KEY) STRICT;
    INSERT INTO pool_accounts VALUES('account-a','codex','A','chatgpt-a',1,1,1000);`);
    legacy.close();
    const pool = new AccountPoolStore({ databasePath, secretsDirectory, now: () => 2_000 });
    try {
      assert.equal(pool.outcome.status, "moved-aside");
      assert.ok(pool.outcome.backupPath);
      assert.equal(pool.listAccounts().length, 0);
      const files = await readdir(root);
      assert.ok(files.some(name => name.includes(".pre-v3-")));
      assert.ok(files.some(name => name.includes(".legacy-")));
    } finally {
      pool.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy account-pool database with v2 schema migrates without ledger and accounts remain readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-legacy-adopted-"));
  const databasePath = join(root, "pool.sqlite");
  const secretsDirectory = join(root, "secrets");
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE pool_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        upstream_account_id TEXT NOT NULL,
        priority INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        email TEXT,
        subscription_type TEXT,
        rate_limit_tier TEXT,
        last_used_at INTEGER,
        last_used_host_id TEXT,
        reset_credit_count INTEGER CHECK(reset_credit_count >= 0),
        reset_credits_observed_at INTEGER
      ) STRICT;
      CREATE TABLE pool_affinity (
        affinity_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES pool_accounts(id) ON DELETE CASCADE,
        last_used_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE pool_active_account (
        provider TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES pool_accounts(id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE pool_quota (
        account_id TEXT PRIMARY KEY REFERENCES pool_accounts(id) ON DELETE CASCADE,
        utilization REAL,
        reset_at INTEGER,
        held_until INTEGER,
        error TEXT,
        observed_at INTEGER NOT NULL,
        limit_windows_json TEXT NOT NULL DEFAULT '[]'
      ) STRICT;
      INSERT INTO pool_accounts VALUES('account-a','codex','A','chatgpt-a',1,1,1000,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    `);
    legacy.close();
    const pool = new AccountPoolStore({ databasePath, secretsDirectory, now: () => 2_000 });
    try {
      assert.equal(pool.outcome.status, "migrated");
      assert.ok(pool.outcome.backupPath);
      assert.equal(pool.listAccounts()[0]?.id, "account-a");
      assert.deepEqual(pool.listAccountStates()[0], {
        accountId: "account-a", email: null, subscriptionType: null, rateLimitTier: null, resetCredits: null,
        lastUsedAt: null, lastUsedHostId: null, observedAt: null, heldUntil: null, error: null,
        limitWindows: [], status: "ready",
      });
      const files = await readdir(root);
      assert.ok(files.some(name => name.includes(".pre-v3-")));
      assert.equal(files.some(name => name.includes(".legacy-")), false);
    } finally {
      pool.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AccountPoolStore manages SQLite lifecycle: fresh and up-to-date", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-pool-fresh-"));
  const databasePath = join(root, "pool.sqlite");
  const secretsDirectory = join(root, "secrets");
  try {
    const fresh = new AccountPoolStore({ databasePath, secretsDirectory });
    assert.equal(fresh.outcome.status, "fresh");
    fresh.close();

    const reopened = new AccountPoolStore({ databasePath, secretsDirectory });
    assert.equal(reopened.outcome.status, "up-to-date");
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new Codex Threads round-robin before upstream acknowledgement; bound and inherited Threads do not move the cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-balance-"));
  let pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  try {
    for (const [priority, id] of ["a", "b", "c"].entries()) {
      pool.addAccount({ id, provider: "codex", label: id, upstreamAccountId: id, priority, enabled: true },
        { accessToken: `fixture-${id}`, refreshToken: null, expiresAt: null });
    }
    const pick = (id: string, parentAffinityId?: string) => pool.select({ provider: "codex", hostId: "local", affinityId: id, parentAffinityId });
    const first = pick("one");
    const second = pick("two");
    assert.equal(first.account.id, "a");
    assert.equal(second.account.id, "b", "parallel admission cannot wait for first response headers");
    assert.equal(pick("one").account.id, "a", "unacknowledged first request already reserves affinity");
    assert.equal(pick("child", "one").account.id, "a");
    second.accept(); first.accept();
    assert.equal(pick("three").account.id, "c", "out-of-order acknowledgements and inherited affinity cannot rewind cursor");
    pool.close();
    pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    assert.equal(pick("four").account.id, "a", "cursor survives restart and wraps");
    assert.equal(pick("two").account.id, "b");
    const counts = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 30; i++) counts[pick(`new-${i}`).account.id as keyof typeof counts]++;
    assert.deepEqual(counts, { a: 10, b: 10, c: 10 });
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex metadata reads do not allocate affinity or consume round-robin slots", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-balance-"));
  const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  try {
    for (const [priority, id] of ["a", "b"].entries()) pool.addAccount(
      { id, provider: "codex", label: id, upstreamAccountId: id, priority, enabled: true },
      { accessToken: `fixture-${id}`, refreshToken: null, expiresAt: null });
    const token = pool.issueHostToken("local");
    const calls: string[] = [];
    const gate = deferred<void>();
    const admitted = deferred<void>();
    const proxy = new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: "https://fixture.test", fetch: async (_url, init) => {
      calls.push(new Headers(init?.headers).get("chatgpt-account-id")!);
      if (calls.length === 5) admitted.resolve();
      if (init?.method === "POST") await gate.promise;
      return Response.json({ ok: true });
    }});
    const send = (thread?: string) => proxy.handle(new Request(`http://127.0.0.1/v1/${thread ? "responses" : "models"}`, {
      method: thread ? "POST" : "GET", headers: { "x-opencraft-account-pool-token": token, ...(thread ? { "thread-id": thread } : {}) },
      ...(thread ? { body: '{}' } : {}),
    }));
    await send(); await send();
    const first = send("one"), second = send("two"), same = send("one");
    await within(admitted.promise, "parallel requests did not reach upstream");
    assert.deepEqual(calls, ["a", "a", "a", "b", "a"]);
    gate.resolve();
    assert.deepEqual((await Promise.all([first, second, same])).map(response => response.status), [200, 200, 200]);
    await send();
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "three" }).account.id, "a");
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});

test("a late success cannot overwrite a newer fallback assignment or rewind new-Thread routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-account-balance-"));
  const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  try {
    for (const [priority, id] of ["a", "b", "c"].entries()) pool.addAccount(
      { id, provider: "codex", label: id, upstreamAccountId: id, priority, enabled: true },
      { accessToken: `fixture-${id}`, refreshToken: null, expiresAt: null });
    const old = pool.select({ provider: "codex", hostId: "local", affinityId: "one" });
    pool.observeQuota("a", { utilization: 1, resetAt: Date.now() + 60_000 });
    const fallback = pool.select({ provider: "codex", hostId: "local", affinityId: "one", excludeAccountIds: new Set(["a"]) });
    assert.equal(fallback.account.id, "b");
    fallback.accept(); old.accept();
    pool.observeQuota("a", { utilization: 0, resetAt: null });
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "one" }).account.id, "b");
    assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "new" }).account.id, "c");
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});


test("subscription exhaustion can use verified extra credits and persists across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-extra-credits-"));
  const options = { databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets"), now: () => 2_000_000 };
  let pool = new AccountPoolStore(options);
  try {
    pool.addAccount({ id: "paid", provider: "codex", label: "Paid", upstreamAccountId: "paid", priority: 1, enabled: true, allowCredits: true },
      { accessToken: "private", refreshToken: null, expiresAt: null });
    let credits: unknown;
    const usage = () => new CodexSubscriptionService({ store: pool, now: options.now, resolveCredential: async (_account, secret) => secret, fetch: async () => Response.json({
      rate_limit: { allowed: false, primary_window: { used_percent: 100, reset_after_seconds: 600, limit_window_seconds: 604800 } }, credits,
    }) });
    for (const [value, eligible] of [
      [{ has_credits: true, unlimited: false, overage_limit_reached: false }, true],
      [{ has_credits: false, unlimited: true }, true],
      [{ has_credits: false, unlimited: false }, false],
      [{ has_credits: true, overage_limit_reached: true }, false],
      [{ has_credits: "true", unlimited: 1 }, false],
      [undefined, false],
    ] as const) {
      credits = value; const service = usage();
      await service.refreshAccount("paid"); await service.dispose();
      assert.equal(pool.listAccountStates()[0]?.status, eligible ? "ready" : "exhausted");
      assert.equal(pool.listAccountStates()[0]?.limitWindows[0]?.utilization, 1, "never reset the real subscription usage");
      if (eligible) assert.equal(pool.select({ provider: "codex", hostId: "local", affinityId: "test" }).account.id, "paid");
      else assert.throws(() => pool.select({ provider: "codex", hostId: "local", affinityId: "test" }), /eligible/);
    }
    credits = { has_credits: true }; const service = usage();
    await service.refreshAccount("paid"); await service.dispose();
    pool.close(); pool = new AccountPoolStore(options);
    assert.equal(pool.listAccountStates()[0]?.status, "ready");
    assert.equal(pool.listAccountStates()[0]?.limitWindows[0]?.creditsAvailable, true);
    const token = pool.issueHostToken("local"); let calls = 0;
    const proxy = new CodexAccountPoolProxy({ store: pool, now: options.now, upstreamBaseUrl: "https://codex.example.test", fetch: async () => {
      calls++;
      return new Response(null, { status: calls < 3 ? 200 : 429, headers: {
        "x-codex-primary-used-percent": "100", "x-codex-primary-reset-after-seconds": "600",
        ...(calls === 3 ? { "x-codex-credits-has-credits": "true" } : {}),
      } });
    } });
    const request = () => new Request("http://localhost/v1/responses", { method: "POST", body: "{}", headers: { "x-opencraft-account-pool-token": token } });
    assert.equal((await proxy.handle(request())).status, 200);
    assert.equal((await proxy.handle(request())).status, 200, "ordinary headers without credits must preserve the usage fact");
    assert.equal((await proxy.handle(request())).status, 429);
    assert.equal(pool.listAccountStates()[0]?.status, "exhausted", "a real upstream rejection overrides the credits flag");
    assert.equal((await proxy.handle(request())).status, 429);
    assert.equal(calls, 3, "do not retry a rejected exhausted account");
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});


test("loopback bridge preserves compressed native request bytes and encoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-image-binary-"));
  const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  let server: Awaited<ReturnType<typeof startCodexAccountPoolServer>> | undefined;
  try {
    pool.addAccount({ id: "a", provider: "codex", label: "A", upstreamAccountId: "a", priority: 1, enabled: true },
      { accessToken: "upstream-only", refreshToken: null, idToken: null, expiresAt: null });
    const body = gzipSync(Buffer.from('{"model":"test","input":[]}'));
    const proxy = new CodexAccountPoolProxy({ store: pool, upstreamBaseUrl: "https://codex.example.test", fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("content-encoding"), "gzip");
      assert.deepEqual(Buffer.from(init?.body as Uint8Array), body);
      return Response.json({ preserved: true });
    } });
    server = await startCodexAccountPoolServer({ proxy });
    const response = await fetch(`${server.url}/v1/responses`, { method: "POST", headers: {
      "content-encoding": "gzip", "x-opencraft-account-pool-token": pool.issueHostToken("test"), "thread-id": "binary-thread",
    }, body });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { preserved: true });
  } finally { await server?.close(); pool.close(); await rm(root, { recursive: true, force: true }); }
});


test("credit policy is account-scoped, persistent and gates bound Threads at 98% and 100%", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-credit-policy-"));
  const options = { databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets"), now: () => 2_000 };
  let pool = new AccountPoolStore(options);
  try {
    for (const id of ["a", "b"]) pool.addAccount(
      { id, provider: "codex", label: id, upstreamAccountId: id, priority: 1, enabled: true },
      { accessToken: `fixture-${id}`, refreshToken: null, expiresAt: null });
    assert.equal(pool.getAccount("a").allowCredits, false, "new accounts must opt in");
    const pick = () => pool.select({ provider: "codex", hostId: "test", affinityId: "bound" });
    assert.equal(pick().account.id, "a");
    pool.setAllowCredits("a", true);
    for (const utilization of [0.98, 1]) {
      for (const id of ["a", "b"]) pool.observeQuota(id, { utilization, resetAt: 9_000, limitWindows: [{
        slot: "primary", windowMinutes: 300, utilization, resetAt: 9_000,
        status: utilization === 1 ? "rejected" : "allowed", observedAt: 2_000, source: "usage", creditsAvailable: true,
      }] });
      assert.deepEqual(pool.listAccountStates().map(state => state.status), ["ready", "exhausted"]);
      assert.equal(pick().account.id, "a");
    }
    pool.close(); pool = new AccountPoolStore(options);
    assert.equal(pool.getAccount("a").allowCredits, true);
    assert.equal(pool.getAccount("b").allowCredits, false);
    assert.equal(pick().account.id, "a", "affinity and policy survive restart");
    pool.setAllowCredits("a", false);
    assert.throws(pick, /No eligible account/, "disabling policy also gates existing affinity");
    pool.setAllowCredits("a", true);
    assert.equal(pick().account.id, "a");
    pool.observeQuota("a", { utilization: 1, resetAt: 9_000, limitWindows: [{
      slot: "primary", windowMinutes: 300, utilization: 1, resetAt: 9_000,
      status: "rejected", observedAt: 2_001, source: "header", creditsAvailable: false,
    }] });
    assert.throws(pick, /No eligible account/, "the toggle cannot override an actual rejection");
    assert.throws(() => pool.setAllowCredits("a", "true" as any), /Invalid credit policy/);
    assert.throws(() => pool.setAllowCredits("missing", true), /Account not found/);
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});
