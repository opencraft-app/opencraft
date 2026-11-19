import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  AccountPoolStore,
  CodexAccountService,
  ModelGatewayStore,
} from "../../packages/account-pool-host/src/index.js";

test("personal subscription reconnect uses only the owning Human account and private proxy token", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-subscription-"));
  const previous = process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
  const path = join(root, "gateway.sqlite");
  process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = path;
  const ledger = new ModelGatewayStore(path),
    options = { databasePath: join(root, "account-pool.sqlite"), secretsDirectory: join(root, "secrets") };
  const alice = new AccountPoolStore({ ...options, ownerActor: "alice" }),
    platform = new AccountPoolStore(options);
  alice.addAccount(
    {
      id: "alice-account",
      label: "Alice",
      provider: "codex",
      upstreamAccountId: "alice-upstream",
      priority: 1,
      enabled: true,
    },
    { accessToken: "alice-upstream-secret", refreshToken: null, expiresAt: null },
  );
  platform.addAccount(
    {
      id: "platform-account",
      label: "Platform",
      provider: "codex",
      upstreamAccountId: "platform-upstream",
      priority: 1,
      enabled: true,
    },
    { accessToken: "platform-upstream-secret", refreshToken: null, expiresAt: null },
  );
  let starts = 0;
  const seen: string[] = [];
  const service = await CodexAccountService.start({
    executable: "unused",
    dataDirectory: root,
    nativeCodexHomeDirectory: join(root, "native"),
    createMaintenanceClient: async () => ({
      request: async <T>() => {
        starts++;
        return {
          type: "chatgptDeviceCode",
          loginId: "fixture",
          verificationUrl: "https://auth.example.test/device",
          userCode: "ABCD",
        } as T;
      },
      subscribeNotification: () => () => {},
      close: async () => {},
    }),
    fetch: async (url, init) => {
      if (String(url).includes("/models")) seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json(
        String(url).includes("/models")
          ? { models: [{ slug: "codex-fixture", display_name: "Codex Fixture" }] }
          : { plan_type: "pro" },
      );
    },
  });
  t.after(async () => {
    await service.close();
    alice.close();
    platform.close();
    ledger.close();
    if (previous === undefined) delete process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
    else process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = previous;
    await rm(root, { recursive: true, force: true });
  });
  const connected = (await service.request("opencraft/codex/accounts/personal/start", { actor: "alice" })) as any;
  assert.equal(connected.status, "complete");
  assert.equal(starts, 0);
  assert.doesNotMatch(JSON.stringify(connected), /alice-upstream-secret|platform-upstream-secret/);
  assert.equal(connected.connection.models[0].id, "codex-fixture");
  const hash = createHash("sha256").update("alice").digest("hex");
  assert.equal(connected.connection.providerId, "subscription-" + hash);
  assert.equal(seen.includes("Bearer alice-upstream-secret"), true);
  assert.equal(seen.includes("Bearer platform-upstream-secret"), false);
  const global = (await service.request("opencraft/codex/accounts/list", {})) as any;
  assert.deepEqual(
    global.accounts.map((a: any) => a.id),
    ["platform-account"],
  );
  const pending = (await service.request("opencraft/codex/accounts/personal/start", { actor: "bob" })) as any;
  const again = (await service.request("opencraft/codex/accounts/personal/start", { actor: "bob" })) as any;
  assert.equal(pending.status, "pending");
  assert.equal(again.login.sessionId, pending.login.sessionId);
  assert.equal(starts, 1);
  const foreign = (await service.request("opencraft/codex/accounts/personal/poll", {
    actor: "alice",
    sessionId: pending.login.sessionId,
  })) as any;
  assert.equal(foreign.status, "error");
  ledger.prepareContribution("subscription-" + hash, "alice", "codex-subscription");
  ledger.contributionState("subscription-" + hash, "alice", "shared");
  const url = connected.connection.baseUrl + "/models",
    launch = service.launch();
  assert.equal(
    (await fetch(url, { headers: { authorization: "Bearer " + launch.env.OPENCRAFT_CODEX_POOL_AUTH_TOKEN } })).status,
    401,
  );
  assert.equal(
    (await fetch(url, { headers: { authorization: "Bearer " + connected.connection.proxyToken } })).status,
    200,
  );
  ledger.contributionState("subscription-" + hash, "alice", "withdrawn");
  assert.equal(
    (await fetch(url, { headers: { authorization: "Bearer " + connected.connection.proxyToken } })).status,
    403,
  );
});

