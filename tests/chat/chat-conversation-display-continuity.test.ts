import assert from "node:assert/strict";
import test from "node:test";
import { visibleQueuedSubmissions } from "../../apps/workbench-web/src/queued-submission-presentation";
import type { QueuedSubmission } from "@opencraft/chat-runtime";

import { asTurnId, createConversationKey, groupTimelineFramesByTurn, createTimelineTurnPresentationPlan, type TimelineSnapshot, assistantMessageActions, resolveAgentActivityLayout } from "@opencraft/chat-core";
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
      data.messages = data.messages.map(({ durationMs, workStatus, ...message }: Record<string, any>) => ({
        ...message, durationMs: timing.durationMs, workStatus: timing.workStatus,
        block: { ...message.block, sentAtMs: timing.sentAtMs },
      }));
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
    stored.messages[0].block.sender = sender;
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

test("complete history count survives bounded messages, persistence and metadata-only changes", async () => {
  const local = storage();
  const cache = createConversationDisplayContinuity({ namespace: "count", storage: local, now: () => 1000 });
  await cache.observe({ ...timeline(true), historyTurnCount: 601 });
  assert.equal(cache.peek("host", "thread")?.historyTurnCount, 601);
  const restored = createConversationDisplayContinuity({ namespace: "count", storage: local, now: () => 1001 });
  assert.equal((await restored.load("host", "thread"))?.historyTurnCount, 601);
  await cache.observe({ ...timeline(true), historyTurnCount: 602 });
  const updated = createConversationDisplayContinuity({ namespace: "count", storage: local, now: () => 1001 });
  assert.equal((await updated.load("host", "thread"))?.historyTurnCount, 602);
});

for (const reason of ["evicted", "expired"] as const) test(`unchanged authoritative content refills ${reason} memory without another write`, async () => {
  let now = 1000, writes = 0;
  const local = storage(), save = local.save;
  local.save = async (...args) => { writes++; await save(...args); };
  const cache = createConversationDisplayContinuity({ namespace: "refill", storage: local, now: () => now });
  await cache.observe(timeline(true));
  if (reason === "evicted") for (let i = 0; i < 64; i++) {
    await cache.observe({ ...timeline(true), key: createConversationKey("host", `other-${i}`) });
  } else now += 8 * 24 * 60 * 60 * 1000;
  assert.equal(cache.peek("host", "thread"), null);
  const before = writes;
  await cache.observe(timeline(true));
  assert.ok(cache.peek("host", "thread"));
  assert.equal(writes, before, "memory residency does not decide persistence deduplication");
  const painted = cache.peek("host", "thread");
  await cache.observe(timeline(true));
  assert.equal(cache.peek("host", "thread"), painted, "unchanged observations retain paint identity");
});

for (const empty of [false, true]) test(`failed ${empty ? "removal" : "save"} cannot authorize a delayed stale read`, async () => {
  const local = storage();
  await createConversationDisplayContinuity({ namespace: "race", storage: local }).observe(timeline(true));
  const old = [...local.data.values()][0]!;
  let release!: (value: string) => void;
  local.load = () => new Promise(resolve => { release = resolve; });
  local.save = local.remove = async () => { throw new Error("disk unavailable"); };
  const cache = createConversationDisplayContinuity({ namespace: "race", storage: local });
  const reading = cache.load("host", "thread");
  await new Promise(resolve => setImmediate(resolve));
  const next = timeline(true);
  const latest = { ...next, frames: empty ? [] : next.frames.map(frame => ({ ...frame,
    blocks: frame.blocks.map(block => block.type === "text" ? { ...block, text: "LATEST" } : block) })) };
  await assert.rejects(cache.observe(latest), /disk unavailable/);
  const current = cache.peek("host", "thread");
  if (empty) assert.equal(current, null); else assert.ok(current);
  release(old);
  assert.equal(await reading, current);
  assert.equal(cache.peek("host", "thread"), current);
});

test("overlapping cache misses share one read and an authoritative ABA observation revokes it", async () => {
  const local = storage();
  await createConversationDisplayContinuity({ namespace: "aba", storage: local }).observe(timeline(true));
  const old = [...local.data.values()][0]!;
  let reads = 0, release!: (value: string) => void;
  local.load = () => { reads++; return new Promise(resolve => { release = resolve; }); };
  const cache = createConversationDisplayContinuity({ namespace: "aba", storage: local });
  const first = cache.load("host", "thread"), second = cache.load("host", "thread");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  await cache.observe(timeline(true));
  await cache.observe({ ...timeline(true), frames: [] });
  await cache.observe(timeline(true));
  const current = cache.peek("host", "thread");
  release(old);
  assert.equal(await first, current);
  assert.equal(await second, current);
});

test("authoritative empty display stays empty when failed deletion leaves stale storage", async () => {
  const local = storage();
  let reads = 0;
  const load = local.load;
  local.load = async key => { reads++; return load(key); };
  const cache = createConversationDisplayContinuity({ namespace: "empty", storage: local });
  await cache.observe(timeline(true));
  local.remove = async () => { throw Error("removal unavailable"); };
  await assert.rejects(cache.observe({ ...timeline(true), frames: [] }), /removal unavailable/);
  assert.equal(await cache.load("host", "thread"), null);
  assert.equal(reads, 0, "known empty differs from a cache miss");
  local.remove = async key => { local.data.delete(key); };
  await cache.observe({ ...timeline(true), frames: [] });
  assert.equal(local.data.size, 0, "same empty projection retries failed removal");
});

