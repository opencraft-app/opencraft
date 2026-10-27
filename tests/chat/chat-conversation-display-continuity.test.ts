import assert from "node:assert/strict";
import test from "node:test";
import { visibleQueuedSubmissions } from "../../apps/workbench-web/src/queued-submission-presentation";
import type { QueuedSubmission } from "@opencraft/chat-runtime";

import { asTurnId, createConversationKey, groupTimelineFramesByTurn, createTimelineTurnPresentationPlan, type TimelineSnapshot, assistantMessageActions } from "@opencraft/chat-core";
import {
  createConversationDisplayContinuity,
  retainPreviewMetadata,
  selectConversationDisplay,
  type ConversationDisplayStorage,
} from "@opencraft/workbench-runtime";

function storage(): ConversationDisplayStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    load: async key => data.get(key) ?? null,
    save: async (key, value) => { data.set(key, value); },
    remove: async key => { data.delete(key); },
  };
}

function timeline(authoritative: boolean): TimelineSnapshot {
  const common = { status: "complete" as const, durationMs: null, hookStats: null, anchors: [] };
  return {
    key: createConversationKey("host", "thread"), revision: 4, phase: "live", authoritative,
    anchorFrameIds: new Map(),
    frames: [
      {
        ...common, id: "user-frame", turnId: asTurnId("turn"), type: "user",
        blocks: [{
          type: "user-message", id: "user", sourceItemIds: [], message: "Hello",
          content: [], attachments: [], messageKind: "user", clientId: null,
          steeringStatus: null, sentAtMs: null, deliveryStatus: "sent",
          referencesPriorConversation: false, reviewMode: false, pullRequestFixMode: false,
          autoResolveSync: false, goal: false, hookFeedback: false,
          commentCount: 0, hasExternalAttachments: false,
        }],
      },
      {
        ...common, id: "assistant-frame", turnId: asTurnId("turn"), type: "assistant",
        blocks: [{ type: "text", id: "answer", sourceItemIds: [], text: "Hi", streaming: false, phase: "final_answer" }],
      },
    ],
  };
}

test("only authoritative text becomes a paint-only cached timeline", async () => {
  const local = storage();
  const cache = createConversationDisplayContinuity({ namespace: "account.bot", storage: local, now: () => 1_000 });
  await cache.observe(timeline(false));
  assert.equal(local.data.size, 0);
  await cache.observe(timeline(true));
  const result = await cache.load("host", "thread");
  assert.equal(result?.phase, "painted");
  assert.equal(result?.authoritative, false);
  assert.equal(result?.frames.length, 2);
  assert.equal(groupTimelineFramesByTurn(result!).length, 1);
  assert.deepEqual(result?.frames.flatMap(frame => frame.blocks.map(block => block.type)), ["user-message", "text"]);
  assert.equal(await cache.load("host", "another-thread"), null);
});

test("expired display data is not reused", async () => {
  const local = storage();
  const old = createConversationDisplayContinuity({ namespace: "account", storage: local, now: () => 1_000 });
  await old.observe(timeline(true));
  const later = createConversationDisplayContinuity({ namespace: "account", storage: local,
    now: () => 1_000 + 8 * 24 * 60 * 60 * 1_000 });
  assert.equal(await later.load("host", "thread"), null);
});

function submission() {
  return {
    commandId: "command", clientMessageId: "client-message",
    target: { type: "new-thread" as const, draftId: "draft",
      execution: { hostId: createConversationKey("host", "thread").hostId,
        workspace: { cwd: "/fixture", runtimeWorkspaceRoots: ["/fixture"] } } },
    document: { version: 1 as const, blocks: [{ type: "paragraph" as const,
      children: [{ type: "text" as const, text: "Keep my submitted message" }] }] },
    attachments: [{ id: "file", name: "notes.txt", mimeType: "text/plain", size: 1,
      uri: "/fixture/notes.txt", lifecycle: "ready" as const, error: null }],
    context: [], selections: {}, options: { autoContext: false }, createdAt: 10,
  };
}
const accepted = { commandId: "command", clientMessageId: "client-message", hostId: "host",
  threadId: "thread", turnId: null, acceptedAt: 11, replayed: false };

