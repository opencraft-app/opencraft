import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ChatDocumentCompiler } from "@opencraft/chat-document";
import {
  activeTimelineTurnTodo, asItemId, createConversationKey, createDefaultTimelineProjectorRegistry,
  createTimelineTurnPresentationPlan, groupTimelineFramesByTurn, presentReasoning,
  projectTimeline, ReasoningPresentationCache,
  type ReasoningTimelineBlock, type TimelineSourceTurn,
} from "@opencraft/chat-core";

function reasoning(id = "reasoning", summary = "First **line**\n\nLatest `line`", streaming = true): ReasoningTimelineBlock {
  return { type: "reasoning", id, sourceItemIds: [asItemId(id)], summary, detail: null, streaming };
}

function turn(items: TimelineSourceTurn["items"], status: TimelineSourceTurn["status"] = "streaming") {
  return groupTimelineFramesByTurn(projectTimeline({
    key: createConversationKey("host", "thread"), revision: 1, phase: "live", authoritative: true,
    turns: [{ id: "turn", status, items }],
  }, createDefaultTimelineProjectorRegistry()))[0]!;
}

function countCompiles(t: TestContext) {
  const original = ChatDocumentCompiler.prototype.compile;
  return t.mock.method(ChatDocumentCompiler.prototype, "compile", function (this: ChatDocumentCompiler, ...args: Parameters<typeof original>) {
    return original.apply(this, args);
  });
}

test("a long Turn parses each reasoning once and reuses history after source objects are replaced", t => {
  const compile = countCompiles(t);
  const items: TimelineSourceTurn["items"] = Array.from({ length: 48 }, (_, i) => ({
    id: `reasoning-${i}`, type: "reasoning", payload: { content: [`First ${i}\n\nLatest ${i}`] },
  }));
  const cache = new ReasoningPresentationCache();
  const plan = (input: typeof items, status: TimelineSourceTurn["status"] = "streaming") =>
    createTimelineTurnPresentationPlan(turn(input, status), undefined, { isMostRecentTurn: true, reasoningPresenter: cache.present });
  const first = plan(items);
  assert.equal(compile.mock.callCount(), 48, "grouping must not parse headers before Thinking arbitration");
  assert.equal(first.thinkingOwner.type, "reasoning");
  assert.deepEqual(plan(structuredClone(items)), first);
  assert.equal(compile.mock.callCount(), 48, "reprojection must not reparse unchanged historical Items");
  const changed = structuredClone(items);
  changed[47] = { ...changed[47]!, payload: { content: ["First 47\n\nLatest 47\n\n**Appended**"] } };
  plan(changed);
  assert.equal(compile.mock.callCount(), 49, "only the changed active Item is parsed");
  const completed = plan(changed, "complete");
  assert.equal(compile.mock.callCount(), 50, "completion invalidates only the formerly active parse mode");
  assert.equal(completed.thinkingOwner.type, "none");
});

test("todo reads never compile transcript and retain latest/live semantics", t => {
  const compile = countCompiles(t);
  const value = turn([
    { id: "r", type: "reasoning", payload: { content: ["Long **thought**"] } },
    { id: "old", type: "todo-list", payload: { plan: [{ step: "Old", status: "pending" }] } },
    { id: "new", type: "todo-list", payload: { plan: [{ step: "New", status: "inProgress" }] } },
  ]);
  assert.equal(activeTimelineTurnTodo(value, true)?.sourceItemIds[0], "new");
  assert.equal(activeTimelineTurnTodo(value, false), null);
  assert.equal(activeTimelineTurnTodo({ ...value, status: "complete" }, true), null);
  assert.equal(compile.mock.callCount(), 0);
  assert.deepEqual(createTimelineTurnPresentationPlan(value, undefined, { isMostRecentTurn: true }).activeTodo,
    activeTimelineTurnTodo(value, true));
});

test("cache invalidates selected source, active grammar, edits and empty content; body remains canonical", () => {
  const cache = new ReasoningPresentationCache();
  const block = reasoning();
  const original = cache.present(block, true);
  assert.strictEqual(cache.present({ ...block }, true), original);
  assert.deepEqual(original, presentReasoning(block, true));
  for (const [next, active] of [
    [{ ...block, summary: "", detail: block.summary }, true],
    [block, false],
    [{ ...block, summary: "[Link][ref]\n\n[ref]: https://example.test" }, true],
    [{ ...block, summary: "```js\nconst a_b = '*';\n```" }, true],
    [{ ...block, summary: "Literal \\*stars\\* and **unfinished" }, true],
  ] as const) assert.deepEqual(cache.present(next, active), presentReasoning(next, active));
  assert.equal(cache.present({ ...block, summary: " \n ", detail: "" }), null);
  assert.notStrictEqual(cache.present(block, true), original, "empty replacement removes the old entry");
  assert.equal(cache.present(block, true)?.content, block.summary);
  assert.notStrictEqual(new ReasoningPresentationCache().present(block, true), cache.present(block, true), "owners do not share text caches");
});

test("reasoning cache bounds entries and retained characters without dropping oversized content", () => {
  const cache = new ReasoningPresentationCache(2, 100);
  const a = reasoning("a", "A");
  const b = reasoning("b", "B");
  const c = reasoning("c", "C");
  const first = cache.present(a);
  const second = cache.present(b);
  assert.strictEqual(cache.present(a), first, "read refreshes LRU position");
  cache.present(c);
  assert.strictEqual(cache.present(a), first);
  assert.notStrictEqual(cache.present(b), second, "entry bound evicts the oldest");
  const huge = reasoning("huge", "x".repeat(101));
  assert.deepEqual(cache.present(huge), presentReasoning(huge));
  assert.notStrictEqual(cache.present(huge), cache.present(huge), "oversized content is rendered but not retained");
  const bounded = new ReasoningPresentationCache(10, 4);
  const before = bounded.present(a);
  bounded.present(reasoning("d", "DD"));
  assert.notStrictEqual(bounded.present(a), before, "character budget applies independently of entry limit");
});