test("failed cache reads release their receipt so subsequent loads can retry", async () => {
  const local = storage();
  await createConversationDisplayContinuity({ namespace: "retry", storage: local }).observe(timeline(true));
  const load = local.load;
  let calls = 0;
  local.load = async key => { if (++calls === 1) throw Error("read unavailable"); return load(key); };
  const cache = createConversationDisplayContinuity({ namespace: "retry", storage: local });
  assert.equal(await cache.load("host", "thread"), null);
  assert.ok(await cache.load("host", "thread"));
  assert.equal(calls, 2);
});

test("a partial window cannot erase cached messages without metadata; canonical deletion still wins", () => {
  const cached = timeline(false);
  const partial = {...cached, frames: cached.frames.slice(1)};
  assert.equal(selectConversationDisplay({key: cached.key, cached, timeline: partial}).timeline, cached);
  const canonical = {...partial, authoritative: true};
  assert.equal(selectConversationDisplay({key: cached.key, cached, timeline: canonical}).timeline, canonical);
  const empty = {...canonical, frames: []};
  assert.equal(selectConversationDisplay({key: cached.key, cached, timeline: empty}).timeline, empty);
});

function historyWindow(ids: readonly string[], authoritative = true): TimelineSnapshot {
  return { ...timeline(authoritative), frames: ids.flatMap(id => timeline(authoritative).frames.map(frame => ({
    ...frame, turnId: asTurnId(id), id: `${id}:${frame.id}`,
    blocks: frame.blocks.map(block => ({ ...block, id: `${id}:${block.id}` })),
  }))) };
}
const turnIds = (value: TimelineSnapshot) => [...new Set(value.frames.map(frame => frame.turnId))];

test("a partial authoritative tail retains only a proven cached prefix and keeps live output", () => {
  const cached = historyWindow(["old", "boundary", "removed", "tail"], false);
  const tail = historyWindow(["boundary", "tail"]);
  const result = selectConversationDisplay({ key: tail.key, timeline: tail, cached, historyHasOlder: true });
  assert.equal(result.source, "mixed");
  assert.deepEqual(turnIds(result.timeline!), ["old", "boundary", "tail"], "absence inside canonical coverage is a deletion");
  assert.equal(result.timeline!.authoritative, false, "the combined body cannot claim full authority");
  if (result.source !== "mixed") throw Error("expected mixed history");
  assert.deepEqual([...result.cachedTurnIds], ["old"]);
  assert.equal(result.timeline.frames.at(-1), tail.frames.at(-1), "the live tail is never replaced by cached output");
  const streaming = { ...tail, revision: 5, frames: tail.frames.map(frame => ({ ...frame, status: "streaming" as const })) };
  const next = selectConversationDisplay({ key: tail.key, timeline: streaming, cached, historyHasOlder: true });
  assert.equal(next.timeline!.frames.at(-1)?.status, "streaming");
});

test("complete, disjoint and foreign authoritative windows do not inherit cached history", () => {
  const tail = historyWindow(["tail"]), cached = historyWindow(["old", "tail"], false);
  for (const historyHasOlder of [false, undefined]) {
    const result = selectConversationDisplay({ key: tail.key, timeline: tail, cached, historyHasOlder });
    assert.equal(result.timeline, tail);
    assert.equal(result.source, "history");
  }
  for (const other of [historyWindow(["unrelated"], false), { ...cached, key: createConversationKey("other", "thread") }]) {
    assert.equal(selectConversationDisplay({ key: tail.key, timeline: tail, cached: other, historyHasOlder: true }).timeline, tail);
  }
  const empty = { ...tail, frames: [] };
  assert.equal(selectConversationDisplay({ key: tail.key, timeline: empty, cached, historyHasOlder: false }).timeline, empty);
});

test("successive canonical pages progressively retire cached prefix authority fences", () => {
  const cached = historyWindow(["a", "b", "c"], false);
  const select = (ids: string[], hasOlder: boolean) => selectConversationDisplay({ key: cached.key,
    timeline: historyWindow(ids), cached, historyHasOlder: hasOlder });
  const first = select(["c"], true), second = select(["b", "c"], true), complete = select(["a", "b", "c"], false);
  assert.equal(first.source, "mixed"); assert.equal(second.source, "mixed");
  if (first.source !== "mixed" || second.source !== "mixed") throw Error("missing prefix");
  assert.deepEqual([...first.cachedTurnIds], ["a", "b"]);
  assert.deepEqual([...second.cachedTurnIds], ["a"]);
  assert.equal(complete.source, "history");
  assert.equal(complete.timeline!.authoritative, true);
});

test("observing a short canonical window does not persist a shrunken display cache", async () => {
  const local = storage();
  const cache = createConversationDisplayContinuity({ namespace: "coverage", storage: local });
  await cache.observe(historyWindow(["old", "tail"]), false);
  await cache.observe(historyWindow(["tail"]), true);
  assert.deepEqual(turnIds(cache.peek("host", "thread")!), ["old", "tail"]);
  const reloaded = createConversationDisplayContinuity({ namespace: "coverage", storage: local });
  assert.deepEqual(turnIds((await reloaded.load("host", "thread"))!), ["old", "tail"]);
  await cache.observe(historyWindow(["tail"]), false);
  assert.deepEqual(turnIds(cache.peek("host", "thread")!), ["tail"], "a complete baseline can delete old history");
  await cache.observe({ ...historyWindow([]), frames: [] }, false);
  assert.equal(cache.peek("host", "thread"), null);
});