test("first submission survives promotion and empty baselines without a storage or identity read", async () => {
  const local = storage();
  local.load = async () => { throw new Error("display handoff must be synchronous"); };
  const cache = createConversationDisplayContinuity({ namespace: "account", storage: local });
  const intent = submission();
  cache.retainSubmission(intent, accepted);
  const first = cache.peekSubmission("host", "thread")!;
  assert.equal(first.authoritative, false);
  assert.equal(first.phase, "painted");
  const block = first.frames[0]!.blocks[0]!;
  assert.equal(block.type, "user-message");
  if (block.type !== "user-message") throw new Error("missing submitted message");
  assert.equal(block.message, "Keep my submitted message");
  assert.equal(block.attachments[0]?.type, "file");
  assert.equal(block.clientId, intent.clientMessageId);
  assert.equal(block.sender, undefined);
  assert.equal(await cache.load("host", "thread"), null, "unconfirmed content is not persisted");
  await cache.observe({ ...timeline(true), frames: [] });
  assert.equal(cache.peekSubmission("host", "thread"), first, "empty baseline cannot erase local input");
  cache.retainSubmission(intent, accepted);
  assert.equal(cache.peekSubmission("host", "thread"), first, "promotion retries retain identity");
  await cache.observe(timeline(false));
  assert.equal(cache.peekSubmission("host", "thread"), first, "unconfirmed remote data cannot retire the handoff");
  await cache.observe(timeline(true));
  assert.equal(cache.peekSubmission("host", "thread"), null, "canonical user message replaces local presentation");
});

test("first submission cannot leak across Host, Thread, account or application restart", () => {
  const local = storage();
  const a = createConversationDisplayContinuity({ namespace: "account-a", storage: local });
  a.retainSubmission(submission(), accepted);
  assert.equal(a.peekSubmission("other-host", "thread"), null);
  assert.equal(a.peekSubmission("host", "other-thread"), null);
  for (const namespace of ["account-b", "account-a"]) {
    const fresh = createConversationDisplayContinuity({ namespace, storage: local });
    assert.equal(fresh.peekSubmission("host", "thread"), null);
  }
  assert.throws(() => a.retainSubmission(submission(), { ...accepted, hostId: "other-host" }), /does not match/);
});

test("attachment-only first submission stays visible and transient handoffs are bounded", () => {
  const cache = createConversationDisplayContinuity({ namespace: "account", storage: storage() });
  const intent = { ...submission(), document: { version: 1 as const, blocks: [] } };
  for (let i = 0; i < 65; i++) cache.retainSubmission(intent, { ...accepted, threadId: `thread-${i}` });
  assert.equal(cache.peekSubmission("host", "thread-0"), null);
  const block = cache.peekSubmission("host", "thread-64")!.frames[0]!.blocks[0]!;
  assert.equal(block.type, "user-message");
  if (block.type === "user-message") {
    assert.equal(block.message, "");
    assert.equal(block.attachments.length, 1);
  }
});

test("completed display is available synchronously before persistence completes", async () => {
  const local = storage();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  local.save = async () => new Promise<void>(resolve => { release = resolve; entered(); });
  const cache = createConversationDisplayContinuity({ namespace: "account", storage: local });
  const writing = cache.observe(timeline(true));
  const painted = cache.peek("host", "thread");
  assert.equal(painted?.authoritative, false);
  assert.equal(painted?.frames.length, 2);
  assert.equal(cache.peek("other-host", "thread"), null);
  await started; release(); await writing;
  local.load = async () => { throw Error("warm display must not wait on storage"); };
  assert.equal(await cache.load("host", "thread"), painted);
});

test("display memory is bounded, expires and is cleared by an authoritative empty transcript", async () => {
  let now = 1_000;
  const cache = createConversationDisplayContinuity({ namespace: "account", storage: storage(), now: () => now });
  for (let i = 0; i < 65; i++) await cache.observe({ ...timeline(true), key: createConversationKey("host", `thread-${i}`) });
  assert.equal(cache.peek("host", "thread-0"), null);
  assert.ok(cache.peek("host", "thread-64"));
  await cache.observe({ ...timeline(true), key: createConversationKey("host", "thread-64"), frames: [] });
  assert.equal(cache.peek("host", "thread-64"), null);
  now += 8 * 24 * 60 * 60 * 1_000;
  assert.equal(cache.peek("host", "thread-63"), null);
});


test("a delayed disk read cannot replace a newer authoritative display", async () => {
  const local = storage();
  const original = createConversationDisplayContinuity({ namespace: "account", storage: local });
  await original.observe(timeline(true));
  const old = [...local.data.values()][0]!;
  let release!: (value: string) => void;
  local.load = async () => new Promise<string>(resolve => { release = resolve; });
  const cache = createConversationDisplayContinuity({ namespace: "account", storage: local });
  const reading = cache.load("host", "thread");
  await new Promise(resolve => setImmediate(resolve));
  const next = { ...timeline(true), frames: [] };
  await cache.observe(next);
  release(old);
  assert.equal(await reading, null);
  assert.equal(cache.peek("host", "thread"), null);
});

