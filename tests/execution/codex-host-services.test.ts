import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import {
  CodexHostServices,
  codexAccountsService,
  codexTasksService,
} from "../../apps/opencraft-daemon/src/codex-host-services.ts";
import { CodexNativeReader } from "../../apps/opencraft-daemon/src/codex-native-reader.ts";

test("Host metadata reads the split runtime socket with broker auth from the account Core", async t => {
  const directory = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "oc-reader-"));
  const accountPath = join(directory, "account.sock");
  const runtimePath = join(directory, "runtime.sock");
  const nativePath = join(directory, "native.sock");
  const accountRequests: Array<[string | undefined, string | undefined]> = [];
  const runtimeRequests: Array<[string | undefined, string | undefined]> = [];
  const auth = { accessToken: "fixture", chatgptAccountId: "opencraft-account-pool" };
  const models = { data: [{ id: "fixture-model" }], nextCursor: null };
  const account = createServer((req, res) => {
    accountRequests.push([req.url, req.headers.authorization]);
    res.setHeader("content-type", "application/json");
    if (req.url !== "/launch") {
      res.writeHead(404).end(JSON.stringify({ error: "Account Core has no runtime owner" }));
      return;
    }
    res.end(JSON.stringify({ dataDirectory: directory, launch: {
      args: [], env: { OPENCRAFT_CODEX_POOL_AUTH_TOKEN: "fixture" }, auth: { type: "chatgptAuthTokens", ...auth },
    } }));
  });
  const runtime = createServer((req, res) => {
    runtimeRequests.push([req.url, req.headers.authorization]);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ protocolVersion: 1, pid: 1, codexPid: 2, nativeSocket: "/brain-only/native.sock" }));
  });
  const native = createServer();
  const sockets = new WebSocketServer({ server: native });
  let receivedAuth: unknown;
  sockets.on("connection", socket => {
    let listRequest: number | undefined;
    socket.on("message", raw => {
      const frame = JSON.parse(String(raw));
      if (frame.method === "initialize") socket.send(JSON.stringify({ id: frame.id, result: {} }));
      if (frame.method === "initialized") socket.send(JSON.stringify({ id: "refresh", method: "account/chatgptAuthTokens/refresh" }));
      if (frame.id === "refresh") receivedAuth = frame.result;
      if (frame.method === "model/list") listRequest = frame.id;
      if (receivedAuth && listRequest !== undefined) {
        socket.send(JSON.stringify({ id: listRequest, result: models }));
        listRequest = undefined;
      }
    });
  });
  let fenced = 0;
  const reader = new CodexNativeReader(accountPath, "account-token", 1500, {
    endpoint: runtimePath,
    token: async () => "runtime-token",
    nativeSocket: nativePath,
    fence: async operation => { fenced++; return operation(); },
  });
  const servers = [[account, accountPath], [runtime, runtimePath], [native, nativePath]] as const;
  t.after(async () => {
    reader.close();
    sockets.close();
    await Promise.all(servers.map(([server]) => new Promise<void>(resolve => server.close(() => resolve()))));
    rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all(servers.map(([server, path]) => new Promise<void>(resolve => server.listen(path, resolve))));

  assert.deepEqual(await reader.request("model/list", {}), models);
  assert.deepEqual(accountRequests, [["/launch", "Bearer account-token"]]);
  assert.deepEqual(runtimeRequests, [["/native-health", "Bearer runtime-token"]]);
  assert.equal(fenced, 1);
  assert.deepEqual(receivedAuth, auth);
});