test("omitted activity bodies retain ordered region identities and header shape after a cold reload", async () => {
  const local = storage();
  const source = timeline(true);
  const command = (id: string) => ({ type: "command-execution" as const, id, sourceItemIds: [],
    command: "pwd", callId: null, cwd: null, processId: null, startedAtMs: null, turnInProgress: false,
    output: "/fixture", exitCode: 0, durationMs: 10, actions: [], automaticApprovalReviews: [], status: "completed" as const });
  const answer = (id: string) => ({ type: "text" as const, id, sourceItemIds: [], text: id,
    streaming: false, completed: true, phase: "final_answer" as const });
  const withWork: TimelineSnapshot = { ...source, frames: source.frames.map(frame => frame.type === "assistant"
    ? { ...frame, displayDurationMs: 71000, blocks: [command("first"), answer("first-answer"), command("second"), answer("second-answer")] }
    : frame) };
  const plan = (snapshot: TimelineSnapshot) => createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(snapshot)[0]!).assistant!;
  const shape = (snapshot: TimelineSnapshot) => plan(snapshot).slots.map(slot => slot.type === "agent-activity"
    ? { type: slot.type, id: slot.id, durationMs: slot.workedDurationMs, count: slot.collapsedItemCount }
    : { type: slot.type, id: slot.id });
  await createConversationDisplayContinuity({ namespace: "regions", storage: local }).observe(withWork);
  const cached = (await createConversationDisplayContinuity({ namespace: "regions", storage: local }).load("host", "thread"))!;
  assert.deepEqual(shape(cached), shape(withWork), "each omitted region stays in its original place, including work after an answer");
  assert.ok(cached.frames.every(frame => frame.blocks.every(block => block.type !== "command-execution")), "no executable bodies persisted");
  assert.equal(cached.authoritative, false);
  assert.equal(plan(cached).slots.filter(slot => slot.type === "agent-activity" && slot.contentAvailable === false).length, 2);
  // A fresh authoritative result owns presentation again; cached descriptors do
  // not outlive it or suppress genuinely updated content.
  const selected = selectConversationDisplay({ key: source.key, timeline: withWork, cached, historyHasOlder: false });
  assert.ok(plan(selected.timeline!).slots.every(slot => slot.type !== "agent-activity" || !slot.displayOnly));
});

test("cached body availability never changes View-owned disclosure preference", async () => {
  const local = storage();
  const source = timeline(true);
  const withWork: TimelineSnapshot = { ...source, frames: source.frames.map(frame => frame.type === "assistant"
    ? { ...frame, presentationRegions: [{ type: "activity" as const, id: "retained-work",
      beforeBlockId: frame.blocks[0]?.id ?? null, count: 3, durationMs: 10, workStatus: null }] }
    : frame) };
  await createConversationDisplayContinuity({ namespace: "disclosure", storage: local }).observe(withWork);
  const cached = (await createConversationDisplayContinuity({ namespace: "disclosure", storage: local }).load("host", "thread"))!;
  const activity = createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(cached)[0]!).assistant!.slots
    .find(slot => slot.type === "agent-activity" && slot.contentAvailable === false);
  assert.ok(activity && activity.type === "agent-activity");
  for (const contentAvailable of [false, true]) {
    assert.equal(resolveAgentActivityLayout({ ...activity, contentAvailable }, false).isCollapsed, false);
    assert.equal(resolveAgentActivityLayout({ ...activity, contentAvailable }, true).isCollapsed, true);
    assert.equal(resolveAgentActivityLayout({ ...activity, contentAvailable }).isCollapsed, true);
  }
});

function segmentedWorkHistory(count: number): TimelineSnapshot {
  const source = timeline(true);
  return { ...source, frames: source.frames.filter(frame => frame.type === "assistant").map(frame => ({
    ...frame, displayDurationMs: 71000,
    blocks: Array.from({ length: count }, (_, index) => [
      { type: "command-execution" as const, id: "command-" + index, sourceItemIds: [],
        command: "pwd", callId: null, cwd: null, processId: null, startedAtMs: null, turnInProgress: false,
        output: "/fixture", exitCode: 0, durationMs: 10, actions: [], automaticApprovalReviews: [], status: "completed" as const },
      { type: "text" as const, id: "answer-" + index, sourceItemIds: [], text: "Answer " + index,
        streaming: false, completed: true, phase: "final_answer" as const },
    ]).flat(),
  })) };
}

const regionPlan = (snapshot: TimelineSnapshot) =>
  createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(snapshot)[0]!).assistant!;

for (const count of [24, 25, 60]) test(`message trimming retains only anchored regions, warm and cold: ${count} responses`, async () => {
  const local = storage(), source = segmentedWorkHistory(count);
  const owner = createConversationDisplayContinuity({ namespace: "bounded-regions", storage: local });
  await owner.observe(source);
  const warm = owner.peek("host", "thread")!;
  const cold = (await createConversationDisplayContinuity({ namespace: "bounded-regions", storage: local }).load("host", "thread"))!;
  const anchors = new Set(cold.frames.flatMap(frame => frame.blocks.map(block => block.id)));
  const regions = cold.frames.flatMap(frame => frame.presentationRegions ?? []);
  assert.equal(anchors.size, 24);
  assert.equal(regions.length, 24, "regions for omitted replies retire with their anchors");
  assert.ok(regions.every(region => region.beforeBlockId === null || anchors.has(region.beforeBlockId)));
  const ids = new Set(regions.map(region => region.id));
  const expected = regionPlan(source).slots.filter(slot => slot.type === "agent-activity"
    ? ids.has(slot.id) : anchors.has(slot.block.id)).map(slot => slot.id);
  assert.deepEqual(regionPlan(cold).slots.map(slot => slot.id), expected,
    "no orphan regions or synthetic aggregate headers may migrate into the retained suffix");
  assert.deepEqual(regionPlan(warm), regionPlan(cold), "in-memory paint and persisted reload share one normalization");
});

