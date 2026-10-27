import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openManagedDatabase } from "../../packages/sqlite-node/src/index.js";
import { AccountPoolStore } from "../../packages/account-pool-host/src/store.js";
import { CodexSubscriptionService, parseCodexUsage } from "../../packages/account-pool-host/src/codex-usage.js";
import { CodexAccountService } from "../../packages/account-pool-host/src/codex-account-service.js";

test("independent Core account owner returns redacted reset counts through its account RPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-reset-core-"));
  let service: CodexAccountService | undefined;
  try {
    const store = new AccountPoolStore({ databasePath: join(root, "account-pool.sqlite"), secretsDirectory: join(root, "secrets") });
    store.addAccount({ id: "a", provider: "codex", label: "A", upstreamAccountId: "upstream-a", priority: 1, enabled: true },
      { accessToken: "fixture-access-a", refreshToken: "fixture-refresh-a", expiresAt: null });
    store.close();
    service = await CodexAccountService.start({ executable: process.execPath, dataDirectory: root,
      nativeCodexHomeDirectory: join(root, "native"), fetch: async () => Response.json({ rate_limit_reset_credits: { available_count: 2 } }) });
    const result = await service.request("opencraft/codex/accounts/refresh", { accountId: "a" }) as { accounts: any[] };
    assert.equal(result.accounts[0].resetCredits.availableCount, 2);
    assert.ok(result.accounts[0].resetCredits.observedAt > 0);
    assert.doesNotMatch(JSON.stringify(result), /fixture-access|fixture-refresh|upstream-a/);
    assert.equal(result.accounts[0].allowCredits, false);
    const changed = await service.request("opencraft/codex/accounts/setAllowCredits", { accountId: "a", allowCredits: true }) as { accounts: any[] };
    assert.equal(changed.accounts[0].allowCredits, true);
    await assert.rejects(service.request("opencraft/codex/accounts/setAllowCredits", { accountId: "a", allowCredits: "true" }), /Invalid credit policy/);

  } finally { await service?.close(); await rm(root, { recursive: true, force: true }); }
});

test("reset credit count uses the backend total, distinguishes zero and unknown, and rejects malformed totals", () => {
  for (const count of [0, 2, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseCodexUsage({ rate_limit_reset_credits: { available_count: count, credits: [] } }).resetCreditCount, count);
  }
  for (const count of [undefined, null, -1, 0.5, "3", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseCodexUsage({ rate_limit_reset_credits: { available_count: count } }).resetCreditCount, null);
  }
  assert.equal(parseCodexUsage({}).resetCreditCount, null);
  assert.equal(parseCodexUsage({ rate_limit_reset_credits: null }).resetCreditCount, null);
  assert.equal(parseCodexUsage({ credits: { balance: "10" } }).resetCreditCount, null);
});

