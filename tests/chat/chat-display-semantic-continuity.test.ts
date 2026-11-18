import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline,
  renderAsyncQuestionReply, deriveAsyncQuestionPresentation, groupTimelineFramesByTurn,
  createTimelineTurnPresentationPlan, resolveAgentActivityLayout, type TimelineSnapshot,
} from "@opencraft/chat-core";
import { createConversationDisplayContinuity, selectConversationDisplay } from "@opencraft/workbench-runtime";

const question = { id: JSON.stringify(["request_user_input_async", "question", 0]), title: "从零刷新时，闪动更像哪一种？", options: ["整块正文消失", "文字一直在，位置或大小跳变"] };
function source() {
  return projectTimeline({ key: createConversationKey("host", "thread"), revision: 1, phase: "live", authoritative: true,
    turns: [{ id: "turn", status: "complete", durationMs: 3093000, items: [
      { id: "input", type: "userMessage", payload: { type: "userMessage", content: [{ type: "text", text: "从零刷新也是一样" }] } },
      { id: "question", type: "agentMessage", payload: { type: "agentMessage", phase: "final_answer", delivery: "async", text: "从零刷新时，闪动更像哪一种？\n- 整块正文消失\n- 文字一直在，位置或大小跳变", questions: [question] } },
      { id: "reply", type: "steeringUserMessage", payload: { type: "steeringUserMessage", clientId: "reply-client", content: [{ type: "text", text: renderAsyncQuestionReply(question, question.options[1]!) }] } },
      { id: "reason", type: "reasoning", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "检查布局" }] } },
      { id: "progress", type: "agentMessage", payload: { type: "agentMessage", phase: "commentary", text: "检查布局测量。" } },
      { id: "final", type: "agentMessage", payload: { type: "agentMessage", phase: "final_answer", text: "已修复并上线。\n\n- 正文高度\n- 滚动补偿" } },
    ] }],
  }, createDefaultTimelineProjectorRegistry());
}
function storage() {
  const data = new Map<string, string>();
  return { data, load: async (key: string) => data.get(key) ?? null,
    save: async (key: string, value: string) => { data.set(key, value); }, remove: async (key: string) => { data.delete(key); } };
}
function shape(timeline: TimelineSnapshot) {
  const plan = createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(timeline)[0]!);
  return { users: plan.userFrames.flatMap(f => f.blocks.map(b => b.id)), slots: plan.assistant?.slots.map(slot =>
    slot.type === "assistant-content" ? { type: slot.type, id: slot.block.id, kind: slot.block.type }
      : slot.type === "agent-activity" ? { type: slot.type, toggle: resolveAgentActivityLayout(slot).showToggle, duration: slot.workedDurationMs }
        : { type: slot.type, id: slot.id }) };
}
test("cache reload retains async question, inline steering reply and work boundaries before authority", async () => {
  const disk = storage(), canonical = source();
  await createConversationDisplayContinuity({ namespace: "a", storage: disk }).observe(canonical);
  const cached = (await createConversationDisplayContinuity({ namespace: "a", storage: disk }).load("host", "thread"))!;
  assert.equal(cached.authoritative, false);
  assert.equal(cached.phase, "painted");
  assert.deepEqual(deriveAsyncQuestionPresentation(cached), deriveAsyncQuestionPresentation(canonical));
  assert.equal(deriveAsyncQuestionPresentation(cached).states.get(question.id), "answered");
  assert.deepEqual(shape(cached), shape(canonical));
  const originals = canonical.frames.flatMap(f => f.blocks);
  for (const b of cached.frames.flatMap(f => f.blocks)) {
    const original = originals.find(o => o.id === b.id)!;
    if (b.type === "user-message" && original.type === "user-message") {
      assert.deepEqual(b.content, original.content);
      assert.equal(b.message, original.message);
      assert.equal(b.messageKind, original.messageKind);
    }
  }
  const downgraded = { ...canonical, authoritative: false, frames: canonical.frames.map(f => ({ ...f, blocks: f.blocks.map(b =>
    b.type === "text" ? { ...b, asyncQuestions: undefined, delivery: undefined } : b) })) };
  assert.equal(selectConversationDisplay({ key: canonical.key, timeline: downgraded, cached }).timeline, cached);
  assert.equal(selectConversationDisplay({ key: canonical.key, timeline: { ...canonical, frames: [] }, cached }).timeline?.frames.length, 0);
});