function routing() {
  const sent: any[] = [],
    listeners = new Set<(frame: string) => void>();
  let closed = false;
  const transport = {
    status: { state: "open" as const },
    async connect() {},
    subscribeStatus() {
      return () => {};
    },
    subscribeMessage(listener: (frame: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(raw: string) {
      const frame = JSON.parse(raw);
      sent.push(frame);
      if (frame.id !== undefined) {
        const result =
          frame.method === "initialize"
            ? { userAgent: "codex", capabilities: { extensions: { "opencraft/thread-queue": { version: 2 } } } }
            : { routed: frame.method };
        for (const listener of listeners)
          listener(JSON.stringify({ id: frame.id, result, [LOGICAL_CLIENT_FIELD]: frame[LOGICAL_CLIENT_FIELD] }));
      }
    },
    async close() {
      closed = true;
    },
  };
  return {
    transport,
    sent,
    get closed() {
      return closed;
    },
  };
}

test("Host-wide duties are answered by the front; Thread work goes to routing untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-host-services-"));
  const inner = routing(),
    frames: any[] = [];
  let opened = 0,
    serviceClosed = false;
  const services = new CodexHostServices(inner.transport as any, (clients) => [
    {
      ...codexTasksService(join(directory, "tasks.sqlite"), clients, () => {
        opened++;
      }),
    },
    {
      handles: (method) => method === "fixture/boom",
      request: () => {
        throw Object.assign(new Error("boom"), { code: -32042 });
      },
      capabilities: () => ({ "fixture/front": { version: 1 } }),
      close: () => {
        serviceClosed = true;
      },
    },
  ]);
  services.subscribeMessage((frame) => frames.push(JSON.parse(frame)));
  const send = async (id: number | undefined, method: string, params: unknown = {}, client = "a") => {
    await services.send(
      JSON.stringify({ ...(id === undefined ? {} : { id }), method, params, [LOGICAL_CLIENT_FIELD]: client }),
    );
    return frames.find((frame) => frame.id === id);
  };
  try {
    assert.equal(
      (await send(90, "opencraft/tasks/list", {}, "early")).error.code,
      -32600,
      "an uninitialized client is refused, as before",
    );
    const init = await send(1, "initialize", { clientInfo: { name: "t", version: "1" } });
    assert.deepEqual(
      init.result.capabilities.extensions,
      { "opencraft/thread-queue": { version: 2 }, "fixture/front": { version: 1 } },
      "routing capabilities kept, front ones added",
    );
    await send(2, "initialize", {}, "b");
    const task = (id: string, title: string) => ({
      id,
      title,
      description: "",
      projectServerId: null,
      projectId: null,
      status: "todo",
    });
    const created = await send(3, "opencraft/tasks/create", task("task-1", "Write the plan"));
    assert.equal(created.error, undefined, JSON.stringify(created.error));
    assert.equal(created[LOGICAL_CLIENT_FIELD], "a");
    assert.ok(existsSync(join(directory, "tasks.sqlite")));
    assert.equal(opened, 1, "the store opening is reported once");
    assert.deepEqual(
      services.storage().map((row) => row.name),
      ["tasks"],
    );
    assert.equal(
      frames
        .filter((f) => f.method === "opencraft/tasks/changed")
        .map((f) => f[LOGICAL_CLIENT_FIELD])
        .sort()
        .join(),
      "a,b",
      "every initialized client hears the change",
    );
    assert.ok(
      !inner.sent.some((frame) => String(frame.method).startsWith("opencraft/tasks/")),
      "tasks never reach Thread routing",
    );
    assert.deepEqual((await send(4, "thread/list")).result, { routed: "thread/list" });
    assert.deepEqual((await send(5, "fixture/boom")).error, { code: -32042, message: "boom" });
    assert.equal((await send(6, "opencraft/tasks/frobnicate")).error.code !== undefined, true);
    await send(undefined, "runtime/client/disconnect", {}, "b");
    const before = frames.filter((f) => f.method === "opencraft/tasks/changed").length;
    await send(7, "opencraft/tasks/create", task("task-2", "Second"));
    assert.equal(
      frames.filter((f) => f.method === "opencraft/tasks/changed").length,
      before + 1,
      "a disconnected client hears nothing",
    );
    assert.ok(
      inner.sent.some((frame) => frame.method === "runtime/client/disconnect"),
      "disconnect still reaches routing",
    );
  } finally {
    await services.close();
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(inner.closed, true);
  assert.equal(serviceClosed, true);
});

test("Core-backed accounts are relayed by the front, before initialize too, with the account failure shape", async () => {
  const calls: unknown[] = [];
  const control = {
    async accountRequest(method: string, params: Record<string, unknown>) {
      calls.push([method, params]);
      if (method.endsWith("/remove")) throw new Error("Core refused");
      return { accounts: [{ id: "a1" }] };
    },
  };
  const inner = routing(),
    frames: any[] = [];
  const services = new CodexHostServices(inner.transport as any, () => [codexAccountsService(control)]);
  services.subscribeMessage((frame) => frames.push(JSON.parse(frame)));
  const send = async (id: number, method: string, params: unknown = {}) => {
    await services.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: "early" }));
    return frames.find((frame) => frame.id === id);
  };
  try {
    assert.deepEqual(
      (await send(1, "opencraft/codex/accounts/list")).result,
      { accounts: [{ id: "a1" }] },
      "no initialize needed, as before",
    );
    const failed = (await send(2, "opencraft/codex/accounts/remove", { accountId: "a1" })).error;
    assert.equal(failed.code, -32020);
    assert.ok(failed.data.codexAccountFailure);
    assert.equal((await send(3, "opencraft/codex/accounts/personal/start")).error.code, -32020);
    assert.deepEqual(
      calls.map((call: any) => call[0]),
      ["opencraft/codex/accounts/list", "opencraft/codex/accounts/remove"],
      "personal subscriptions never reach Core here",
    );
    assert.ok(!inner.sent.some((frame) => String(frame.method).startsWith("opencraft/codex/accounts/")));
  } finally {
    await services.close();
  }
});

