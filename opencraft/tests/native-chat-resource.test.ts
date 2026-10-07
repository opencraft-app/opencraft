import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { resolveStandardChatResource } from "../packages/chat-render-react/src/resource-target";

const require = createRequire(import.meta.url);
const nativeResource = require("../apps/workbench-expo/src/runtime/native-chat-resource.ts") as typeof import("../apps/workbench-expo/src/runtime/native-chat-resource");
const { decodeNativeChatResourceText, nativeChatResourceAction } = nativeResource;

const context = { cwd: "/home/agentuser/workspace", externalResourcePolicy: "allow" as const };

test("native ChatUI opens resolved workspace files through the Host, never the phone filesystem", () => {
  const decision = resolveStandardChatResource("src/app.tsx:12", context);
  assert.deepEqual(nativeChatResourceAction(decision.target!, decision), {
    kind: "file", path: "/home/agentuser/workspace/src/app.tsx", title: "/home/agentuser/workspace/src/app.tsx#L12",
  });
  const unresolved = resolveStandardChatResource("src/app.tsx", { ...context, cwd: null });
  assert.deepEqual(nativeChatResourceAction(unresolved.target!, unresolved), { kind: "unavailable" });
});

test("native ChatUI preserves external policy and refuses unsupported schemes", () => {
  const link = resolveStandardChatResource("https://example.com/path", context);
  assert.deepEqual(nativeChatResourceAction(link.target!, link), { kind: "external", url: "https://example.com/path" });
  const blocked = resolveStandardChatResource("https://example.com/path", { ...context, externalResourcePolicy: "restricted" as const });
  assert.deepEqual(nativeChatResourceAction("https://example.com/path", blocked), { kind: "unavailable" });
  const route = resolveStandardChatResource("app://settings", context);
  assert.deepEqual(nativeChatResourceAction(route.target!, route), { kind: "unavailable" });
  assert.deepEqual(nativeChatResourceAction("file://other-host/private", { allowed: true, kind: "file", target: "file://other-host/private" }), { kind: "unavailable" });
});

test("native Host text preview decodes UTF-8 and excludes binary or oversized content", () => {
  assert.equal(decodeNativeChatResourceText(Buffer.from("你好, OpenCraft\n").toString("base64")), "你好, OpenCraft\n");
  assert.equal(decodeNativeChatResourceText(Buffer.from([0, 1, 2]).toString("base64")), null);
  assert.equal(decodeNativeChatResourceText("not valid base64"), null);
  assert.equal(decodeNativeChatResourceText(Buffer.alloc(512 * 1024 + 1, 65).toString("base64")), null);
});