test("synchronous display memory cannot cross account namespaces", async () => {
  const local = storage();
  const a = createConversationDisplayContinuity({ namespace: "account-a", storage: local });
  const b = createConversationDisplayContinuity({ namespace: "account-b", storage: local });
  await a.observe(timeline(true));
  assert.ok(a.peek("host", "thread"));
  assert.equal(b.peek("host", "thread"), null);
  assert.equal(await b.load("host", "thread"), null);
});


test("first-send queue display suppresses only the input already painted by its handoff", () => {
  const cache = createConversationDisplayContinuity({ namespace: "account", storage: storage() });
  cache.retainSubmission(submission(), accepted);
  const first = cache.peekSubmission("host", "thread");
  const row: QueuedSubmission = { commandId: "command", clientMessageId: "client-message",
    serverSubmissionId: "queue-first", input: [], preview: "Keep my submitted message",
    state: "queued", operation: "idle", createdAt: 10, pausedReason: null, error: null };
  const followup = { ...row, commandId: "next", clientMessageId: "next-message", serverSubmissionId: "next" };
  assert.deepEqual(visibleQueuedSubmissions([row, followup], first), [followup], "identical text in a distinct message stays queued");
  assert.deepEqual(visibleQueuedSubmissions([{ ...row, state: "submitting" }], first), []);
  assert.deepEqual(visibleQueuedSubmissions([{ ...row, local: true, pausedReason: "outbox-waiting" }], first), []);
  for (const visible of [
    { ...row, state: "failed" as const }, { ...row, state: "unknown" as const },
    { ...row, error: new Error("delivery failed") },
    { ...row, pausedReason: "outbox-unconfirmed" }, { ...row, pausedReason: "outbox-failed" },
    { ...row, pausedReason: "interrupted" }, { ...row, operation: "updating" as const },
  ]) assert.deepEqual(visibleQueuedSubmissions([visible], first), [visible], "recovery/action state must remain accessible");
  const canonical = timeline(true);
  const frame = canonical.frames[0]!;
  const message = frame.blocks[0]!;
  if (message.type !== "user-message") throw new Error("expected canonical user message");
  const acknowledged = { ...canonical, frames: [{ ...frame, blocks: [{ ...message, clientId: row.clientMessageId }] }] };
  assert.deepEqual(visibleQueuedSubmissions([row, followup], acknowledged), [followup], "queue read may lag canonical acknowledgement without flashing a duplicate");
  assert.equal(visibleQueuedSubmissions([row], canonical).length, 1, "unidentified history cannot suppress a queue entry");
  const queue = [row, followup];
  assert.equal(visibleQueuedSubmissions(queue, null), queue, "existing conversations keep their queue");
  assert.equal(visibleQueuedSubmissions(queue, cache.peekSubmission("host", "another-thread")), queue);
  assert.equal(queue.length, 2, "presentation never deletes execution queue state");
});


function timedTimeline(): TimelineSnapshot {
  const source = timeline(true);
  return { ...source, frames: source.frames.map(frame => frame.type === "user"
    ? { ...frame, blocks: frame.blocks.map(block => block.type === "user-message" ? { ...block, sentAtMs: 100 } : block) }
    : { ...frame, durationMs: 54_000, workStatus: { type: "worked-for", status: "worked", startedAtMs: 100, completedAtMs: 54_100 } }) };
}

test("reload paints message date and completed work clock before authoritative history arrives", async () => {
  const local = storage();
  const before = createConversationDisplayContinuity({ namespace: "account", storage: local });
  await before.observe(timedTimeline());
  const after = createConversationDisplayContinuity({ namespace: "account", storage: local });
  const restored = (await after.load("host", "thread"))!;
  assert.equal(restored.authoritative, false);
  const user = restored.frames[0]!.blocks[0]!;
  assert.equal(user.type === "user-message" && user.sentAtMs, 100);
  const turn = groupTimelineFramesByTurn(restored)[0]!;
  const plan = createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: true });
  const activity = plan.assistant?.slots.find(slot => slot.type === "agent-activity");
  assert.ok(activity && activity.type === "agent-activity");
  assert.equal(activity.workedDurationMs, 54_000);
  assert.deepEqual(activity.contentUnits.find(unit => unit.type === "worked-for")?.item,
    { type: "worked-for", status: "worked", startedAtMs: 100, completedAtMs: 54_100 });
  assert.equal(activity.blocks.length, 0, "tool bodies are not cached");
});