test("models, permission profiles and pins are read from native Codex by the front, with bridge identities", async () => {
  const { codexModelsService, codexPinsService } =
    await import("../../apps/opencraft-daemon/src/codex-host-services.ts");
  const PINNED = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
  const calls: any[] = [];
  const native = {
    async request(method: string, params: any) {
      calls.push([method, params]);
      if (method === "model/list")
        return {
          data: [
            { id: "gpt-x", model: "gpt-x" },
            { id: "configured/provider-a/m", model: "configured/provider-a/m" },
            { id: "cursor-x", model: "cursor-x", agentId: "cursor", agentLabel: "Cursor" },
          ],
          nextCursor: "next",
        };
      if (method === "permissionProfile/list")
        return { data: [{ id: ":workspace" }, { id: ":danger-no-sandbox" }], nextCursor: null };
      if (method === "threadSection/list") return { data: [{ id: PINNED }], nextCursor: null };
      if (method === "thread/list")
        return {
          data: ["native-1", "plain"].map((id) => ({ id, cwd: "/w", updatedAt: 1, preview: "", turns: [] })),
          nextCursor: null,
        };
      if (method === "thread/read") return { thread: { id: params.threadId, section: null } };
      if (method === "thread/section/move") return {};
      throw Object.assign(new Error("nope"), { code: -32601 });
    },
  };
  const broadcasts: any[] = [];
  const clients = { broadcast: (method: string, params: any) => broadcasts.push([method, params]) };
  const identities = {
    toNative: (id: string) => (id === "bridge:codex:p" ? "native-1" : undefined),
    toPublic: (id: string) => (id === "native-1" ? "bridge:codex:p" : undefined),
  };
  const context = { sender: null } as any;
  const models = codexModelsService(native),
    pins = codexPinsService(native, clients, identities);
  assert.deepEqual(await models.request("model/list", {}, context), {
    data: [
      { id: "gpt-x", model: "gpt-x", agentId: "codex", agentLabel: "Codex" },
      { id: "configured/provider-a/m", model: "configured/provider-a/m", agentId: "codex", agentLabel: "Codex" },
      { id: "cursor-x", model: "cursor-x", agentId: "cursor", agentLabel: "Cursor" },
    ],
    nextCursor: "next",
  });
  const profiles = (await models.request("permissionProfile/list", {}, context)) as any;
  assert.ok(
    Array.isArray(profiles.data) && profiles.data.length > 0,
    "profiles are projected into the OpenCraft catalog",
  );
  const directory = mkdtempSync(join(tmpdir(), "gateway-"));
  process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = join(directory, "gateway.sqlite");
  try {
    // An unregistered provider stays visible; a registered, unshared one is hidden from others.
    assert.equal(((await models.request("model/list", {}, context)) as any).data.length, 3);
    const { ModelGatewayStore } = await import("@opencraft/account-pool-host");
    const store = new ModelGatewayStore(join(directory, "gateway.sqlite"));
    try {
      store.prepareContribution("provider-a", "owner", "openai");
    } finally {
      store.close();
    }
    assert.deepEqual(
      ((await models.request("model/list", {}, context)) as any).data.map((row: any) => row.id),
      ["gpt-x", "cursor-x"],
      "a configured gateway model is hidden from whom it may not serve",
    );
  } finally {
    delete process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
    rmSync(directory, { recursive: true, force: true });
  }
  assert.deepEqual(
    ((await pins.request("opencraft/thread-pins/list", {}, context)) as any).data.map((row: any) => row.id),
    ["bridge:codex:p", "plain"],
  );
  await pins.request("opencraft/thread-pins/set", { threadId: "bridge:codex:p", pinned: true }, context);
  assert.deepEqual(
    calls.filter((c) => c[0] === "thread/section/move").map((c) => c[1]),
    [{ threadId: "native-1", sectionId: PINNED }],
  );
  assert.deepEqual(broadcasts, [["thread/pins/updated", { threadId: "bridge:codex:p" }]]);
  await assert.rejects(
    pins.request("opencraft/thread-pins/set", { threadId: 7 }, context),
    (error: any) => error.code === -32000,
  );
});
