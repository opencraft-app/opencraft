import assert from "node:assert/strict";
import test from "node:test";
import { createAppBridge } from "../../apps/workbench-web/src/mcp-apps/bridge";
import { readAppResource, appCsp } from "../../apps/workbench-web/src/mcp-apps/policy";
import { createMcpAppOwner } from "../../apps/workbench-web/src/mcp-apps/owner";
import type { McpAppPort, McpAppWidgetStateStore } from "../../apps/workbench-web/src/mcp-apps/contract";
import { MCP_APP_RESOURCE_META } from "../../packages/appserver-protocol/src/mcp-apps";

test("same-name published cards select their own tools and exact URI metadata", async () => {
  const server = "opencraft-app-calculator-r1", calls: any[] = [];
  const owner = createMcpAppOwner({ key: "host:thread:1", threadId: "thread", assertCurrent() {},
    request: (async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "mcpServerStatus/list") return { data: [
        { name: server, resources: [{ uri: "ui://first" }], tools: { first: { name: "first" } } },
        { name: server, resources: [{ uri: "ui://second" }], tools: { second: { name: "second" } } },
      ], nextCursor: null };
      return { content: [] };
    }) as any, sendMessage: async () => {}, openLink() {},
  });
  assert.deepEqual(Object.keys(await owner.listTools(server, "ui://first")), ["first"]);
  assert.deepEqual(Object.keys(await owner.listTools(server, "ui://second")), ["second"]);
  await owner.callTool(server, "first", {}, "ui://first");
  assert.deepEqual(calls.at(-1).params._meta, { [MCP_APP_RESOURCE_META]: "ui://first" });
});