test("whole rich text survives beyond the old 2048-character excerpt", async () => {
  const disk = storage(), s = source();
  const text = "一段完整内容。".repeat(400) + "\n\n**末尾不能丢失**";
  const canonical = { ...s, frames: s.frames.map(f => ({ ...f, blocks: f.blocks.map(b => b.id === "text:final" && b.type === "text" ? { ...b, text } : b) })) };
  await createConversationDisplayContinuity({ namespace: "a", storage: disk }).observe(canonical);
  const cache = (await createConversationDisplayContinuity({ namespace: "a", storage: disk }).load("host", "thread"))!;
  assert.equal(cache.frames.flatMap(f => f.blocks).find(b => b.type === "text" && b.id === "text:final")?.type, "text");
  const final = cache.frames.flatMap(f => f.blocks).find(b => b.id === "text:final");
  assert.equal(final?.type === "text" && final.text, text);
});

test("lossy old envelopes and malformed semantic payloads are not painted", async () => {
  const disk = storage();
  await createConversationDisplayContinuity({ namespace: "a", storage: disk }).observe(source());
  const [key, value] = [...disk.data][0]!;
  const old = JSON.parse(value); old.version = 1;
  disk.data.set(key, JSON.stringify(old));
  assert.equal(await createConversationDisplayContinuity({ namespace: "a", storage: disk }).load("host", "thread"), null);
  const broken = JSON.parse(value); broken.messages.find((m: any) => m.block.type === "text").block.asyncQuestions = [{ id: "q", title: "q", options: [null] }];
  disk.data.set(key, JSON.stringify(broken));
  assert.equal(await createConversationDisplayContinuity({ namespace: "a", storage: disk }).load("host", "thread"), null);
});

test("user input presentation retains attachment descriptors and long raw reply content", async () => {
  const disk = storage(), s = source();
  const raw = renderAsyncQuestionReply(question, "完整回答".repeat(700));
  const canonical = { ...s, frames: s.frames.map(f => ({ ...f, blocks: f.blocks.map(b => b.type === "user-message"
    ? { ...b, content: [{ type: "text" as const, text: raw, textElements: [] }],
      attachments: [{ type: "file" as const, id: "attachment", name: "example.mp4", target: "/example.mp4", mimeType: "video/mp4", startLine: null, endLine: null }] }
    : b) })) };
  await createConversationDisplayContinuity({ namespace: "a", storage: disk }).observe(canonical);
  const cache = (await createConversationDisplayContinuity({ namespace: "a", storage: disk }).load("host", "thread"))!;
  const users = (value: TimelineSnapshot) => value.frames.flatMap(f => f.blocks).filter(b => b.type === "user-message").map(b => ({ content: b.content, attachments: b.attachments }));
  assert.deepEqual(users(cache), users(canonical));
  assert.deepEqual(deriveAsyncQuestionPresentation(cache), deriveAsyncQuestionPresentation(canonical));
});

test("oversize presentation is evicted whole rather than storing malformed markdown or partial envelopes", async () => {
  const disk = storage(), s = source();
  const oversized = { ...s, frames: s.frames.map(f => ({ ...f, blocks: f.blocks.map(b => b.type === "text" && b.id === "text:final"
    ? { ...b, text: "x".repeat(70_000) } : b) })) };
  const cache = createConversationDisplayContinuity({ namespace: "a", storage: disk });
  await cache.observe(oversized);
  assert.equal(cache.peek("host", "thread"), null);
  assert.equal(await createConversationDisplayContinuity({ namespace: "a", storage: disk }).load("host", "thread"), null);
});