test("legacy region arrays above the message limit are validated individually, not discarded wholesale", async () => {
  const local = storage(), source = segmentedWorkHistory(25);
  await createConversationDisplayContinuity({ namespace: "legacy-regions", storage: local }).observe(source);
  const [key, value] = [...local.data][0]!;
  const envelope = JSON.parse(value);
  const slots = regionPlan(source).slots;
  envelope.messages[0].regions = slots.flatMap((unit, index) => {
    if (unit.type !== "agent-activity") return [];
    const next = slots.slice(index + 1).find(slot => slot.type === "assistant-content");
    return [{ type: "activity", id: unit.id, beforeBlockId: next?.type === "assistant-content" ? next.block.id : null,
      count: unit.collapsedItemCount, durationMs: unit.workedDurationMs, workStatus: null }];
  });
  assert.equal(envelope.messages[0].regions.length, 25);
  local.data.set(key, JSON.stringify(envelope));
  const cold = (await createConversationDisplayContinuity({ namespace: "legacy-regions", storage: local }).load("host", "thread"))!;
  assert.equal(cold.frames.flatMap(frame => frame.presentationRegions ?? []).length, 24);
  assert.equal(regionPlan(cold).slots.filter(slot => slot.type === "agent-activity").length, 24);
});

test("malformed, duplicate and dangling regions cannot append ghost work to another answer", async () => {
  const local = storage();
  await createConversationDisplayContinuity({ namespace: "region-anchors", storage: local }).observe(segmentedWorkHistory(2));
  const [key, value] = [...local.data][0]!;
  const envelope = JSON.parse(value), first = envelope.messages[0].regions[0];
  envelope.messages[0].regions.push(first, null, 7, { ...first, id: "orphan", beforeBlockId: "not-retained" });
  envelope.messages[1].regions = [first];
  local.data.set(key, JSON.stringify(envelope));
  const cold = (await createConversationDisplayContinuity({ namespace: "region-anchors", storage: local }).load("host", "thread"))!;
  assert.equal(cold.frames.flatMap(frame => frame.presentationRegions ?? []).length, 2);
  assert.equal(regionPlan(cold).slots.filter(slot => slot.type === "agent-activity").length, 2);
  // An explicit empty descriptor set means the former regions were omitted,
  // not that an aggregate clock should be attached to the first remaining answer.
  envelope.messages.forEach((message: any) => { message.regions = [{ ...first, beforeBlockId: "not-retained" }]; });
  local.data.set(key, JSON.stringify(envelope));
  const noRegions = (await createConversationDisplayContinuity({ namespace: "region-anchors", storage: local }).load("host", "thread"))!;
  assert.equal(regionPlan(noRegions).slots.filter(slot => slot.type === "agent-activity").length, 0);
  const direct = { ...sourceAssistant(segmentedWorkHistory(1)), presentationRegions: [{ ...first, id: "orphan", beforeBlockId: "missing" }] };
  const directTimeline = { ...segmentedWorkHistory(1), frames: [direct] };
  assert.ok(!regionPlan(directTimeline).slots.some(slot => slot.id === "orphan"), "shared presenter also rejects a missing anchor");
});

function sourceAssistant(snapshot: TimelineSnapshot) {
  return snapshot.frames.find(frame => frame.type === "assistant")! as Extract<TimelineSnapshot["frames"][number], { type: "assistant" }>;
}

test("a trimmed predecessor cannot give retained commentary a second activity identity", async () => {
  const local = storage(), source = segmentedWorkHistory(25);
  const dense: TimelineSnapshot = { ...source, frames: source.frames.map(frame => ({ ...frame,
    blocks: frame.blocks.flatMap(block => block.type === "command-execution" ? [
      { type: "text" as const, id: "comment-" + block.id, sourceItemIds: [], text: "Working",
        streaming: false, completed: true, phase: "commentary" as const }, block,
    ] : [block]),
  })) };
  const cache = createConversationDisplayContinuity({ namespace: "cropped-predecessor", storage: local });
  await cache.observe(dense);
  const cached = cache.peek("host", "thread")!;
  const regions = cached.frames.flatMap(frame => frame.presentationRegions ?? []);
  const work = regionPlan(cached).slots.filter(slot => slot.type === "agent-activity");
  assert.deepEqual(work.map(unit => unit.id), regions.map(region => region.id),
    "the retained reply anchor identifies its original work interval even if its predecessor was trimmed");
  assert.ok(work.every(unit => unit.contentAvailable === false));
});

test("Turn resource shapes survive warm/cold cache without Hook output, diff bodies or review authority", async () => {
  const local = storage(), source = segmentedWorkHistory(25);
  const body = "PRIVATE_DIFF_BODY\n".repeat(5002);
  const rich: TimelineSnapshot = { ...source, frames: source.frames.map(frame => ({ ...frame,
    hookStats: { count: 2, blockedCount: 1, errorCount: 1, blockedMessages: ["PRIVATE_HOOK_OUTPUT"],
      blockedSources: ["secret"], entries: [{ kind: "error" as const, text: "PRIVATE_HOOK_OUTPUT" }], feedbackMessages: [], runs: [] },
    changeSummary: { type: "turn-diff" as const, id: "resource-diff", sourceItemIds: [], unifiedDiff: body,
      status: "complete" as const, files: [{ path: "src/a.ts", additions: 1, deletions: 0 }], additions: 1, deletions: 0 },
  })) };
  const cache = createConversationDisplayContinuity({ namespace: "turn-resources", storage: local });
  await cache.observe(rich);
  const warm = cache.peek("host", "thread")!;
  const cold = (await createConversationDisplayContinuity({ namespace: "turn-resources", storage: local }).load("host", "thread"))!;
  assert.deepEqual(warm, cold);
  const plan = regionPlan(cold);
  assert.equal(plan.changeSummary?.contentAvailable, false);
  assert.equal(plan.changeSummary?.files[0]?.inlinePreviewLineCount, 5003);
  assert.equal(plan.changeSummary?.unifiedDiff, "");
  assert.equal(cold.frames.filter(frame => frame.hookStats !== null).length, 1, "Turn metadata is attached once after message trimming");
  assert.equal(cold.frames[0]?.hookStats?.contentAvailable, false);
  assert.equal(cold.frames[0]?.hookStats?.count, 2);
  const value = [...local.data.values()][0]!;
  assert.ok(!value.includes("PRIVATE_DIFF_BODY") && !value.includes("PRIVATE_HOOK_OUTPUT"));
  const [key] = [...local.data.keys()];
  const envelope = JSON.parse(value);
  envelope.messages[0].resources.changeSummary.contentAvailable = true;
  envelope.messages[0].resources.changeSummary.unifiedDiff = "INJECTED_BYTES";
  envelope.messages[0].resources.hookStats.runs = [{ id: "execute", command: "unsafe" }];
  local.data.set(key!, JSON.stringify(envelope));
  const untrusted = (await createConversationDisplayContinuity({ namespace: "turn-resources", storage: local }).load("host", "thread"))!;
  assert.equal(regionPlan(untrusted).changeSummary?.contentAvailable, false);
  assert.equal(regionPlan(untrusted).changeSummary?.unifiedDiff, "");
  assert.deepEqual(untrusted.frames[0]?.hookStats?.runs, []);
});

