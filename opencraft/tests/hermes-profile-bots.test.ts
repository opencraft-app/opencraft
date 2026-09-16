import assert from "node:assert/strict";
import test from "node:test";
import { parseInstanceProfileBots } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/instance-profile-bots.js";
import { HermesBotAppServerHandler } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/bot-protocol-handler.js";
import type { HermesAppServerAdapter } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter.js";
import { BrowserHermesAppServerBridge } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/index.js";

class ProfileSocket extends EventTarget {
  readyState = WebSocket.OPEN;
  readonly requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  profileError: unknown;
  profiles = [{ name: "default" }, { name: "sales" }] as Array<{ name: string; canonical_session?: { id: string } }>;
  groupCapabilities: unknown = { driver: false, methods: [] };
  send(data: string) {
    const request = JSON.parse(data);
    this.requests.push(request);
    const result = request.method === "groups.capabilities"
      ? this.groupCapabilities
      : { profiles: this.profiles };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      jsonrpc: "2.0", id: request.id,
      ...(this.profileError && request.method === "profiles.list" ? { error: this.profileError } : { result }),
    }) })));
  }
  close() { this.readyState = WebSocket.CLOSED; }
}

test("managed bridge negotiates read-only capability through both AppServer entry paths", async () => {
  const socket = new ProfileSocket();
  const bridge = new BrowserHermesAppServerBridge(socket, { instanceId: "instance", resolveProfileBots: async () => bindings() });
  try {
    const initialized = await bridge.request("initialize") as { capabilities: { extensions: Record<string, { features: { botManagement: boolean } }> } };
    assert.equal(initialized.capabilities.extensions["vela/bot-conversations"]?.features.botManagement, false);
    assert.deepEqual(socket.requests[0]?.params, { include_sessions: true });
    const listed = await bridge.handle({ id: 1, method: "bot/list" }) as { result: { data: Array<{ botId: string }> } };
    assert.deepEqual(listed.result.data.map(bot => bot.botId).sort(), ["instance", "sales-id"]);
    const denied = await bridge.handle({ id: 2, method: "bot/create", params: { name: "Unsafe clone" } }) as { error: { data: { code: string } } };
    assert.equal(denied.error.data.code, "BOT_CAPABILITY_UNAVAILABLE");
    assert.ok(socket.requests.every(request => ["profiles.list", "groups.capabilities"].includes(request.method)));
  } finally { bridge.dispose(); }
});

test("managed bridge advertises Hermes hosted rooms only after capability negotiation", async () => {
  const socket = new ProfileSocket();
  socket.groupCapabilities = {
    driver: true,
    methods: ["groups.list", "groups.create", "groups.state", "groups.log", "groups.send", "groups.stop"],
  };
  const bridge = new BrowserHermesAppServerBridge(socket, { resolveProfileBots: async () => bindings() });
  try {
    const initialized = await bridge.request("initialize") as {
      capabilities: { extensions: Record<string, { topologies: string[]; features: { interactions: boolean; groupMembership: boolean }; limits: { maxParticipants: number } }> };
    };
    const capability = initialized.capabilities.extensions["vela/bot-conversations"]!;
    assert.deepEqual(capability.topologies, ["direct", "group"]);
    assert.equal(capability.features.interactions, true);
    assert.equal(capability.features.groupMembership, false);
    assert.equal(capability.limits.maxParticipants, 7);
  } finally { bridge.dispose(); }
});

test("unsupported native profiles omit capability; control-plane and auth errors remain actionable", async () => {
  const socket = new ProfileSocket();
  socket.profileError = { code: -32601, message: "profiles.list unsupported" };
  const bridge = new BrowserHermesAppServerBridge(socket, { resolveProfileBots: async () => bindings() });
  try {
    const initialized = await bridge.request("initialize") as { capabilities: { extensions: Record<string, unknown> } };
    assert.equal(initialized.capabilities.extensions["vela/bot-conversations"], undefined);
  } finally { bridge.dispose(); }
  const unauthorized = new BrowserHermesAppServerBridge(new ProfileSocket(), {
    resolveProfileBots: async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }); },
  });
  try { await assert.rejects(unauthorized.request("initialize"), /unauthorized/); }
  finally { unauthorized.dispose(); }
  for (const error of [Object.assign(new Error("route_not_allowed"), { status: 404, code: "route_not_allowed" }), Object.assign(new Error("method rejected"), { status: 405 })]) {
    const failed = new BrowserHermesAppServerBridge(new ProfileSocket(), { resolveProfileBots: async () => { throw error; } });
    try { await assert.rejects(failed.request("initialize"), /route_not_allowed|method rejected/u); }
    finally { failed.dispose(); }
  }
});

