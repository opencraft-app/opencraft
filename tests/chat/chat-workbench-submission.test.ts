import assert from "node:assert/strict";
import test from "node:test";

import { createComposerController, type SubmissionReceipt, type SubmitIntent } from "@opencraft/composer-core";
import {
  createConversationScopeRegistry,
  createWorkbenchSubmissionPipeline,
} from "@opencraft/workbench-runtime";

const receipt: SubmissionReceipt = {
  commandId: "command-one",
  clientMessageId: "message-one",
  hostId: "local",
  threadId: "thread-one",
  turnId: "turn-one",
  acceptedAt: 1,
  replayed: false,
};

function createIntent(draftId: string): SubmitIntent {
  return {
    commandId: receipt.commandId,
    clientMessageId: receipt.clientMessageId,
    target: {
      type: "new-thread",
      draftId,
      execution: {
        hostId: "local",
        workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      },
    },
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text: "Build" }] }],
    },
    attachments: [],
    context: [],
    selections: {},
    options: { autoContext: true },
    createdAt: 1,
  };
}

test("an accepted first Turn retries promotion without submitting twice", async () => {
  const scopes = createConversationScopeRegistry();
  const draft = scopes.openDraft({
    draftId: "draft-one",
    execution: {
      hostId: "local",
      workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
    },
  });
  let submits = 0;
  let promotions = 0;
  const pipeline = createWorkbenchSubmissionPipeline({
    scopes,
    async submitNewThread() {
      submits += 1;
      return receipt;
    },
    async submitExistingThread() {
      throw new Error("not used");
    },
    async submitFirstTurn() { return receipt; },
    async promoteDraft(draftId) {
      promotions += 1;
      if (promotions === 1) throw new Error("View activation failed");
      assert.equal(scopes.promoteDraft(draftId), true);
    },
  });

  await assert.rejects(pipeline.submit(createIntent(draft.id)), /View activation failed/u);
  assert.equal(submits, 1);
  assert.equal(scopes.getDraft(draft.id)?.phase, "accepted");
  assert.equal(scopes.getDraft(draft.id)?.receipt?.threadId, "thread-one");

  const resumed = await pipeline.submit(createIntent(draft.id));
  assert.equal(resumed.threadId, "thread-one");
  assert.equal(submits, 1, "the irreversible AppServer command is not repeated");
  assert.equal(promotions, 2);
  assert.equal(scopes.getDraft(draft.id), null);
});

test("Composer retries unchanged failed promotion with the accepted identity and gives edits a new identity", async () => {
  const scopes = createConversationScopeRegistry();
  const scope = scopes.openDraft({ draftId: "composer-retry", execution: { hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] } } });
  let ids = 0, starts = 0, queued = 0, promotions = 0;
  const composer = createComposerController(scope.target, { now: () => 1, createId: () => `retry-${++ids}` });
  composer.dispatch({ type: "set-document", document: createIntent(scope.id).document });
  const pipeline = createWorkbenchSubmissionPipeline({ scopes,
    async submitNewThread(intent) { starts++; return { ...receipt, commandId: intent.commandId, clientMessageId: intent.clientMessageId }; },
    async submitFirstTurn() { throw new Error("first Turn already accepted"); },
    async submitExistingThread(intent) { queued++; return { ...receipt, commandId: intent.commandId, clientMessageId: intent.clientMessageId }; },
    async promoteDraft(id) { if (++promotions === 1) throw new Error("activation failed"); scopes.promoteDraft(id); },
  });
  const first = composer.createSubmitIntent(), draftId = composer.getSnapshot().draft.id;
  composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
  // Match composer-editor: project model selections, then directly dispatch
  // failed lifecycle from the awaited onSubmit catch (no settleSubmission).
  await assert.rejects(pipeline.submit({ ...first, selections: { ...first.selections, model: "fixture" } }), /activation failed/);
  composer.dispatch({ type: "set-lifecycle", phase: "failed", error: "activation failed" });
  const retry = composer.createSubmitIntent();
  assert.equal(retry.commandId, first.commandId);
  assert.equal(retry.clientMessageId, first.clientMessageId);
  composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
  await pipeline.submit(retry);
  composer.settleSubmission(draftId, retry, { status: "accepted" });
  assert.equal(starts, 1);
  assert.equal(queued, 0);
  assert.equal(composer.getSnapshot().hasContent, false);

  composer.dispatch({ type: "set-document", document: createIntent(scope.id).document });
  const next = composer.createSubmitIntent();
  composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
  composer.settleSubmission(composer.getSnapshot().draft.id, next, { status: "failed", error: "retryable" });
  composer.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "New input" }] }] } });
  const edited = composer.createSubmitIntent();
  assert.notEqual(edited.clientMessageId, next.clientMessageId);
  composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
  composer.dispatch({ type: "set-lifecycle", phase: "failed", error: "not submitted" });
  assert.equal(edited.target.type, "new-thread");
  const target = edited.target as Extract<SubmitIntent["target"], { type: "new-thread" }>;
  composer.dispatch({ type: "switch-target", target: { ...target, execution: { ...target.execution,
    workspace: { cwd: "/moved", runtimeWorkspaceRoots: ["/moved"], projectId: "new-project" } } } });
  const moved = composer.createSubmitIntent();
  assert.notEqual(moved.clientMessageId, edited.clientMessageId);
  assert.equal(moved.target.type === "new-thread" && moved.target.execution.workspace.cwd, "/moved");
  composer.dispose();
});

