import assert from "node:assert/strict";
import test from "node:test";
import { DshExecutionRecord } from "../../apps/local-agent-host/src/dsh-execution-record.js";

function fixture() {
  const record = new DshExecutionRecord("s", "t", "/");
  let seq = 0;
  const events: any[] = [];
  const send = (type: string, data: any) => {
    const event = { type, data, seq: seq++, time: seq * 1000 };
    events.push(event);
    return record.project(event);
  };
  return { record, events, send, chunk: (chunk: any) => send("assistant/chunk", { chunk }) };
}

test("reasoning block ends before text begins, with no duplicate in the final envelope or replay", () => {
  const f = fixture();
  f.chunk({ type: "block-start", index: 0, blockType: "reasoning" });
  const started = f.chunk({ type: "reasoning-delta", index: 0, text: "thinking" });
  const id = started.find(e => e.method === "item/started")!.params.item.id;
  const ended = f.chunk({ type: "block-end", index: 0, block: { type: "reasoning", text: "thinking" } });
  assert.equal(ended.find(e => e.method === "item/completed")?.params.item.id, id);
  f.chunk({ type: "block-start", index: 1, blockType: "text" });
  f.chunk({ type: "text-delta", index: 1, text: "answer" });
  f.chunk({ type: "block-end", index: 1, block: { type: "text", text: "answer" } });
  const envelope = f.send("assistant/message", { message: { content: [
    { type: "reasoning", text: "thinking" }, { type: "text", text: "answer" },
  ] } });
  assert.equal(envelope.filter(e => e.method === "item/started").length, 0);
  const terminal = f.send("turn/end", { reason: { kind: "completed" } });
  const snapshot = f.record.snapshot();
  assert.equal(snapshot.items.filter((i: any) => i.type === "reasoning").length, 1);
  assert.equal(snapshot.items.find((i: any) => i.type === "agentMessage").text, "answer");
  assert.equal(terminal.find(e => e.method === "item/completed")!.params.item.phase, "final_answer");
  const replay = new DshExecutionRecord("s", "t", "/");
  for (const event of f.events) { replay.project(event); assert.deepEqual(replay.project(event), []); }
  assert.deepEqual(replay.snapshot(), snapshot);
});

test("text closes legacy reasoning without block-end and final reasoning corrections preserve identity", () => {
  const f = fixture();
  f.chunk({ type: "reasoning-delta", index: 0, text: "draft" });
  const text = f.chunk({ type: "text-delta", index: 1, text: "reply" });
  assert.ok(text.find(e => e.method === "item/completed" && e.params.item.type === "reasoning"));
  const id = f.record.snapshot().items[0].id;
  f.send("assistant/message", { message: { content: [{ type: "reasoning", text: "corrected" }, { type: "text", text: "reply" }] } });
  assert.equal(f.record.snapshot().items[0].id, id);
  assert.deepEqual(f.record.snapshot().items[0].content, ["corrected"]);
  assert.equal(f.record.snapshot().items.length, 2);
});

test("block-end alone carries full content, indexed blocks reconcile and steps reset ownership", () => {
  const f = fixture();
  f.chunk({ type: "block-end", index: 0, block: { type: "reasoning", text: "first" } });
  f.chunk({ type: "block-end", index: 1, block: { type: "reasoning", text: "second" } });
  f.chunk({ type: "block-end", index: 3, block: { type: "text", text: "B" } });
  f.chunk({ type: "block-end", index: 2, block: { type: "text", text: "A" } });
  f.send("assistant/message", { message: { content: [
    { type: "reasoning", text: "first" }, { type: "reasoning", text: "second corrected" },
    { type: "text", text: "A" }, { type: "text", text: "B" },
  ] } });
  f.send("step/start", {});
  f.chunk({ type: "block-end", index: 0, block: { type: "reasoning", text: "new step" } });
  f.chunk({ type: "block-end", index: 1, block: { type: "text", text: "final" } });
  f.send("turn/end", { reason: { kind: "completed" } });
  const items = f.record.snapshot().items;
  assert.deepEqual(items.filter((i: any) => i.type === "reasoning").map((i: any) => i.content), [["first"], ["second corrected"], ["new step"]]);
  assert.deepEqual(items.filter((i: any) => i.type === "agentMessage").map((i: any) => [i.text, i.phase]), [["AB", "commentary"], ["final", "final_answer"]]);
});

test("empty block boundaries create no synthetic output and interruption closes a truncated reasoning block", () => {
  const f = fixture();
  assert.deepEqual(f.chunk({ type: "block-start", index: 0, blockType: "reasoning" }), []);
  f.chunk({ type: "block-end", index: 0, block: { type: "reasoning", text: "" } });
  assert.equal(f.record.snapshot().items.length, 0);
  f.chunk({ type: "reasoning-delta", index: 1, text: "partial" });
  const events = f.record.interrupt(5000);
  assert.ok(events.find(e => e.method === "item/completed" && e.params.item.type === "reasoning"));
  assert.equal(f.record.snapshot().status, "interrupted");
});
