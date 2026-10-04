import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createConversationKey,
  createTimelineTurnPresentationPlan,
  createDefaultTimelineProjectorRegistry,
  deriveAsyncQuestionStates,
  displayAsyncQuestionReply,
  groupTimelineFramesByTurn,
  parseAsyncQuestionReply,
  projectTimeline,
  renderAsyncQuestionReply,
  type AsyncQuestion,
  type TimelineProjectionSource,
} from "@opencraft/chat-core";
import { AsyncQuestionCard } from "../apps/workbench-web/src/components/conversation/async-question-card";
import { AsyncQuestionContext } from "../apps/workbench-web/src/components/conversation-renderers/render-contexts";

const questionId = (messageId: string, index: number) => JSON.stringify(["request_user_input_async", messageId, index]);

function timeline(items: TimelineProjectionSource["turns"][number]["items"], status: "streaming" | "complete" = "streaming") {
  return projectTimeline({
    key: createConversationKey("host", "thread"),
    revision: 1,
    phase: "live",
    authoritative: true,
    turns: [{ id: "turn", status, items }],
  }, createDefaultTimelineProjectorRegistry());
}

const asyncMessage = {
  id: "message",
  type: "agentMessage",
  payload: {
    id: "message",
    type: "agentMessage",
    content: [{ type: "text", text: "Which way?\n- A\n- B\n\nWhich way?" }],
    phase: "finalAnswer",
    delivery: "async",
    questions: [
      { title: "Which way?", options: ["A", "B"] },
      { title: "Which way?", options: null },
    ],
  },
};

test("Codex async questions survive AgentMessage projection with stable per-index IDs", () => {
  const projected = timeline([asyncMessage]);
  const text = projected.frames.flatMap((frame) => frame.blocks).find((block) => block.type === "text");
  assert.equal(text?.type, "text");
  if (text?.type !== "text") return;
  assert.deepEqual(text.asyncQuestions, [
    { id: questionId("message", 0), title: "Which way?", options: ["A", "B"] },
    { id: questionId("message", 1), title: "Which way?", options: [] },
  ]);
  assert.deepEqual([...deriveAsyncQuestionStates(projected)], [
    [questionId("message", 0), "pending"],
    [questionId("message", 1), "pending"],
  ]);
  const turn = groupTimelineFramesByTurn(projected)[0];
  assert.equal(turn?.type, "turn");
  if (turn?.type === "turn") {
    assert.ok(createTimelineTurnPresentationPlan(turn).assistant?.slots.some((slot) =>
      slot.type === "assistant-content" && slot.block.type === "text" && slot.block.asyncQuestions?.length === 2));
  }
});

test("one structured reply resolves only its question and displays as readable text", () => {
  const question: AsyncQuestion = { id: questionId("message", 0), title: "Which way?", options: ["A", "B"] };
  const reply = renderAsyncQuestionReply(question, "B");
  assert.deepEqual(parseAsyncQuestionReply(reply), [{ questionItemId: question.id, question: question.title, answer: "B" }]);
  assert.equal(displayAsyncQuestionReply(reply), "> Which way?\n\nB");
  const projected = timeline([asyncMessage, {
    id: "user-answer",
    type: "steeringUserMessage",
    payload: { type: "steeringUserMessage", content: [{ type: "text", text: reply }], clientId: "client-answer" },
  }]);
  assert.deepEqual([...deriveAsyncQuestionStates(projected)], [
    [questionId("message", 0), "answered"],
    [questionId("message", 1), "pending"],
  ]);
  const user = projected.frames.flatMap((frame) => frame.blocks).find((block) => block.type === "user-message");
  assert.equal(user?.type === "user-message" ? user.message : null, "> Which way?\n\nB");
});

test("accepted ordinary follow-up dismisses old questions; failed or uncertain replies do not", () => {
  const ordinary = { id: "follow-up", type: "userMessage", payload: { type: "userMessage", content: [{ type: "text", text: "New topic" }] } };
  const laterTurn = projectTimeline({
    key: createConversationKey("host", "thread"), revision: 1, phase: "live", authoritative: true,
    turns: [
      { id: "asking", status: "complete", items: [asyncMessage] },
      { id: "follow-up", status: "streaming", items: [ordinary] },
    ],
  }, createDefaultTimelineProjectorRegistry());
  assert.deepEqual([...deriveAsyncQuestionStates(laterTurn)].map(([, state]) => state), ["dismissed", "dismissed"]);
  const question: AsyncQuestion = { id: questionId("message", 0), title: "Which way?", options: ["A"] };
  const reply = renderAsyncQuestionReply(question, "A");
  const uncertain = { id: "uncertain", type: "steeringUserMessage", payload: { type: "steeringUserMessage", content: [{ type: "text", text: reply }], deliveryStatus: "unknown" } };
  assert.equal(deriveAsyncQuestionStates(timeline([asyncMessage, uncertain])).get(question.id), "unconfirmed");
  const failed = { id: "failed", type: "steeringUserMessage", payload: { type: "steeringUserMessage", content: [{ type: "text", text: reply }], deliveryStatus: "failed" } };
  assert.equal(deriveAsyncQuestionStates(timeline([asyncMessage, failed])).get(question.id), "pending");
});

test("reply parser rejects partial envelopes and preserves escaped answers", () => {
  const question: AsyncQuestion = { id: questionId("message", 0), title: "选择？", options: [] };
  const rendered = renderAsyncQuestionReply(question, "含有 \"引号\"\n第二行");
  assert.equal(parseAsyncQuestionReply(rendered)?.[0]?.answer, "含有 \"引号\"\n第二行");
  assert.equal(parseAsyncQuestionReply(`${rendered} trailing`), null);
  assert.equal(parseAsyncQuestionReply("<send_user_message_question_reply>oops</send_user_message_question_reply>"), null);
});

test("async question card renders touch choices and a free-text answer without taking over the composer", () => {
  const question: AsyncQuestion = { id: questionId("message", 0), title: "Which way?", options: ["A", "B"] };
  const context = {
    states: new Map([[question.id, "pending" as const]]),
    queuedIds: new Set<string>(),
    drafts: { [question.id]: { selectedIndex: null, otherText: "My answer" } },
    submittingIds: new Set<string>(),
    errors: {},
    answer: async () => undefined,
    updateDraft: () => undefined,
  };
  const markup = renderToStaticMarkup(createElement(AsyncQuestionContext.Provider, { value: context },
    createElement(AsyncQuestionCard, { question, title: createElement("span", null, question.title) })));
  assert.match(markup, /<fieldset aria-labelledby="([^"]+)"/u);
  assert.match(markup, /class="thread-async-question__title" id="[^"]+"/u);
  assert.match(markup, /Which way\?/u);
  assert.doesNotMatch(markup, /<legend>/u);
  assert.match(markup, /Suggested answers/u);
  assert.match(markup, /<span>Other<\/span>/u);
  assert.match(markup, /<textarea[^>]*>My answer<\/textarea>/u);
  assert.match(markup, /Send answer/u);
  const answered = renderToStaticMarkup(createElement(AsyncQuestionContext.Provider, {
    value: { ...context, states: new Map([[question.id, "answered" as const]]) },
  }, createElement(AsyncQuestionCard, { question, title: createElement("span", null, question.title) })));
  assert.match(answered, /Answered/u);
  assert.doesNotMatch(answered, /Send answer/u);
});
