import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountPoolStore } from "../../packages/account-pool-host/src/store.js";
import { CodexResetCreditService, parseCodexResetCredits } from "../../packages/account-pool-host/src/codex-reset-credits.js";
import { CodexAccountsService } from "../../plugins/builtin-agents/src/codex-accounts/service.js";
import { CodexAccountService } from "../../packages/account-pool-host/src/codex-account-service.js";

const now = Date.parse("2026-10-25T00:00:00Z");
const credit = { id: "synthetic-credit-a", reset_type: "codex_rate_limits", status: "available", is_supported_by_plan: true,
  granted_at: "2026-10-01T00:00:00.123456Z", expires_at: "2026-11-01T00:00:00.123456Z" };
const details = (rows: unknown[] = [credit]) => ({ available_count: 2, credits: rows });
const request = { accountId: "a", creditId: credit.id, idempotencyKey: "attempt-one-1234", confirmed: true };

async function setup(fetcher: typeof fetch, refreshUsage: () => Promise<void> = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "oc-reset-redemption-"));
  const store = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
  store.addAccount({ id: "a", provider: "codex", label: "A", upstreamAccountId: "synthetic-upstream-a", priority: 1, enabled: true },
    { accessToken: "synthetic-token", refreshToken: null, expiresAt: null });
  const service = new CodexResetCreditService({ store, fetch: fetcher, now: () => now, refreshUsage, resolveCredential: async (_a, secret) => secret });
  return { store, service, close: async () => { await service.dispose(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("HTTP detail parser normalizes ISO expiry, preserves authoritative count and excludes private profile fields", () => {
  const parsed = parseCodexResetCredits(details([{ ...credit, profile_user_id: "private-profile", profile_image_url: "private-image", title: "Credit" }]), now);
  assert.equal(parsed.availableCount, 2, "the list can be capped; its length is not the total");
  assert.equal(parsed.credits[0]!.expiresAt, Date.parse(credit.expires_at));
  assert.equal(parsed.credits[0]!.expiryKnown, true);
  assert.doesNotMatch(JSON.stringify(parsed), /private-profile|private-image|profile_user/);
  assert.equal(parseCodexResetCredits(details([{ ...credit, expires_at: null }])).credits[0]!.expiryKnown, true);
  assert.equal(parseCodexResetCredits(details([{ ...credit, expires_at: undefined }])).credits[0]!.expiryKnown, false);
  assert.equal(parseCodexResetCredits(details([{ ...credit, expires_at: "bad-date" }])).credits[0]!.expiryKnown, false);
  assert.equal(parseCodexResetCredits({ available_count: "2", credits: [] }).availableCount, null);
  assert.throws(() => parseCodexResetCredits(details([credit, credit])), /identity/);
  assert.throws(() => parseCodexResetCredits({ available_count: 2 }), /details/);
});

test("opening details uses only GET; confirmed redemption binds exact account, coupon and retry key", async () => {
  const calls: { method: string; body: any }[] = [];
  let refreshes = 0;
  const fixture = await setup(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-token");
    assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "synthetic-upstream-a");
    assert.equal(init?.redirect, "error");
    if (method === "GET") return Response.json(details());
    assert.equal(String(url), "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
    return Response.json({ outcome: "reset" });
  }, async () => { refreshes++; });
  try {
    await fixture.service.list("a");
    assert.deepEqual(calls.map(call => call.method), ["GET"]);
    const result = await fixture.service.consume(request);
    assert.equal(result.outcome, "reset");
    assert.equal(result.usageRefreshed, true);
    assert.equal(refreshes, 1);
    assert.deepEqual(calls.filter(c => c.method === "POST").map(c => c.body), [{ credit_id: credit.id, redeem_request_id: request.idempotencyKey }]);
    await fixture.service.consume(request);
    assert.equal(calls.filter(c => c.method === "POST").length, 1, "completed attempt is not submitted twice");
    await assert.rejects(fixture.service.consume({ ...request, creditId: "other-credit" }), /identity/);
  } finally { await fixture.close(); }
});

test("confirmation, identity, current status, supported plan and known unexpired expiry are required before POST", async () => {
  for (const changed of [{ status: "redeemed" }, { status: "redeeming" }, { status: "future-state" }, { is_supported_by_plan: false },
    { expires_at: "2026-10-24T00:00:00Z" }, { expires_at: undefined }, { reset_type: "unknown" }, { id: "other-credit" }]) {
    let posts = 0;
    const fixture = await setup(async (_url, init) => {
      if (init?.method === "POST") posts++;
      return Response.json(details([{ ...credit, ...changed }]));
    });
    try {
      await assert.rejects(fixture.service.consume({ ...request, confirmed: false }), /confirmed/);
      await assert.rejects(fixture.service.consume({ ...request, idempotencyKey: "" }), /confirmed/);
      await assert.rejects(fixture.service.consume(request), /not available/);
      assert.equal(posts, 0);
    } finally { await fixture.close(); }
  }
});

test("unknown transport outcome is not retried automatically; explicit retry retains the same upstream key", async () => {
  const bodies: unknown[] = [];
  const fixture = await setup(async (_url, init) => {
    if (init?.method !== "POST") return Response.json(details());
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length === 1) throw new TypeError("synthetic connection lost after commit");
    return Response.json({ outcome: "already_redeemed" });
  });
  try {
    assert.equal((await fixture.service.consume(request)).outcome, "unknown");
    assert.equal(bodies.length, 1);
    assert.equal((await fixture.service.consume(request)).outcome, "alreadyRedeemed");
    assert.deepEqual(bodies[0], bodies[1]);
  } finally { await fixture.close(); }
});

test("unrecognized/failed POST never reports success; failure to refresh does not repeat a successful reset", async () => {
  for (const response of [Response.json({ outcome: "future_value" }), new Response("error", { status: 503 }), new Response("not json")]) {
    let posts = 0;
    const fixture = await setup(async (_url, init) => {
      if (init?.method !== "POST") return Response.json(details());
      posts++; return response;
    });
    try { assert.equal((await fixture.service.consume(request)).outcome, "unknown"); assert.equal(posts, 1); }
    finally { await fixture.close(); }
  }
  let posts = 0;
  const fixture = await setup(async (_url, init) => {
    if (init?.method === "POST") { posts++; return Response.json({ outcome: "reset" }); }
    return Response.json(details());
  }, async () => { throw new Error("synthetic usage unavailable"); });
  try {
    const result = await fixture.service.consume(request);
    assert.equal(result.outcome, "reset"); assert.equal(result.usageRefreshed, false); assert.equal(posts, 1);
  } finally { await fixture.close(); }
});

test("duplicate in-flight attempts coalesce and a different attempt cannot consume concurrently", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let posts = 0;
  const fixture = await setup(async (_url, init) => {
    if (init?.method !== "POST") return Response.json(details());
    posts++; await gate; return Response.json({ outcome: "reset" });
  });
  try {
    const first = fixture.service.consume(request);
    const duplicate = fixture.service.consume(request);
    assert.equal(first, duplicate);
    await assert.rejects(fixture.service.consume({ ...request, idempotencyKey: crypto.randomUUID() }), /in progress/);
    finish(); await first;
    assert.equal(posts, 1);
  } finally { finish(); await fixture.close(); }
});