test("count-only usage persists per-account observations; headers and failed refreshes cannot replace them", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-reset-credit-"));
  const options = { databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets"), now: () => now };
  let now = 1_000;
  let pool = new AccountPoolStore(options);
  let response: object | null = { rate_limit_reset_credits: { available_count: 3 } };
  let requests = 0;
  const service = new CodexSubscriptionService({
    store: pool, now: () => now,
    resolveCredential: async (_account, secret) => secret,
    fetch: async (_url, init) => {
      assert.equal(init?.method ?? "GET", "GET");
      requests += 1;
      if (response === null) return new Response(null, { status: 503 });
      return Response.json(response);
    },
  });
  try {
    for (const id of ["a", "b"]) pool.addAccount({
      id, provider: "codex", label: id, upstreamAccountId: `upstream-${id}`, priority: 1, enabled: true,
    }, { accessToken: `fixture-access-${id}`, refreshToken: null, expiresAt: null });
    await Promise.all([service.refreshAccount("a"), service.refreshAccount("a")]);
    assert.equal(requests, 1);
    const credits = () => pool.listAccountStates().find(account => account.accountId === "a")!.resetCredits;
    assert.deepEqual(credits(), { availableCount: 3, observedAt: 1_000 });
    assert.equal(pool.listAccountStates().find(account => account.accountId === "b")!.resetCredits, null);
    now = 2_000;
    pool.observeQuota("a", { utilization: 0.8, resetAt: 9_000 });
    pool.updateSubscriptionMetadata("a", { email: "person@example.test" });
    assert.deepEqual(credits(), { availableCount: 3, observedAt: 1_000 });
    response = null;
    await assert.rejects(service.refreshAccount("a"), /503/);
    assert.deepEqual(credits(), { availableCount: 3, observedAt: 1_000 });
    response = { rate_limit_reset_credits: { available_count: 0 } };
    await service.refreshAccount("a");
    assert.deepEqual(credits(), { availableCount: 0, observedAt: 2_000 });
    await service.dispose();
    pool.close();
    pool = new AccountPoolStore(options);
    assert.deepEqual(credits(), { availableCount: 0, observedAt: 2_000 });
    assert.equal(pool.listAccountStates()[0]!.email, "person@example.test");
    assert.equal(pool.listAccountStates()[0]!.observedAt, 2_000);
    assert.doesNotMatch(JSON.stringify(pool.listAccountStates()), /fixture-access/);
  } finally {
    await service.dispose();
    pool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful response without reset metadata replaces a previously known total with unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-reset-unknown-"));
  const pool = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  try {
    pool.addAccount({ id: "a", provider: "codex", label: "A", upstreamAccountId: "upstream-a", priority: 1, enabled: true },
      { accessToken: "fixture-access-a", refreshToken: null, expiresAt: null });
    pool.updateSubscriptionMetadata("a", { resetCredits: { availableCount: 2, observedAt: 1_000 } });
    const service = new CodexSubscriptionService({ store: pool, resolveCredential: async (_account, secret) => secret,
      fetch: async () => Response.json({ plan_type: "pro" }) });
    await service.refreshAccount("a");
    assert.equal(pool.listAccountStates()[0]!.resetCredits, null);
    assert.equal(pool.listAccountStates()[0]!.subscriptionType, "pro");
    await service.dispose();
  } finally { pool.close(); await rm(root, { recursive: true, force: true }); }
});

test("ledger v1 upgrades without moving aside accounts, credentials, quota or affinity", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-reset-v1-"));
  const databasePath = join(root, "pool.sqlite");
  const secretsDirectory = join(root, "secrets");
  try {
    const sql = (await readFile(new URL("../fixtures/account-pool-v1.sql", import.meta.url), "utf8")).trim();
    const legacy = openManagedDatabase({ path: databasePath, migrations: [{ version: 1, name: "account-pool", sql }] });
    legacy.database.exec(`INSERT INTO pool_accounts VALUES('a','codex','A','upstream-a',1,1,1000,'a@example.test','pro',NULL,1000,'host-a');
      INSERT INTO pool_quota VALUES('a',0.3,9000,NULL,NULL,1000,'[]');
      INSERT INTO pool_affinity VALUES('retained-affinity','a',1000);`);
    legacy.database.close();
    await mkdir(secretsDirectory, { mode: 0o700 });
    await writeFile(join(secretsDirectory, "account-a.json"), JSON.stringify({ accessToken: "fixture-access-a", refreshToken: null, expiresAt: null }), { mode: 0o600 });
    const pool = new AccountPoolStore({ databasePath, secretsDirectory, now: () => 2_000 });
    try {
      assert.equal(pool.outcome.status, "migrated");
      assert.equal(pool.outcome.movedAsidePaths?.length ?? 0, 0);
      assert.equal(pool.listAccounts()[0]!.credentialConfigured, true);
      assert.equal(pool.readCredential("a").accessToken, "fixture-access-a");
      assert.equal(pool.listAccountStates()[0]!.resetCredits, null);
      assert.equal(pool.listAccountStates()[0]!.email, "a@example.test");
      pool.updateSubscriptionMetadata("a", { resetCredits: { availableCount: 2, observedAt: 2_000 } });
    } finally { pool.close(); }
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath);
    try {
      assert.equal(database.prepare("SELECT account_id FROM pool_affinity").get()!.account_id, "a");
      assert.equal(database.prepare("SELECT utilization FROM pool_quota").get()!.utilization, 0.3);
      assert.equal(database.prepare("SELECT max(version) AS version FROM schema_migrations").get()!.version, 3);
    } finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