test("timing-only corrections refresh persisted display and live clocks are discarded", async () => {
  const local = storage();
  const cache = createConversationDisplayContinuity({ namespace: "account", storage: local });
  await cache.observe(timeline(true));
  await cache.observe(timedTimeline());
  const restored = (await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"))!;
  assert.equal(restored.frames[1]!.workStatus?.completedAtMs, 54_100);
  await cache.observe({ ...timedTimeline(), frames: timedTimeline().frames.map(frame => frame.type === "assistant"
    ? { ...frame, workStatus: { type: "worked-for", status: "working", startedAtMs: 100, completedAtMs: null } } : frame) });
  assert.equal(cache.peek("host", "thread")!.frames[1]!.workStatus, null);
});

test("legacy and malformed cached clocks remain unknown without losing text", async () => {
  for (const timing of [{}, { sentAtMs: -1, durationMs: "54000", workStatus: { type: "worked-for", status: "working", startedAtMs: 1, completedAtMs: null } },
    { sentAtMs: "100", durationMs: -10, workStatus: { type: "worked-for", status: "worked", startedAtMs: 100, completedAtMs: 50 } }]) {
    const local = storage();
    const original = createConversationDisplayContinuity({ namespace: "account", storage: local });
    await original.observe(timeline(true));
    for (const [key, value] of local.data) {
      const data = JSON.parse(value);
      data.messages = data.messages.map(({ sentAtMs, durationMs, workStatus, ...message }: Record<string, unknown>) => ({ ...message, ...timing }));
      local.data.set(key, JSON.stringify(data));
    }
    const restored = (await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"))!;
    assert.equal(restored.frames.length, 2);
    assert.equal(restored.frames[1]!.durationMs, null);
    assert.equal(restored.frames[1]!.workStatus, null);
    const user = restored.frames[0]!.blocks[0]!;
    assert.equal(user.type === "user-message" && user.sentAtMs, null);
  }
});


function activeTimeline(text = "Partial answer received so far"): TimelineSnapshot {
  const source = timedTimeline();
  return { ...source, frames: source.frames.map(frame => frame.type === "user"
    ? { ...frame, status: "streaming" as const }
    : { ...frame, status: "streaming" as const, durationMs: 54_000,
      workStatus: { type: "worked-for" as const, status: "working" as const, startedAtMs: 100, completedAtMs: null },
      blocks: [
        { type: "reasoning" as const, id: "reasoning", sourceItemIds: [], summary: "Checking the result", detail: null, streaming: true },
        { type: "text" as const, id: "progress", sourceItemIds: [], text: "Reading the source", phase: "commentary" as const, streaming: true, completed: false },
        { type: "text" as const, id: "answer", sourceItemIds: [], text, phase: "final_answer" as const, streaming: true, completed: false },
      ] }) };
}

test("reload retains an active Turn's input, progress and partial answer as static read-only text", async () => {
  const local = storage();
  const before = createConversationDisplayContinuity({ namespace: "account", storage: local });
  await before.observe(activeTimeline());
  const after = createConversationDisplayContinuity({ namespace: "account", storage: local });
  const cached = (await after.load("host", "thread"))!;
  assert.equal(cached.authoritative, false);
  assert.equal(cached.phase, "painted");
  const blocks = cached.frames.flatMap(frame => frame.blocks);
  assert.deepEqual(blocks.map(block => block.type), ["user-message", "reasoning", "text", "text"]);
  assert.equal(blocks[0]!.type === "user-message" && blocks[0]!.sentAtMs, 100);
  assert.equal(blocks[1]!.type === "reasoning" && blocks[1]!.summary, "Checking the result");
  assert.equal(blocks[2]!.type === "text" && blocks[2]!.phase, "commentary");
  assert.equal(blocks[3]!.type === "text" && blocks[3]!.text, "Partial answer received so far");
  assert.equal(blocks[3]!.type === "text" && blocks[3]!.completed, false, "partial text is not relabeled as a final reply");
  assert.ok(blocks.every(block => !("streaming" in block) || !block.streaming));
  assert.ok(cached.frames.every(frame => frame.status === "complete" && frame.durationMs === null && frame.workStatus === null), "cached progress never resumes a live animation or clock");
  await after.observe(timedTimeline());
  assert.deepEqual(after.peek("host", "thread")!.frames.flatMap(frame => frame.blocks.map(block => block.type)), ["user-message", "text"]);
  assert.equal(after.peek("host", "thread")!.frames[1]!.workStatus?.status, "worked");
  await after.observe({ ...timeline(true), frames: [] });
  assert.equal(await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"), null);
});

test("streaming updates coalesce behind slow persistence and retain the newest received text", async () => {
  const local = storage();
  const writes: string[] = [];
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  local.save = async (key, value) => {
    writes.push(value);
    if (writes.length === 1) await new Promise<void>(resolve => { release = resolve; entered(); });
    local.data.set(key, value);
  };
  const cache = createConversationDisplayContinuity({ namespace: "account", storage: local });
  const first = cache.observe(activeTimeline("first"));
  await started;
  const updates = Array.from({ length: 100 }, (_, i) => cache.observe(activeTimeline(`received ${i}`)));
  const latest = cache.peek("host", "thread")!.frames.at(-1)!.blocks[0]!;
  assert.equal(latest.type === "text" && latest.text, "received 99", "memory never waits for disk");
  assert.equal(writes.length, 1);
  release(); await Promise.all([first, ...updates]);
  assert.equal(writes.length, 2, "only the latest queued snapshot is written after the in-flight snapshot");
  const restored = (await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"))!;
  const answer = restored.frames.at(-1)!.blocks[0]!;
  assert.equal(answer.type === "text" && answer.text, "received 99");
  await cache.observe({ ...timeline(true), frames: [] });
  assert.equal(local.data.size, 0, "an empty authoritative history supersedes streaming snapshots");
});

test("failed display persistence can retry the same active snapshot", async () => {
  const local = storage();
  const save = local.save;
  local.save = async () => { throw Error("disk unavailable"); };
  const cache = createConversationDisplayContinuity({ namespace: "account", storage: local });
  await assert.rejects(cache.observe(activeTimeline()), /disk unavailable/);
  assert.ok(cache.peek("host", "thread"));
  local.save = save;
  await cache.observe(activeTimeline());
  assert.ok(await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"));
});


test("both completed and partial assistant timestamps survive reload and timing-only correction", async () => {
  for (const source of [timedTimeline(), activeTimeline()]) {
    const local = storage();
    const cache = createConversationDisplayContinuity({ namespace: "account", storage: local });
    await cache.observe(source);
    for (const sentAtMs of [54_100, 54_200]) {
      await cache.observe({ ...source, frames: source.frames.map(frame => frame.type === "assistant"
        ? { ...frame, blocks: frame.blocks.map(block => block.type === "text" ? { ...block, sentAtMs } : block) } : frame) });
      const restored = (await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"))!;
      const assistant = restored.frames.at(-1)!;
      assert.equal(assistant.type, "assistant");
      if (assistant.type !== "assistant") throw Error("Expected assistant frame");
      assert.equal(assistantMessageActions(assistant)?.sentAtMs, sentAtMs);
      assert.equal(restored.authoritative, false);
    }
  }
});


test("partial previews retain exact message clocks while showing fresh text until authority", async () => {
  const cache = createConversationDisplayContinuity({ namespace: "account", storage: storage() });
  const source = timedTimeline();
  const complete = { ...source, frames: source.frames.map(frame => frame.type === "assistant"
    ? { ...frame, blocks: frame.blocks.map(block => block.type === "text" ? { ...block, sentAtMs: 54_100, completed: true } : block) } : frame) };
  await cache.observe(complete);
  const display = cache.peek("host", "thread")!;
  const preview = { ...timeline(false), frames: timeline(false).frames.map(frame => frame.type === "assistant"
    ? { ...frame, blocks: frame.blocks.map(block => block.type === "text" ? { ...block, text: "Fresher preview" } : block) } : frame) };
  const result = retainPreviewMetadata(preview, display);
  assert.equal(result.authoritative, false);
  const user = result.frames[0]!.blocks[0]!;
  assert.equal(user.type === "user-message" && user.sentAtMs, 100);
  const answer = result.frames[1]!.blocks[0]!;
  assert.equal(answer.type === "text" && answer.text, "Fresher preview");
  assert.equal(answer.type === "text" && answer.sentAtMs, 54_100);
  assert.equal(result.frames[1]!.durationMs, 54_000);
  assert.equal(result.frames[1]!.workStatus?.status, "worked");
  assert.equal(retainPreviewMetadata({ ...preview, authoritative: true }, display).frames, preview.frames,
    "authority can correct or remove clocks");
  assert.equal(retainPreviewMetadata(preview, null), preview);
  for (const key of [createConversationKey("other", "thread"), createConversationKey("host", "other")]) {
    assert.equal(retainPreviewMetadata(preview, { ...display, key }), preview);
  }
  const mismatched = { ...display, frames: display.frames.map(frame => ({ ...frame, turnId: asTurnId("other-turn") })) };
  assert.equal(retainPreviewMetadata(preview, mismatched).frames[1]!.durationMs, null);
  const otherBlock = { ...preview, frames: preview.frames.map(frame => ({ ...frame,
    blocks: frame.blocks.map(block => ({ ...block, id: "other-block" })) })) };
  assert.equal(retainPreviewMetadata(otherBlock, display).frames[1]!.durationMs, null);
  const active = { ...preview, frames: preview.frames.map(frame => ({ ...frame, status: "streaming" as const })) };
  assert.equal(retainPreviewMetadata(active, display).frames[1]!.workStatus, undefined);
  assert.equal(retainPreviewMetadata(active, display).frames[1]!.durationMs, null);
  const updated = { ...complete, authoritative: false };
  assert.equal(retainPreviewMetadata(updated, display).frames[1]!.workStatus, complete.frames[1]!.workStatus,
    "newly supplied clocks win");
});


test("a long active activity tail cannot evict the question, dated replies or completed clocks", async () => {
  for (const unphased of [false, true]) {
  const local = storage();
  const before = createConversationDisplayContinuity({ namespace: "account", storage: local });
  const prior = timedTimeline().frames.map(frame => ({ ...frame, id: `prior-${frame.id}`, turnId: asTurnId("prior-turn"),
    blocks: frame.blocks.map(block => block.type === "text"
      ? { ...block, id: `prior-${block.id}`, sentAtMs: 54_100 }
      : { ...block, id: `prior-${block.id}` }) }));
  const active = activeTimeline();
  const frames = active.frames.map(frame => frame.type === "assistant" ? { ...frame,
    blocks: Array.from({ length: 68 }, (_, i) => !unphased && i % 2 === 0
      ? { type: "reasoning" as const, id: `reason-${i}`, sourceItemIds: [], summary: `Reasoning ${i}`, detail: null, streaming: true }
      : { type: "text" as const, id: `progress-${i}`, sourceItemIds: [], text: `Progress ${i}`, phase: unphased ? null : "commentary" as const, streaming: true, completed: false }) } : frame);
  await before.observe({ ...active, frames: [...prior, ...frames] });
  const cached = (await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"))!;
  const blocks = cached.frames.flatMap(frame => frame.blocks);
  assert.ok(blocks.length <= 24, "existing storage bound is preserved");
  assert.ok(blocks.some(block => block.id === "user" && block.type === "user-message" && block.sentAtMs === 100), "active input survives more than 24 activity blocks");
  assert.ok(blocks.some(block => block.id === "prior-answer" && block.type === "text" && block.sentAtMs === 54_100), "dated final reply stays with its text");
  assert.equal(cached.frames.find(frame => frame.blocks.some(block => block.id === "prior-answer"))?.workStatus?.status, "worked");
  assert.equal(cached.frames.at(-1)?.blocks[0]?.id, "progress-67", "newest received progress remains visible");
  assert.ok(cached.frames.every(frame => frame.workStatus?.status !== "working"), "activity never resumes a live clock");
  assert.ok(blocks.findIndex(block => block.id === "prior-answer") < blocks.findIndex(block => block.id === "user"), "original conversation order is preserved");
  }
});


test("a completed work interval remains static while its final reply is still arriving", async () => {
  const local = storage();
  const source = activeTimeline();
  const worked: TimelineSnapshot = { ...source, frames: source.frames.map(frame => frame.type === "assistant"
    ? { ...frame, workStatus: { type: "worked-for", status: "worked", startedAtMs: 100, completedAtMs: 54_100 } } : frame) };
  await createConversationDisplayContinuity({ namespace: "account", storage: local }).observe(worked);
  const cached = (await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"))!;
  const reply = cached.frames.at(-1)!;
  assert.equal(reply.workStatus?.status, "worked");
  assert.equal(reply.workStatus?.completedAtMs, 54_100);
  assert.equal(reply.durationMs, null, "an active Turn's aggregate duration is not a static work clock");
  const text = reply.blocks[0]!;
  assert.equal(text.type === "text" && text.completed, false, "the partial reply stays partial");
  const plan = createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(cached)[0]!, undefined, { isMostRecentTurn: true });
  const activity = plan.assistant?.slots.find(slot => slot.type === "agent-activity");
  assert.ok(activity?.type === "agent-activity");
  assert.equal(activity.contentUnits.find(unit => unit.type === "worked-for")?.item.status, "worked");
  assert.ok(cached.frames.every(frame => frame.workStatus?.status !== "working"));
});


test("a regrouped partial preview cannot replace cached dates and duration before authority", async () => {
  const cache = createConversationDisplayContinuity({ namespace: "account", storage: storage() });
  const source = timedTimeline();
  await cache.observe(source);
  const display = cache.peek("host", "thread")!;
  const preview = { ...timeline(false), frames: timeline(false).frames.map(frame => ({
    ...frame, turnId: asTurnId("regrouped-history-window"),
    blocks: frame.blocks.map(block => block.type === "text" ? { ...block, text: "Fresh regrouped preview" } : block),
  })) };
  assert.equal(selectConversationDisplay({ key: createConversationKey("host", "thread"), timeline: preview, cached: display }).timeline, display,
    "known clocks stay with cached text while the partial history regroups");
  const authoritative = { ...preview, authoritative: true };
  assert.equal(selectConversationDisplay({ key: createConversationKey("host", "thread"), timeline: authoritative, cached: display }).timeline, authoritative,
    "authority can replace the whole display and remove old clocks");
  const compatible = retainPreviewMetadata(timeline(false), display);
  assert.equal(selectConversationDisplay({ key: createConversationKey("host", "thread"), timeline: compatible, cached: display }).timeline?.frames[1]?.blocks[0]?.id, "answer");
  assert.equal(selectConversationDisplay({ key: createConversationKey("host", "thread"), timeline: preview, cached: null }).timeline, preview);
  assert.equal(selectConversationDisplay({ key: createConversationKey("host", "thread"), timeline: preview, cached: { ...display, key: createConversationKey("foreign", "thread") } }).timeline, preview,
    "another scope never supplies a fallback");
});

test("duration-only history renders its observed aggregate without inventing a work interval", async () => {
  const local = storage();
  const source = { ...timedTimeline(), frames: timedTimeline().frames.map(frame => frame.type === "assistant"
    ? { ...frame, workStatus: null, blocks: [{ type: "reasoning" as const, id: "observed-work", sourceItemIds: [], summary: "Previously visible work", detail: null, streaming: false }, ...frame.blocks] }
    : frame) };
  await createConversationDisplayContinuity({ namespace: "account", storage: local }).observe(source);
  const cached = (await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"))!;
  const plan = createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(cached)[0]!, undefined, { isMostRecentTurn: true });
  const activity = plan.assistant?.slots.find(slot => slot.type === "agent-activity");
  assert.ok(activity?.type === "agent-activity", "the duration has a surface even without cached tools or reasoning");
  assert.equal(activity.workedDurationMs, 54_000);
  assert.equal(activity.partitions.workedForItem, null);
  const preview = selectConversationDisplay({ key: createConversationKey("host", "thread"), timeline: timeline(false), cached: cached }).timeline!;
  const previewPlan = createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(preview)[0]!);
  const previewActivity = previewPlan.assistant?.slots.find(slot => slot.type === "agent-activity");
  assert.equal(previewActivity?.workedDurationMs, 54_000, "a text-only compatible preview retains the visible duration surface");
  assert.ok(cached.frames.every(frame => frame.workStatus == null), "no timestamps are fabricated from the duration");
  const active = { ...source, frames: source.frames.map(frame => ({ ...frame, status: "streaming" as const })) };
  await createConversationDisplayContinuity({ namespace: "account", storage: local }).observe(active);
  assert.ok(createConversationDisplayContinuity({ namespace: "account", storage: local }).peek("host", "thread") === null);
  const reloaded = (await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"))!;
  assert.ok(reloaded.frames.every(frame => frame.durationMs === null), "an active aggregate is still not retained");
});


test("hidden duration cannot gain a cached label that was never visible", async () => {
  const local = storage();
  const hidden = { ...timeline(true), frames: timeline(true).frames.map(frame => ({ ...frame, durationMs: 8_000, workStatus: null })) };
  await createConversationDisplayContinuity({ namespace: "account", storage: local }).observe(hidden);
  const cached = (await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"))!;
  const plan = createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(cached)[0]!);
  assert.ok(cached.frames.every(frame => frame.displayDurationMs == null));
  assert.ok(plan.assistant?.slots.every(slot => slot.type !== "agent-activity"));
});

test("reload retains each message sender and a partial preview cannot erase it", async () => {
  const local = storage();
  const sender = { kind: "employee" as const, loginName: "fixture.employee" };
  const source = { ...timeline(true), frames: timeline(true).frames.map(frame => frame.type === "user"
    ? { ...frame, blocks: frame.blocks.map(block => ({ ...block, sender })) } : frame) };
  await createConversationDisplayContinuity({ namespace: "account", storage: local }).observe(source);
  const restored = (await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"))!;
  const user = restored.frames[0]!.blocks[0]!;
  assert.ok(user.type === "user-message");
  assert.deepEqual(user.sender, sender);
  assert.equal(restored.authoritative, false);
  const preview = timeline(false);
  const retained = retainPreviewMetadata(preview, restored).frames[0]!.blocks[0]!;
  assert.ok(retained.type === "user-message");
  assert.deepEqual(retained.sender, sender);
  const regrouped = { ...preview, frames: preview.frames.map(frame => ({ ...frame, turnId: asTurnId("different-turn") })) };
  assert.equal(selectConversationDisplay({ key: createConversationKey("host", "thread"), timeline: regrouped, cached: restored }).timeline, restored, "even undated sender rows survive regrouped preview");
  const corrected = { ...preview, frames: preview.frames.map(frame => frame.type === "user"
    ? { ...frame, blocks: frame.blocks.map(block => ({ ...block, sender: null })) } : frame) };
  const removed = retainPreviewMetadata(corrected, restored).frames[0]!.blocks[0]!;
  assert.ok(removed.type === "user-message");
  assert.equal(removed.sender, null, "explicit sender removal wins over inherited display");
  const authoritative = timeline(true);
  assert.equal(selectConversationDisplay({ key: createConversationKey("host", "thread"), timeline: authoritative, cached: restored }).timeline, authoritative, "authority removes stale sender");
  const other = { ...preview, key: createConversationKey("other", "thread") };
  assert.equal(retainPreviewMetadata(other, restored), other);
});

test("stored sender parsing is bounded and old or malformed data cannot invent identity", async () => {
  const local = storage();
  await createConversationDisplayContinuity({ namespace: "account", storage: local }).observe(timeline(true));
  const [key, value] = [...local.data][0]!;
  for (const sender of [undefined, null, { kind: "admin", loginName: "fixture" }, { kind: "employee", loginName: " " },
    { kind: "employee", loginName: "x".repeat(257) }, { kind: "employee", loginName: 123 }]) {
    const stored = JSON.parse(value);
    stored.messages[0].sender = sender;
    local.data.set(key, JSON.stringify(stored));
    const cached = (await createConversationDisplayContinuity({ namespace: "account", storage: local }).load("host", "thread"))!;
    const user = cached.frames[0]!.blocks[0]!;
    assert.ok(user.type === "user-message");
    assert.equal(user.sender, null);
  }
});


test("display provenance follows cold restore, preview and authority without authorizing cached input", async () => {
  const key = createConversationKey("host", "thread");
  const local = storage();
  const cache = createConversationDisplayContinuity({ namespace: "account", storage: local });
  await cache.observe(timeline(true));
  const cached = cache.peek("host", "thread")!;
  const choose = (value: TimelineSnapshot | null, submission: TimelineSnapshot | null = null) =>
    selectConversationDisplay({ key, timeline: value, cached, submission });
  assert.deepEqual(selectConversationDisplay({ key, timeline: null, cached: null }), { source: "empty", timeline: null });
  assert.deepEqual(choose(null), { source: "cache", timeline: cached });
  const preview = choose(timeline(false));
  assert.equal(preview.source, "preview");
  assert.equal(preview.timeline?.authoritative, false);
  const history = timeline(true);
  assert.deepEqual(choose(history), { source: "history", timeline: history });
  const empty = { ...history, frames: [] };
  assert.deepEqual(choose(empty), { source: "history", timeline: empty }, "canonical deletion clears stale content");
  cache.retainSubmission(submission(), accepted);
  const echo = cache.peekSubmission("host", "thread")!;
  assert.deepEqual(choose(empty, echo), { source: "submission", timeline: echo }, "creation echo survives empty baseline");
  assert.deepEqual(choose(history, echo), { source: "history", timeline: history }, "canonical content replaces creation echo");
  assert.deepEqual(choose({ ...empty, authoritative: false }), { source: "cache", timeline: cached });
});

test("a committed View rejects late history, cache and submission from another conversation", () => {
  const old = timeline(true);
  const cached = { ...old, authoritative: false };
  for (const key of [null, createConversationKey("other", "thread"), createConversationKey("host", "other")]) {
    assert.deepEqual(selectConversationDisplay({ key, timeline: old, cached, submission: cached }),
      { source: "empty", timeline: null });
  }
  const key = createConversationKey("host", "next");
  const next = { ...cached, key };
  assert.deepEqual(selectConversationDisplay({ key, timeline: old, cached: next, submission: cached }),
    { source: "cache", timeline: next }, "late old history cannot displace the new View's cached body");
});
