import assert from "node:assert/strict";
import test from "node:test";

import { AgentCapabilityEgressService } from "../src/services/agent-capability-egress.ts";

function createService({ role = "administrator", root = true, available = true, registered = true } = {}) {
  const calls = [];
  const appCalls = [];
  const service = Object.create(AgentCapabilityEgressService.prototype);
  service.ctx = {
    threadManager: { isRoot: () => root },
    userDirectory: { find: () => registered ? ({ id: "user:admin", role }) : null },
    threadSearch: {
      available,
      search(query, options) {
        calls.push({ query, options });
        return [{
          threadId: "thread-other",
          turnId: "turn-1",
          itemId: "item-1",
          role: "assistant",
          content: "找到了另一个会话",
          occurredAtMs: 1,
          threadName: "其他任务",
          archived: false,
        }];
      },
    },
    mcpAppBuilder: {
      executeAgent(argumentsValue, principalId) {
        appCalls.push({ argumentsValue, principalId });
        return { text: "published r1" };
      },
    },
  };
  return { service, calls, appCalls };
}

test("every DSH conversation receives the App Builder while only root receives search", () => {
  const ordinary = createService({ root: false }).service.bindingsForThread("thread-1");
  assert.deepEqual(ordinary.map((binding) => binding.capabilityId), ["mcp-app.manage"]);
  assert.equal(ordinary[0].tool.name, "manage_mcp_app");
  assert.match(ordinary[0].skill.instructions, /one-sentence|natural-language/i);
  const root = createService().service.bindingsForThread("thread-admin");
  assert.deepEqual(root.map((binding) => binding.capabilityId), [
    "conversation.search", "mcp-app.manage",
  ]);
  assert.match(root[0].skill.instructions, /current management conversation is always excluded/i);
});

test("MCP App capability reauthorizes and delegates publication to the Builder", () => {
  const { service, appCalls } = createService({ root: false });
  const result = service.execute({
    capabilityId: "mcp-app.manage",
    threadId: "thread-1",
    principalId: "user:admin",
    arguments: { action: "publish", spec_json: "{}" },
  });
  assert.equal(result.text, "published r1");
  assert.deepEqual(appCalls, [{
    argumentsValue: { action: "publish", spec_json: "{}" },
    principalId: "user:admin",
  }]);
  assert.throws(() => createService({ registered: false }).service.execute({
    capabilityId: "mcp-app.manage",
    threadId: "thread-1",
    principalId: "unknown",
    arguments: { action: "list" },
  }), /registered HyperNode user/);
});

test("conversation-search egress reauthorizes and excludes the active outer thread", () => {
  const { service, calls } = createService();
  const result = service.execute({
    capabilityId: "conversation.search",
    threadId: "thread-admin",
    principalId: "user:admin",
    arguments: { query: " 登录   问题 ", limit: 500 },
  });
  assert.deepEqual(calls, [{
    query: "登录 问题",
    options: { limit: 50, excludeThreadId: "thread-admin" },
  }]);
  assert.match(result.text, /其他任务/);
  assert.doesNotMatch(result.text, /thread-admin/);
});

test("conversation-search egress accepts members and rejects unknown principals", () => {
  const request = {
    capabilityId: "conversation.search",
    threadId: "thread-admin",
    principalId: "user:member",
    arguments: { query: "登录" },
  };
  assert.match(createService({ role: "member" }).service.execute(request).text, /其他任务/);
  assert.throws(
    () => createService({ registered: false }).service.execute(request),
    /only a registered HyperNode user/,
  );
});

function browserConnection(id, enabled = true) {
  return {
    connectionId: id,
    initializeParams: {
      capabilities: enabled
        ? { extensions: { "vela/browser-use": { version: 1 } } }
        : { extensions: {} },
    },
  };
}

function createBrowserEgress() {
  const sent = [];
  const deferred = [];
  const service = Object.create(AgentCapabilityEgressService.prototype);
  service.pendingClientToolCalls = new Map();
  service.pendingClientToolCallsByCall = new Map();
  service.clientToolSequence = 0;
  service.ctx = {
    threadManager: { isRoot: () => false },
    appServer: {
      send: (connection, message) => sent.push({ connection, message }),
      defer: (_connection, _delayMs, action) => deferred.push(action),
    },
  };
  return { service, sent, deferred };
}

test("DSH receives Vela browser tools only from an explicitly capable owner client", () => {
  const { service } = createBrowserEgress();
  assert.deepEqual(
    service.bindingsForThread("thread-1", browserConnection("plain", false))
      .map((binding) => binding.tool.name),
    ["manage_mcp_app"],
  );
  const capable = service.bindingsForThread("thread-1", browserConnection("vela"));
  assert.deepEqual(capable.map((binding) => binding.tool.name), [
    "manage_mcp_app", "open_in_vela", "get_tab_context", "browser_use",
  ]);
  assert.equal(capable.filter((binding) => binding.skill?.name === "vela-web-preview").length, 1);
  const browserUse = capable.find((binding) => binding.tool.name === "browser_use");
  assert.doesNotMatch(browserUse.tool.parameters.action.description, /claim|release|screenshot|set_viewport/);
  const open = capable.find((binding) => binding.tool.name === "open_in_vela");
  assert.match(open.tool.parameters.placement.description, /right only/);
});

test("DSH browser capability uses item/tool/call and only the owner response can settle it", async () => {
  const { service, sent } = createBrowserEgress();
  const owner = browserConnection("owner");
  const stranger = browserConnection("stranger");
  const resultPromise = service.execute({
    capabilityId: "vela.browser.open",
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    principalId: "user-1",
    connection: owner,
    arguments: { url: "http://127.0.0.1:5173/" },
  });

  assert.deepEqual(sent[0], {
    connection: owner,
    message: {
      id: "dsh-browser-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "vela_app",
        tool: "open_in_vela",
        arguments: { url: "http://127.0.0.1:5173/" },
      },
    },
  });
  assert.equal(service.handleClientToolResponse({
    id: "dsh-browser-1",
    result: { success: true, contentItems: [{ type: "inputText", text: "wrong" }] },
  }, stranger), true);
  assert.equal(service.pendingClientToolCalls.size, 1);
  assert.equal(service.handleClientToolResponse({
    id: "dsh-browser-1",
    result: { success: true, contentItems: [{ type: "inputText", text: "opened" }] },
  }, owner), true);
  assert.deepEqual(await resultPromise, { text: "opened" });
  assert.equal(service.pendingClientToolCalls.size, 0);
});

test("DSH cancellation resolves the client request surface and rejects the pending tool", async () => {
  const { service, sent } = createBrowserEgress();
  const owner = browserConnection("owner");
  const resultPromise = service.execute({
    capabilityId: "vela.browser.use",
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-2",
    principalId: "user-1",
    connection: owner,
    arguments: { action: "wait", tab_id: "tab-1", text: "ready" },
  });
  assert.equal(service.cancel("thread-1", "call-2", "cancelled by test"), true);
  await assert.rejects(resultPromise, /cancelled by test/);
  assert.deepEqual(sent.at(-1), {
    connection: owner,
    message: {
      method: "serverRequest/resolved",
      params: { requestId: "dsh-browser-1" },
    },
  });
});
