import assert from "node:assert/strict";
import test from "node:test";

import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";
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
      hostId: "local-codex",
      workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
    },
  });
  const atomicReceipt = { ...receipt, hostId: "local-codex" };
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