test("managed catalog never invents default and does not publish a detached refresh", async () => {
  let release: ((value: ReturnType<typeof bindings>) => void) | undefined;
  const handler = new HermesBotAppServerHandler({ async listProfiles() { return [{ name: "sales" }]; } } as unknown as HermesAppServerAdapter,
    () => {}, { resolveProfileBots: async () => bindings() });
  assert.equal(await handler.prepareCapability(), true);
  const listed = await handler.handle("bot/list", {}) as { data: Array<{ botId: string }> };
  assert.deepEqual(listed.data.map(bot => bot.botId), ["sales-id"]);
  const detached = new HermesBotAppServerHandler({ async listProfiles() { return [{ name: "default" }]; } } as unknown as HermesAppServerAdapter,
    () => {}, { resolveProfileBots: () => new Promise(resolve => { release = resolve; }) });
  const loading = detached.prepareCapability();
  await new Promise(resolve => setImmediate(resolve));
  detached.dispose();
  release!(bindings());
  await assert.rejects(loading, /detached/);
});

test("native profile index cannot silently assign one persisted session to two Bots", async () => {
  const socket = new ProfileSocket();
  socket.profiles = [
    { name: "default", canonical_session: { id: "ambiguous-stored-id" } },
    { name: "sales", canonical_session: { id: "ambiguous-stored-id" } },
  ];
  const bridge = new BrowserHermesAppServerBridge(socket, { resolveProfileBots: async () => bindings() });
  try { await assert.rejects(bridge.request("initialize"), /Ambiguous Hermes session profile/); }
  finally { bridge.dispose(); }
});

const bindings = () => parseInstanceProfileBots({ items: [
  { bot_id: "instance", instance_id: "instance", profile_id: "main", name: "Main", status: "ready" },
  { bot_id: "sales-id", instance_id: "instance", profile_id: "sales", name: "销售", status: "ready" },
] }, "instance");

function fixture() {
  const submissions: string[] = [];
  const cancellations: string[] = [];
  const events: unknown[] = [];
  const thread = (id: string) => ({ id, name: "Bot Chat", preview: "", createdAt: 1, updatedAt: 1, turns: [] });
  const turn = (id: string) => ({ id, status: "inProgress", startedAt: 1, completedAt: null, error: null,
    items: [{ id: `user:${id}`, type: "userMessage", content: [{ type: "text", text: id }] }] });
  const adapter = {
    async listProfiles() { return [{ name: "default" }, { name: "sales" }, { name: "private" }]; },
    async resolveNamedThread(profile: string) { return thread(`stored:${profile}`); },
    async loadThread(id: string) { return thread(id); },
    profileForThread(id: string) { return id.slice("stored:".length); },
    async readTurnsPage() { return { chronological: [], nextOffset: null }; },
    async activateProjection() {},
    async submitBotTurn(_id: string, _input: unknown, clientId: string, _model: unknown, profile: string) {
      submissions.push(profile); return { turn: turn(clientId), disposition: "started" };
    },
    async cancelTurn(id: string) { cancellations.push(id); },
  } as unknown as HermesAppServerAdapter;
  const handler = new HermesBotAppServerHandler(adapter, event => events.push(event), { resolveProfileBots: async () => bindings() });
  return { handler, submissions, cancellations, events, turn };
}

test("managed Bot catalog projects only bound profiles and rejects runtime profile management", async () => {
  const { handler } = fixture();
  const result = await handler.handle("bot/list", {}) as { data: Array<{ botId: string; name: string }> };
  assert.deepEqual(result.data.map(bot => bot.botId).sort(), ["instance", "sales-id"]);
  assert.equal(result.data.find(bot => bot.botId === "sales-id")?.name, "销售");
  assert.equal(handler.botManagement, false);
  for (const method of ["bot/create", "bot/update", "bot/delete"]) {
    await assert.rejects(handler.handle(method, {}), { domainData: { code: "BOT_CAPABILITY_UNAVAILABLE", retryable: false } });
  }
});

test("Bot session, submissions and cancellation retain their original profile ownership", async () => {
  const { handler, submissions, cancellations, events, turn } = fixture();
  const create = (botId: string) => handler.handle("bot/conversation/create", {
    clientRequestId: botId, topology: "direct", participantIds: [`bot:${botId}`],
  }) as Promise<{ conversation: { conversationId: string } }>;
  const [main, sales] = await Promise.all([create("instance"), create("sales-id")]);
  assert.equal(main.conversation.conversationId, "stored:default");
  assert.equal(sales.conversation.conversationId, "stored:sales");
  for (const [conversationId, clientMessageId] of [["stored:default", "turn-main"], ["stored:sales", "turn-sales"]]) {
    await handler.handle("bot/message/send", { conversationId, clientMessageId, content: [{ type: "text", text: "hello" }] });
  }
  assert.deepEqual(submissions, ["default", "sales"]);
  await assert.rejects(handler.handle("bot/execution/cancel", {
    conversationId: "stored:sales", executionId: "turn-main", commandId: "cross-profile",
  }), { domainData: { code: "BOT_EXECUTION_NOT_FOUND", retryable: false } });
  assert.deepEqual(cancellations, []);
  await handler.handle("bot/execution/cancel", {
    conversationId: "stored:sales", executionId: "turn-sales", commandId: "cancel-sales",
  });
  assert.deepEqual(cancellations, ["stored:sales"]);
  await assert.rejects(handler.handle("bot/execution/cancel", {
    conversationId: "stored:sales", executionId: "turn-sales", commandId: "stale-cancel",
  }), { domainData: { code: "BOT_CAPABILITY_UNAVAILABLE", retryable: false } });
  handler.observeAppServerNotification("turn/started", { threadId: "ordinary-task", turn: turn("ordinary-turn") });
  assert.equal(events.length, 0);

  // Fresh connection resolves persisted session ownership, rather than using the last selected Bot.
  const reconnected = fixture();
  const restored = await reconnected.handler.handle("bot/conversation/read", { conversationId: "stored:sales" }) as {
    conversation: { participantIds: string[] };
  };
  assert.deepEqual(restored.conversation.participantIds, ["person:you", "bot:sales-id"]);
  await reconnected.handler.handle("bot/message/send", {
    conversationId: "stored:sales", clientMessageId: "restored", content: [{ type: "text", text: "continue" }],
  });
  assert.deepEqual(reconnected.submissions, ["sales"]);
});

