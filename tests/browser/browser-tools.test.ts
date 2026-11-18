import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_TOOL_CATALOG, BrowserToolError, executeBrowserTool, type BrowserToolHost } from "@opencraft/browser-core";

const context = { hostId: "host", threadId: "thread", turnId: "execution", callId: "call" };
const tool = { namespace: "opencraft_browser", name: "browser_use" };

test('cancelled trusted request cannot dispatch a new browser effect', async () => {
  const controller = new AbortController(); controller.abort();
  const dispatch = () => assert.fail('cancelled tool must not dispatch');
  const result = await executeBrowserTool({ open: dispatch, getTabContext: dispatch, browserUse: dispatch },
    { ...context, signal: controller.signal }, tool, { action: 'click' });
  assert.equal(result?.success, false);
  assert.equal(JSON.parse((result!.content[0] as { text: string }).text).outcome, 'not-dispatched');
});

test('native outcome remains unknown through neutral tool dispatch', async () => {
  const host: BrowserToolHost = { open() {}, getTabContext() {}, browserUse() {
    throw new BrowserToolError('CDP_TIMEOUT', 'Input result was not confirmed', false, 'unknown');
  } };
  const result = await executeBrowserTool(host, context, tool, { action: 'click' });
  assert.equal(result?.success, false);
  if (result?.content[0]?.type !== 'text') throw new Error('Missing structured failure');
  assert.deepEqual(JSON.parse(result.content[0].text), {
    code: 'CDP_TIMEOUT', message: 'Input result was not confirmed', retryable: false, outcome: 'unknown',
  });
});

test("neutral browser dispatch keeps trusted context separate from model arguments", async () => {
  let invocation: unknown;
  const host: BrowserToolHost = {
    open() {}, getTabContext() {},
    browserUse(scope, args) { invocation = { scope, args }; return { tabs: [] }; },
  };
  const args = { action: "list_tabs", hostId: "forged", threadId: "forged" };
  const result = await executeBrowserTool(host, context, tool, args);
  assert.deepEqual(invocation, { scope: context, args });
  assert.deepEqual(result, { success: true, content: [{ type: "text", text: '{"tabs":[]}' }] });
  assert.equal(await executeBrowserTool(host, context, { namespace: "other", name: "browser_use" }, args), null);
});

test("neutral results preserve image content and structured failures", async () => {
  const host: BrowserToolHost = {
    open() {}, getTabContext() {},
    browserUse(_context, args) {
      if (args.action === "screenshot") return { screenshot: true, imageUrl: "data:image/png;base64,eA==" };
      throw new BrowserToolError("STALE_ELEMENT_REFERENCE", "Inspect again", true);
    },
  };
  assert.deepEqual(await executeBrowserTool(host, context, tool, { action: "screenshot" }), {
    success: true, content: [{ type: "image", imageUrl: "data:image/png;base64,eA==" }],
  });
  const failed = await executeBrowserTool(host, context, tool, { action: "click" });
  assert.equal(failed?.success, false);
  assert.equal(failed?.content[0]?.type, "text");
  if (failed?.content[0]?.type !== "text") throw new Error("Missing error");
  assert.deepEqual(JSON.parse(failed.content[0].text), {
    code: "STALE_ELEMENT_REFERENCE", message: "Inspect again", retryable: true,
  });
  const names = BROWSER_TOOL_CATALOG.flatMap(namespace => namespace.tools.map(entry => `${namespace.name}/${entry.name}`));
  assert.equal(new Set(names).size, names.length);
});