test("active diff resources are not resurrected as completed cards from cache", async () => {
  const local = storage(), source = segmentedWorkHistory(1);
  await createConversationDisplayContinuity({ namespace: "active-resources", storage: local }).observe({
    ...source, frames: source.frames.map(frame => ({ ...frame, changeSummary: {
      type: "turn-diff" as const, id: "live-diff", sourceItemIds: [], unifiedDiff: "", status: "running" as const,
      files: [{ path: "a.ts", additions: 1, deletions: 0 }], additions: 1, deletions: 0,
    } })),
  });
  const cold = (await createConversationDisplayContinuity({ namespace: "active-resources", storage: local }).load("host", "thread"))!;
  assert.equal(regionPlan(cold).changeSummary, null);
});

test("Hook indicator ownership follows the visible frame, not a hidden later observation", async () => {
  const source = segmentedWorkHistory(1), local = storage();
  const frame = source.frames[0]!;
  const hookStats = { count: 1, blockedCount: 0, errorCount: 0, blockedMessages: [], blockedSources: [], entries: [], feedbackMessages: [], runs: [] };
  const split: TimelineSnapshot = { ...source, frames: [{ ...frame, hookStats: null },
    { ...frame, id: "hidden-later-frame", blocks: [], hookStats }] };
  assert.equal(createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(split)[0]!).assistantFrame?.hookStats, null);
  const cache = createConversationDisplayContinuity({ namespace: "hook-owner", storage: local });
  await cache.observe(split);
  assert.ok(cache.peek("host", "thread")!.frames.every(frame => frame.hookStats === null), "cache cannot invent an indicator absent from the rendered owner");
});

test("Turn resources survive when no assistant message body can be retained", async () => {
  const local = storage(), source = timeline(true);
  const resourceOnly: TimelineSnapshot = { ...source, frames: source.frames.map(frame => frame.type !== "assistant" ? frame : ({
    ...frame, blocks: [], hookStats: { count: 1, blockedCount: 0, errorCount: 0,
      blockedMessages: [], blockedSources: [], entries: [], feedbackMessages: [], runs: [] },
    changeSummary: { type: "turn-diff" as const, id: "changes-without-answer", sourceItemIds: [], status: "complete" as const,
      unifiedDiff: "", files: [{ path: "partial.ts", additions: 1, deletions: 0 }], additions: 1, deletions: 0 },
  })) };
  const cache = createConversationDisplayContinuity({ namespace: "bodyless-resource", storage: local });
  await cache.observe(resourceOnly);
  const cold = (await createConversationDisplayContinuity({ namespace: "bodyless-resource", storage: local }).load("host", "thread"))!;
  assert.deepEqual(cache.peek("host", "thread"), cold);
  assert.ok(cold.frames.some(frame => frame.type === "assistant" && frame.blocks.length === 0 && frame.hookStats?.contentAvailable === false));
  assert.equal(regionPlan(cold).changeSummary?.id, "changes-without-answer");
  assert.equal(cold.authoritative, false);
});


test("display retention never plans resources of discarded historical Turns", async () => {
  const original = timeline(true), local = storage();
  const frames = Array.from({ length: 60 }, (_, index) => original.frames.map(frame => ({
    ...frame, id: frame.id + ':' + index, turnId: asTurnId('turn-' + index),
    blocks: frame.blocks.map(block => ({ ...block, id: block.id + ':' + index })),
  }))).flat();
  Object.defineProperty(frames[1]!, 'changeSummary', { get() { throw new Error('discarded Turn resources were planned'); } });
  const source = { ...original, frames } as TimelineSnapshot;
  const cache = createConversationDisplayContinuity({ namespace: 'bounded-planning', storage: local });
  await cache.observe(source);
  const warm = cache.peek('host', 'thread')!;
  assert.ok(warm.frames.length > 0);
  assert.ok(warm.frames.every(frame => frame.turnId !== 'turn-0'));
  const cold = await createConversationDisplayContinuity({ namespace: 'bounded-planning', storage: local }).load('host', 'thread');
  assert.deepEqual(cold, warm);
});


