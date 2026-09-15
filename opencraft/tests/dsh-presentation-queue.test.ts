import test from "node:test";
import assert from "node:assert/strict";
import { DshPresentationQueue } from "../apps/local-agent-host/src/dsh-presentation-queue.js";
test("paced text drains before Item/Turn completion without splitting Unicode graphemes", async () => {
  const sent: any[] = [];
  const queue = new DshPresentationQueue((method, params) => sent.push({ method, params }));
  try {
    const text = "你好👩🏽‍💻".repeat(100);
    queue.emit("item/started", { threadId: "s", turnId: "t", item: { id: "a", type: "agentMessage", text: "" } });
    queue.emit("item/agentMessage/delta", { threadId: "s", turnId: "t", itemId: "a", delta: text });
    queue.emit("item/completed", { threadId: "s", turnId: "t", item: { id: "a", type: "agentMessage", text } });
    queue.emit("turn/completed", { threadId: "s", turn: { id: "t", status: "completed" } });
    assert.equal(sent.some(frame => frame.method === "turn/completed"), false);
    await new Promise(resolve => setTimeout(resolve, 450));
    const deltas = sent.filter(frame => frame.method === "item/agentMessage/delta");
    assert.equal(deltas.map(frame => frame.params.delta).join(""), text);
    assert.ok(deltas.length > 1);
    assert.equal(sent.at(-2).method, "item/completed");
    assert.equal(sent.at(-1).method, "turn/completed");
    assert.equal(queue.diagnostics().activeItems, 0);
  } finally { queue.close(); }
});
test("interruption flushes pending text before terminal and shutdown prevents late callbacks", async () => {
  const sent: string[] = [];
  const queue = new DshPresentationQueue(method => sent.push(method));
  queue.emit("item/agentMessage/delta", { threadId: "s", turnId: "t", itemId: "a", delta: "partial".repeat(100) });
  queue.emit("item/completed", { threadId: "s", turnId: "t", item: { id: "a", type: "agentMessage", text: "partial" } });
  queue.emit("turn/completed", { threadId: "s", turn: { id: "t", status: "interrupted" } });
  assert.equal(sent.at(-1), "turn/completed");
  queue.close();
  const count = sent.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sent.length, count);
});