test("managed catalog refresh cannot transfer an existing Bot identity to another native profile", async () => {
  let route = "sales";
  const handler = new HermesBotAppServerHandler({ async listProfiles() { return [{ name: "sales" }, { name: "other" }]; } } as unknown as HermesAppServerAdapter,
    () => {}, { resolveProfileBots: async () => [{ botId: "stable-bot", nativeProfile: route, name: "Bot", status: "available" }] });
  await handler.handle("bot/list", {});
  route = "other";
  await assert.rejects(handler.handle("bot/list", {}), /binding changed/);
});

test("cold activation owns a newly adopted live execution before accepting cancellation", async () => {
  const cancelled: string[] = [];
  const adapter = {
    async listProfiles() { return [{ name: "sales" }]; },
    async loadThread() { return { id: "stored:sales", name: "Bot Chat", preview: "", createdAt: 1, updatedAt: 1 }; },
    async resolveNamedThread() { return { id: "stored:sales", name: "Bot Chat", preview: "", createdAt: 1, updatedAt: 1 }; },
    profileForThread() { return "sales"; },
    async readTurnsPage() { return { chronological: [], nextOffset: null }; },
    async activateProjection(_id: string, turns: unknown[]) {
      turns.push({ id: "adopted-live-turn", items: [], status: "inProgress", startedAt: 1, completedAt: null });
    },
    async cancelTurn(id: string) { cancelled.push(id); },
  } as unknown as HermesAppServerAdapter;
  const handler = new HermesBotAppServerHandler(adapter, () => {}, { resolveProfileBots: async () => bindings() });
  const restored = await handler.handle("bot/conversation/read", { conversationId: "stored:sales" }) as { executions: Array<{ executionId: string }> };
  assert.equal(restored.executions[0]?.executionId, "adopted-live-turn");
  await handler.handle("bot/execution/cancel", { conversationId: "stored:sales", executionId: "adopted-live-turn", commandId: "cancel-adopted" });
  assert.deepEqual(cancelled, ["stored:sales"]);
});

test("canonical Bot identity is owned by profile session id, not its restored display title", async () => {
  const adapter = {
    async listProfiles() { return [{ name: "sales" }]; },
    async loadThread() {
      return { id: "stored:sales", name: "New chat", preview: "", createdAt: 1, updatedAt: 1 };
    },
    async resolveNamedThread() {
      return { id: "stored:sales", name: "Bot Chat", preview: "", createdAt: 1, updatedAt: 1 };
    },
    profileForThread() { return "sales"; },
    async readTurnsPage() { throw new Error("Conversation not found: stored:sales"); },
    async activateProjection() {},
  } as unknown as HermesAppServerAdapter;
  const handler = new HermesBotAppServerHandler(adapter, () => {}, {
    resolveProfileBots: async () => bindings(),
  });
  const restored = await handler.handle("bot/conversation/read", {
    conversationId: "stored:sales",
  }) as { initialMessagesPage: { data: unknown[] } };
  assert.deepEqual(restored.initialMessagesPage.data, []);
});

test("control-plane Bot identities bind native profiles without interpreting display names", () => {
  const profiles = parseInstanceProfileBots({ items: [
    { bot_id: "instance", instance_id: "instance", profile_id: "main", is_default: true, name: "Main Bot", status: "ready" },
    { bot_id: "sales-123", instance_id: "instance", profile_id: "sales-123", is_default: false, name: "任意中文显示名", status: "ready", gateway_running: false },
  ] }, "instance");
  assert.deepEqual(profiles.map(profile => [profile.botId, profile.nativeProfile, profile.name, profile.status]), [
    ["instance", "default", "Main Bot", "available"], ["sales-123", "sales-123", "任意中文显示名", "available"],
  ]);
  assert.throws(() => parseInstanceProfileBots({ items: [{ bot_id: "x", instance_id: "foreign", profile_id: "x", name: "x", status: "ready" }] }, "instance"), /instance/);
});