for (const metadata of ["complete", "absent"] as const) {
  test("bounded display selection never normalizes discarded history with " + metadata + " optional anchors", async () => {
    const base = timeline(true);
    const frames = Array.from({ length: 60 }, (_, index) => base.frames.map(frame => ({
      ...frame, id: frame.id + index, turnId: asTurnId("bounded-" + index),
      ...(frame.type === "assistant" && metadata === "complete" ? {
        durationMs: 10, workStatus: { type: "worked-for" as const, status: "worked" as const, startedAtMs: 1, completedAtMs: 11 },
      } : {}),
      blocks: frame.blocks.map(block => ({ ...block, id: block.id + index,
        ...(block.type === "text" && metadata === "complete" ? { sentAtMs: index } : {}),
      })),
    }))).flat();
    Object.defineProperty(frames[1]!.blocks[0]!, "asyncQuestions", { get() { throw Error("discarded body was parsed"); } });
    Object.defineProperty(frames[0]!.blocks[0]!, "attachments", { get() { throw Error("discarded user was parsed"); } });
    const local = storage(), cache = createConversationDisplayContinuity({ namespace: "bounded", storage: local, now: () => 1000 });
    await cache.observe({ ...base, frames });
    const stored = JSON.parse([...local.data.values()][0]!).messages as { turnId: string; block: {id: string} }[];
    assert.equal(stored.length, 24);
    assert.equal(stored.some(message => message.turnId === "bounded-0"), false);
    assert.equal(stored.at(-1)?.block.id, "answer59");
    const cold = createConversationDisplayContinuity({ namespace: "bounded", storage: local, now: () => 1000 });
    assert.deepEqual(await cold.load("host", "thread"), cache.peek("host", "thread"));
  });
}

test("sparse display anchors survive a commentary tail in the original source order", async () => {
  const base = timeline(true), assistant = base.frames[1]!;
  const work = { ...assistant, id: "work", turnId: asTurnId("work"), durationMs: 5,
    workStatus: { type: "worked-for" as const, status: "worked" as const, startedAtMs: 1, completedAtMs: 6 },
    blocks: [{ type: "reasoning" as const, id: "work-body", sourceItemIds: [], summary: "Working", detail: null, streaming: false }],
  };
  const clock = { ...assistant, id: "clock", turnId: asTurnId("clock"),
    blocks: [{ type: "text" as const, id: "clock-body", sourceItemIds: [], text: "Clock", streaming: false, phase: "commentary" as const, sentAtMs: 5 }],
  };
  const tail = Array.from({length: 40}, (_, index) => ({ ...assistant, id: "tail-" + index, turnId: asTurnId("tail-" + index),
    blocks: [{ type: "text" as const, id: "tail-body-" + index, sourceItemIds: [], text: "Commentary", streaming: false, phase: "commentary" as const }],
  }));
  const local = storage(), cache = createConversationDisplayContinuity({namespace: "sparse", storage: local, now: () => 1000});
  await cache.observe({...base, frames: [work, ...base.frames, clock, ...tail]});
  const stored = JSON.parse([...local.data.values()][0]!).messages as {block: {id: string}}[];
  assert.deepEqual(stored.map(message => message.block.id), ["work-body", "user", "answer", "clock-body", ...Array.from({length: 20}, (_, i) => "tail-body-" + (i + 20))]);
});


for (const workOnly of [false, true]) test("region successors retain forward order and work-only null anchors: " + workOnly, async () => {
  const source = segmentedWorkHistory(8), assistant = sourceAssistant(source);
  const lastCommand = assistant.blocks.find(block => block.type === "command-execution")!;
  const withTrailingWork: TimelineSnapshot = { ...source, frames: [{ ...assistant,
    ...(workOnly ? {presentationRegions: [{type: "activity" as const, id: "display-work", beforeBlockId: null, count: 2, durationMs: 71000, workStatus: null}]} : {}),
    blocks: workOnly ? [{type: "reasoning", id: "inspection", sourceItemIds: [], summary: "Inspecting", detail: null, streaming: false}, lastCommand]
      : [...assistant.blocks, { ...lastCommand, id: "trailing-command" }],
  }] };
  const slots = regionPlan(withTrailingWork).slots;
  const expected = slots.flatMap((unit, index) => {
    if (unit.type !== "agent-activity" || !resolveAgentActivityLayout(unit).showToggle) return [];
    const next = slots.slice(index + 1).find(slot => slot.type === "assistant-content");
    return [{id: unit.id, beforeBlockId: next?.type === "assistant-content" ? next.block.id : null}];
  });
  assert.equal(expected.length, workOnly ? 1 : 8);
  if (workOnly) assert.equal(expected[0]?.beforeBlockId, null);
  const local = storage(), cache = createConversationDisplayContinuity({namespace: "successors", storage: local, now: () => 1000});
  await cache.observe(withTrailingWork);
  const messages = JSON.parse([...local.data.values()][0]!).messages;
  const actual = messages.flatMap((message: {regions?: {id: string; beforeBlockId: string | null}[]}) =>
    message.regions?.map(region => ({id: region.id, beforeBlockId: region.beforeBlockId})) ?? []);
  assert.deepEqual(actual, expected);
  const cold = createConversationDisplayContinuity({namespace: "successors", storage: local, now: () => 1000});
  assert.deepEqual(await cold.load("host", "thread"), cache.peek("host", "thread"));
});

function command(id: string) {
  return { type: "command-execution" as const, id, sourceItemIds: ["secret-detail-key"],
    command: "echo refreshed", callId: "execution-grant", cwd: "/private", processId: "pty-1", startedAtMs: 123,
    turnInProgress: false, output: "private output", exitCode: 0, durationMs: 12,
    actions: [], automaticApprovalReviews: [], status: "complete" as const };
}
function activityHistory(): TimelineSnapshot {
  const source = timeline(true);
  return { ...source, frames: source.frames.map(frame => frame.type === "assistant" ? { ...frame,
    blocks: [command("command-a"), command("command-b"), ...frame.blocks, command("trailing-command")] } : frame) };
}