test("client preserves retry key after lost RPC and never publishes late data after disposal", async () => {
  const calls: any[] = [];
  let fail = true;
  const service = new CodexAccountsService(async (_host, method, params) => {
    calls.push({ method, params });
    if (fail) { fail = false; throw new Error("lost response"); }
    return { outcome: "alreadyRedeemed", credits: null, usageRefreshed: true, accounts: [] } as any;
  }, "synthetic-host");
  await assert.rejects(service.consumeResetCredit("a", credit.id));
  assert.equal(calls.length, 1);
  await service.consumeResetCredit("a", credit.id);
  assert.equal(calls[0].params.idempotencyKey, calls[1].params.idempotencyKey);
  assert.equal(calls[1].params.confirmed, true);
  service.dispose();
  await assert.rejects(service.listResetCredits("a"), /closed/);
});

test("independent account owner exposes capability and both RPCs with synthetic upstream only", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-reset-core-rpc-"));
  const store = new AccountPoolStore({ databasePath: join(root, "account-pool.sqlite"), secretsDirectory: join(root, "secrets") });
  store.addAccount({ id: "a", provider: "codex", label: "A", upstreamAccountId: "synthetic-upstream", priority: 1, enabled: true },
    { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: null });
  store.close();
  let posts = 0;
  const owner = await CodexAccountService.start({ executable: process.execPath, dataDirectory: root,
    nativeCodexHomeDirectory: join(root, "native"), fetch: async (url, init) => {
      if (init?.method === "POST") { posts++; return Response.json({ outcome: "nothing_to_reset" }); }
      return Response.json(String(url).endsWith("/usage") ? { rate_limit_reset_credits: { available_count: 2 } } : details());
    } });
  try {
    const accounts = await owner.request("opencraft/codex/accounts/list", {}) as any;
    assert.equal(accounts.accounts[0].resetCreditActions, true);
    const read = await owner.request("opencraft/codex/accounts/resetCredits/list", { accountId: "a" }) as any;
    assert.equal(read.credits[0].id, credit.id); assert.equal(posts, 0);
    const result = await owner.request("opencraft/codex/accounts/resetCredits/consume", request) as any;
    assert.equal(result.outcome, "nothingToReset"); assert.equal(posts, 1);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-access|synthetic-refresh|synthetic-upstream/);
  } finally { await owner.close(); await rm(root, { recursive: true, force: true }); }
});
