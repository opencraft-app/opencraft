import test from "node:test";
import assert from "node:assert/strict";
import { aggregateUserInputQuestionAnswers, createUserInputQuestionDrafts, selectUserInputQuestionOption, userInputQuestionExtensions, type UserInputQuestion } from "@opencraft/chat-core";
import { DshInteractions } from "../../apps/local-agent-host/src/dsh-interactions.js";
test("multiple choices start empty, toggle independently and preserve custom text", () => {
  const question: UserInputQuestion = { id: "q", header: null, prompt: "Pick", isOther: true, isSecret: false, multiSelect: true,
    options: [{ id: "a", label: "A", description: null }, { id: "b", label: "B", description: null }] };
  let draft = createUserInputQuestionDrafts([question])[0]!;
  assert.deepEqual(aggregateUserInputQuestionAnswers([question], [draft]), {});
  draft = selectUserInputQuestionOption(question, draft, "a"); draft = selectUserInputQuestionOption(question, draft, "b");
  assert.deepEqual(aggregateUserInputQuestionAnswers([question], [{ ...draft, freeformText: "Custom" }]), { q: ["A", "B", "Custom"] });
  draft = selectUserInputQuestionOption(question, draft, "a"); assert.deepEqual(aggregateUserInputQuestionAnswers([question], [draft]), { q: ["B"] });
  assert.equal(createUserInputQuestionDrafts([{ ...question, multiSelect: false }])[0]?.selectedOptionId, "a");
});
test("native plan detail/intent and multiple selections survive projection and answer encoding", async () => {
  let request: any, response: any;
  const interactions = new DshInteractions({ respond: async (_: string, value: any) => { response = value; return { accepted: true }; } } as any, async () => ({ turnId: "turn" }), () => {});
  interactions.subscribe(value => request = value);
  try {
    await interactions.receive({ type: "question/requested", sessionId: "s", rpcId: "q", questions: [{ id: "plan", question: "Approve?", detail: "# Full plan", intent: { kind: "plan-review", approve: "A" }, multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] });
    assert.deepEqual(userInputQuestionExtensions(request.params.questions[0]), { multiSelect: true, detail: "# Full plan", intent: { kind: "plan-review", approve: "A" } });
    await interactions.respond("q", { result: { answers: { plan: { answers: ["A", "B", "Custom"] } } } });
    assert.deepEqual(response.value.answer.answers, [{ id: "plan", selected: ["A", "B"], custom: "Custom" }]);
  } finally { interactions.close(); }
});