test("reload retains ordered inert command rows and title in one display document", async () => {
  const local = storage(), source = activityHistory();
  const owner = createConversationDisplayContinuity({ namespace: "refresh", storage: local });
  await owner.observe(source, false, { title: "排查性能", project: "project" });
  const cold = (await createConversationDisplayContinuity({ namespace: "refresh", storage: local }).load("host", "thread"))!;
  assert.deepEqual(cold.displayHeader, { title: "排查性能", project: "project" });
  assert.deepEqual(cold.frames.flatMap(f => f.blocks.map(b => b.id)), source.frames.flatMap(f => f.blocks.map(b => b.id)));
  const tools = cold.frames.flatMap(f => f.blocks).filter(b => b.type === "command-execution");
  assert.equal(tools.length, 3);
  assert.ok(tools.every(b => b.displayPreview && b.output === null && b.processId === null && b.callId === null && !b.sourceItemIds.length));
  const serialized = [...local.data.values()].join("");
  for (const secret of ["private output", "execution-grant", "pty-1", "secret-detail-key", "/private"]) assert.ok(!serialized.includes(secret), secret);
  const plans = (t: TimelineSnapshot) => groupTimelineFramesByTurn(t).flatMap(turn => createTimelineTurnPresentationPlan(turn).assistant?.slots.map(s => ({ id: s.id, type: s.type })) ?? []);
  assert.deepEqual(plans(cold), plans(source));
  const partial = { ...source, authoritative: false, frames: source.frames.map(f => ({ ...f, blocks: f.blocks.filter(b => b.type !== "command-execution") })) };
  assert.equal(selectConversationDisplay({ key: source.key, timeline: partial, cached: cold }).source, "cache");
  assert.equal(selectConversationDisplay({ key: source.key, timeline: { ...partial, authoritative: true }, cached: cold }).source, "history", "canonical deletion still wins");
  await owner.observe(source, false, { title: "Renamed", project: "project" });
  assert.equal(owner.peek("host", "thread")?.displayHeader?.title, "Renamed");
  await owner.observe(source);
  assert.equal(owner.peek("host", "thread")?.displayHeader?.title, "Renamed");
});

test("tool previews are bounded and discarded messages never relocate activity", async () => {
  const source = activityHistory(), local = storage();
  const large = { ...source, frames: source.frames.map(f => f.type === "assistant" ? { ...f,
    blocks: [...Array.from({ length: 500 }, (_, i) => command(`c-${i}`)), ...f.blocks] } : f) };
  const owner = createConversationDisplayContinuity({ namespace: "bounds", storage: local });
  await owner.observe(large);
  const cached = owner.peek("host", "thread")!;
  assert.ok(cached.frames.flatMap(f => f.blocks).filter(b => b.type === "command-execution").length <= 64);
  assert.ok([...local.data.values()].every(v => v.length <= 64 * 1024));
  assert.ok(cached.frames.some(f => f.blocks.some(b => b.type === "text")));
});

test("forged preview payloads cannot restore tool authority and malformed summaries are rejected", async () => {
  const local = storage(), owner = createConversationDisplayContinuity({ namespace: "forged", storage: local });
  await owner.observe(activityHistory());
  const [key, value] = [...local.data.entries()][0]!;
  const stored = JSON.parse(value);
  const message = stored.messages.find((m: any) => m.before?.length);
  Object.assign(message.before[0], { processId: "forged", callId: "forged", output: "forged", automaticApprovalReviews: [{}], sourceItemIds: ["forged"] });
  local.data.set(key, JSON.stringify(stored));
  const reload = () => createConversationDisplayContinuity({ namespace: "forged", storage: local }).load("host", "thread");
  const cold = (await reload())!;
  assert.ok(!JSON.stringify(cold).includes("forged"));
  message.before[0].displayPreview.presentation.summary = "x".repeat(1025);
  local.data.set(key, JSON.stringify(stored));
  assert.equal(await reload(), null);
});

test("MCP, dynamic and patch summaries survive without app payloads or executable arguments", async () => {
  const { projectDisplayActivity, parseDisplayActivity } = await import("../../packages/workbench-runtime/src/conversation-display-activity");
  const { presentToolActivity, deriveAgentActivityHeaderPresentation } = await import("@opencraft/chat-core");
  const tool = { type: "tool-call" as const, id: "tool", sourceItemIds: ["item"], status: "complete" as const,
    kind: "mcp" as const, name: "inspect", server: "example", namespace: null, callId: "call", input: { secret: "raw-args" },
    output: { content: [{ type: "text", text: "raw-result" }] }, errorMessage: null, durationMs: 7,
    readOnlyHint: false, appResourceUri: null, automaticApprovalReviews: [], appToolResult: { secret: "private-ui" } };
  const patch = { type: "patch" as const, id: "patch", sourceItemIds: [], status: "complete" as const, title: "Updated files",
    changes: [{ path: "src/a.ts", kind: "modify" as const, additions: 1, deletions: 0, unifiedDiff: "secret-diff", movePath: null }], automaticApprovalReviews: [] };
  for (const original of [tool, { ...tool, kind: "dynamic" as const, name: "custom_action" }, patch]) {
    const preview = projectDisplayActivity(original)!;
    assert.ok(preview?.displayPreview);
    assert.equal(presentToolActivity(preview).summary, presentToolActivity(original).summary);
    const lifecycle = { isLatestVisibleUnit: true, isActivitySliceClosed: true, isExploring: false, inProgress: false };
    assert.deepEqual(deriveAgentActivityHeaderPresentation({ blocks: [preview], lifecycle }).summary,
      deriveAgentActivityHeaderPresentation({ blocks: [original], lifecycle }).summary);
    assert.deepEqual(parseDisplayActivity(JSON.parse(JSON.stringify(preview))), preview);
    for (const secret of ["raw-args", "raw-result", "private-ui", "secret-diff"]) assert.ok(!JSON.stringify(preview).includes(secret));
  }
});