test("subscription Unix-socket relay streams responses and authenticates the control plane", async (t) => {
  const { CodexCoreControlClient } = await import("../../packages/account-pool-host/src/codex-core-control.js");
  const { startControlServer } = await import("../../apps/codex-core/src/control-server.js");
  const root = await mkdtemp(join(tmpdir(), "subscription-relay-")),
    endpoint = join(root, "core.sock");
  let received = "";
  const server = await startControlServer(endpoint, "core-token", async (request) => {
    assert.equal(request.headers["x-opencraft-subscription-token"], "private-proxy-token");
    for await (const part of request) received += part.toString();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("data: complete\n\n"));
            controller.close();
          }, 20);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const path = "http://127.0.0.1:1/personal/" + "a".repeat(64) + "/v1/responses";
  const input = () =>
    new Request(path, {
      method: "POST",
      headers: { authorization: "Bearer private-proxy-token", "content-type": "application/json" },
      body: '{"model":"codex-fixture"}',
    });
  const response = await new CodexCoreControlClient(endpoint, "core-token").subscriptionRequest(input());
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n");
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: complete\n\n");
  assert.equal((await reader.read()).done, true);
  assert.equal(received, '{"model":"codex-fixture"}');
  assert.equal((await new CodexCoreControlClient(endpoint, "wrong-token").subscriptionRequest(input())).status, 401);
});

test("a personal subscription follows its Core after restart instead of reusing the saved proxy port", async (t) => {
  const { createServer } = await import("node:http");
  const root = await mkdtemp(join(tmpdir(), "subscription-restart-")),
    previous = process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
  const path = join(root, "gateway.sqlite");
  process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = path;
  const ledger = new ModelGatewayStore(path),
    hash = createHash("sha256").update("alice").digest("hex"),
    provider = "subscription-" + hash,
    model = "configured/" + provider + "/codex-fixture";
  ledger.configure("alice", { monthlyTokens: 1000, requestTokens: 100, concurrency: 2 }, 0, "admin");
  ledger.prepareContribution(provider, "alice", "codex-subscription");
  ledger.contributionState(provider, "alice", "shared");
  const accounts = new AccountPoolStore({
    databasePath: join(root, "account-pool.sqlite"),
    secretsDirectory: join(root, "secrets"),
    ownerActor: "alice",
  });
  accounts.addAccount(
    { id: "alice", provider: "codex", label: "Alice", upstreamAccountId: "alice", enabled: true, priority: 1 },
    { accessToken: "synthetic-alice", refreshToken: null, expiresAt: null },
  );
  accounts.close();
  let connection: any;
  let staleCalls = 0;
  const stale = createServer((_req, res) => {
    staleCalls++;
    res.writeHead(503);
    res.end();
  });
  const options: Parameters<typeof CodexAccountService.start>[0] = {
    executable: "unused",
    dataDirectory: root,
    nativeCodexHomeDirectory: join(root, "native"),
    createMaintenanceClient: async () => {
      throw Error("No login or refresh expected");
    },
    configuredResponses: {
      catalog: async () => [],
      resolve: async (selected) =>
        selected === model
          ? { baseUrl: connection.baseUrl, model: "codex-fixture", apiKey: connection.proxyToken }
          : null,
    },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return fetch(input, init);
      if (url.includes("/models")) return Response.json({ models: [{ slug: "codex-fixture" }] });
      if (url.endsWith("/responses")) {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-alice");
        return Response.json({
          id: "fixture",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }
      return Response.json({ plan_type: "pro" });
    },
  };
  let service = await CodexAccountService.start(options);
  t.after(async () => {
    await service.close();
    await new Promise<void>((r) => stale.close(() => r()));
    ledger.close();
    if (previous === undefined) delete process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
    else process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = previous;
    await rm(root, { recursive: true, force: true });
  });
  connection = ((await service.request("opencraft/codex/accounts/personal/start", { actor: "alice" })) as any)
    .connection;
  const invoke = async (thread: string) => {
    ledger.beginExecution(thread, {
      id: thread,
      authorizer: "alice",
      executor: null,
      model,
      expiresAt: Date.now() + 60000,
    });
    const base = JSON.parse(
      service
        .launch()
        .args.find((a) => a.startsWith("chatgpt_base_url="))!
        .slice("chatgpt_base_url=".length),
    );
    const response = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: {
        "x-opencraft-account-pool-token": service.launch().env.OPENCRAFT_CODEX_POOL_AUTH_TOKEN,
        "thread-id": thread,
        "x-codex-turn-metadata": JSON.stringify({ turn_id: thread + "-turn" }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, input: "synthetic" }),
    });
    assert.equal(response.status, 200, await response.text());
  };
  await invoke("before");
  const oldPort = Number(new URL(connection.baseUrl).port);
  await service.close();
  await new Promise<void>((r) => stale.listen(oldPort, "127.0.0.1", r));
  service = await CodexAccountService.start(options);
  await invoke("after");
  assert.equal(staleCalls, 0);
  assert.equal(ledger.summary("alice").usedTokens, 4);
});
