import assert from "node:assert/strict";
import test from "node:test";

import {
  CALCULATOR_HTML,
  CALCULATOR_RESOURCE_URI,
  CalculatorService,
  convertCmbRate,
  evaluateExpression,
} from "../src/services/calculator.ts";
import {
  calculatorLaunchRequest,
  executeMcpAppLaunch,
  isMcpAppLaunchRequest,
} from "../src/services/mcp-app-launcher.ts";
import { McpRegistry } from "../src/services/mcp-registry.ts";

function calculatorRegistration() {
  const service = Object.create(CalculatorService.prototype);
  return service.registration();
}

test("MCP registry exposes calculator tools and UI resource", () => {
  const registry = new McpRegistry();
  registry.registerServer(calculatorRegistration());

  const response = registry.list({ cursor: null, limit: 100, detail: "full" });
  assert.equal(response.nextCursor, null);
  assert.equal(response.data.length, 1);
  const server = response.data[0];
  assert.equal(server.name, "hypernode-calculator");
  assert.equal(server.pluginId, "hypernode-control");
  assert.equal(server.authStatus, "bearerToken");
  assert.equal(server.resources[0].uri, CALCULATOR_RESOURCE_URI);
  assert.deepEqual(Object.keys(server.tools), [
    "calculator.compute",
    "calculator.convertCurrency",
  ]);
  assert.equal(
    server.tools["calculator.compute"]._meta.ui.resourceUri,
    CALCULATOR_RESOURCE_URI,
  );
});

test("MCP registry removes a dynamically unregistered server", () => {
  const registry = new McpRegistry();
  registry.registerServer(calculatorRegistration());
  assert.equal(registry.removeServer("hypernode-calculator"), true);
  assert.equal(registry.removeServer("hypernode-calculator"), false);
  assert.deepEqual(registry.list().data, []);
});

test("toolsAndAuthOnly omits resource inventory but keeps tool descriptors", () => {
  const registry = new McpRegistry();
  registry.registerServer(calculatorRegistration());
  const response = registry.list({ detail: "toolsAndAuthOnly" });
  assert.deepEqual(response.data[0].resources, []);
  assert.ok(response.data[0].tools["calculator.compute"]);
});