test("large activity labels cannot evict otherwise retained message bodies", async () => {
  const local = storage(), source = activityHistory();
  const large = { ...source, frames: source.frames.map(f => f.type === "assistant" ? { ...f, blocks: [
    ...Array.from({ length: 64 }, (_, i) => ({ ...command(`large-${i}`), command: "x".repeat(2000) })),
    ...f.blocks.map(b => b.type === "text" ? { ...b, text: "Retained body ".repeat(2500) } : b),
  ] } : f) };
  const owner = createConversationDisplayContinuity({ namespace: "large", storage: local });
  await owner.observe(large);
  const cached = owner.peek("host", "thread");
  assert.ok(cached?.frames.some(f => f.blocks.some(b => b.type === "text" && b.text.startsWith("Retained body"))));
  assert.ok([...local.data.values()].every(v => v.length <= 64 * 1024));
});

test("oversized display observations serialize a bounded amount of message data", async context => {
  const local = storage();
  const body = '正文 "\\\n'.repeat(2_000);
  const base = timeline(true);
  const assistant = base.frames[1]!;
  const source: TimelineSnapshot = { ...base, frames: Array.from({ length: 24 }, (_, index) => ({
    ...assistant, id: `frame-${index}`, turnId: asTurnId(`turn-${index}`),
    blocks: [{ type: "text", id: `text-${index}`, sourceItemIds: [], text: body,
      streaming: false, phase: "final_answer", sentAtMs: 100 }],
  })) };
  const inputCharacters = JSON.stringify(source).length;
  const cache = createConversationDisplayContinuity({ namespace: "linear-budget", storage: local });
  const stringify = JSON.stringify;
  let serializedCharacters = 0;
  const probe = context.mock.method(JSON, "stringify", (...args: Parameters<typeof JSON.stringify>) => {
    const value = stringify(...args);
    serializedCharacters += value?.length ?? 0;
    return value;
  });
  let pending: Promise<void>;
  try { pending = cache.observe(source); } finally { probe.mock.restore(); }
  await pending;
  assert.ok(serializedCharacters < inputCharacters * 3 + 200_000,
    `cache serialized ${serializedCharacters} characters for ${inputCharacters} input characters`);
  assert.ok(local.data.size > 0);
  assert.ok([...local.data.values()].every(value => value.length <= 64 * 1_024));
});

test("escaped message sizes preserve whole-Turn eviction and cold recovery", async () => {
  const base = timeline(true), assistant = base.frames[1]!;
  const turns = ["a", "b", "a", "c", "d", "c", "e", "e"];
  const source: TimelineSnapshot = { ...base, frames: turns.map((turn, index) => ({
    ...assistant, id: `frame-${index}`, turnId: asTurnId(turn),
    blocks: [{ type: "text", id: `text-${index}`, sourceItemIds: [], text: "short",
      streaming: false, phase: "final_answer", sentAtMs: 100 }],
  })) };
  const short = storage();
  await createConversationDisplayContinuity({ namespace: "short", storage: short }).observe(source);
  const body = '中文 "\\\n'.repeat(1_500);
  let expected = JSON.parse([...short.data.values()][0]!).messages.map((message: any) => ({
    ...message, block: { ...message.block, text: body },
  }));
  while (JSON.stringify(expected).length > 64 * 1_024 - 1_024 && expected.length) {
    const oldest = expected[0].turnId;
    expected = expected.filter((message: any) => message.turnId !== oldest);
  }
  const local = storage(), cache = createConversationDisplayContinuity({ namespace: "escaped", storage: local });
  await cache.observe({ ...source, frames: source.frames.map(frame => ({ ...frame,
    blocks: frame.blocks.map(block => block.type === "text" ? { ...block, text: body } : block),
  })) });
  const value = [...local.data.values()][0]!;
  assert.ok(value.length <= 64 * 1_024);
  assert.deepEqual(JSON.parse(value).messages, expected);
  const cold = await createConversationDisplayContinuity({ namespace: "escaped", storage: local }).load("host", "thread");
  assert.deepEqual(cold?.frames.map(frame => frame.blocks[0]!.id), expected.map((message: any) => message.block.id));
});

test("metadata-only recovered file summaries retain unknown statistics but no detail authority", async () => {
  const local = storage(), source = segmentedWorkHistory(1);
  const partial: TimelineSnapshot = { ...source, frames: source.frames.map(frame => ({ ...frame, changeSummary: {
    type: "turn-diff" as const, id: `${frame.turnId}:turn-diff`, sourceItemIds: [], status: "complete" as const,
    unifiedDiff: "", files: [{ path: "large.ts", additions: 0, deletions: 0 }], additions: 0, deletions: 0,
    statsAvailable: false, contentAvailable: false, detailItemIds: ["private-detail-target"],
  } })) };
  const cache = createConversationDisplayContinuity({ namespace: "partial-resource", storage: local });
  await cache.observe(partial);
  const cold = (await createConversationDisplayContinuity({ namespace: "partial-resource", storage: local }).load("host", "thread"))!;
  assert.equal(regionPlan(cold).changeSummary?.statsAvailable, false);
  assert.equal(regionPlan(cold).changeSummary?.contentAvailable, false);
  assert.equal(regionPlan(cold).changeSummary?.detailItemIds, undefined);
  assert.equal(cold.authoritative, false);
  assert.ok(![...local.data.values()].join("").includes("private-detail-target"));
});
