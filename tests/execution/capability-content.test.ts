import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SessionCapabilities, type CapabilityResult } from "../../packages/session-capabilities/src/index.js";
import { SessionCapabilityMcp } from "../../packages/session-capabilities/src/mcp.js";
import { RemoteSessionCapabilities } from "../../packages/session-capabilities/src/remote.js";
import { capabilityResultFromMcp, capabilityResultToMcp } from "../../packages/session-capabilities/src/content.js";

const result: CapabilityResult = { success: true, contentItems: [
  { type: "inputText", text: "Screenshot" },
  { type: "inputImage", imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
] };

test("capability wire preserves mixed content, order and error status", () => {
  for (const success of [true, false]) {
    const source = { ...result, success };
    const wire = capabilityResultToMcp(source);
    assert.deepEqual(wire.content, [{ type: "text", text: "Screenshot" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
    assert.deepEqual(capabilityResultFromMcp(wire), source);
  }
  const screenshot = "A".repeat(4 * 1024 * 1024);
  assert.equal(capabilityResultFromMcp({ content: [{ type: "image", mimeType: "image/jpeg", data: screenshot }] }).contentItems.length, 1);
});

test("unsupported, remote, malformed and oversized content fails explicitly", () => {
  for (const imageUrl of ["https://example.test/private", "data:image/svg+xml;base64,YQ==", "data:image/png;base64,A===", "data:image/png;base64,YQ", "data:image/png;base64,YQ==\n"]) {
    assert.throws(() => capabilityResultToMcp({ success: true, contentItems: [{ type: "inputImage", imageUrl }] }));
  }
  for (const content of [[{ type: "resource_link", uri: "file:///private" }], [{ type: "image", mimeType: "image/png", data: "=AAA" }],
    Array.from({ length: 257 }, () => ({ type: "text", text: "" })), [{ type: "text", text: "a".repeat(24 * 1024 * 1024 + 1) }]]) {
    assert.throws(() => capabilityResultFromMcp({ content }));
  }
  assert.throws(() => capabilityResultToMcp({ success: true, contentItems: [{ type: "inputAudio", audioUrl: "data:audio/wav;base64,YQ==" }] }));
});

test("independent host MCP roundtrip delivers image bytes and checks session revocation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "capability-images-"));
  const key = randomBytes(32), capabilities = new SessionCapabilities(); let enabled = true, calls = 0;
  capabilities.register({ id: "browser-fixture", tools: session => enabled && session.serverId === "host" && session.threadId === "thread"
    ? [{ name: "screenshot", description: "Screenshot", inputSchema: { type: "object" } }] : [],
    async call() { calls++; return result; }, formatResult: value => value as CapabilityResult });
  await writeFile(join(directory, "session-capabilities.key"), key, { mode: 0o600 });
  const gateway = new SessionCapabilityMcp(capabilities, key, undefined, { descriptorPath: join(directory, "session-capabilities.json") });
  t.after(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  await gateway.listen();
  const host = new RemoteSessionCapabilities(directory, "host"), signal = new AbortController().signal;
  await host.refresh("thread"); assert.equal(host.tools("thread").length, 1);
  assert.deepEqual(await host.call("thread", "screenshot", {}, signal), result);
  const foreign = await host.call("other", "screenshot", { threadId: "thread" }, signal);
  assert.equal(foreign.success, false);
  enabled = false;
  assert.equal((await host.call("thread", "screenshot", {}, signal)).success, false);
  assert.equal(calls, 1);
});

test("cancelled provider completion cannot deliver a late result", async () => {
  const capabilities = new SessionCapabilities(), controller = new AbortController();
  capabilities.register({ id: "late", tools: () => [{ name: "late", description: "Late", inputSchema: {} }],
    async call() { controller.abort(new Error("execution cancelled")); return result; }, formatResult: value => value as CapabilityResult });
  await assert.rejects(capabilities.call({ serverId: "s", threadId: "t" }, "late", {}, controller.signal), /execution cancelled/);
});