test("concurrent promotion retries share one operation", async () => {
  const scopes = createConversationScopeRegistry();
  const draft = scopes.openDraft({
    draftId: "draft-concurrent",
    execution: {
      hostId: "local",
      workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
    },
  });
  scopes.beginSubmit(draft.id, createIntent(draft.id));
  scopes.acceptSubmission(draft.id, receipt);
  let release = () => undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let promotions = 0;
  const pipeline = createWorkbenchSubmissionPipeline({
    scopes,
    async submitNewThread() { throw new Error("must not submit"); },
    async submitExistingThread() { throw new Error("not used"); },
    async submitFirstTurn() { return receipt; },
    async promoteDraft(draftId) {
      promotions += 1;
      await wait;
      scopes.promoteDraft(draftId);
    },
  });
  const first = pipeline.resumeDraftPromotion(draft.id);
  const second = pipeline.resumeDraftPromotion(draft.id);
  assert.equal(first, second);
  release();
  await first;
  assert.equal(promotions, 1);
});

test("an atomic first-Turn receipt promotes without submitting the message twice", async () => {
  const scopes = createConversationScopeRegistry();
  const draft = scopes.openDraft({
    draftId: "draft-atomic",
    execution: {
      hostId: "fixture-host",
      workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
    },
  });
  const atomicReceipt = { ...receipt, hostId: "fixture-host" };
  let firstTurnSubmits = 0;
  const pipeline = createWorkbenchSubmissionPipeline({
    scopes,
    async submitNewThread() { return atomicReceipt; },
    async submitExistingThread() { throw new Error("not used"); },
    async submitFirstTurn() {
      firstTurnSubmits += 1;
      return atomicReceipt;
    },
    async promoteDraft(draftId) {
      assert.equal(scopes.promoteDraft(draftId), true);
    },
  });

  const result = await pipeline.submit({
    ...createIntent(draft.id),
    target: draft.target,
  });
  assert.equal(result.turnId, "turn-one");
  assert.equal(firstTurnSubmits, 0);
  assert.equal(scopes.getDraft(draft.id), null);
});

test("a different input during first-Turn promotion receives its own queue receipt", async () => {
  const scopes = createConversationScopeRegistry();
  const draft = scopes.openDraft({ draftId: "promoting-follow-up", execution: {
    hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
  } });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const queued: SubmitIntent[] = [];
  let starts = 0;
  const pipeline = createWorkbenchSubmissionPipeline({ scopes,
    async submitNewThread() { starts++; return receipt; },
    async submitFirstTurn() { throw new Error("the first Turn already has its native receipt"); },
    async promoteDraft(id) { await held; scopes.promoteDraft(id); },
    async submitExistingThread(intent) {
      queued.push(intent); return { ...receipt, commandId: intent.commandId, clientMessageId: intent.clientMessageId,
        turnId: null, disposition: "local-queue" };
    },
  });
  try {
    const first = pipeline.submit(createIntent(draft.id));
    await new Promise<void>(resolve => setImmediate(resolve));
    const followUp = { ...createIntent(draft.id), commandId: "command-two", clientMessageId: "message-two",
      document: { version: 1 as const, blocks: [{ type: "paragraph" as const, children: [{ type: "text" as const, text: "offline follow-up" }] }] } };
    const second = pipeline.submit(followUp);
    assert.equal(queued.length, 0, "promotion cannot authorize input before it reaches the original conversation");
    release(); await first;
    const ownReceipt = await second;
    assert.equal(starts, 1);
    assert.equal(ownReceipt.clientMessageId, "message-two", "the original receipt cannot clear a different input");
    assert.deepEqual(queued, [{ ...followUp, target: { type: "enqueue-follow-up", key: { hostId: "local", threadId: "thread-one" } } }]);
  } finally { release(); scopes.dispose(); }
});