test("MCP registry reads the calculator sandbox HTML", () => {
  const registry = new McpRegistry();
  registry.registerServer(calculatorRegistration());
  const response = registry.read({
    server: "hypernode-calculator",
    uri: CALCULATOR_RESOURCE_URI,
  });
  assert.equal(response.contents.length, 1);
  assert.equal(response.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.equal(response.contents[0].text, CALCULATOR_HTML);
  assert.match(response.contents[0].text, /window\.openai\.callTool/);
  assert.match(response.contents[0].text, /role="tablist"/);
  assert.match(response.contents[0].text, /aria-live="polite"/);
  assert.match(response.contents[0].text, /class="card" role="status"/);
  assert.doesNotMatch(response.contents[0].text, /<main class="card"/);
  assert.doesNotMatch(response.contents[0].text, /(?:^|[{;])\s*max-width\s*:/m);
  assert.doesNotMatch(response.contents[0].text, /#[0-9a-f]{3,8}/i);
  assert.doesNotMatch(response.contents[0].text, /ResizeObserver/);
  const inlineScript = CALCULATOR_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Function(inlineScript));
});

test("calculator.compute evaluates arithmetic without eval", () => {
  assert.equal(evaluateExpression("12 * (8 + 2) / 5"), 24);
  assert.equal(evaluateExpression("-2 + .5"), -1.5);
  assert.throws(() => evaluateExpression("globalThis"), /expected a number/);
  assert.throws(() => evaluateExpression("1 / 0"), /division by zero/);
});

test("MCP registry dispatches calculator.compute with structured content", () => {
  const registry = new McpRegistry();
  registry.registerServer(calculatorRegistration());
  const result = registry.call({
    server: "hypernode-calculator",
    threadId: "thread-1",
    tool: "calculator.compute",
    arguments: { expression: "12 * 8" },
  }, {});
  assert.deepEqual(result.structuredContent, { expression: "12 * 8", value: 96 });
  assert.deepEqual(result.content, [{ type: "text", text: "12 * 8 = 96" }]);
});

test("calculator launcher produces a native completed MCP App item", () => {
  const launch = calculatorLaunchRequest();
  assert.equal(isMcpAppLaunchRequest(launch), true);
  let invocation = null;
  const projection = executeMcpAppLaunch({
    callTool(actual) {
      invocation = actual;
      return {
        content: [{ type: "text", text: "0 = 0" }],
        structuredContent: { expression: "0", value: 0 },
      };
    },
  }, launch, {}, "thread-1", "mcp-launch-1");

  assert.deepEqual(invocation, {
    server: "hypernode-calculator",
    tool: "calculator.compute",
    threadId: "thread-1",
    arguments: { expression: "0" },
    meta: { source: "hypernode-virtual-skill" },
  });
  assert.equal(projection.started.id, projection.completed.id);
  assert.equal(projection.started.type, "mcpToolCall");
  assert.equal(projection.started.status, "inProgress");
  assert.equal(projection.completed.status, "completed");
  assert.equal(projection.completed.appContext.resourceUri, CALCULATOR_RESOURCE_URI);
  assert.deepEqual(projection.completed.result.structuredContent, {
    expression: "0",
    value: 0,
  });
});

test("calculator launcher rejects an asynchronous bootstrap tool without leaking it", () => {
  let cancelled = false;
  assert.throws(() => executeMcpAppLaunch({
    callTool() {
      return {
        kind: "pending",
        poll: () => null,
        cancel: () => { cancelled = true; },
      };
    },
  }, calculatorLaunchRequest(), {}, "thread-1", "mcp-launch-pending"), /must complete synchronously/);
  assert.equal(cancelled, true);
});

const CMB_RESPONSE = {
  returnCode: "SUC0000",
  errorMsg: null,
  body: [{
    ccyNbr: "港币",
    ccyNbrEng: "港币 HKD",
    rthOfr: "85.92",
    rthBid: "85.58",
    ratDat: "2026年08月31日",
    ratTim: "12:55:17",
  }],
};

test("CMB conversion uses the bank selling rate for CNY to HKD", () => {
  const result = convertCmbRate(CMB_RESPONSE, 859.2, "CNY", "HKD");
  assert.equal(result.convertedAmount, 1000);
  assert.equal(result.bankRateCnyPer100Hkd, 85.92);
  assert.equal(result.quoteType, "现汇卖出价");
  assert.equal(result.quotedAt, "2026年08月31日 12:55:17");
});

test("CMB conversion uses the bank buying rate for HKD to CNY", () => {
  const result = convertCmbRate(CMB_RESPONSE, 1000, "HKD", "CNY");
  assert.equal(result.convertedAmount, 855.8);
  assert.equal(result.bankRateCnyPer100Hkd, 85.58);
  assert.equal(result.quoteType, "现汇买入价");
});

test("currency tool keeps polling while the HTTP transport has no error yet", () => {
  const service = Object.create(CalculatorService.prototype);
  service.requestSequence = 0;
  const bytes = [...Buffer.from(JSON.stringify(CMB_RESPONSE))];
  const drains = [
    { status: 200, dataBytes: [], closed: false, error: "" },
    { status: 0, dataBytes: bytes, closed: true, error: null },
  ];
  let opened = null;
  let closed = null;
  service.ctx = {
    httpClient: {
      open(id, options) { opened = { id, options }; },
      drain() { return drains.shift(); },
      close(id) { closed = id; },
    },
  };

  const tool = service.registration().tools.find((candidate) => (
    candidate.name === "calculator.convertCurrency"
  ));
  const pending = tool.call({ amount: 1000, from: "HKD", to: "CNY" });
  assert.equal(pending.poll(), null);
  assert.equal(opened.options.url, "https://fx.cmbchina.com/api/v1/fx/rate");
  assert.equal(pending.poll().structuredContent.convertedAmount, 855.8);
  pending.cancel();
  assert.equal(closed, opened.id);
});

test("MCP registry rejects duplicate servers and unknown resources", () => {
  const registry = new McpRegistry();
  const server = calculatorRegistration();
  registry.registerServer(server);
  assert.throws(() => registry.registerServer(server), /duplicate MCP server/);
  assert.throws(() => registry.read({
    server: "hypernode-calculator",
    uri: "ui://missing",
  }), /unknown MCP resource/);
});
