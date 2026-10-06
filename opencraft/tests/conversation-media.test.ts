import assert from "node:assert/strict";
import test from "node:test";
import { resolveChatConversationMediaSource } from "../packages/chat-render-react/src/conversation-media";
import { chatMediaPresentationKey } from "../packages/chat-render-react/src/resource-media";

test("conversation images route Host files through the media boundary", () => {
  const absolute = resolveChatConversationMediaSource("/workspace/chart.png", "/workspace", null, true);
  assert.equal(absolute.decision.kind, "file");
  assert.equal(absolute.decision.target, "file:///workspace/chart.png");
  assert.equal(absolute.loadThroughHost, true);
  const relative = resolveChatConversationMediaSource("images/chart.png", "/workspace", null, true);
  assert.equal(relative.decision.target, "file:///workspace/images/chart.png");
  assert.equal(relative.loadThroughHost, true);
  assert.equal(resolveChatConversationMediaSource("/workspace/chart.png", "/workspace", null, false).loadThroughHost, false);
});

test("conversation images preserve direct sources and reject unsafe targets", () => {
  const direct = resolveChatConversationMediaSource("data:image/png;base64,AA==", null, "data:image/png;base64,AA==", true);
  assert.equal(direct.directSource, "data:image/png;base64,AA==");
  assert.equal(direct.loadThroughHost, false);
  const blocked = resolveChatConversationMediaSource("javascript:alert(1)", null, null, true);
  assert.equal(blocked.decision.allowed, false);
  assert.equal(blocked.loadThroughHost, false);
});

test("image presentation state follows the full Host media request scope", () => {
  const decision = { allowed: true, kind: "file" as const, target: "file:///workspace/chart.png" };
  const context = { hostId: "host-a", conversationId: "thread-a", cwd: "/workspace", documentId: "message-a" };
  const key = chatMediaPresentationKey("chart.png", decision, context);
  assert.equal(key, chatMediaPresentationKey("chart.png", decision, { ...context }));
  assert.notEqual(key, chatMediaPresentationKey("chart.png", decision, { ...context, hostId: "host-b" }));
  assert.notEqual(key, chatMediaPresentationKey("chart.png", decision, { ...context, conversationId: "thread-b" }));
  assert.notEqual(key, chatMediaPresentationKey("chart.png", decision, { ...context, cwd: "/other" }));
  assert.notEqual(key, chatMediaPresentationKey("chart.png", decision, { ...context, documentId: "message-b" }));
});
