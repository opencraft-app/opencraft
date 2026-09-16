import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { AuthenticationService } from "@opencraft/workbench-runtime";
import { authenticationProviderAdapter } from "../apps/workbench-web/src/runtime/authentication-contributions";
import type { AppServerThread, AppServerTurn } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/types";
import { deserialize, serialize } from "bson";
import { IDBFactory } from "fake-indexeddb";

import {
  ExtensionSupervisor,
  type InternalContributionAdapter,
} from "@opencraft/extension-runtime";
import {
  PlatformViewRendererRegistry,
  type PlatformAccountContribution,
  type PlatformViewRendererContribution,
} from "@opencraft/extension-react";
import {
  createLightVelaHermesHostProvider,
  createLightVelaHermesExtension,
  IndexedDbHermesSessionTokenCache,
  LIGHTVELA_ACTIVE_BOT_KEY,
  LIGHTVELA_HERMES_HOST_ID,
  LightVelaAccountService,
  LightVelaHermesTransport,
  LIGHTVELA_TOKEN_KEY,
  lightVelaBotCreationUrl,
  projectLightVelaBotOnboarding,
} from "@opencraft/plugin-lightvela-hermes";
import { EnvironmentDirectory, preflightHostConnection, type HostConnectionProvider } from "@opencraft/workbench-runtime";
import { environmentSourceAdapter } from "../apps/workbench-web/src/runtime/environment-directory/contribution-adapter";
import {
  createHermesDashboardEnsureCommand,
  ensureHermesDashboard,
} from "../plugins/lightvela-hermes/src/lib/hermes-dashboard-ensure";
import {
  TencentTatProxyConnection,
  TencentTatSessionMultiplexer,
} from "../plugins/lightvela-hermes/src/lib/tencent-tat-session-multiplexer";
import { createTatWebSocketConstructor } from "../plugins/lightvela-hermes/src/lib/tat-websocket";
import { HermesAppServerAdapter, isUnmaterializedHermesHistory, mapMessages } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import { HermesBotAppServerHandler } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/bot-protocol-handler";
import { BrowserHermesAppServerBridge } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/index";
import { encodeHermesModelSelection } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/model-catalog";
import { HermesTurnEventStateMachine } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/turn-event-state-machine";
import { dispatchAppServerRequest } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol";
import { HermesDashboardFileSystem } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/dashboard-file-system";
import type { HermesHistoryClient } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/history-client";
import { HermesDashboardHistoryClient } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/history-client";
import { HermesTatTerminalService } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/tat-terminal";
import type { HermesRpcClient } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/rpc-transport";
import {
  HermesReplayCheckpoint,
  HermesRpcWebSocketTransport,
} from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/rpc-transport";

const lightOpenCraftTransportSource = readFileSync(
  new URL("../plugins/lightvela-hermes/src/transport/lightvela-hermes-transport.ts", import.meta.url),
  "utf8",
);

const tatBootstrap = {
  poolId: "pool-1",
  sessionId: "session-1",
  region: "ap-guangzhou",
  instanceId: "instance-1",
  ownerUin: "10001",
  loginUin: "10002",
  appId: 1250000000,
  wsUrl: "wss://tat.example/ws",
  cols: 120,
  rows: 32,
  timeoutSeconds: 3600,
  username: "agentuser",
  workingDirectory: "/workspace/projects",
};

class FakeTatWebSocket {
  static instances: FakeTatWebSocket[] = [];
  binaryType: BinaryType = "blob";
  readyState = WebSocket.CONNECTING;
  sent: Array<string | Uint8Array> = [];
  onopen: ((this: WebSocket, event: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, event: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null;

  constructor(readonly url: string | URL) { FakeTatWebSocket.instances.push(this); }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data === "string") this.sent.push(data);
    else if (ArrayBuffer.isView(data)) {
      this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else if (data instanceof ArrayBuffer) this.sent.push(new Uint8Array(data));
  }
  open() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.call(this as unknown as WebSocket, new Event("open"));
  }
  receive(data: string | Uint8Array) {
    this.onmessage?.call(this as unknown as WebSocket, { data } as MessageEvent);
  }
  close() { this.readyState = WebSocket.CLOSED; }
  remoteClose(code = 1006, reason = "connection lost") {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.call(this as unknown as WebSocket, {
      code,
      reason,
      wasClean: false,
    } as CloseEvent);
  }
}

const FakeTatWebSocketImpl = FakeTatWebSocket as unknown as typeof WebSocket;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test("LightVela first-Bot onboarding is shared and region-aware", () => {
  assert.deepEqual(projectLightVelaBotOnboarding({
    region: "cn",
    phase: "authenticated",
    botCount: 0,
    error: null,
  }), {
    kind: "bot-required",
    createUrl: "https://lightvela.com/agents",
  });
  assert.deepEqual(projectLightVelaBotOnboarding({
    region: "intl",
    phase: "authenticated",
    botCount: 1,
    error: null,
  }), { kind: "ready" });
  assert.equal(lightVelaBotCreationUrl("intl"), "https://lightvela.ai/agents");
  assert.throws(() => projectLightVelaBotOnboarding({
    region: "intl",
    phase: "authenticated",
    botCount: -1,
    error: null,
  }), /non-negative integer/u);
});

test("Hermes dashboard ensure detaches the Host backend from the transient TAT PTY", () => {
  const command = createHermesDashboardEnsureCommand();
  assert.match(command, /command -v setsid/u);
  assert.match(command, /"\$opencraft_detacher" sh -c 'exec 9>&-; exec "\$@"'/u);
  assert.match(command, /opencraft-hermes "\$opencraft_hermes_bin" serve/u);
  assert.doesNotMatch(command, /nohup "\$opencraft_hermes_bin" serve/u);
});

test("a failed TAT proxy stream can close without masking its transport error", async () => {
  const connection = new TencentTatProxyConnection(
    "proxy-1",
    "channel-1",
    {} as TencentTatSessionMultiplexer,
  );
  const reader = connection.readable.getReader();
  connection.markReady();
  connection.fail(new Error("original transport failure"));
  await assert.rejects(reader.read(), /original transport failure/u);
  assert.doesNotThrow(() => connection.markClosed());
});

test("TAT WebSocket preserves native open-before-first-message task ordering", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let answeredHandshake = false;
  const connection = {
    readable: new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
    }),
    write(data: string | Uint8Array | ArrayBuffer) {
      if (answeredHandshake) return true;
      answeredHandshake = true;
      const bytes = typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      const request = new TextDecoder().decode(bytes);
      const key = /Sec-WebSocket-Key:\s*([^\r\n]+)/iu.exec(request)?.[1]?.trim();
      assert.ok(key);
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      const payload = new TextEncoder().encode(JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "gateway.ready", payload: { heartbeat: true } },
      }));
      assert.equal(payload.byteLength < 126, true);
      const responseHead = new TextEncoder().encode([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"));
      const frame = new Uint8Array(2 + payload.byteLength);
      frame[0] = 0x81;
      frame[1] = payload.byteLength;
      frame.set(payload, 2);
      const combined = new Uint8Array(responseHead.byteLength + frame.byteLength);
      combined.set(responseHead);
      combined.set(frame, responseHead.byteLength);
      queueMicrotask(() => controller.enqueue(combined));
      return true;
    },
    close() {},
  };
  const TatWebSocket = createTatWebSocketConstructor({
    async openProxy() { return connection; },
  } as never, { origin: "https://chat.lightvela.com" });
  const socket = new TatWebSocket("ws://127.0.0.1:9119/api/ws");
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
  const firstMessage = await new Promise<MessageEvent>((resolve) => {
    socket.addEventListener("message", (event) => resolve(event as MessageEvent), { once: true });
  });
  assert.equal(JSON.parse(String(firstMessage.data)).params.type, "gateway.ready");
  socket.close();
});

function proxyResponse(type: string, proxyId: string): Uint8Array {
  return serialize({
    Type: type,
    Data: {
      SessionId: tatBootstrap.sessionId,
      ChannelId: proxyId,
      CustomData: "",
      Data: { ProxyId: proxyId },
    },
  });
}

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