const identity = { server: "apps", uri: "ui://counter/app.html", callId: "call1", name: "Counter" };
test("saved widget data survives owner replacement, isolates App identities and rejects stale writes", async () => {
  const entries: McpAppWidgetStateStore = new Map();
  const calls: string[] = [], replies: any[] = [];
  let current = true;
  const owner = (scope: string, key: string, assertCurrent = () => {}) => createMcpAppOwner({
    key, threadId: "thread", widgetStateStore: { scope, entries }, assertCurrent,
    request: (async (method: string) => { calls.push(method); throw Error("Unexpected RPC"); }) as any,
    sendMessage: async () => { calls.push("message"); }, openLink() { calls.push("link"); },
  });
  const first = owner("host:thread", "lease1", () => { if (!current) throw Error("stale"); });
  const state = first.widgetState!("item", identity);
  const bridge = createAppBridge({ port: first, identity, contextId: "item", hostContext: () => ({}),
    input: () => ({}), output: () => ({}), onHeight() {}, onWidgetState: value => { state.current = value; } });
  const save = (id: number, value: unknown) => bridge.receive({ jsonrpc: "2.0", id, method: "opencraft/widget-state", params: { state: value } }, reply => replies.push(reply), true);
  const saved = { note: "Keep my note 你好", pausedByUser: false };
  state.pausedByUser = true;
  await save(1, saved); saved.note = "mutated caller object";
  assert.deepEqual(state.current, { note: "Keep my note 你好", pausedByUser: false });
  await save(2, { note: "x".repeat(32769) });
  assert.ok(replies.at(-1).error);
  current = false; await save(3, { note: "late overwrite" });
  assert.match(replies.at(-1).error.message, /stale/);
  assert.throws(() => first.widgetState!("item", identity), /stale/);
  const replacement = owner("host:thread", "lease2");
  assert.equal(replacement.widgetState!("item", identity), state);
  assert.equal(state.pausedByUser, true, "App-authored JSON cannot change the host pause choice");
  assert.equal(replacement.widgetState!("item", { ...identity, name: "Renamed display" }), state);
  for (const [scope, item, changed] of [
    ["other-host:thread", "item", identity], ["host:other-thread", "item", identity],
    ["host:thread", "other-item", identity], ["host:thread", "item", { ...identity, callId: "call2" }],
    ["host:thread", "item", { ...identity, uri: "ui://other/app.html" }],
    ["host:thread", "item", { ...identity, server: "other" }],
  ] as const) {
    const fresh = owner(scope, "lease3").widgetState!(item, changed);
    assert.equal(fresh.current, null);
    assert.notEqual(fresh.pausedByUser, true, "A different App does not inherit manual pause");
  }
  assert.deepEqual(state.current, { note: "Keep my note 你好", pausedByUser: false });
  assert.deepEqual(calls, []);
  bridge.dispose();
});
test("cached built-in cards share one canonical history read; resources retry once, tool calls never retry", async () => {
  let hydrated = false, hydrations = 0, reads = 0, writes = 0;
  const owner = createMcpAppOwner({ key: "host:thread:1", threadId: "thread", assertCurrent() {},
    request: (async (method: string) => {
      if (method === "thread/read") { hydrations++; await new Promise(r => setTimeout(r, 0)); hydrated = true; return {}; }
      if (method === "mcpServer/resource/read") { reads++; if (!hydrated) throw Error("inactive"); return { contents: [] }; }
      writes++; throw Error("write failed");
    }) as any, sendMessage: async () => {}, openLink() {},
  });
  await Promise.all([owner.readResource("opencraft-app-example-r1", "ui://opencraft/apps/first", null),
    owner.readResource("opencraft-app-example-r1", "ui://opencraft/apps/second", null)]);
  assert.equal(hydrations, 1); assert.equal(reads, 4);
  await assert.rejects(owner.callTool("opencraft-app-example-r1", "write", {}), /write failed/);
  assert.equal(writes, 1);
});
test("failed history hydration is shared but a later explicit resource retry can recover", async () => {
  let hydrated = false, hydrations = 0, reads = 0, current = true;
  const inactive = Error("canonical resource denied");
  const owner = createMcpAppOwner({ key: "host:thread:1", threadId: "thread",
    assertCurrent() { if (!current) throw Error("stale owner"); },
    request: (async (method: string) => {
      if (method === "thread/read") {
        hydrations++; await new Promise(resolve => setTimeout(resolve, 0));
        if (hydrations === 1) throw Error("temporary history failure");
        hydrated = true; return {};
      }
      assert.equal(method, "mcpServer/resource/read"); reads++;
      if (!hydrated) throw inactive;
      return { contents: [] };
    }) as any, sendMessage: async () => {}, openLink() {},
  });
  const read = () => owner.readResource("opencraft-app-example-r1", "ui://opencraft/apps/first", null);
  const first = await Promise.allSettled([read(), read()]);
  assert.ok(first.every(result => result.status === "rejected" && result.reason === inactive));
  assert.equal(hydrations, 1); assert.equal(reads, 2);
  await Promise.all([read(), read()]);
  assert.equal(hydrations, 2); assert.equal(reads, 6);
  current = false;
  await assert.rejects(read(), /stale owner/);
  assert.equal(hydrations, 2); assert.equal(reads, 6);
});
test("history recovery preserves resource authorization and built-in scope", async () => {
  let hydrations = 0, reads = 0;
  const denied = Error("denied");
  const owner = createMcpAppOwner({ key: "host:thread:1", threadId: "thread", assertCurrent() {},
    request: (async (method: string) => {
      if (method === "thread/read") { hydrations++; return {}; }
      assert.equal(method, "mcpServer/resource/read"); reads++; throw denied;
    }) as any, sendMessage: async () => {}, openLink() {},
  });
  for (const [server, uri] of [["external", "ui://opencraft/apps/first"], ["opencraft-app-example-r1", "ui://other/app"]]) {
    await assert.rejects(owner.readResource(server, uri, null), error => error === denied);
  }
  assert.equal(hydrations, 0); assert.equal(reads, 2);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(owner.readResource("opencraft-app-example-r1", "ui://opencraft/apps/first", null), error => error === denied);
  }
  assert.equal(hydrations, 1, "successful history stays cached without granting resource access");
  assert.equal(reads, 6, "each explicit attempt retries its read only once");
});
function fixture() {
  let current = true;
  const calls: unknown[] = [], messages: unknown[] = [], sent: any[] = [];
  const context = new Map();
  const port: McpAppPort = {
    key: "host:thread:1", assertCurrent: () => { if (!current) throw Error("stale owner"); },
    readResource: async (...args) => { calls.push(args); return {}; },
    listTools: async () => ({ increment: { name: "increment" }, private: { name: "private", _meta: { ui: { visibility: ["model"] } } } }),
    callTool: async (...args) => { calls.push(args); return { content: [], structuredContent: { count: 2 } }; },
    sendMessage: async text => { messages.push(text); }, updateContext: (id, value) => context.set(id, value), openLink: url => messages.push(url),
  };
  const bridge = createAppBridge({ identity, port, contextId: "view", hostContext: () => ({ theme: "dark" }), input: () => ({ count: 1 }), output: () => ({ content: [], _meta: { private: "ui-only" } }), onHeight: height => messages.push(height), onWidgetState: state => messages.push(state) });
  const receive = (method: string, params: unknown = {}, legacy = true, id: number | undefined = sent.length + 1) => bridge.receive({ jsonrpc: "2.0", id, method, params }, value => sent.push(value), legacy);
  return { port, calls, messages, context, bridge, receive, sent, revoke: () => { current = false; } };
}
test("standard initialize precedes tool events and preserves UI-only metadata", async () => {
  const f = fixture();
  await f.receive("tools/call", { name: "increment" }, false);
  assert.match(f.sent[0].error.message, /Initialize/);
  await f.receive("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "Test", version: "1" }, appCapabilities: {} }, false);
  assert.equal(f.sent[1].result.hostCapabilities.sampling, undefined);
  const notifications: any[] = [];
  await f.bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, value => notifications.push(value));
  assert.deepEqual(notifications.map(value => value.method), ["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  assert.equal(notifications[1].params._meta.private, "ui-only");
  f.bridge.dispose();
});
test("tools and resource reads cannot select another server, URI or model-only tool", async () => {
  const f = fixture();
  await f.receive("tools/call", { name: "increment", server: "other", arguments: { amount: 2 } });
  assert.deepEqual(f.calls, [["apps", "increment", { amount: 2 }, identity.uri]]);
  await f.receive("tools/call", { name: "private" });
  await f.receive("tools/call", { name: "missing" });
  await f.receive("resources/read", { uri: "file:///secret" });
  assert.equal(f.calls.length, 1);
  assert.ok(f.sent.slice(1).every(value => value.error));
  f.bridge.dispose();
});
test("legacy text followup/context use narrow ports; URLs and rich messages fail closed", async () => {
  const f = fixture();
  await f.receive("ui/message", { role: "user", content: [{ type: "text", text: "Next" }] });
  await f.receive("ui/update-model-context", { structuredContent: { count: 3 } });
  assert.deepEqual(f.messages, ["Next"]);
  assert.equal(f.context.get("view"), '{"count":3}');
  await f.receive("ui/open-link", { url: "javascript:alert(1)" });
  await f.receive("ui/message", { role: "assistant", content: [{ type: "text", text: "spoof" }] });
  await f.receive("ui/message", { role: "user", content: [{ type: "image", data: "x" }] });
  assert.ok(f.sent.slice(2).every(value => value.error));
  f.bridge.dispose();
});
test("lease revocation and disposal fence a tool waiting for catalog, without retries", async () => {
  for (const dispose of [false, true]) {
    const f = fixture();
    let release!: (value: Record<string, unknown>) => void;
    f.port.listTools = () => new Promise(resolve => { release = resolve; });
    const pending = f.receive("tools/call", { name: "increment" });
    if (dispose) f.bridge.dispose(); else f.revoke();
    release({ increment: { name: "increment" } });
    await pending;
    assert.equal(f.calls.length, 0);
    if (dispose) assert.equal(f.sent.length, 0); else assert.match(f.sent[0].error.message, /stale/);
    f.bridge.dispose();
  }
});
test("request budget and duplicate IDs bound pending app work", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.port.listTools = async () => { await gate; return { increment: {} }; };
  const pending = Array.from({ length: 17 }, (_, id) => f.receive("tools/call", { name: "increment" }, true, id));
  await f.receive("tools/call", { name: "increment" }, true, 0);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].error.message, /Too many/);
  f.bridge.dispose(); release(); await Promise.all(pending);
  assert.equal(f.calls.length, 0);
});
test("resource policy verifies provenance, MIME, size and CSP injection boundaries", () => {
  const result = (overrides = {}) => ({ contents: [{ uri: identity.uri, mimeType: "text/html;profile=mcp-app", text: "<b>OK</b>", ...overrides }] });
  const resource = readAppResource(result(), identity.uri, "call1");
  assert.match(appCsp(resource), /connect-src 'none'/);
  assert.match(appCsp(resource), /form-action 'none'/);
  assert.throws(() => readAppResource({ ...result(), originCallId: "other" }, identity.uri, "call1"), /provenance/);
  assert.throws(() => readAppResource(result({ mimeType: "application/javascript" }), identity.uri, "call1"));
  assert.throws(() => readAppResource(result({ text: "x".repeat(1048577) }), identity.uri, "call1"));
  assert.throws(() => readAppResource(result({ _meta: { ui: { csp: { connectDomains: ["https://safe.test; script-src *"] } } } }), identity.uri, "call1"));
  assert.equal(readAppResource(result({ _meta: { ui: { csp: { resourceDomains: ["https://cdn.example.com"] } } } }), identity.uri, "call1").csp.resourceDomains[0], "https://cdn.example.com");
});
test("owner shares paginated discovery and compiles only ephemeral untrusted context", async () => {
  const calls: any[] = [];
  const owner = createMcpAppOwner({ key: "h:t:1", threadId: "t", assertCurrent() {}, openLink() {}, sendMessage: async () => {},
    request: async (method: any, params: any): Promise<any> => { calls.push({ method, params }); return { data: [{ name: "apps", tools: { increment: { name: "increment" } } }], nextCursor: null }; } });
  await Promise.all([owner.listTools("apps"), owner.listTools("apps")]);
  assert.equal(calls.length, 1);
  owner.updateContext("view", "count=5");
  const intent: any = { target: { type: "existing-thread", key: { hostId: "h", threadId: "t" } }, commandId: "c", clientMessageId: "m", createdAt: 0, attachments: [], selections: {}, options: { autoContext: false }, context: [], document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Continue" }] }] } };
  const augmented = owner.augment(intent);
  assert.equal(intent.context.length, 0);
  const { compileSubmitIntent } = await import("@opencraft/composer-appserver");
  const compiled = compileSubmitIntent(augmented);
  assert.deepEqual(compiled.additionalContext, { "mcp-app:view": { kind: "untrusted", value: "count=5" } });
  assert.equal(JSON.stringify(compiled.input).includes("count=5"), false);
  assert.throws(() => owner.updateContext("large", "x".repeat(65536)), /budget/);
  owner.updateContext("view", null);
  assert.equal(owner.augment(intent), intent);
});


test("timeline preserves the MCP UI envelope even when a structured display result exists", async () => {
  const { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } = await import("@opencraft/chat-core");
  const envelope = { content: [], structuredContent: { count: 1 }, _meta: { private: "ui-only" } };
  const timeline = projectTimeline({ key: createConversationKey("host", "thread"), revision: 1, authoritative: true, phase: "live", turns: [{ id: "turn", status: "complete", items: [{ id: "call", type: "mcpToolCall", payload: { server: "apps", tool: "counter", status: "completed", structuredResult: { count: 1 }, result: envelope, mcpAppResourceUri: "ui://legacy/app.html", mcpAppUi: { resourceUri: "ui://counter/app.html", preferredModelDisplayMode: "inline" } } }] }] }, createDefaultTimelineProjectorRegistry());
  const block = timeline.frames.flatMap(frame => frame.blocks).find(block => block.type === "tool-call");
  assert.ok(block?.type === "tool-call");
  assert.equal(block.appResourceUri, "ui://counter/app.html");
  assert.deepEqual(block.appToolResult, envelope);
  assert.deepEqual(block.output, { count: 1 });
});


test("theme updates never replay tool results, and interrupted tools emit cancellation", async () => {
  const f = fixture();
  let status = "running";
  const bridge = createAppBridge({ port: f.port, identity, contextId: "view", hostContext: () => ({ theme: "dark" }), input: () => ({ count: 1 }), output: () => null, status: () => status, onHeight() {}, onWidgetState() {} });
  const sent: any[] = [];
  const send = (value: unknown) => sent.push(value);
  await bridge.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "Test" } } }, send);
  await bridge.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, send);
  assert.equal(sent[1].method, "ui/notifications/tool-input-partial");
  bridge.update(send);
  assert.deepEqual(sent.slice(2).map(value => value.method), ["ui/notifications/host-context-changed"]);
  status = "interrupted"; bridge.updateTool(send);
  assert.equal(sent[3].method, "ui/notifications/tool-cancelled");
  bridge.dispose(); f.bridge.dispose();
});
