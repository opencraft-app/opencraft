import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatRenderRuntime,
  registerStandardChatResourcePolicy,
  resolveStandardChatResource,
} from "@opencraft/chat-render-react";
import type { Context } from "@deepseek-ai/cordis";
const FixtureExternalProtocols = Object.assign(
  (ctx: Context) => {
    ctx.effect(() =>
      ctx.chatResourcePolicies.register({
        name: "fixture-external",
        priority: 10,
        matches: (target) => /^fixture-app:/iu.test(target.trim()),
        resolve: (target, context) =>
          context.externalResourcePolicy === "restricted"
            ? { allowed: false, kind: "blocked", target: null, reason: "External resources are restricted" }
            : { allowed: true, kind: "external", target: target.trim() },
      }),
    );
  },
  { inject: ["chatResourcePolicies"] },
);
const context = {
  documentId: "test",
  theme: "light",
  streaming: false,
  allowWideBlocks: false,
  cwd: "/work",
  externalResourcePolicy: "allow",
} as const;
test("URI admission requires product registration, preserves targets, and releases with owner", async () => {
  const runtime = await createChatRenderRuntime();
  registerStandardChatResourcePolicy(runtime.resources, "test");
  const target = "FIXTURE-APP://message/?user=example";
  assert.equal(runtime.resources.resolve(target, context).allowed, false);
  const plugin = await runtime.install(FixtureExternalProtocols);
  assert.deepEqual(runtime.resources.resolve(target, context), { allowed: true, kind: "external", target });
  assert.equal(runtime.resources.resolve(target, { ...context, externalResourcePolicy: "restricted" }).allowed, false);
  for (const uri of [
    "unknown+app://host/file.md:42",
    "unknown:123",
    "javascript:alert(1)",
    "vbscript:test",
    "data:text/html,test",
  ])
    assert.equal(runtime.resources.resolve(uri, context).allowed, false, uri);
  await plugin.dispose();
  assert.equal(runtime.resources.resolve(target, context).allowed, false);
  await runtime.dispose();
});
test("file locations retain Windows absolute and drive relative paths", () => {
  for (const [input, target] of [
    ["C:\\work\\main.ts:42:3", "file:///C:/work/main.ts#L42C3"],
    ["C:/work/main.ts#L4", "file:///C:/work/main.ts#L4"],
    ["C:src/main.ts:12", "C:src/main.ts#L12"],
    ["main.ts:42", "file:///work/main.ts#L42"],
    ["./readme.md:2", "file:///work/readme.md#L2"],
    ["/work/main.ts:3", "file:///work/main.ts#L3"],
  ])
    assert.equal(resolveStandardChatResource(input!, context).target, target, input);
});