test("LightVela account consumes OAuth fragment and owns the Bot catalog", async () => {
  const storage = new MemoryStorage();
  const replacements: string[] = [];
  let authorization: string | null = null;
  let requestCache: RequestCache | undefined;
  const service = new LightVelaAccountService({
    storage,
    location: {
      origin: "https://localhost.lightvela.ai",
      pathname: "/settings",
      search: "?section=lightvela.hermes.settings",
      hash: "#session_token=secret-token&keep=1",
      assign: () => undefined,
    },
    history: {
      state: null,
      replaceState: (_data, _unused, url) => { replacements.push(String(url)); },
    },
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      requestCache = init?.cache;
      return new Response(JSON.stringify({
        code: "OK",
        message: "ok",
        data: {
          items: [
            { created_at: "2026-09-03", instance_id: "bot-running", name: "Hermes", status: "RUNNING" },
            { created_at: "2026-09-03", instance_id: "bot-stopped", name: "Old", status: "STOPPED" },
          ],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(service.bootstrapOAuthFragment(), true);
  assert.equal(storage.getItem(LIGHTVELA_TOKEN_KEY), "secret-token");
  assert.deepEqual(replacements, ["/settings?section=lightvela.hermes.settings#keep=1"]);
  const bots = await service.refreshBots();
  assert.equal(authorization, "Bearer secret-token");
  assert.equal(requestCache, "no-store");
  assert.deepEqual(bots.map(({ instanceId }) => instanceId), ["bot-running"]);
  assert.equal(bots[0]?.status, "running", "the account boundary normalizes executable instance state");
  assert.equal(service.getSnapshot().phase, "authenticated");
  assert.equal(service.getSnapshot().activeBotId, "bot-running");
  assert.equal(storage.getItem(LIGHTVELA_ACTIVE_BOT_KEY), "bot-running");

  service.signOut();
  assert.equal(storage.getItem(LIGHTVELA_TOKEN_KEY), null);
  assert.equal(storage.getItem(LIGHTVELA_ACTIVE_BOT_KEY), null);
  assert.equal(service.getSnapshot().phase, "anonymous");
});

test("LightVela replaces a deleted Bot binding without changing the logical Host identity", async () => {
  const storage = new MemoryStorage();
  storage.setItem(LIGHTVELA_TOKEN_KEY, "secret-token");
  let catalog: readonly Record<string, string>[] = [
    { created_at: "2026-09-03T08:00:00Z", instance_id: "bot-a", name: "Old Bot", status: "RUNNING" },
  ];
  const service = new LightVelaAccountService({
    storage,
    location: {
      origin: "https://localhost.lightvela.ai",
      pathname: "/",
      search: "",
      hash: "",
      assign: () => undefined,
    },
    history: { state: null, replaceState: () => undefined },
    fetchImpl: async () => new Response(JSON.stringify({
      code: "OK",
      message: "ok",
      data: { items: catalog },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.equal((await service.resolveActiveBot()).instanceId, "bot-a");
  assert.equal(storage.getItem(LIGHTVELA_ACTIVE_BOT_KEY), "bot-a");

  catalog = [];
  await service.refreshBots();
  assert.equal(service.getSnapshot().activeBotId, null);
  assert.equal(storage.getItem(LIGHTVELA_ACTIVE_BOT_KEY), null);

  catalog = [
    { created_at: "2026-09-03T09:00:00Z", instance_id: "bot-b", name: "New Bot", status: "RUNNING" },
  ];
  assert.equal((await service.resolveActiveBot()).instanceId, "bot-b");
  assert.equal(service.getSnapshot().activeBotId, "bot-b");
  assert.equal(storage.getItem(LIGHTVELA_ACTIVE_BOT_KEY), "bot-b");
  assert.equal(LIGHTVELA_HERMES_HOST_ID, "velahermes0");
});

test("LightVela preserves an explicit running Bot selection but retires a stale one", async () => {
  const storage = new MemoryStorage();
  storage.setItem(LIGHTVELA_TOKEN_KEY, "secret-token");
  let catalog = [
    { created_at: "2026-09-03", instance_id: "bot-a", name: "A", status: "RUNNING" },
    { created_at: "2026-09-03", instance_id: "bot-b", name: "B", status: "RUNNING" },
  ];
  const service = new LightVelaAccountService({
    storage,
    location: {
      origin: "https://localhost.lightvela.ai",
      pathname: "/",
      search: "",
      hash: "",
      assign: () => undefined,
    },
    history: { state: null, replaceState: () => undefined },
    fetchImpl: async () => new Response(JSON.stringify({
      code: "OK",
      message: "ok",
      data: { items: catalog },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  await service.refreshBots();
  service.selectBot("bot-b");
  catalog = [catalog[1]!, catalog[0]!];
  await service.refreshBots();
  assert.equal(service.getSnapshot().activeBotId, "bot-b", "catalog ordering cannot steal an explicit selection");

  catalog = [
    { created_at: "2026-09-04", instance_id: "bot-c", name: "C", status: "RUNNING" },
  ];
  await service.refreshBots();
  assert.equal(service.getSnapshot().activeBotId, "bot-c", "a deleted selection yields to the new authority");
});

test("LightVela account catalog refresh is one authoritative single-flight", async () => {
  const storage = new MemoryStorage();
  storage.setItem(LIGHTVELA_TOKEN_KEY, "secret-token");
  let requestCount = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = new LightVelaAccountService({
    storage,
    location: {
      origin: "https://localhost.lightvela.ai",
      pathname: "/",
      search: "",
      hash: "",
      assign: () => undefined,
    },
    history: { state: null, replaceState: () => undefined },
    fetchImpl: async () => {
      requestCount += 1;
      await gate;
      return new Response(JSON.stringify({
        code: "OK",
        message: "ok",
        data: {
          items: [{ created_at: "2026-09-03", instance_id: "bot-a", name: "A", status: "RUNNING" }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const first = service.refreshBots();
  const second = service.refreshBots();
  assert.equal(first, second);
  assert.equal(requestCount, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(service.getSnapshot().phase, "authenticated");
  assert.equal(service.getSnapshot().activeBotId, "bot-a");
});

for (const authenticated of [false, true]) {
test(`LightVela account (${authenticated ? "authenticated without Bots" : "anonymous"}) does not gate the workspace`, async () => {
  const context = new Context();
  const authenticationFiber = context.plugin(AuthenticationService); await authenticationFiber;
  const storage = new MemoryStorage();
  if (authenticated) storage.setItem(LIGHTVELA_TOKEN_KEY, "synthetic-test-session");
  const environments = new EnvironmentDirectory();
  const renderers = new PlatformViewRendererRegistry();
  let platformAccount: PlatformAccountContribution | null = null;
  let provider: HostConnectionProvider | null = null;
  const adapters: Record<string, InternalContributionAdapter> = {
    authenticationProvider: authenticationProviderAdapter(context.authentication),
    environmentSource: environmentSourceAdapter(environments),
    platformViewRenderer: {
      prepare(owner, value) {
        const contribution = value as PlatformViewRendererContribution;
        return { commit: () => renderers.register(owner.activationId, contribution) };
      },
    },
    hostConnectionProvider: {
      prepare(_owner, value) {
        provider = value as HostConnectionProvider;
        return { commit: () => () => { provider = null; } };
      },
    },
    platformAccount: {
      prepare(_owner, value) {
        return {
          commit: () => {
            platformAccount = value as PlatformAccountContribution;
            return () => { platformAccount = null; };
          },
        };
      },
    },
  };
  const supervisor = new ExtensionSupervisor({
    platform: "web",
    internalContributions: adapters,
  });
  await supervisor.activate(createLightVelaHermesExtension({
    storage,
    location: {
      origin: "https://localhost.lightvela.ai",
      pathname: "/",
      search: "",
      hash: "",
      assign: () => undefined,
    },
    history: { state: null, replaceState: () => undefined },
    fetchImpl: async () => authenticated
      ? Response.json({ code: "OK", message: "ok", data: { items: [], user: { id: "test-user", name: "Test user" }, hasSubscription: false, passes: [] } })
      : new Response("{}", { status: 401 }),
  }));
  await new Promise<void>(resolve => setImmediate(resolve));

  const views = supervisor.contributions.getSnapshot().views;
  assert.equal(views.length, 11);
  assert.equal(
    views.some(({ contribution }) => contribution.id === "lightvela.hermes.account-view"),
    false,
  );
  assert.ok(views.some(({ contribution }) => contribution.viewType === "lightvela.hermes.models"));
  assert.ok(views.some(({ contribution }) => contribution.viewType === "lightvela.hermes.diagnostics"));
  assert.ok(supervisor.contributions.getSnapshot().settingsPages.some(({ contribution }) => contribution.viewId === "lightvela.hermes.settings-view"));
  const connectorsPage = supervisor.contributions.getSnapshot().settingsPages.find(
    ({ contribution }) => contribution.viewId === "lightvela.hermes.connectors-view",
  )?.contribution;
  assert.equal(connectorsPage?.audience, "internal");
  const managementPages = supervisor.contributions.getSnapshot().settingsPages.filter(
    ({ contribution }) => contribution.management?.familyId === "lightvela.hermes.manage",
  );
  assert.equal(managementPages.length, 9);
  assert.equal(managementPages.filter(({ contribution }) => contribution.management?.scope === "agent").length, 6);
  assert.equal(managementPages.filter(({ contribution }) => contribution.management?.scope === "host").length, 3);
  assert.equal(supervisor.contributions.getSnapshot().workbenchSurfaces[0]?.contribution.viewId, "lightvela.hermes.empty-view");
  assert.equal(supervisor.contributions.getSnapshot().workbenchSurfaces.some(({ contribution }) => contribution.surface === "empty-workbench"), false);
  assert.ok(supervisor.contributions.getSnapshot().workbenchSurfaces.some(({ contribution }) =>
    contribution.surface === "host-connection-intervention"
      && contribution.providerId === "lightvela.hermes"
      && contribution.intervention === "configuration-required"));
  // The extension contributes transport/settings only. Bot identity is
  // discovered from the AppServer `bot/*` catalog after the Host connects.
  assert.deepEqual(supervisor.contributions.getSnapshot().bots, []);
  assert.equal(renderers.resolve("lightvela.hermes.settings") !== null, true);
  assert.equal(renderers.resolve("lightvela.hermes.models") !== null, true);
  assert.equal(renderers.resolve("lightvela.hermes.empty-workbench") !== null, true);
  assert.equal(provider?.id, "lightvela.hermes");
  assert.equal(provider?.settingsPageId, "lightvela.hermes.settings");
  assert.equal(platformAccount, null);
  assert.deepEqual(provider?.targets, ["web", "electron"]);
  assert.deepEqual(
    provider?.validate({ botId: " bot-1 " }, { platform: "web", hostId: LIGHTVELA_HERMES_HOST_ID, profileRevision: 1 }),
    {},
  );
  assert.equal(LIGHTVELA_HERMES_HOST_ID, "velahermes0");

  await supervisor.deactivate("lightvela.hermes");
  assert.equal(provider, null);
  assert.equal(renderers.resolve("lightvela.hermes.settings"), null);
  assert.equal(renderers.resolve("lightvela.hermes.empty-workbench"), null);
  assert.equal(supervisor.contributions.getSnapshot().views.length, 0);
  await supervisor.dispose();
  assert.equal(context.authentication.getSession("lightvela.hermes.account"), null);
  await authenticationFiber.dispose();
});
}

test("LightVela Host preflight validates the selected Bot without minting a TAT session", async () => {
  const storage = new MemoryStorage();
  storage.setItem(LIGHTVELA_TOKEN_KEY, "secret-token");
  const requests: string[] = [];
  const account = new LightVelaAccountService({
    storage,
    location: {
      origin: "https://localhost.lightvela.ai",
      pathname: "/",
      search: "",
      hash: "",
      assign: () => undefined,
    },
    history: { state: null, replaceState: () => undefined },
    fetchImpl: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        code: "OK",
        message: "ok",
        data: {
          items: [{
            created_at: "2026-09-07T00:00:00Z",
            instance_id: "bot-a",
            name: "A",
            status: "RUNNING",
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await account.refreshBots();
  const provider = createLightVelaHermesHostProvider(account);
  const context = {
    platform: "web" as const,
    hostId: LIGHTVELA_HERMES_HOST_ID,
    profileRevision: 0,
  };

  await preflightHostConnection(provider, provider.validate({}, context), context);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.includes("/v1/instances?page=1&page_size=100"), true);
  assert.equal(requests.some((url) => url.includes("/tat/session")), false);
  account.dispose();
});

test("platform View renderer registry enforces unique ownership and idempotent disposal", () => {
  const registry = new PlatformViewRendererRegistry();
  const Component = () => null;
  const dispose = registry.register("owner-a", { viewType: "example.settings", Component });
  assert.equal(registry.resolve("example.settings"), Component);
  assert.throws(
    () => registry.register("owner-b", { viewType: "example.settings", Component }),
    /already registered/u,
  );
  dispose();
  dispose();
  assert.equal(registry.resolve("example.settings"), null);
});

test("one authenticated TAT socket multiplexes PTY and proxy channels", async () => {
  FakeTatWebSocket.instances = [];
  const client = new TencentTatSessionMultiplexer(tatBootstrap, {
    WebSocketImpl: FakeTatWebSocketImpl,
    connectDelayMs: 0,
  });
  const outputs: string[] = [];
  const ptyPromise = client.openPty({ onOutput: (output) => outputs.push(output) });
  const socket = FakeTatWebSocket.instances[0]!;
  socket.open();
  await flush();

  const jsonFrames = socket.sent
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => JSON.parse(frame) as { readonly Type?: string });
  assert.deepEqual(jsonFrames.map((frame) => frame.Type), ["SessionAuth", "PtyStart"]);

  socket.receive(JSON.stringify({ Type: "PtyReady", Data: {} }));
  const pty = await ptyPromise;
  assert.equal(pty.sendInput("printf ready\\n"), true);
  assert.equal(pty.resize(132, 41), true);
  const resizeFrame = socket.sent
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => JSON.parse(frame) as { Type: string; Data: Record<string, unknown> })
    .find((frame) => frame.Type === "PtyResize");
  assert.deepEqual(resizeFrame?.Data, {
    SessionId: "session-1",
    ChannelId: "",
    Cols: 132,
    Rows: 41,
  });
  socket.receive(JSON.stringify({
    Type: "PtyOutput",
    Data: { Output: btoa("ready\\n") },
  }));
  await flush();
  assert.deepEqual(outputs, ["ready\\n"]);

  const proxyPromise = client.openProxy({ port: 9119, proxyId: "dashboard" });
  await flush();
  socket.receive(proxyResponse("PtyProxyReady", "dashboard"));
  const proxy = await proxyPromise;
  assert.equal(proxy.proxyId, "dashboard");
  assert.equal(FakeTatWebSocket.instances.length, 1);
  assert.equal(jsonFrames.filter((frame) => frame.Type === "SessionAuth").length, 1);
  client.close();
});

test("a dedicated TAT PTY keeps itself alive and projects socket loss", async () => {
  FakeTatWebSocket.instances = [];
  const client = new TencentTatSessionMultiplexer(tatBootstrap, {
    WebSocketImpl: FakeTatWebSocketImpl,
    connectDelayMs: 0,
  });
  const errors: Error[] = [];
  const ptyPromise = client.openPty({ onError: error => errors.push(error) }, {
    keepaliveIntervalMs: 5,
  });
  const socket = FakeTatWebSocket.instances[0]!;
  socket.open();
  await flush();
  socket.receive(JSON.stringify({ Type: "PtyReady", Data: {} }));
  const pty = await ptyPromise;

  await new Promise(resolve => setTimeout(resolve, 20));
  const frames = socket.sent
    .filter((frame): frame is string => typeof frame === "string")
    .map(frame => JSON.parse(frame) as { Type: string });
  assert.ok(frames.some(frame => frame.Type === "PtyResize"));

  socket.remoteClose();
  assert.equal(pty.sendInput("echo stale\n"), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /websocket closed/u);
  client.close();
});

test("Hermes command/exec leases a dedicated TAT PTY and preserves AppServer process ownership", async () => {
  FakeTatWebSocket.instances = [];
  let sessions = 0;
  const terminal = new HermesTatTerminalService({
    async createSession() {
      sessions += 1;
      return { ...tatBootstrap, sessionId: `terminal-${sessions}` };
    },
    createMultiplexer: (session) => new TencentTatSessionMultiplexer(session, {
      WebSocketImpl: FakeTatWebSocketImpl,
      connectDelayMs: 0,
    }),
  });
  const output: string[] = [];
  terminal.subscribeNotification((notification) => {
    output.push(atob(notification.params.deltaBase64));
  });

  const completion = terminal.exec({
    command: ["/bin/bash", "--noprofile", "--norc"],
    processId: "terminal-1",
    cwd: "/workspace/projects",
    tty: true,
    streamStdin: true,
    streamStdoutStderr: true,
    size: { cols: 80, rows: 24 },
  });
  await terminal.write({ processId: "terminal-1", deltaBase64: btoa("printf buffered\\n") });
  await terminal.resize({ processId: "terminal-1", size: { cols: 100, rows: 30 } });
  await flush();
  const socket = FakeTatWebSocket.instances[0]!;
  socket.open();
  await flush();
  socket.receive(JSON.stringify({ Type: "PtyReady", Data: {} }));
  await flush();

  const jsonFrames = () => socket.sent
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => JSON.parse(frame) as { Type: string; Data: Record<string, unknown> });
  const inputFrames = () => jsonFrames()
    .filter((frame) => frame.Type === "PtyInput");
  const startFrame = jsonFrames().find((frame) => frame.Type === "PtyStart");
  assert.deepEqual(startFrame?.Data, {
    SessionId: "terminal-1",
    ChannelId: "",
    Cols: 80,
    Rows: 24,
    UserName: "agentuser",
    Cwd: "/workspace/projects",
    Envs: {},
    Program: "/bin/bash",
    Args: ["--noprofile", "--norc"],
  });
  assert.equal("WorkingDirectory" in (startFrame?.Data ?? {}), false);
  assert.equal("MaxIdleTime" in (startFrame?.Data ?? {}), false);
  assert.equal(atob(inputFrames()[0]!.Data.Input as string), "printf buffered\\n");
  const resizeFrames = () => jsonFrames()
    .filter((frame) => frame.Type === "PtyResize");
  assert.deepEqual(resizeFrames()[0]?.Data, {
    SessionId: "terminal-1",
    ChannelId: "",
    Cols: 100,
    Rows: 30,
  });

  await terminal.resize({ processId: "terminal-1", size: { cols: 120, rows: 36 } });
  const terminalResize = resizeFrames().at(-1);
  assert.deepEqual(terminalResize?.Data, {
    SessionId: "terminal-1",
    ChannelId: "",
    Cols: 120,
    Rows: 36,
  });

  await terminal.write({ processId: "terminal-1", deltaBase64: btoa("printf hello\\n") });
  assert.equal(atob(inputFrames().at(-1)!.Data.Input as string), "printf hello\\n");
  socket.receive(JSON.stringify({
    Type: "PtyOutput",
    Seq: 7,
    Data: { Output: btoa("hello\r\n") },
  }));
  socket.receive(JSON.stringify({
    Type: "PtyOutput",
    Seq: 7,
    Data: { Output: btoa("this duplicate frame must be ignored") },
  }));
  socket.receive(JSON.stringify({ Type: "PtyError", Seq: 8, Data: { Error: "logout" } }));
  await flush();

  assert.deepEqual(await completion, { exitCode: 0, stdout: "", stderr: "" });
  assert.deepEqual(output, ["hello\r\n"]);
  assert.equal(sessions, 1);
  terminal.dispose();
});

test("dashboard ensure borrows and releases a PTY without closing its TAT owner", async () => {
  let released = false;
  let command = "";
  const token = await ensureHermesDashboard({
    async openPty(handlers) {
      return {
        sendInput(input) {
          command = input;
          queueMicrotask(() => handlers.onOutput?.("__LV_DASHBOARD_READY__:test-session-token\\n"));
          return true;
        },
        resize: () => true,
        release() { released = true; },
      };
    },
  });
  assert.equal(token, "test-session-token");
  assert.match(command, /127\.0\.0\.1:9119/u);
  assert.match(command, /serve --help/u);
  assert.match(command, /HERMES_DASHBOARD_SESSION_TOKEN/u);
  assert.match(command, /\/api\/health/u);
  assert.match(command, /X-Hermes-Session-Token/u);
  assert.match(command, /window\\\.__HERMES_SESSION_TOKEN__/u);
  assert.match(command, /opencraft_adopt_running_backend/u);
  assert.match(command, /opencraft_retire_owned_backend/u);
  assert.match(command, /opencraft_find_owned_backend_pid/u);
  assert.match(command, /opencraft_validate_backend_pid/u);
  assert.match(command, /ss -ltnp/u);
  assert.match(command, /candidate_uid/u);
  assert.match(command, /\/proc\/\$opencraft_candidate_pid\/cmdline/u);
  assert.match(command, /\/usr\/local\/lib\/hermes-agent\/venv\/bin\/hermes/u);
  assert.doesNotMatch(command, /<<<|dashboard_args=\(|\$\{dashboard_args\[@\]\}/u);
  assert.doesNotMatch(command, /(?:^|;)\s*exit\s*$/u);
  const syntax = spawnSync("/bin/sh", ["-n"], { input: command, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.equal(released, true);
});

test("dashboard ensure surfaces a remote startup failure without waiting for its browser deadline", async () => {
  let released = false;
  await assert.rejects(
    ensureHermesDashboard({
      async openPty(handlers) {
        return {
          sendInput() {
            queueMicrotask(() => handlers.onOutput?.("__LV_DASHBOARD_ERROR__:process_exited\n"));
            return true;
          },
          resize: () => true,
          release() { released = true; },
        };
      },
    }),
    /process_exited/u,
  );
  assert.equal(released, true);
});

test("cached Hermes tokens are scoped by physical instance", async () => {
  const cache = new IndexedDbHermesSessionTokenCache({
    databaseName: `hermes-token-cache-${Date.now()}-${Math.random()}`,
    factory: new IDBFactory(),
  });
  await cache.put("instance-a", "token-a");
  await cache.put("instance-b", "token-b");
  assert.equal(await cache.get("instance-a"), "token-a");
  assert.equal(await cache.get("instance-b"), "token-b");
  cache.close();
});

test("a stale tab cannot delete a newer cached Hermes token", async () => {
  const cache = new IndexedDbHermesSessionTokenCache({
    databaseName: `hermes-token-race-${Date.now()}-${Math.random()}`,
    factory: new IDBFactory(),
  });
  await cache.put("instance-a", "old-token");
  await cache.put("instance-a", "new-token");
  await cache.remove("instance-a", "old-token");
  assert.equal(await cache.get("instance-a"), "new-token");
  cache.close();
});

test("Hermes Host creates one TAT bootstrap and shares its proxy owner", () => {
  assert.equal(lightOpenCraftTransportSource.match(/await createSession\(\)/gu)?.length, 1);
  assert.match(lightOpenCraftTransportSource, /resolveActiveBot\(\)/u);
  assert.doesNotMatch(lightOpenCraftTransportSource, /options\.botId/u);
  assert.match(lightOpenCraftTransportSource, /openDashboardSocket/u);
  assert.match(lightOpenCraftTransportSource, /Hermes session rejected/u);
  assert.match(lightOpenCraftTransportSource, /sessionToken = await ensureHermesDashboard\(proxy\)/u);
  assert.match(lightOpenCraftTransportSource, /\{ proxyClient: proxy, sessionToken \}/u);
  assert.match(lightOpenCraftTransportSource, /createTatWebSocketConstructor\(proxy/u);
});

test("Hermes transport resolves the current Bot before every physical TAT connection", async () => {
  const storage = new MemoryStorage();
  storage.setItem(LIGHTVELA_TOKEN_KEY, "secret-token");
  storage.setItem(LIGHTVELA_ACTIVE_BOT_KEY, "deleted-bot");
  const requests: string[] = [];
  const account = new LightVelaAccountService({
    storage,
    location: {
      origin: "https://localhost.lightvela.ai",
      pathname: "/",
      search: "",
      hash: "",
      assign: () => undefined,
    },
    history: { state: null, replaceState: () => undefined },
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/v1/instances?page=1&page_size=100")) {
        return new Response(JSON.stringify({
          code: "OK",
          message: "ok",
          data: {
            items: [{
              created_at: "2026-09-03T09:00:00Z",
              instance_id: "replacement-bot",
              name: "Replacement",
              status: "RUNNING",
            }],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "stop after binding assertion" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const transport = new LightVelaHermesTransport({ account });

  await assert.rejects(transport.connect(), /stop after binding assertion/u);
  assert.equal(requests.some((url) => url.includes("/v1/instances/replacement-bot/tat/session")), true);
  assert.equal(requests.some((url) => url.includes("/v1/instances/deleted-bot/tat/session")), false);
  assert.equal(storage.getItem(LIGHTVELA_ACTIVE_BOT_KEY), "replacement-bot");
  await transport.close();
});

function createHermesHistoryHarness() {
  const calls: Array<{ method: string; params: unknown }> = [];
  const historyCalls: Array<{ sessionId: string; limit: number; offset: number; order: string }> = [];
  const client: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "session.resume") {
        return {
          session_id: "live-1",
          stored_session_id: "stored-1",
          message_count: 2,
          messages: [],
          info: { cwd: "/workspace/projects/demo", reasoning_effort: "high" },
        } as T;
      }
      if (method === "session.list") {
        return {
          sessions: [{
            id: "stored-1",
            title: "Historical thread",
            preview: "hello",
            started_at: 1_788_000_000,
            message_count: 2,
            source: "desktop",
          }],
        } as T;
      }
      if (method === "profiles.list") {
        return {
          profiles: [{
            name: "default",
            is_default: true,
            last_session: { id: "stored-1" },
          }],
        } as T;
      }
      throw new Error(`Unexpected Hermes call: ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const history: HermesHistoryClient = {
    async readMessages(sessionId, request) {
      historyCalls.push({ sessionId, ...request });
      return {
        session_id: sessionId,
        messages: [
          { role: "user", text: "hello", row_id: 1 },
          { role: "assistant", text: "world", row_id: 2 },
        ],
        pagination: { ...request, returned: 2 },
      };
    },
    dispose() {},
  };
  return {
    adapter: new HermesAppServerAdapter(client, "/workspace/projects", history),
    calls,
    historyCalls,
  };
}

test("Hermes paginated resume exposes a cursor and hydrates stored history", async () => {
  const harness = createHermesHistoryHarness();
  const resumed = await dispatchAppServerRequest(harness.adapter, {
    id: 1,
    method: "thread/resume",
    params: { threadId: "stored-1", excludeTurns: true },
  }) as {
    thread: { turns: unknown[] };
    turnsBackwardsCursor: string | null;
    reasoningEffort: string | null;
  };
  assert.deepEqual(resumed.thread.turns, []);
  assert.equal(resumed.turnsBackwardsCursor, "hermes-messages:0");
  assert.equal(resumed.reasoningEffort, "high");
  assert.equal(harness.calls.some(({ method }) => method === "session.history"), false);

  const page = await dispatchAppServerRequest(harness.adapter, {
    id: 2,
    method: "thread/turns/list",
    params: {
      threadId: "stored-1",
      cursor: resumed.turnsBackwardsCursor,
      limit: 5,
      itemsView: "full",
      sortDirection: "desc",
    },
  }) as { data: Array<{ items: Array<{ type: string; text?: string }> }>; nextCursor: string | null };
  assert.equal(page.data.length, 1);
  assert.deepEqual(page.data[0]?.items.map(({ type }) => type), ["userMessage", "agentMessage"]);
  assert.equal(page.data[0]?.items[1]?.text, "world");
  assert.equal(page.nextCursor, null);
  assert.equal(harness.calls.filter(({ method }) => method === "session.history").length, 0);
  assert.deepEqual(harness.historyCalls.map(({ offset, order }) => ({ offset, order })), [
    { offset: 0, order: "latest" },
  ]);
});

test("Hermes durable projection joins tool declarations and results by tool_call_id", () => {
  const turns = mapMessages("stored-tools", [
    { role: "system", content: "private model scaffolding", id: 1 },
    { role: "user", content: "inspect it", id: 2 },
    {
      role: "assistant",
      content: "I will inspect it.",
      reasoning: "Need to read the file.",
      reasoning_content: "Need to read the file.",
      finish_reason: "tool_calls",
      tool_calls: [{
        id: "call-read",
        type: "function",
        function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
      }],
      id: 3,
    },
    {
      role: "tool",
      tool_call_id: "call-read",
      tool_name: "read_file",
      content: "file contents",
      id: 4,
    },
    { role: "assistant", content: "I will inspect it.", finish_reason: "stop", id: 5 },
    { role: "assistant", content: "Done.", finish_reason: "stop", id: 6 },
    { role: "assistant", content: "must stay private", display_kind: "hidden", id: 7 },
  ]);

  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0]?.items.map(({ type }) => type), [
    "userMessage",
    "reasoning",
    "agentMessage",
    "dynamicToolCall",
    "agentMessage",
    "agentMessage",
  ]);
  assert.deepEqual(turns[0]?.items[1], {
    type: "reasoning",
    id: "hermes-reasoning-stored-tools-3",
    summary: [],
    content: ["Need to read the file."],
  });
  assert.equal(turns[0]?.items[2]?.text, "I will inspect it.");
  assert.equal(turns[0]?.items[2]?.phase, "commentary");
  assert.deepEqual(turns[0]?.items[3], {
    type: "dynamicToolCall",
    id: "hermes-tool-stored-tools-call-read",
    callId: "call-read",
    namespace: "hermes",
    tool: "read_file",
    arguments: { path: "README.md" },
    status: "completed",
    contentItems: [{ type: "inputText", text: "file contents" }],
    success: null,
    durationMs: null,
    activityPresentation: {
      operation: "read",
      grouping: "groupable",
      icon: "read",
      active: "Reading",
      completed: "Read",
      hidden: false,
    },
  });
  assert.equal(turns[0]?.items[4]?.text, "I will inspect it.");
  assert.equal(turns[0]?.items[4]?.phase, "final_answer");
  assert.equal(turns[0]?.items[5]?.text, "Done.");
});

test("Hermes durable projection gives final text ownership over repeated reasoning", () => {
  const turns = mapMessages("stored-repeated-reasoning", [
    { role: "user", content: "hello", id: 1 },
    {
      role: "assistant",
      reasoning: "Hello. How can I help?",
      content: "Hello. How can I help?",
      finish_reason: "stop",
      id: 2,
    },
  ]);

  assert.deepEqual(turns[0]?.items.map(({ type }) => type), ["userMessage", "agentMessage"]);
  assert.equal(turns[0]?.items[1]?.text, "Hello. How can I help?");
});

test("Hermes durable projection restores staged file attachments as typed mentions instead of @file text", () => {
  const path = "/home/agentuser/.hermes/opencraft-attachments/e3a8d764-afc4-4a38-afa3-4aacf3bad0f9-1-1-3-构建-Hermes-CVM-镜像-3.log";
  const turns = mapMessages("stored-file-attachment", [
    { role: "user", content: `这是啥 @file:${path}`, id: 1 },
    { role: "assistant", content: "这是构建日志。", id: 2 },
  ]);

  assert.deepEqual(turns[0]?.items[0], {
    type: "userMessage",
    id: "hermes-stored-file-attachment-1",
    clientId: null,
    content: [
      { type: "text", text: "这是啥", text_elements: [] },
      {
        type: "mention",
        name: "1-1-3-构建-Hermes-CVM-镜像-3.log",
        path,
      },
    ],
  });
});

test("Hermes durable projection restores ordinary quoted @file references as typed mentions", () => {
  const turns = mapMessages("stored-file-reference", [
    { role: "user", content: "review @file:`/workspace/My File.log` please", id: 1 },
    { role: "assistant", content: "Done.", id: 2 },
  ]);

  assert.deepEqual(turns[0]?.items[0]?.content, [
    { type: "text", text: "review please", text_elements: [] },
    { type: "mention", name: "/workspace/My File.log", path: "/workspace/My File.log" },
  ]);
});

test("Hermes durable history restores Turn wall-clock duration without inventing missing time", () => {
  const turns = mapMessages("stored-timing", [
    { role: "user", content: "first", id: 1, timestamp: 100.125 },
    { role: "assistant", content: "working", id: 2, timestamp: 101.25 },
    { role: "tool", content: "done", id: 3, timestamp: 102.5 },
    { role: "assistant", content: "finished", id: 4, timestamp: 103.875 },
    { role: "user", content: "second", id: 5 },
    { role: "assistant", content: "unknown", id: 6 },
  ]);

  assert.deepEqual(
    turns.map(({ startedAt, completedAt, durationMs }) => ({ startedAt, completedAt, durationMs })),
    [
      { startedAt: 100.125, completedAt: 103.875, durationMs: 3_750 },
      { startedAt: null, completedAt: null, durationMs: null },
    ],
  );

  const running = mapMessages("stored-running-timing", [
    { role: "user", content: "still working", id: 1, timestamp: 200 },
    { role: "assistant", content: "partial", id: 2, timestamp: 201 },
  ], true);
  assert.deepEqual(
    running.map(({ status, startedAt, completedAt, durationMs }) => ({ status, startedAt, completedAt, durationMs })),
    [{ status: "inProgress", startedAt: 200, completedAt: null, durationMs: null }],
  );
});

test("Hermes pending clarify is restored as an AppServer question and answered on its owning Gateway", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      const request = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: request });
      if (method === "session.resume") {
        return {
          session_id: "live-clarify",
          stored_session_id: "stored-clarify",
          message_count: 2,
          messages: [],
          running: false,
          info: { cwd: "/workspace" },
          pending_clarify: {
            request_id: "gateway-request",
            question: "Which note?",
            choices: ["Memory", "Document"],
          },
        } as T;
      }
      if (method === "session.list") {
        return { sessions: [{
          id: "stored-clarify",
          title: "Clarify",
          preview: "Which note?",
          started_at: 1_788_000_000,
          message_count: 2,
          source: "desktop",
        }] } as T;
      }
      if (method === "profiles.list") {
        return { profiles: [{ name: "default", is_default: true }] } as T;
      }
      if (method === "clarify.respond") return { ok: true } as T;
      throw new Error(`Unexpected Hermes call: ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const history: HermesHistoryClient = {
    async readMessages(sessionId, request) {
      return {
        session_id: sessionId,
        messages: [
          { role: "user", content: "Which one?", row_id: 10, timestamp: 100 },
          {
            role: "assistant",
            content: "",
            row_id: 11,
            timestamp: 102,
            finish_reason: "tool_calls",
            tool_calls: [{
              id: "model-tool-call",
              type: "function",
              function: { name: "clarify", arguments: "{\"question\":\"Which note?\"}" },
            }],
          },
        ],
        pagination: { ...request, returned: 2 },
      };
    },
    dispose() {},
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", history);
  const interactions: Array<Parameters<Parameters<typeof adapter.subscribeServerRequest>[0]>[0]> = [];
  adapter.subscribeServerRequest((request) => interactions.push(request));

  await dispatchAppServerRequest(adapter, {
    id: 1,
    method: "thread/resume",
    params: { threadId: "stored-clarify" },
  });

  assert.equal(interactions.length, 1);
  const interaction = interactions[0]!;
  assert.equal(interaction.method, "item/tool/requestUserInput");
  assert.equal(interaction.params.threadId, "stored-clarify");
  assert.equal(interaction.params.turnId, "hermes-turn-stored-clarify-10");
  assert.equal(interaction.params.itemId, "hermes-tool-stored-clarify-model-tool-call");
  assert.deepEqual(interaction.params.questions, [{
    id: "answer",
    header: "Clarify",
    question: "Which note?",
    isOther: true,
    isSecret: false,
    options: [
      { label: "Memory", description: "" },
      { label: "Document", description: "" },
    ],
  }]);

  assert.equal(await adapter.respondServerRequest(interaction.id, {
    answers: { answer: { answers: ["Document"] } },
  }), true);
  assert.deepEqual(calls.filter(({ method }) => method === "clarify.respond"), [{
    method: "clarify.respond",
    params: { request_id: "gateway-request", answer: "Document" },
  }]);
  adapter.dispose();
});

test("Hermes tail resume keeps thread turns excluded but fills initialTurnsPage", async () => {
  const harness = createHermesHistoryHarness();
  const resumed = await dispatchAppServerRequest(harness.adapter, {
    id: 1,
    method: "thread/resume",
    params: {
      threadId: "stored-1",
      excludeTurns: true,
      initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" },
    },
  }) as {
    thread: { turns: unknown[] };
    initialTurnsPage: { data: unknown[]; nextCursor: string | null };
  };
  assert.deepEqual(resumed.thread.turns, []);
  assert.equal(resumed.initialTurnsPage.data.length, 1);
  assert.equal(resumed.initialTurnsPage.nextCursor, null);
  assert.equal(harness.calls.filter(({ method }) => method === "session.history").length, 0);
  assert.equal(harness.historyCalls.length, 1);
});

test("Hermes first-Turn promotion treats only an unmaterialized empty history row as empty", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      const request = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: request });
      if (method === "session.create") {
        return {
          session_id: "live-fresh",
          stored_session_id: "stored-fresh",
          message_count: 0,
          messages: [],
          info: { cwd: "/workspace" },
        } as T;
      }
      if (method === "session.list") return { sessions: [] } as T;
      if (method === "prompt.submit") return { status: "running" } as T;
      throw new Error(`Unexpected Hermes call: ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const history: HermesHistoryClient = {
    async readMessages() {
      throw new Error('HTTP 404: {"detail":"Session not found"}');
    },
    dispose() {},
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", history);
  const created = await dispatchAppServerRequest(adapter, {
    id: 1,
    method: "thread/start",
    params: { cwd: "/workspace" },
  }) as { thread: { id: string } };

  const resumed = await dispatchAppServerRequest(adapter, {
    id: 2,
    method: "thread/resume",
    params: { threadId: created.thread.id, excludeTurns: true },
  }) as { thread: { turns: unknown[] }; turnsBackwardsCursor: string | null };

  assert.deepEqual(resumed.thread.turns, []);
  assert.equal(resumed.turnsBackwardsCursor, null);

  await dispatchAppServerRequest(adapter, {
    id: 3,
    method: "turn/start",
    params: {
      threadId: created.thread.id,
      input: [{ type: "text", text: "first message" }],
      clientUserMessageId: "client-first",
    },
  });
  assert.deepEqual(
    calls.filter(({ method }) => method === "prompt.submit").map(({ params }) => params),
    [{ session_id: "live-fresh", text: "first message", queued: true }],
  );
});

test("Hermes accepts Dashboard's Conversation-not-found spelling only for a resumed empty session", () => {
  const empty = {
    extra: { hermes: { messageCount: 0 } },
  } as AppServerThread;
  const materialized = {
    extra: { hermes: { messageCount: 1 } },
  } as AppServerThread;
  const missing = new Error("Conversation not found: 20260915_220527_127dc9");
  assert.equal(isUnmaterializedHermesHistory(empty, missing), true);
  assert.equal(isUnmaterializedHermesHistory(materialized, missing), false);
  assert.equal(isUnmaterializedHermesHistory(empty, new Error("HTTP 500: storage unavailable")), false);
});

test("Hermes resume does not hide a missing durable history that should contain messages", async () => {
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "session.resume") {
        return {
          session_id: "live-materialized",
          stored_session_id: "stored-materialized",
          message_count: 2,
          messages: [],
        } as T;
      }
      if (method === "session.list") return { sessions: [] } as T;
      if (method === "profiles.list") return { profiles: [{ name: "default" }] } as T;
      throw new Error(`Unexpected Hermes call: ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const history: HermesHistoryClient = {
    async readMessages() {
      throw new Error('HTTP 404: {"detail":"Session not found"}');
    },
    dispose() {},
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", history);

  await assert.rejects(
    dispatchAppServerRequest(adapter, {
      id: 1,
      method: "thread/resume",
      params: { threadId: "stored-materialized", excludeTurns: true },
    }),
    /HTTP 404.*Session not found/u,
  );
});

test("Hermes history cursor pages by durable message offset from the bounded transcript window", async () => {
  const allMessages = [
    { role: "user", text: "one", row_id: 1 },
    { role: "assistant", text: "first", row_id: 2 },
    { role: "user", text: "two", row_id: 3 },
    { role: "assistant", text: "second", row_id: 4 },
    { role: "user", text: "three", row_id: 5 },
    { role: "assistant", text: "third", row_id: 6 },
  ];
  const requests: Array<{ offset: number; limit: number }> = [];
  const history: HermesHistoryClient = {
    async readMessages(sessionId, request) {
      requests.push({ offset: request.offset, limit: request.limit });
      const end = Math.max(0, allMessages.length - request.offset);
      const start = Math.max(0, end - request.limit);
      const messages = allMessages.slice(start, end);
      return {
        session_id: sessionId,
        messages,
        pagination: { limit: request.limit, offset: request.offset, order: request.order, returned: messages.length },
      };
    },
    dispose() {},
  };
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "profiles.list") return { profiles: [{ name: "main" }] } as T;
      if (method === "session.resume") return { session_id: "live", messages: [], message_count: 6 } as T;
      if (method === "session.list") return { sessions: [{ id: "stored" }] } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", history);
  const newest = await dispatchAppServerRequest(adapter, {
    id: 1,
    method: "thread/turns/list",
    params: { threadId: "stored", cursor: "hermes-messages:0", limit: 2, sortDirection: "desc" },
  }) as { data: Array<{ items: Array<{ content?: Array<{ text?: string }> }> }>; nextCursor: string | null };
  assert.deepEqual(newest.data.map((turn) => turn.items[0]?.content?.[0]?.text), ["three", "two"]);
  assert.equal(newest.nextCursor, "hermes-messages:4");

  const older = await dispatchAppServerRequest(adapter, {
    id: 2,
    method: "thread/turns/list",
    params: { threadId: "stored", cursor: newest.nextCursor, limit: 2, sortDirection: "desc" },
  }) as { data: Array<{ items: Array<{ content?: Array<{ text?: string }> }> }>; nextCursor: string | null };
  assert.deepEqual(older.data.map((turn) => turn.items[0]?.content?.[0]?.text), ["one"]);
  assert.equal(older.nextCursor, null);
  assert.deepEqual(requests.map(({ offset }) => offset), [0]);
});

test("Hermes model.options is projected as a provider-safe AppServer catalog", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "model.options") {
        return {
          model: "shared/model",
          provider: "nous",
          providers: [
            {
              slug: "nous",
              name: "Nous",
              is_current: true,
              authenticated: true,
              models: ["shared/model", "nous/only"],
              capabilities: {
                "shared/model": { reasoning: true, fast: true },
              },
            },
            {
              slug: "custom:lab",
              name: "Lab",
              authenticated: true,
              models: ["shared/model"],
            },
            {
              slug: "offline",
              name: "Offline",
              authenticated: false,
              models: ["offline/model"],
            },
          ],
        } as T;
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const response = await dispatchAppServerRequest(adapter, {
    id: 1,
    method: "model/list",
    params: { cursor: null, limit: 100, includeHidden: false },
  }) as { data: Array<{ model: string; displayName: string; isDefault: boolean; inputModalities: string[] }> };

  assert.deepEqual(response.data.map(({ displayName }) => displayName), [
    "shared/model · Nous",
    "nous/only",
    "shared/model · Lab",
  ]);
  assert.equal(response.data[0]?.model, encodeHermesModelSelection("nous", "shared/model"));
  assert.equal(response.data[0]?.isDefault, true);
  assert.deepEqual(response.data[0]?.inputModalities, ["text", "image"]);
  assert.deepEqual(calls, [{ method: "model.options", params: { explicit_only: true } }]);
});

test("Hermes reasoning capability distinguishes unsupported, optional, and mandatory thinking", async () => {
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "model.options") return {
        model: "glm-5.3-flash", provider: "tokenhub", providers: [{
          slug: "tokenhub", name: "TokenHub", authenticated: true,
          models: ["plain", "optional", "glm-5.3-flash"],
          capabilities: {
            plain: { reasoning: false },
            optional: { reasoning: true, can_disable_reasoning: true },
            "glm-5.3-flash": { reasoning: true, can_disable_reasoning: false },
          },
        }],
      } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const response = await dispatchAppServerRequest(adapter, { id: 1, method: "model/list", params: { includeHidden: false } }) as {
    data: Array<{ displayName: string; supportedReasoningEfforts: Array<{ reasoningEffort: string }>; defaultReasoningEffort: string | null }>;
  };
  const byName = new Map(response.data.map((model) => [model.displayName, model]));
  assert.deepEqual(byName.get("plain")?.supportedReasoningEfforts, []);
  assert.equal(byName.get("plain")?.defaultReasoningEffort, null);
  assert.deepEqual(byName.get("optional")?.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort), ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(byName.get("optional")?.defaultReasoningEffort, "medium");
  assert.deepEqual(byName.get("glm-5.3-flash")?.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort), ["low", "high", "max"]);
  assert.equal(byName.get("glm-5.3-flash")?.defaultReasoningEffort, "high");
});

test("Hermes model catalog is scoped to the owning Thread profile and live session", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      const value = params as Record<string, unknown>;
      calls.push({ method, params: value });
      if (method === "session.resume") {
        return {
          session_id: "live-owner",
          stored_session_id: "stored-owner",
          message_count: 0,
          messages: [],
          info: { cwd: "/workspace", model: "owned-model", provider: "owned-provider" },
        } as T;
      }
      if (method === "session.list") {
        return {
          sessions: [{
            id: "stored-owner",
            title: "Owned",
            preview: "",
            started_at: 1,
            message_count: 0,
            source: "desktop",
            profile: "team-profile",
          }],
        } as T;
      }
      if (method === "model.options") {
        return {
          model: "owned-model",
          provider: "owned-provider",
          providers: [{
            slug: "owned-provider",
            name: "Owned Provider",
            authenticated: true,
            models: ["owned-model"],
          }],
        } as T;
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");

  await adapter.loadThread("stored-owner", false, "team-profile");
  calls.length = 0;
  await dispatchAppServerRequest(adapter, {
    id: 1,
    method: "model/list",
    params: { cursor: null, limit: 100, includeHidden: false, threadId: "stored-owner" },
  });

  assert.deepEqual(calls, [{
    method: "model.options",
    params: {
      explicit_only: true,
      session_id: "live-owner",
      profile: "team-profile",
    },
  }]);
});

test("Hermes model selection is decoded for session creation and live turn switching", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      const value = params as Record<string, unknown>;
      calls.push({ method, params: value });
      if (method === "session.create") {
        return {
          session_id: "live-model",
          stored_session_id: "stored-model",
          message_count: 0,
          messages: [],
          info: {
            cwd: "/workspace",
            model: value.model,
            provider: value.provider,
          },
        } as T;
      }
      if (method === "config.set") {
        return { value: "model-b", confirm_required: false } as T;
      }
      if (method === "model.options") {
        return {
          model: "model-a",
          provider: "provider-a",
          providers: [
            { slug: "provider-a", name: "Provider A", authenticated: true, models: ["model-a"] },
            { slug: "provider-b", name: "Provider B", authenticated: true, models: ["model-b"] },
          ],
        } as T;
      }
      if (method === "prompt.submit") return { status: "accepted" } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const initial = encodeHermesModelSelection("provider-a", "model-a");
  const thread = await adapter.startThread("/workspace", initial);
  assert.deepEqual(calls[0], {
    method: "session.create",
    params: {
      cwd: "/workspace",
      source: "desktop",
      model: "model-a",
      provider: "provider-a",
    },
  });
  assert.equal(adapter.executionModel(thread.id), initial);

  const next = encodeHermesModelSelection("provider-b", "model-b");
  await adapter.startTurn(thread.id, [{ type: "text", text: "hello" }], next);
  assert.equal(calls[1]?.method, "model.options");
  assert.equal(calls[2]?.method, "config.set");
  assert.deepEqual(calls[2]?.params, {
    session_id: "live-model",
    key: "model",
    value: "model-b --provider provider-b --session",
    confirm_expensive_model: true,
  });
  assert.equal(calls[3]?.method, "prompt.submit");
  assert.equal(calls[3]?.params.queued, true);
  assert.equal(adapter.executionModel(thread.id), next);
});

test("Hermes applies AppServer reasoning effort to new and existing sessions", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      const value = params as Record<string, unknown>;
      calls.push({ method, params: value });
      if (method === "session.create") return {
        session_id: "live-reasoning", stored_session_id: "stored-reasoning", message_count: 0, messages: [],
        info: { cwd: value.cwd, model: value.model, provider: value.provider },
      } as T;
      if (method === "config.set") return { value: value.value } as T;
      if (method === "prompt.submit") return { status: "accepted" } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const model = encodeHermesModelSelection("tokenhub", "glm-5.3-flash");
  const started = await dispatchAppServerRequest(adapter, { id: 1, method: "thread/start", params: { cwd: "/workspace", model, effort: "high" } }) as {
    thread: { id: string }; reasoningEffort: string | null;
  };
  assert.equal(started.reasoningEffort, "high");
  assert.deepEqual(calls[0], { method: "session.create", params: { cwd: "/workspace", source: "desktop", model: "glm-5.3-flash", provider: "tokenhub", reasoning_effort: "high" } });
  await dispatchAppServerRequest(adapter, { id: 2, method: "turn/start", params: {
    threadId: started.thread.id, input: [{ type: "text", text: "hello" }], model, effort: "low", clientUserMessageId: "reasoning-message",
  } });
  assert.deepEqual(calls.slice(1), [
    { method: "config.set", params: { session_id: "live-reasoning", key: "reasoning", value: "low" } },
    { method: "prompt.submit", params: { session_id: "live-reasoning", text: "hello", queued: true } },
  ]);
  assert.equal(adapter.executionReasoningEffort(started.thread.id), "low");
});

test("Hermes rebinds a stale foreign provider to the unique live catalog owner", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, raw?: unknown): Promise<T> {
      const params = (raw ?? {}) as Record<string, unknown>;
      calls.push({ method, params });
      if (method === "session.create") return {
        session_id: "live-stale", stored_session_id: "stored-stale", message_count: 0, messages: [],
        info: { model: "deepseek-v4-flash-0731", provider: "111", cwd: "/workspace" },
      } as T;
      if (method === "model.options") return {
        model: "deepseek-v4-flash-0731",
        provider: "111",
        providers: [{ slug: "111", name: "111", authenticated: true, models: ["deepseek-v4-flash-0731", "hy-3d-3.0"] }],
      } as T;
      if (method === "config.set") return { value: "hy-3d-3.0", confirm_required: false } as T;
      if (method === "prompt.submit") return { status: "accepted" } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const thread = await adapter.startThread("/workspace");
  await adapter.startTurn(thread.id, [{ type: "text", text: "hello" }],
    encodeHermesModelSelection("lightvela-custom-111-1yq8src", "hy-3d-3.0"));
  const configSet = calls.find(({ method }) => method === "config.set");
  assert.equal(configSet?.params.value, "hy-3d-3.0 --provider 111 --session");
  assert.equal(calls.at(-1)?.method, "prompt.submit");
  assert.equal(adapter.executionModel(thread.id), encodeHermesModelSelection("111", "hy-3d-3.0"));
});

test("Hermes cold deep links recover their owning Profile before Resume", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const target = "20260906_094819_abab2c";
  const rpc: HermesRpcClient = {
    async call<T>(method: string, rawParams?: unknown): Promise<T> {
      const params = (rawParams ?? {}) as Record<string, unknown>;
      calls.push({ method, params });
      if (method === "profiles.list") {
        return {
          profiles: [
            { name: "default", last_session: null },
            {
              name: "release-captain",
              display_name: "Release Captain",
              last_session: {
                id: target,
                title: "Release notes",
                preview: "ready",
                started_at: 1,
                message_count: 2,
                source: "desktop",
              },
            },
          ],
        } as T;
      }
      if (method === "session.resume") {
        assert.equal(params.session_id, target);
        assert.equal(params.profile, "release-captain");
        return {
          session_id: "live-release",
          stored_session_id: target,
          message_count: 2,
          messages: [],
        } as T;
      }
      if (method === "session.list") {
        assert.equal(params.profile, "release-captain");
        return {
          sessions: [{
            id: target,
            title: "Release notes",
            preview: "ready",
            started_at: 1,
            message_count: 2,
            source: "desktop",
            profile: "release-captain",
          }],
        } as T;
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const thread = await adapter.loadThread(target, false);

  assert.equal(thread.id, target);
  assert.equal(adapter.profileForThread(target), "release-captain");
  assert.deepEqual(calls.map(({ method }) => method), [
    "profiles.list",
    "session.resume",
    "session.list",
  ]);
});

test("Hermes thread/read retains session.create metadata until Dashboard history indexes the Thread", async () => {
  let listed = false;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      const request = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: request });
      if (method === "session.create") {
        return {
          session_id: "new-live",
          stored_session_id: "new-stored",
          message_count: 0,
          messages: [],
          running: false,
          info: { cwd: "/workspace/new" },
        } as T;
      }
      if (method === "session.list") {
        return { sessions: listed ? [{
          id: "new-stored",
          title: "Indexed title",
          preview: "first message",
          started_at: 1_789_000_000,
          message_count: 1,
          source: "desktop",
          profile: "default",
        }] : [] } as T;
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");

  const started = await adapter.startThread("/workspace/new");
  const beforeIndex = await adapter.readThreadMetadata(started.id);
  assert.equal(beforeIndex.id, "new-stored");
  assert.equal(beforeIndex.name, "New chat");
  assert.equal(beforeIndex.cwd, "/workspace/new");

  listed = true;
  const afterIndex = await adapter.readThreadMetadata(started.id);
  assert.equal(afterIndex.name, "Indexed title");
  assert.equal(afterIndex.preview, "Indexed title");
  assert.deepEqual(calls.map(({ method }) => method), [
    "session.create",
    "session.list",
    "session.list",
  ]);
  adapter.dispose();
});

test("Hermes cold deep links find an older session through Profile-scoped catalogs", async () => {
  const target = "stored-older-profile-session";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      const request = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: request });
      if (method === "profiles.list") {
        return {
          profiles: [
            { name: "default", is_default: true },
            { name: "release-captain", is_default: false },
          ],
        } as T;
      }
      if (method === "session.list") {
        const sessions = request.profile === "release-captain"
          ? [{ id: target, title: "Older Bot conversation", preview: "restored", started_at: 1, message_count: 1, source: "desktop", profile: "release-captain" }]
          : [];
        return { sessions } as T;
      }
      if (method === "session.resume") {
        assert.equal(request.profile, "release-captain");
        return { session_id: "live-older", stored_session_id: target, messages: [], message_count: 1 } as T;
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  await adapter.loadThread(target, false);
  assert.equal(adapter.profileForThread(target), "release-captain");
  assert.equal(
    calls.some(({ method, params }) => method === "session.list" && params.profile === "release-captain"),
    true,
  );
});

test("Hermes cold deep links recover an unlisted lazy named session by authoritative Resume", async () => {
  const target = "lazy-hidden-canonical";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      const request = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: request });
      if (method === "profiles.list") {
        return { profiles: [{ name: "default" }, { name: "release-captain" }] } as T;
      }
      if (method === "session.list") return { sessions: [] } as T;
      if (method === "session.resume" && request.profile === "default") {
        throw new Error("session not found");
      }
      if (method === "session.resume" && request.profile === "release-captain") {
        return {
          session_id: "lazy-live",
          resumed: target,
          messages: [],
          message_count: 0,
          info: { profile_name: "release-captain" },
        } as T;
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const thread = await adapter.loadThread(target, false);

  assert.equal(thread.id, target);
  assert.equal(thread.extra?.hermes && (thread.extra.hermes as { messageCount?: number }).messageCount, 0);
  assert.equal(adapter.profileForThread(target), "release-captain");
  assert.equal(
    calls.filter(({ method, params }) => method === "session.resume" && params.session_id === target).length,
    2,
  );
});

class FakeHermesRpcSocket extends EventTarget {
  readyState = WebSocket.OPEN;
  readonly requests: Array<{ id: number | string; method: string; params: Record<string, unknown> }> = [];
  send(data: string): void {
    const request = JSON.parse(data) as { id: number | string; method: string; params: Record<string, unknown> };
    this.requests.push(request);
    if (request.method === "groups.capabilities") queueMicrotask(() => this.receive({
      jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "groups.capabilities unsupported" },
    }));
  }
  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code: 1000, wasClean: true }));
  }
}

test("Hermes RPC transport owns the advertised Gateway heartbeat lifecycle", async () => {
  const socket = new FakeHermesRpcSocket();
  const rpc = new HermesRpcWebSocketTransport(socket, {
    heartbeatIntervalMs: 5,
    heartbeatDeadlineMs: 100,
  });

  socket.receive({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", payload: { heartbeat: true } },
  });
  await new Promise((resolve) => setTimeout(resolve, 18));
  const heartbeats = socket.requests.filter(({ method }) => method === "gateway.ping");
  assert.equal(heartbeats.length >= 2, true);
  assert.equal(String(heartbeats[0]?.id).startsWith("heartbeat-"), true);

  rpc.dispose();
  const countAfterDispose = socket.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(socket.requests.length, countAfterDispose);
});

test("Hermes browser Handler keeps the dormant Bot protocol out of its public capability surface", async () => {
  const socket = new FakeHermesRpcSocket();
  const bridge = new BrowserHermesAppServerBridge(socket);

  const initialized = await bridge.request("initialize", {}) as {
    capabilities: { extensions: Record<string, unknown> };
  };
  assert.deepEqual(initialized.capabilities.extensions, {
    "opencraft/message-window-history": {
      version: 1,
      pageRows: 120,
      previewNotification: "thread/history/preview",
    },
    "opencraft/thread-queue": {
      version: 2,
      reorder: true,
      atomicSteer: true,
      perItemPause: true,
    },
    "opencraft/scoped-model-catalog": { version: 1 },
  });

  const response = await bridge.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "bot/list",
    params: {},
  });
  assert.equal("error" in response && response.error.code, -32601);
  assert.equal(socket.requests.length, 0);
  bridge.dispose();
});

test("Hermes browser Handler routes live clarify through an AppServer server request", async () => {
  const socket = new FakeHermesRpcSocket();
  const bridge = new BrowserHermesAppServerBridge(socket);
  const outbound: Array<{ id?: string | number; method: string; params: unknown }> = [];
  bridge.onNotification((frame) => outbound.push(frame));

  const starting = bridge.request("thread/start", { cwd: "/workspace" }) as Promise<{ thread: { id: string } }>;
  await flush();
  const create = socket.requests.at(-1)!;
  assert.equal(create.method, "session.create");
  socket.receive({ jsonrpc: "2.0", id: create.id, result: {
    session_id: "live-question",
    stored_session_id: "stored-question",
    message_count: 0,
    messages: [],
    running: false,
    info: { cwd: "/workspace" },
  } });
  const thread = (await starting).thread;

  const submitting = bridge.request("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "Ask me" }],
    clientUserMessageId: "client-question",
  });
  await flush();
  const prompt = socket.requests.at(-1)!;
  assert.equal(prompt.method, "prompt.submit");
  socket.receive({ jsonrpc: "2.0", id: prompt.id, result: { status: "accepted" } });
  const submitted = await submitting as { turn: { id: string } };

  socket.receive({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type: "clarify.request",
      session_id: "live-question",
      payload: {
        request_id: "clarify-live-1",
        question: "Continue?",
        choices: ["Yes", "No"],
      },
    },
  });
  await flush();
  const question = outbound.find((frame) => frame.method === "item/tool/requestUserInput");
  assert.ok(question?.id);
  assert.equal((question.params as { turnId: string }).turnId, submitted.turn.id);

  socket.receive({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type: "session.info",
      session_id: "live-question",
      payload: { running: false },
    },
  });
  await flush();
  assert.equal(outbound.some((frame) => frame.method === "turn/completed"), false);

  const answering = bridge.handleResponse({
    jsonrpc: "2.0",
    id: question.id,
    result: { answers: { answer: { answers: ["Yes"] } } },
  });
  await flush();
  const response = socket.requests.at(-1)!;
  assert.equal(response.method, "clarify.respond");
  assert.deepEqual(response.params, { request_id: "clarify-live-1", answer: "Yes" });
  socket.receive({ jsonrpc: "2.0", id: response.id, result: { ok: true } });
  assert.equal(await answering, true);
  socket.receive({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type: "tool.complete",
      session_id: "live-question",
      payload: { tool_id: "clarify-tool", name: "clarify", result: "Yes" },
    },
  });
  socket.receive({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type: "message.complete",
      session_id: "live-question",
      payload: { text: "Continuing." },
    },
  });
  await flush();
  assert.equal(outbound.filter((frame) => frame.method === "turn/completed").length, 1);
  bridge.dispose();
});

test("Hermes browser Handler advertises and serves the engine-neutral Bot extension", async () => {
  const socket = new FakeHermesRpcSocket();
  const bridge = new BrowserHermesAppServerBridge(socket, {
    enableBotConversations: true,
    history: {
      async readMessages() {
        throw new Error("Conversation not found: release-stored-1");
      },
      dispose() {},
    },
  });

  const initialized = await bridge.request("initialize", {}) as {
    capabilities: { extensions: Record<string, { version: number; topologies: string[] }> };
  };
  const catalogRequest = bridge.request("bot/list", {}) as Promise<{
    data: Array<{ botId: string; name: string; capabilities: string[] }>;
  }>;
  await flush();
  const profilesList = socket.requests.at(-1)!;
  assert.equal(profilesList.method, "profiles.list");
  socket.receive({ jsonrpc: "2.0", id: profilesList.id, result: {
    profiles: [
      { name: "default", display_name: "Hermes" },
      { name: "research", display_name: "Research" },
    ],
  } });
  const catalog = await catalogRequest;

  assert.deepEqual(initialized.capabilities.extensions["opencraft/scoped-model-catalog"], {
    version: 1,
  });

  assert.deepEqual(initialized.capabilities.extensions["vela/bot-conversations"], {
    version: 1,
    topologies: ["direct"],
    features: {
      messageStreaming: true,
      executionCancellation: true,
      attachments: true,
      interactions: false,
      botManagement: true,
      botAssets: false,
      groupMembership: false,
      configuration: false,
      routines: false,
    },
    limits: {
      maxPageSize: 100,
      maxInlineAttachmentBytes: 10485760,
      maxParticipants: 2,
    },
  });
  assert.deepEqual(catalog.data.map(({ botId, name }) => ({ botId, name })), [
    { botId: "lightvela.hermes", name: "Hermes" },
    { botId: "lightvela.hermes.profile:research", name: "Research" },
  ]);
  assert.equal(catalog.data[0]?.capabilities.includes("messageStreaming"), true);

  const createBot = bridge.request("bot/create", {
    clientRequestId: "create-bot-1",
    name: "Release Captain",
  }) as Promise<{ bot: { botId: string; name: string }; replayed: boolean }>;
  await flush();
  const createProfile = socket.requests.at(-1)!;
  assert.equal(createProfile.method, "profiles.create");
  assert.deepEqual(createProfile.params, {
    name: "release-captain",
    description: "Release Captain",
    clone_from: "default",
    no_skills: false,
    share_auth: true,
  });
  socket.receive({ jsonrpc: "2.0", id: createProfile.id, result: { created: true } });
  await flush();
  const configureProfile = socket.requests.at(-1)!;
  assert.equal(configureProfile.method, "profiles.configure");
  socket.receive({ jsonrpc: "2.0", id: configureProfile.id, result: { applied: { ui_meta: true } } });
  const created = await createBot;
  assert.equal(created.replayed, false);
  assert.deepEqual(created.bot, {
    botId: "lightvela.hermes.profile:release-captain",
    revision: 1,
    name: "Release Captain",
    subtitle: "Release Captain",
    avatar: {
      type: "generated",
      seed: "lightvela-hermes:release-captain",
      palette: "aqua",
    },
    status: "available",
    capabilities: ["messageStreaming", "executionCancellation", "attachments"],
  });

  const createConversation = bridge.request("bot/conversation/create", {
    clientRequestId: "create-conversation-1",
    topology: "direct",
    participantIds: ["bot:lightvela.hermes.profile:release-captain"],
  }) as Promise<{ conversation: { conversationId: string; participantIds: string[] }; replayed: boolean }>;
  await flush();
  const findCanonical = socket.requests.at(-1)!;
  assert.equal(findCanonical.method, "session.resume");
  assert.deepEqual(findCanonical.params, {
    session_id: "Bot Chat",
    defer_history: true,
    omit_messages: true,
    profile: "release-captain",
  });
  socket.receive({ jsonrpc: "2.0", id: findCanonical.id, error: { code: 4007, message: "session not found" } });
  await flush();
  const createSession = socket.requests.at(-1)!;
  assert.equal(createSession.method, "session.create");
  assert.deepEqual(createSession.params, {
    cwd: "/",
    source: "desktop",
    profile: "release-captain",
    title: "Bot Chat",
    hidden: true,
    follow_profile_config: true,
  });
  socket.receive({ jsonrpc: "2.0", id: createSession.id, result: {
    session_id: "release-live-1",
    stored_session_id: "release-stored-1",
    // Gateway state is not the Dashboard's durable-row count. A newly resumed
    // canonical Bot Chat can report state while its REST transcript is absent.
    message_count: 1,
    messages: [],
  } });
  await flush();
  const titleSession = socket.requests.at(-1)!;
  assert.equal(titleSession.method, "session.title");
  assert.deepEqual(titleSession.params, {
    session_id: "release-live-1",
    title: "Bot Chat",
  });
  socket.receive({ jsonrpc: "2.0", id: titleSession.id, result: {
    pending: false,
    title: "Bot Chat",
  } });
  await flush();
  const hideSession = socket.requests.at(-1)!;
  assert.equal(hideSession.method, "session.set_hidden");
  assert.deepEqual(hideSession.params, {
    session_id: "release-live-1",
    hidden: true,
  });
  socket.receive({ jsonrpc: "2.0", id: hideSession.id, result: {
    hidden: true,
    session_key: "release-stored-1",
  } });
  const conversation = await createConversation;
  assert.equal(conversation.replayed, false);
  assert.deepEqual(conversation.conversation.participantIds, [
    "person:you",
    "bot:lightvela.hermes.profile:release-captain",
  ]);
  assert.equal(conversation.conversation.conversationId, "release-stored-1");

  const readEmptyConversation = bridge.request("bot/conversation/read", {
    conversationId: "release-stored-1",
    initialMessagesPage: { limit: 50 },
  }) as Promise<{ initialMessagesPage: { data: unknown[] } }>;
  await flush();
  const readEmptyList = socket.requests.at(-1)!;
  assert.equal(readEmptyList.method, "session.list");
  socket.receive({ jsonrpc: "2.0", id: readEmptyList.id, result: { sessions: [{
    id: "release-stored-1",
    title: "Bot Chat",
    preview: "",
    started_at: 1,
    source: "desktop",
    profile: "release-captain",
  }] } });
  assert.deepEqual((await readEmptyConversation).initialMessagesPage.data, []);

  const requestCountBeforeReopen = socket.requests.length;
  const reopenConversation = bridge.request("bot/conversation/create", {
    clientRequestId: "create-conversation-2",
    topology: "direct",
    participantIds: ["bot:lightvela.hermes.profile:release-captain"],
  }) as Promise<{ conversation: { conversationId: string } }>;
  assert.equal((await reopenConversation).conversation.conversationId, "release-stored-1");
  assert.equal(socket.requests.length, requestCountBeforeReopen);
  assert.equal(socket.requests.filter(({ method }) => method === "session.create").length, 1);
  bridge.dispose();
});

test("Hermes Bot creation adopts the server-owned named session after a create race", async () => {
  const socket = new FakeHermesRpcSocket();
  const bridge = new BrowserHermesAppServerBridge(socket, { enableBotConversations: true });
  const created = bridge.request("bot/conversation/create", {
    clientRequestId: "racing-create",
    topology: "direct",
    participantIds: ["bot:lightvela.hermes"],
  }) as Promise<{ conversation: { conversationId: string } }>;

  await flush();
  const firstResolve = socket.requests.at(-1)!;
  assert.equal(firstResolve.method, "session.resume");
  socket.receive({ jsonrpc: "2.0", id: firstResolve.id, error: { code: 4007, message: "session not found" } });
  await flush();
  const create = socket.requests.at(-1)!;
  assert.equal(create.method, "session.create");
  socket.receive({
    jsonrpc: "2.0",
    id: create.id,
    error: { code: 5000, message: "Title 'Bot Chat' is already in use by session winner-stored" },
  });
  await flush();
  const reconcile = socket.requests.at(-1)!;
  assert.equal(reconcile.method, "session.resume");
  assert.equal(reconcile.params.session_id, "Bot Chat");
  socket.receive({ jsonrpc: "2.0", id: reconcile.id, result: {
    session_id: "winner-live",
    resumed: "winner-stored",
    message_count: 0,
    messages: [],
    info: { profile_name: "default" },
  } });

  assert.equal((await created).conversation.conversationId, "winner-stored");
  bridge.dispose();
});

test("Hermes replay holds racing live events and restores their sequence exactly once", async () => {
  const checkpoint = new HermesReplayCheckpoint();
  checkpoint.epoch = "epoch-a";
  checkpoint.lastSeenSeq.set("live-1", 1);
  const socket = new FakeHermesRpcSocket();
  const rpc = new HermesRpcWebSocketTransport(socket, { replayCheckpoint: checkpoint });
  const observed: number[] = [];
  rpc.onEvent((event) => {
    if (typeof event.seq === "number") observed.push(event.seq);
  });

  const replay = rpc.catchUpSession("live-1");
  await flush();
  const request = socket.requests.at(-1)!;
  assert.equal(request.method, "session.events.since");
  socket.receive({ jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "live-1", seq: 3, payload: { text: "b" } } });
  socket.receive({ jsonrpc: "2.0", id: request.id, result: {
    events: [{ type: "message.delta", session_id: "live-1", seq: 2, payload: { text: "a" } }],
    latest_seq: 2,
    truncated: false,
    epoch: "epoch-a",
  } });
  assert.deepEqual(await replay, { complete: true });
  assert.deepEqual(observed, [2, 3]);
  assert.equal(checkpoint.lastSeenSeq.get("live-1"), 3);
  rpc.dispose();
});

test("Hermes replay reports a bounded-ring gap so the projection can re-snapshot", async () => {
  const checkpoint = new HermesReplayCheckpoint();
  checkpoint.epoch = "epoch-a";
  checkpoint.lastSeenSeq.set("live-1", 1);
  const socket = new FakeHermesRpcSocket();
  const rpc = new HermesRpcWebSocketTransport(socket, { replayCheckpoint: checkpoint });
  const observed: unknown[] = [];
  rpc.onEvent(event => observed.push(event));
  const replay = rpc.catchUpSession("live-1");
  await flush();
  const request = socket.requests.at(-1)!;
  socket.receive({ jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "live-1", seq: 801, payload: { text: "racing" } } });
  socket.receive({ jsonrpc: "2.0", id: request.id, result: {
    events: [{ type: "message.delta", session_id: "live-1", seq: 800, payload: { text: "partial" } }], latest_seq: 800, truncated: true, epoch: "epoch-a",
  } });
  assert.deepEqual(await replay, { complete: false });
  assert.equal(checkpoint.lastSeenSeq.has("live-1"), false);
  assert.deepEqual(observed, [], "neither partial replay nor racing live frames may extend a gapped replica");
  rpc.dispose();
});

test("Hermes snapshot release waits for its projection owner", async () => {
  const socket = new FakeHermesRpcSocket();
  const rpc = new HermesRpcWebSocketTransport(socket);
  const observed: unknown[] = [];
  rpc.onEvent(event => observed.push(event));
  const snapshot = rpc.snapshotSession("live-1");
  await flush();
  const request = socket.requests.at(-1)!;
  assert.equal(request.method, "session.activate");
  socket.receive({ jsonrpc: "2.0", id: request.id, result: {
    session_id: "live-1", messages: [], message_count: 1, running: true,
    inflight: { user: "hello", assistant: "world", streaming: true },
  } });
  socket.receive({ jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "live-1", seq: 4, payload: { text: "!" } } });
  await snapshot;
  await flush();
  assert.deepEqual(observed, []);
  rpc.releaseSnapshot("live-1");
  assert.equal(observed.length, 1);
  rpc.dispose();
});

test("Hermes cold recovery adopts inflight without applying a detached replay cursor", async () => {
  let eventListener: ((event: Record<string, unknown>) => void) | null = null;
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "profiles.list") {
        return { profiles: [{ name: "default", is_default: true, last_session: { id: "stored-1" } }] } as T;
      }
      if (method === "session.resume") {
        return { session_id: "live-1", stored_session_id: "stored-1", messages: [], message_count: 1, running: true } as T;
      }
      if (method === "session.list") {
        return { sessions: [{ id: "stored-1", title: "Running", preview: "hello", started_at: 1, message_count: 1, source: "desktop" }] } as T;
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent(listener) {
      eventListener = listener;
      return () => { eventListener = null; };
    },
    async catchUpSession() {
      throw new Error("no retained owner: replay must not run");
    },
    async snapshotSession() {
      return { session_id: "live-1", stored_session_id: "stored-1", messages: [], message_count: 1, running: true,
        inflight: { user: "hello", assistant: "world", streaming: true } };
    },
  };
  const history: HermesHistoryClient = {
    async readMessages(sessionId, request) {
      return {
        session_id: sessionId,
        messages: [{ role: "user", text: "hello", row_id: 1 }],
        pagination: { limit: request.limit, offset: request.offset, order: request.order, returned: 1 },
      };
    },
    dispose() {},
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", history);
  const notifications: Array<{ method: string; params: unknown }> = [];
  adapter.subscribeNotification((method, params) => notifications.push({ method, params }));
  const resumed = await dispatchAppServerRequest(adapter, {
    id: 1,
    method: "thread/resume",
    params: { threadId: "stored-1", excludeTurns: true, initialTurnsPage: { limit: 5, sortDirection: "desc" } },
  });
  assert.deepEqual(notifications, []);
  const restored = (resumed as { initialTurnsPage: { data: AppServerTurn[] } }).initialTurnsPage.data[0];
  assert.equal(restored.items.at(-1)?.text, "world");
  eventListener?.({ type: "message.delta", session_id: "live-1", payload: { text: "!" } });
  assert.equal(restored.items.at(-1)?.text, "world!");
  assert.equal(
    (notifications.at(-1)?.params as { turnId?: string }).turnId,
    "hermes-turn-stored-1-1",
  );
});

test("Hermes live projection starts the Turn before the first backend message", () => {
  const turn = {
    id: "turn-1",
    items: [{ type: "userMessage", id: "user-1", clientId: null, content: [{ type: "text", text: "hello" }] }],
    itemsView: "full" as const,
    status: "inProgress" as const,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
  const projection = new HermesTurnEventStateMachine("thread-1", turn, () => "stable");

  assert.deepEqual(projection.accept(10_000).map(({ method }) => method), ["turn/started"]);
  assert.equal(turn.startedAt, 10);
  assert.deepEqual(
    projection.project({ type: "thinking.delta", payload: { text: "spinner copy" } }, 11_000),
    [],
  );
  assert.equal(projection.currentPhase, "thinking");
  assert.deepEqual(turn.items.map(({ type }) => type), ["userMessage"]);
});

test("Hermes adapter publishes accepted work without waiting for message.start", async () => {
  let eventListener: ((event: Record<string, unknown>) => void) | null = null;
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "session.create") {
        return {
          session_id: "live-accepted",
          stored_session_id: "stored-accepted",
          message_count: 0,
          messages: [],
          info: { cwd: "/workspace" },
        } as T;
      }
      if (method === "prompt.submit") return { status: "accepted" } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent(listener) {
      eventListener = listener;
      return () => { eventListener = null; };
    },
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const notifications: Array<{ method: string; params: unknown }> = [];
  adapter.subscribeNotification((method, params) => notifications.push({ method, params }));
  const thread = await adapter.startThread();
  await adapter.startTurn(thread.id, [{ type: "text", text: "hello" }]);

  assert.deepEqual(notifications.map(({ method }) => method), ["turn/started"]);
  eventListener?.({ type: "message.start", session_id: "live-accepted", payload: {} });
  assert.deepEqual(notifications.map(({ method }) => method), ["turn/started"]);
  eventListener?.({ type: "message.delta", session_id: "live-accepted", payload: { text: "hi" } });
  assert.deepEqual(notifications.map(({ method }) => method), [
    "turn/started",
    "item/started",
    "item/agentMessage/delta",
  ]);
});

test("Hermes AppServer turn/start preserves the client message identity before its receipt", async () => {
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "session.create") {
        return {
          session_id: "live-client-identity",
          stored_session_id: "stored-client-identity",
          message_count: 0,
          messages: [],
          info: { cwd: "/workspace" },
        } as T;
      }
      if (method === "prompt.submit") return { status: "accepted" } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  await adapter.startThread();
  const response = await dispatchAppServerRequest(adapter, {
    id: 1,
    method: "turn/start",
    params: {
      threadId: "stored-client-identity",
      clientUserMessageId: "client-first-message",
      input: [{ type: "text", text: "hello" }],
    },
  }) as { turn: { items: Array<{ type: string; clientId?: string | null }> } };

  assert.equal(response.turn.items[0]?.type, "userMessage");
  assert.equal(response.turn.items[0]?.clientId, "client-first-message");
});

test("Hermes Bot follow-ups inherit the Gateway strict queue lease", async () => {
  let eventListener: ((event: Record<string, unknown>) => void) | null = null;
  const promptParams: Array<Record<string, unknown>> = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      if (method === "session.create") {
        return {
          session_id: "live-bot-queue",
          stored_session_id: "stored-bot-queue",
          message_count: 0,
          messages: [],
          info: { cwd: "/workspace" },
        } as T;
      }
      if (method === "prompt.submit") {
        promptParams.push(params as Record<string, unknown>);
        return { status: promptParams.length === 1 ? "streaming" : "queued" } as T;
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent(listener) {
      eventListener = listener;
      return () => { eventListener = null; };
    },
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const methods: Array<{ method: string; turnId?: string }> = [];
  adapter.subscribeNotification((method, params) => methods.push({
    method,
    turnId: (params as { turnId?: string }).turnId
      ?? ((params as { turn?: { id?: string } }).turn?.id),
  }));
  const thread = await adapter.startThread();
  const first = await adapter.submitBotTurn(thread.id, [{ type: "text", text: "one" }], "client-one");
  const second = await adapter.submitBotTurn(thread.id, [{ type: "text", text: "two" }], "client-two");

  assert.equal(first.disposition, "running");
  assert.equal(second.disposition, "queued");
  assert.deepEqual(promptParams.map(({ queued }) => queued), [true, true]);
  assert.deepEqual(methods.filter(({ method }) => method === "turn/started").map(({ turnId }) => turnId), [first.turn.id]);

  eventListener?.({
    type: "message.complete",
    session_id: "live-bot-queue",
    payload: { text: "first", status: "complete" },
  });
  eventListener?.({ type: "session.info", session_id: "live-bot-queue", payload: { running: false } });
  eventListener?.({ type: "message.start", session_id: "live-bot-queue", payload: {} });

  assert.deepEqual(methods.filter(({ method }) => method === "turn/started").map(({ turnId }) => turnId), [
    first.turn.id,
    second.turn.id,
  ]);
  adapter.dispose();
});

test("Hermes serializes physical admission without serializing Turn execution", async () => {
  let resolveFirstPrompt: ((value: { status: string }) => void) | null = null;
  const promptTexts: string[] = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      if (method === "session.create") {
        return {
          session_id: "live-admission",
          stored_session_id: "stored-admission",
          message_count: 0,
          messages: [],
        } as T;
      }
      if (method === "prompt.submit") {
        promptTexts.push(String((params as { text?: unknown }).text ?? ""));
        if (promptTexts.length === 1) {
          return await new Promise<T>((resolve) => {
            resolveFirstPrompt = (value) => resolve(value as T);
          });
        }
        return { status: "queued" } as T;
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const thread = await adapter.startThread();
  const first = adapter.submitBotTurn(thread.id, [{ type: "text", text: "first" }], "client-first");
  while (resolveFirstPrompt === null) await new Promise<void>((resolve) => setImmediate(resolve));
  const second = adapter.submitBotTurn(thread.id, [{ type: "text", text: "second" }], "client-second");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(promptTexts, ["first"]);

  resolveFirstPrompt?.({ status: "streaming" });
  assert.equal((await first).disposition, "running");
  assert.equal((await second).disposition, "queued");
  assert.deepEqual(promptTexts, ["first", "second"]);
  adapter.dispose();
});

test("Hermes admission commits only frames after the new live boundary", async () => {
  let eventListener: ((event: Record<string, unknown>) => void) | null = null;
  let resolvePrompt: ((value: { status: string }) => void) | null = null;
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "session.create") {
        return {
          session_id: "live-admission-boundary",
          stored_session_id: "stored-admission-boundary",
          message_count: 0,
          messages: [],
          running: false,
        } as T;
      }
      if (method === "prompt.submit") {
        return await new Promise<T>((resolve) => {
          resolvePrompt = (value) => resolve(value as T);
        });
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent(listener) {
      eventListener = listener;
      return () => { eventListener = null; };
    },
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const methods: string[] = [];
  adapter.subscribeNotification((method) => methods.push(method));
  const thread = await adapter.startThread();
  const submission = adapter.submitBotTurn(
    thread.id,
    [{ type: "text", text: "hello" }],
    "client-admission-boundary",
  );
  while (resolvePrompt === null) await new Promise<void>((resolve) => setImmediate(resolve));

  // A trailing idle heartbeat belongs to the previous process lease. The
  // positive message.start boundary and following frames belong to this Turn.
  eventListener?.({
    type: "session.info",
    session_id: "live-admission-boundary",
    payload: { running: false },
  });
  eventListener?.({ type: "message.start", session_id: "live-admission-boundary", payload: {} });
  eventListener?.({
    type: "message.delta",
    session_id: "live-admission-boundary",
    payload: { text: "answer" },
  });
  assert.deepEqual(methods, []);

  resolvePrompt?.({ status: "streaming" });
  await submission;
  assert.deepEqual(methods, ["turn/started", "item/started", "item/agentMessage/delta"]);
  adapter.dispose();
});

test("Hermes Bot send idempotency owns the in-flight request, not only its receipt", async () => {
  let resolveSubmission: ((value: {
    turn: {
      id: string;
      items: Array<{ type: string; id: string; clientId: string; content: Array<{ type: string; text: string }> }>;
      itemsView: "full";
      status: "inProgress";
      error: null;
      startedAt: number;
      completedAt: null;
      durationMs: null;
    };
    disposition: "running";
  }) => void) | null = null;
  let submissions = 0;
  const adapter = {
    async loadThread() {},
    profileForThread: () => "default",
    submitBotTurn: async () => {
      submissions += 1;
      return await new Promise((resolve) => { resolveSubmission = resolve; });
    },
  } as unknown as HermesAppServerAdapter;
  const handler = new HermesBotAppServerHandler(adapter, () => undefined);
  const params = {
    conversationId: "stored-idempotent",
    clientMessageId: "client-command",
    content: [{ type: "text", text: "hello" }],
  };
  const first = handler.handle("bot/message/send", params) as Promise<Record<string, unknown>>;
  const replay = handler.handle("bot/message/send", structuredClone(params)) as Promise<Record<string, unknown>>;
  await flush();
  assert.equal(submissions, 1);
  resolveSubmission?.({
    turn: {
      id: "turn-idempotent",
      items: [{
        type: "userMessage",
        id: "user-idempotent",
        clientId: "client-command",
        content: [{ type: "text", text: "hello" }],
      }],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 100,
      completedAt: null,
      durationMs: null,
    },
    disposition: "running",
  });
  assert.equal((await first).replayed, false);
  assert.equal((await replay).replayed, true);
  assert.equal(submissions, 1);
});

test("Hermes Draft promotion attaches to the existing live projection owner", async () => {
  let eventListener: ((event: Record<string, unknown>) => void) | null = null;
  let replay: (() => void) | null = null;
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "session.create") {
        return {
          session_id: "live-promotion",
          stored_session_id: "stored-promotion",
          message_count: 0,
          messages: [],
          running: false,
          info: { cwd: "/workspace" },
        } as T;
      }
      if (method === "prompt.submit") return { status: "accepted" } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent(listener) {
      eventListener = listener;
      return () => { eventListener = null; };
    },
    async catchUpSession() {
      replay?.();
      return { complete: true };
    },
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  adapter.subscribeNotification((method, params) => notifications.push({
    method,
    params: params as Record<string, unknown>,
  }));
  const thread = await adapter.startThread();
  const ownedTurn = await adapter.startTurn(thread.id, [{ type: "text", text: "hello" }]);
  eventListener?.({ type: "message.start", session_id: "live-promotion", payload: {} });
  eventListener?.({ type: "message.delta", session_id: "live-promotion", payload: { text: "first " } });

  replay = () => {
    eventListener?.({ type: "message.delta", session_id: "live-promotion", payload: { text: "reply" } });
    eventListener?.({
      type: "message.complete",
      session_id: "live-promotion",
      payload: { text: "first reply", status: "complete" },
    });
  };
  await adapter.activateProjection(thread.id, [{
    id: "durable-history-tail",
    items: [{ type: "agentMessage", id: "durable-answer", text: "stale", phase: null }],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  }]);

  const projectedTurnIds = notifications.flatMap(({ params }) =>
    typeof params.turnId === "string" ? [params.turnId] : []);
  assert.ok(projectedTurnIds.length > 0);
  assert.deepEqual(new Set(projectedTurnIds), new Set([ownedTurn.id]));
  assert.equal(notifications.filter(({ method }) => method === "turn/started").length, 1);
  assert.equal(notifications.filter(({ method }) => method === "turn/completed").length, 1);
});

test("Hermes completed Draft owner absorbs replay instead of projecting a second response", async () => {
  let eventListener: ((event: Record<string, unknown>) => void) | null = null;
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "session.create") {
        return {
          session_id: "live-settled-promotion",
          stored_session_id: "stored-settled-promotion",
          message_count: 0,
          messages: [],
          running: false,
          info: { cwd: "/workspace" },
        } as T;
      }
      if (method === "prompt.submit") return { status: "accepted" } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent(listener) {
      eventListener = listener;
      return () => { eventListener = null; };
    },
    async catchUpSession() {
      eventListener?.({ type: "message.start", session_id: "live-settled-promotion", payload: {} });
      eventListener?.({ type: "message.delta", session_id: "live-settled-promotion", payload: { text: "duplicate" } });
      eventListener?.({ type: "message.complete", session_id: "live-settled-promotion", payload: { text: "duplicate" } });
      return { complete: true };
    },
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace");
  const methods: string[] = [];
  adapter.subscribeNotification((method) => methods.push(method));
  const thread = await adapter.startThread();
  await adapter.startTurn(thread.id, [{ type: "text", text: "hello" }]);
  eventListener?.({ type: "message.start", session_id: "live-settled-promotion", payload: {} });
  eventListener?.({ type: "message.delta", session_id: "live-settled-promotion", payload: { text: "answer" } });
  eventListener?.({ type: "message.complete", session_id: "live-settled-promotion", payload: { text: "answer" } });
  const beforeActivation = [...methods];

  await adapter.activateProjection(thread.id, []);

  assert.deepEqual(methods, beforeActivation);
  assert.equal(methods.filter((method) => method === "turn/started").length, 1);
  assert.equal(methods.filter((method) => method === "turn/completed").length, 1);
});

test("Hermes reasoning and tool events preserve AppServer Item boundaries", () => {
  const turn = {
    id: "turn-2",
    items: [],
    itemsView: "full" as const,
    status: "inProgress" as const,
    error: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
  };
  let id = 0;
  const projection = new HermesTurnEventStateMachine("thread-2", turn, () => String(++id));
  projection.accept(10_000);

  const reasoning = projection.project({ type: "reasoning.delta", payload: { text: "inspect" } }, 11_000);
  assert.deepEqual(reasoning.map(({ method }) => method), ["item/started", "item/reasoning/textDelta"]);
  assert.equal(reasoning[1]?.params.contentIndex, 0);

  const tool = projection.project({
    type: "tool.start",
    payload: { tool_id: "tool-1", name: "read_file", args: { path: "README.md" } },
  }, 12_000);
  assert.deepEqual(tool.map(({ method }) => method), ["item/completed", "item/started"]);
  assert.deepEqual(turn.items.map(({ type }) => type), ["reasoning", "dynamicToolCall"]);

  const completedTool = projection.project({
    type: "tool.complete",
    payload: { tool_id: "tool-1", name: "read_file", args: { path: "README.md" }, result: "ok" },
  }, 13_000);
  assert.deepEqual(completedTool.map(({ method }) => method), ["item/completed"]);
  assert.equal(projection.currentPhase, "thinking");

  const duplicateCompletion = projection.project({
    type: "tool.complete",
    payload: { tool_id: "tool-1", name: "read_file", result: "ok" },
  }, 13_500);
  assert.deepEqual(duplicateCompletion, []);
});

test("Hermes live completion removes reasoning repeated by the final answer", () => {
  const turn = {
    id: "turn-repeated-reasoning",
    items: [],
    itemsView: "full" as const,
    status: "inProgress" as const,
    error: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
  };
  let id = 0;
  const projection = new HermesTurnEventStateMachine("thread-repeated-reasoning", turn, () => String(++id));
  projection.accept(10_000);
  projection.project({ type: "reasoning.available", payload: { text: "Hello. How can I help?" } }, 11_000);
  projection.project({ type: "message.delta", payload: { text: "Hello. How can I help?" } }, 12_000);
  const completed = projection.project({
    type: "message.complete",
    payload: { text: "Hello. How can I help?" },
  }, 13_000);

  assert.deepEqual(turn.items.map(({ type }) => type), ["agentMessage"]);
  assert.equal(turn.items[0]?.text, "Hello. How can I help?");
  assert.equal(completed.at(-1)?.method, "turn/completed");
  assert.deepEqual(
    (completed.at(-1)?.params.turn as { items: Array<{ type: string }> }).items.map(({ type }) => type),
    ["agentMessage"],
  );
});

test("Hermes live completion gives one final Item ownership over a repeated interim", () => {
  const turn = {
    id: "turn-repeated-interim",
    items: [],
    itemsView: "full" as const,
    status: "inProgress" as const,
    error: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
  };
  let id = 0;
  const projection = new HermesTurnEventStateMachine("thread-repeated-interim", turn, () => String(++id));
  projection.accept(10_000);
  projection.project({ type: "message.delta", payload: { text: "I did not use any tools." } }, 11_000);
  projection.project({ type: "message.interim", payload: { text: "I did not use any tools." } }, 12_000);
  // A provider reasoning frame is a presentation phase, not permission to
  // orphan the interim Item as a second owner of the eventual final text.
  projection.project({ type: "reasoning.available", payload: { text: "Check whether tools ran." } }, 13_000);
  const completed = projection.project({
    type: "message.complete",
    payload: { text: "I did not use any tools.", status: "complete" },
  }, 14_000);

  const messages = turn.items.filter(({ type }) => type === "agentMessage");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.phase, "final_answer");
  assert.equal(messages[0]?.text, "I did not use any tools.");
  const tombstone = completed.find(({ method, params }) => (
    method === "item/completed"
      && (params.item as { type?: string; phase?: string; text?: string } | undefined)?.type === "agentMessage"
      && (params.item as { phase?: string } | undefined)?.phase === "commentary"
  ));
  assert.equal((tombstone?.params.item as { text?: string } | undefined)?.text, "");
  assert.deepEqual(
    (completed.at(-1)?.params.turn as { items: Array<{ type: string; phase?: string | null }> }).items
      .filter(({ type }) => type === "agentMessage")
      .map(({ phase }) => phase),
    ["final_answer"],
  );
});

test("Hermes settles only the latest prefix-continuous interim into the final Item", () => {
  const turn = {
    id: "turn-prefix-interim",
    items: [],
    itemsView: "full" as const,
    status: "inProgress" as const,
    error: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
  };
  let id = 0;
  const projection = new HermesTurnEventStateMachine("thread-prefix-interim", turn, () => String(++id));
  projection.accept(10_000);
  projection.project({ type: "message.interim", payload: { text: "Earlier real narration." } }, 11_000);
  projection.project({ type: "tool.start", payload: { tool_id: "tool-1", name: "inspect" } }, 12_000);
  projection.project({ type: "tool.complete", payload: { tool_id: "tool-1", name: "inspect", result: "ok" } }, 13_000);
  projection.project({ type: "message.interim", payload: { text: "Partial answer" } }, 14_000);
  projection.project({ type: "reasoning.available", payload: { text: "Verify the result." } }, 15_000);
  projection.project({
    type: "message.complete",
    payload: { text: "Partial answer with more detail", status: "complete" },
  }, 16_000);

  const messages = turn.items.filter(({ type }) => type === "agentMessage");
  assert.deepEqual(messages.map(({ text }) => text), [
    "Earlier real narration.",
    "Partial answer with more detail",
  ]);
  assert.deepEqual(messages.map(({ phase }) => phase), ["commentary", "final_answer"]);
});

test("Hermes projection ignores a pre-start idle heartbeat but converges after live work", () => {
  const turn = {
    id: "turn-heartbeat",
    items: [],
    itemsView: "full" as const,
    status: "inProgress" as const,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
  const projection = new HermesTurnEventStateMachine("thread-heartbeat", turn, () => "stable");
  projection.accept(10_000);

  assert.deepEqual(
    projection.project({ type: "session.info", payload: { running: false } }, 10_100),
    [],
  );
  assert.equal(projection.currentPhase, "accepted");

  assert.deepEqual(
    projection.project({ type: "session.info", payload: { running: true } }, 11_000),
    [],
  );
  assert.equal(projection.currentPhase, "thinking");
  assert.deepEqual(
    projection.project({ type: "session.info", payload: { running: false } }, 12_000)
      .map(({ method }) => method),
    ["turn/completed"],
  );
});

test("Hermes projection converges a swallowed pre-start idle heartbeat at its deadline", () => {
  const turn = {
    id: "turn-deferred-idle",
    items: [],
    itemsView: "full" as const,
    status: "inProgress" as const,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
  const projection = new HermesTurnEventStateMachine("thread-deferred-idle", turn, () => "stable");
  projection.accept(10_000);
  assert.deepEqual(projection.project({ type: "session.info", payload: { running: false } }, 10_100), []);
  assert.equal(projection.deferredSettlementAtMs, 25_000);
  assert.deepEqual(projection.settleDeferredSessionInfo(24_999), []);
  assert.deepEqual(
    projection.settleDeferredSessionInfo(25_000).map(({ method }) => method),
    ["turn/completed"],
  );
  assert.equal(turn.status, "completed");
});

test("Hermes adapter owns the deferred terminal clock and publishes one terminal Turn", async () => {
  let eventListener: ((event: Record<string, unknown>) => void) | null = null;
  let now = 10_000;
  const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "session.create") {
        return {
          session_id: "live-deferred-terminal",
          stored_session_id: "stored-deferred-terminal",
          message_count: 0,
          messages: [],
        } as T;
      }
      if (method === "prompt.submit") return { status: "streaming" } as T;
      throw new Error(`Unexpected ${method}`);
    },
    onEvent(listener) {
      eventListener = listener;
      return () => { eventListener = null; };
    },
  };
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", undefined, {
    now: () => now,
    schedule(callback, delayMs) {
      const task = { callback, delayMs, cancelled: false };
      scheduled.push(task);
      return task;
    },
    cancel(handle) {
      (handle as { cancelled: boolean }).cancelled = true;
    },
  });
  const methods: string[] = [];
  adapter.subscribeNotification((method) => methods.push(method));
  const thread = await adapter.startThread();
  await adapter.startTurn(thread.id, [{ type: "text", text: "hello" }]);
  now = 10_100;
  eventListener?.({ type: "session.info", session_id: "live-deferred-terminal", payload: { running: false } });
  assert.equal(scheduled.at(-1)?.delayMs, 14_900);
  assert.deepEqual(methods, ["turn/started"]);

  now = 25_000;
  scheduled.at(-1)?.callback();
  assert.deepEqual(methods, ["turn/started", "turn/completed"]);
  adapter.dispose();
});

test("Hermes final answer starts on the first text delta and commits the complete Turn", () => {
  const turn = {
    id: "turn-3",
    items: [],
    itemsView: "full" as const,
    status: "inProgress" as const,
    error: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
  };
  const projection = new HermesTurnEventStateMachine("thread-3", turn, () => "answer");
  projection.accept(10_000);
  assert.deepEqual(projection.project({ type: "message.start", payload: {} }, 11_000), []);

  const delta = projection.project({ type: "message.delta", payload: { text: "hel" } }, 12_000);
  assert.deepEqual(delta.map(({ method }) => method), ["item/started", "item/agentMessage/delta"]);
  const complete = projection.project({
    type: "message.complete",
    payload: { text: "hello", status: "complete" },
  }, 14_000);
  assert.deepEqual(complete.map(({ method }) => method), ["item/agentMessage/delta", "item/completed", "turn/completed"]);
  assert.equal(turn.status, "completed");
  assert.equal(turn.items[0]?.text, "hello");
  const completedTurn = complete.at(-1)?.params.turn as { items?: Array<{ text?: string }> };
  assert.equal(completedTurn.items?.[0]?.text, "hello");
});

test("Hermes promotes an interim preview into the authoritative final Item", () => {
  const turn = {
    id: "turn-interim",
    items: [],
    itemsView: "full" as const,
    status: "inProgress" as const,
    error: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
  };
  let id = 0;
  const projection = new HermesTurnEventStateMachine("thread-interim", turn, () => String(++id));
  projection.accept(10_000);

  projection.project({ type: "message.delta", payload: { text: "北京今天天气：晴朗" } }, 11_000);
  projection.project({ type: "message.interim", payload: { text: "北京今天天气：晴朗" } }, 12_000);
  assert.equal(turn.items.length, 1);
  assert.equal(turn.items[0]?.phase, null, "an interim preview remains unclassified until a semantic boundary");

  // Hermes can emit another start for a chained/compressed continuation. The
  // Item-owned interim identity must survive this transport-level frame.
  projection.project({ type: "message.start", payload: {} }, 13_000);
  const completed = projection.project({
    type: "message.complete",
    payload: { text: "北京今天天气：晴朗", response_previewed: true, status: "complete" },
  }, 14_000);

  assert.deepEqual(completed.map(({ method }) => method), ["item/completed", "turn/completed"]);
  assert.equal(turn.items.length, 1);
  assert.equal(turn.items[0]?.phase, "final_answer");
  assert.equal(turn.items[0]?.text, "北京今天天气：晴朗");
});

test("Hermes replaces a non-prefix interim completion without creating a duplicate Item", () => {
  const turn = {
    id: "turn-interim-replacement",
    items: [],
    itemsView: "full" as const,
    status: "inProgress" as const,
    error: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
  };
  const projection = new HermesTurnEventStateMachine("thread-interim-replacement", turn, () => "stable");
  projection.accept(10_000);
  projection.project({ type: "message.interim", payload: { text: "draft answer" } }, 11_000);
  projection.project({
    type: "message.complete",
    payload: { text: "authoritative answer", response_previewed: true, status: "complete" },
  }, 12_000);

  assert.equal(turn.items.length, 1);
  assert.equal(turn.items[0]?.id, "hermes-agent-turn-interim-replacement-1-stable");
  assert.equal(turn.items[0]?.phase, "final_answer");
  assert.equal(turn.items[0]?.text, "authoritative answer");
});

test("Hermes seals real pre-tool commentary before creating the final answer", () => {
  const turn = {
    id: "turn-tool-boundary",
    items: [],
    itemsView: "full" as const,
    status: "inProgress" as const,
    error: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
  };
  let id = 0;
  const projection = new HermesTurnEventStateMachine("thread-tool-boundary", turn, () => String(++id));
  projection.accept(10_000);
  projection.project({ type: "message.interim", payload: { text: "I will inspect the page." } }, 11_000);
  projection.project({
    type: "tool.start",
    payload: { tool_id: "browser-1", name: "browser_use", args: {} },
  }, 12_000);
  projection.project({
    type: "tool.complete",
    payload: { tool_id: "browser-1", name: "browser_use", result: "ok" },
  }, 13_000);
  projection.project({
    type: "message.complete",
    payload: { text: "The page is ready.", status: "complete" },
  }, 14_000);

  const messages = turn.items.filter(({ type }) => type === "agentMessage");
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.phase, "commentary");
  assert.equal(messages[1]?.phase, "final_answer");
});

test("Hermes Dashboard history client requests authenticated bounded transcript pages", async () => {
  let requestedPath = "";
  let requestedToken: string | null = null;
  const history = new HermesDashboardHistoryClient({
    async fetchJson<T>(path: string | URL, init = {}) {
      requestedPath = String(path);
      requestedToken = new Headers(init.headers).get("x-hermes-session-token");
      return { session_id: "stored/1", messages: [], pagination: { limit: 120, offset: 0, order: "latest", returned: 0 } } as T;
    },
    close() {},
  }, "dashboard-secret");
  await history.readMessages("stored/1", { limit: 120, offset: 0, order: "latest", includeCompacted: true });
  assert.equal(requestedPath, "/api/sessions/stored%2F1/messages?limit=120&offset=0&order=latest&include_compacted=true");
  assert.equal(requestedToken, "dashboard-secret");
});

test("Hermes Dashboard history client unwraps an HTTP 200 semantic error envelope", async () => {
  const history = new HermesDashboardHistoryClient({
    async fetchJson<T>() {
      return { detail: "Conversation not found: 20260915_220527_127dc9" } as T;
    },
    close() {},
  }, "dashboard-secret");
  await assert.rejects(
    history.readMessages("20260915_220527_127dc9", {
      limit: 120,
      offset: 0,
      order: "latest",
      includeCompacted: true,
    }),
    /Conversation not found: 20260915_220527_127dc9/u,
  );
});

test("Hermes Dashboard filesystem adapts authenticated file APIs to AppServer shapes", async () => {
  const requests: Array<{
    path: string;
    token: string | null;
    method: string;
    json: unknown;
  }> = [];
  let closed = false;
  const fileSystem = new HermesDashboardFileSystem({
    async fetchJson<T>(path: string | URL, init = {}) {
      const pathText = String(path);
      requests.push({
        path: pathText,
        token: new Headers(init.headers).get("x-hermes-session-token"),
        method: init.method ?? "GET",
        json: init.json,
      });
      if (pathText.startsWith("/api/fs/list?path=%2Fhome%2Fagentuser%2F.hermes%2Fimages")) {
        return { entries: [{ name: "upload.png", path: "/home/agentuser/.hermes/images/upload.png", isDirectory: false }] } as T;
      }
      if (pathText.startsWith("/api/fs/read-data-url?")) {
        return { dataUrl: "data:image/png;base64,aGVsbG8=" } as T;
      }
      if (pathText === "/api/files/upload") {
        return { path: "/home/agentuser/.hermes/opencraft-attachments/a.txt" } as T;
      }
      throw new Error(`Unexpected HTTP request: ${pathText}`);
    },
    close() { closed = true; },
  }, "dashboard-secret", "/home/agentuser");
  const harness = createHermesHistoryHarness();

  const metadata = await dispatchAppServerRequest(harness.adapter, {
    id: 1,
    method: "fs/getMetadata",
    params: { path: "/home/agentuser/.hermes/images/upload.png" },
  }, { fileSystem });
  const file = await dispatchAppServerRequest(harness.adapter, {
    id: 2,
    method: "fs/readFile",
    params: { path: "/home/agentuser/.hermes/images/upload.png" },
  }, { fileSystem });
  const initialized = await dispatchAppServerRequest(harness.adapter, {
    id: 3,
    method: "initialize",
    params: {},
  }, { fileSystem });
  const written = await dispatchAppServerRequest(harness.adapter, {
    id: 4,
    method: "fs/writeFile",
    params: {
      path: "/home/agentuser/.hermes/opencraft-attachments/a.txt",
      dataBase64: "aGVsbG8=",
    },
  }, { fileSystem });

  assert.deepEqual(metadata, {
    isDirectory: false,
    isFile: true,
    isSymlink: false,
    createdAtMs: 0,
    modifiedAtMs: 0,
  });
  assert.deepEqual(file, { dataBase64: "aGVsbG8=" });
  assert.equal((initialized as { codexHome: string }).codexHome, "/home/agentuser/.hermes");
  assert.deepEqual(written, {});
  assert.deepEqual(requests.at(-1), {
    path: "/api/files/upload",
    token: "dashboard-secret",
    method: "POST",
    json: {
      path: "/home/agentuser/.hermes/opencraft-attachments/a.txt",
      data_url: "data:application/octet-stream;base64,aGVsbG8=",
      overwrite: true,
    },
  });
  assert.equal(requests.every(({ token }) => token === "dashboard-secret"), true);
  fileSystem.dispose();
  assert.equal(closed, true);
});
