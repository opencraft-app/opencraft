import assert from "node:assert/strict";
import test from "node:test";

import type { AppServerServerRequestInterceptor } from "@opencraft/appserver-client";
import {
  installBrowserDynamicToolHandler,
  OPENCRAFT_BROWSER_DYNAMIC_TOOLS,
  type BrowserDynamicToolHost,
} from "@opencraft/browser-appserver";
import type { AppServerServerRequest } from "@opencraft/appserver-protocol";

function harness(host: BrowserDynamicToolHost, hostId = "host-1") {
  let interceptor: AppServerServerRequestInterceptor | null = null;
  let disposed = false;
  const dispose = installBrowserDynamicToolHandler({
    interceptServerRequest(next) {
      interceptor = next;
      return () => { disposed = true; };
    },
  }, host, { hostId });
  return {
    async call(request: AppServerServerRequest, fallback: unknown = "fallback") {
      assert.notEqual(interceptor, null);
      return interceptor!(request, async () => fallback);
    },
    dispose() {
      dispose();
      assert.equal(disposed, true);
    },
  };
}

test("OpenCraft browser tools are stable namespaced DynamicTool specs", () => {
  assert.deepEqual(OPENCRAFT_BROWSER_DYNAMIC_TOOLS.map((spec) => spec.name), [
    "vela_app", "vela_browser",
  ]);
  const names = OPENCRAFT_BROWSER_DYNAMIC_TOOLS.flatMap((spec) =>
    spec.type === "namespace" ? spec.tools.map((tool) => tool.name) : [spec.name]);
  assert.deepEqual(names, ["open_in_vela", "get_tab_context", "browser_use"]);

  const openNamespace = OPENCRAFT_BROWSER_DYNAMIC_TOOLS.find((spec) => spec.name === "vela_app");
  assert.equal(openNamespace?.type, "namespace");
  const openSchema = openNamespace?.type === "namespace"
    ? openNamespace.tools[0]?.inputSchema as {
      properties?: { placement?: { enum?: readonly string[] } };
    }
    : null;
  assert.deepEqual(openSchema?.properties?.placement?.enum, ["right"]);

  const browserNamespace = OPENCRAFT_BROWSER_DYNAMIC_TOOLS.find((spec) => spec.name === "vela_browser");
  assert.equal(browserNamespace?.type, "namespace");
  const browserSchema = browserNamespace?.type === "namespace"
    ? browserNamespace.tools.find((tool) => tool.name === "browser_use")?.inputSchema as {
      properties?: { action?: { enum?: readonly string[] } };
    }
    : null;
  const actions = browserSchema?.properties?.action?.enum ?? [];
  assert.equal(actions.includes("screenshot"), true);
  assert.equal(actions.includes("set_viewport"), false);
  assert.equal(actions.includes("claim"), false);
  assert.equal(actions.includes("release"), false);
});

test("browser handler captures only OpenCraft item/tool/call requests", async () => {
  const calls: unknown[] = [];
  const host: BrowserDynamicToolHost = {
    open: (context, argumentsValue) => {
      calls.push({ method: "open", context, argumentsValue });
      return { opened: true, tabId: "browser-1" };
    },
    getTabContext: () => "context",
    browserUse: () => ({ ok: true }),
  };
  const h = harness(host);
  const result = await h.call({
    id: "server-1",
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: "vela_app",
      tool: "open_in_vela",
      arguments: { url: "http://127.0.0.1:5173/" },
    },
  });
  assert.deepEqual(result, {
    success: true,
    contentItems: [{
      type: "inputText",
      text: JSON.stringify({ opened: true, tabId: "browser-1" }),
    }],
  });
  assert.deepEqual(calls, [{
    method: "open",
    context: {
      hostId: "host-1",
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
    },
    argumentsValue: { url: "http://127.0.0.1:5173/" },
  }]);
  assert.equal(await h.call({
    id: "server-2",
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-2",
      namespace: "other",
      tool: "other",
      arguments: {},
    },
  }), "fallback");
  h.dispose();
});

test("browser handler returns a structured honest failure instead of mock success", async () => {
  const h = harness({
    open: () => { throw new Error("page blocked by policy"); },
    getTabContext: () => "context",
    browserUse: () => ({ ok: true }),
  });
  const result = await h.call({
    id: "server-1",
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: "vela_app",
      tool: "open_in_vela",
      arguments: { url: "https://blocked.example/" },
    },
  });
  assert.equal((result as { success: boolean }).success, false);
  assert.match(
    (result as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
    /page blocked by policy/,
  );
  h.dispose();
});
