import assert from "node:assert/strict";
import test from "node:test";

import { asHostId, asTurnId, createConversationKey } from "@opencraft/chat-core";
import {
  composerDocumentToPlainText,
  createComposerController,
  invertComposerFollowUpAction,
  legacyContentBlocksToComposer,
  resolveComposerPrimaryAction,
  resolveComposerFollowUpAction,
  retargetSubmitIntentForFollowUp,
  type ComposerDocument,
  type ComposerTarget,
} from "@opencraft/composer-core";

function services() {
  let id = 0;
  let now = 100;
  return {
    now: () => ++now,
    createId: () => `id-${++id}`,
  };
}

function existing(threadId: string): ComposerTarget {
  return {
    type: "existing-thread",
    key: createConversationKey("local", threadId),
  };
}

const richDocument: ComposerDocument = {
  version: 1,
  blocks: [
    {
      type: "paragraph",
      children: [
        { type: "text", text: "Review " },
        {
          type: "mention",
          id: "file-1",
          label: "runtime.ts",
          mentionKind: "file",
          uri: "file:///workspace/runtime.ts",
          metadata: { line: 42 },
        },
        { type: "text", text: " with " },
        {
          type: "resource",
          id: "skill-1",
          title: "review skill",
          uri: "skill://review",
          resourceKind: "skill",
          metadata: { version: 3 },
        },
      ],
    },
  ],
};

test("content inspection includes hidden target drafts and uses active content over its stale cache", () => {
  const controller = createComposerController(existing("a"), services());
  assert.equal(controller.hasRetainedContent(), false);
  controller.dispatch({ type: "set-document", document: richDocument });
  controller.dispatch({ type: "switch-target", target: existing("b") });
  assert.equal(controller.getSnapshot().hasContent, false);
  assert.equal(controller.hasRetainedContent(), true);
  assert.equal(controller.hasTargetContent(existing("a")), true);
  assert.equal(controller.hasTargetContent(existing("b")), false);
  assert.equal(controller.hasTargetContent(existing("unknown")), false);
  controller.dispatch({ type: "switch-target", target: existing("a") });
  controller.dispatch({ type: "replace-content", document: { version: 1, blocks: [] }, attachments: [], context: [] });
  assert.equal(controller.hasTargetContent(existing("a")), false);
  assert.equal(controller.hasRetainedContent(), false);
  controller.dispatch({ type: "set-document", document: richDocument });
  controller.dispatch({ type: "switch-target", target: existing("b") });
  controller.dispatch({ type: "reset-all" });
  assert.equal(controller.hasTargetContent(existing("a")), false);
  assert.equal(controller.hasRetainedContent(), false);
  controller.dispatch({ type: "set-document", document: richDocument });
  controller.dispose();
  assert.equal(controller.hasRetainedContent(), false);
  assert.equal(controller.hasTargetContent(existing("b")), false);
});

test("retained-content inspection includes cached attachments and context but excludes selections", () => {
  const controller = createComposerController(existing("attachment"), services());
  controller.dispatch({ type: "add-attachment", attachment: {
    id: "file", name: "file.txt", mimeType: "text/plain", size: 1,
    uri: null, lifecycle: "processing", error: null,
  } });
  controller.dispatch({ type: "switch-target", target: existing("context") });
  controller.dispatch({ type: "add-context", reference: {
    id: "context", kind: "file", title: "file", uri: "file", visible: true,
  } });
  controller.dispatch({ type: "switch-target", target: existing("empty") });
  controller.dispatch({ type: "set-selections", patch: { model: "selected" } });
  assert.equal(controller.hasRetainedContent(), true);
  assert.equal(controller.hasTargetContent(existing("attachment")), true);
  assert.equal(controller.hasTargetContent(existing("context")), true);
  assert.equal(controller.hasTargetContent(existing("empty")), false);
  controller.dispatch({ type: "switch-target", target: existing("attachment") });
  controller.dispatch({ type: "clear" });
  assert.equal(controller.hasRetainedContent(), true);
  controller.dispatch({ type: "switch-target", target: existing("context") });
  controller.dispatch({ type: "clear" });
  assert.equal(controller.hasRetainedContent(), false);
  controller.dispose();
});

test("cached submission settlement immediately updates retained-content inspection", () => {
  const controller = createComposerController(existing("sending"), services());
  controller.dispatch({ type: "set-document", document: richDocument });
  const draftId = controller.getSnapshot().draft.id;
  const intent = controller.createSubmitIntent();
  controller.dispatch({ type: "set-lifecycle", phase: "submitting" });
  controller.dispatch({ type: "switch-target", target: existing("empty") });
  assert.equal(controller.hasRetainedContent(), true);
  assert.equal(controller.settleSubmission(draftId, intent, { status: "accepted" }), true);
  assert.equal(controller.hasRetainedContent(), false);
  assert.equal(controller.hasTargetContent(existing("sending")), false);
  controller.dispose();
});

test("late attachment results update only their owning cached Draft and clear releases it", () => {
  const controller = createComposerController(existing("image-a"), services());
  const draftId = controller.getSnapshot().draft.id;
  controller.dispatch({ type: "add-attachment", attachment: {
    id: "photo", name: "photo.png", mimeType: "image/png", size: 3,
    uri: null, lifecycle: "processing", error: null,
  } });
  controller.dispatch({ type: "switch-target", target: existing("image-b") });
  assert.equal(controller.updateDraftAttachment(draftId, "photo", {
    uri: "data:image/png;base64,AQID", lifecycle: "ready",
  }), true);
  assert.equal(controller.getSnapshot().draft.attachments.length, 0);
  controller.dispatch({ type: "switch-target", target: existing("image-a") });
  assert.equal(controller.getSnapshot().draft.attachments[0]?.lifecycle, "ready");
  assert.equal(controller.getSnapshot().draft.attachments[0]?.uri, "data:image/png;base64,AQID");
  controller.dispatch({ type: "clear" });
  assert.equal(controller.getDraftAttachment(draftId, "photo"), null);
  let disposed = 0;
  controller.onDispose(() => { disposed++; });
  controller.dispose();
  controller.dispose();
  assert.equal(disposed, 1);
});

test("a late submission settles its originating Draft without clearing the conversation now on screen", () => {
  const controller = createComposerController(existing("send-a"), services());
  controller.dispatch({ type: "set-document", document: richDocument });
  controller.dispatch({ type: "set-selections", patch: { model: "selected-model" } });
  const originId = controller.getSnapshot().draft.id;
  const intent = controller.createSubmitIntent();
  controller.dispatch({ type: "set-lifecycle", phase: "submitting" });
  controller.dispatch({ type: "switch-target", target: existing("send-b") });
  controller.dispatch({ type: "set-document", document: { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Keep B" }] },
  ] } });
  const visibleId = controller.getSnapshot().draft.id;

  assert.equal(controller.settleSubmission(originId, intent, { status: "accepted" }), true);
  assert.equal(controller.getSnapshot().draft.id, visibleId);
  assert.equal(composerDocumentToPlainText(controller.getSnapshot().draft.document), "Keep B");
  controller.dispatch({ type: "switch-target", target: existing("send-a") });
  assert.notEqual(controller.getSnapshot().draft.id, originId);
  assert.equal(composerDocumentToPlainText(controller.getSnapshot().draft.document), "");
  assert.equal(controller.getSnapshot().draft.selections.model, "selected-model");
  assert.equal(controller.settleSubmission(originId, intent, { status: "accepted" }), false);
});

test("a rejected or edited in-flight Draft remains editable on its own target", () => {
  const controller = createComposerController(existing("retry-a"), services());
  controller.dispatch({ type: "set-document", document: richDocument });
  const originId = controller.getSnapshot().draft.id;
  const intent = controller.createSubmitIntent();
  controller.dispatch({ type: "set-lifecycle", phase: "submitting" });
  controller.dispatch({ type: "switch-target", target: existing("retry-b") });
  assert.equal(controller.settleSubmission(originId, intent, { status: "rejected" }), true);
  controller.dispatch({ type: "switch-target", target: existing("retry-a") });
  assert.equal(controller.getSnapshot().draft.id, originId);
  assert.equal(controller.getSnapshot().draft.lifecycle.phase, "editing");
  assert.equal(controller.getSnapshot().draft.document, richDocument);

  controller.dispatch({ type: "set-lifecycle", phase: "submitting" });
  assert.equal(controller.settleSubmission(originId, intent, { status: "failed", error: "Try again" }), true);
  assert.deepEqual(controller.getSnapshot().draft.lifecycle, { phase: "failed", error: "Try again" });

  controller.dispatch({ type: "set-lifecycle", phase: "submitting" });
  controller.dispatch({ type: "set-document", document: { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "New unsent text" }] },
  ] } });
  assert.equal(controller.settleSubmission(originId, intent, { status: "accepted" }), true);
  assert.equal(controller.getSnapshot().draft.id, originId);
  assert.equal(controller.getSnapshot().draft.lifecycle.phase, "editing");
  assert.equal(composerDocumentToPlainText(controller.getSnapshot().draft.document), "New unsent text");
});

test("dictation presentation is owned by its transient input and never by a replaced draft", () => {
  const controller = createComposerController(existing("voice-owner"), services());
  const unregister = controller.registerView({ focus() {}, blur() {}, insertText() {}, undo() {}, redo() {},
    beginTransientTextInput: () => ({ update() {}, commit() { return true; }, cancel() {} }) });
  const first = controller.beginTransientTextInput()!;
  const interaction = { kind: "dictation" as const, phase: "listening" as const, startedAt: 100,
    audioLevels: { subscribe: () => () => {} }, finish: async () => true, cancel() {} };
  first.setInteraction!(interaction);
  assert.equal(controller.getInputInteractionSnapshot(), interaction);
  controller.dispatch({ type: "switch-target", target: existing("replacement") });
  assert.equal(controller.getInputInteractionSnapshot(), null);
  const second = controller.beginTransientTextInput()!;
  second.setInteraction!(interaction);
  first.cancel(); first.setInteraction!({ ...interaction, phase: "transcribing" });
  assert.equal(controller.getInputInteractionSnapshot(), interaction);
  unregister();
  assert.equal(controller.getInputInteractionSnapshot(), null);
  controller.dispose();
});
test("a replacement physical View cannot inherit old dictation controls", () => {
  const controller = createComposerController(existing("voice-view"), services());
  const view = () => ({ focus() {}, blur() {}, insertText() {}, undo() {}, redo() {}, beginTransientTextInput: () => ({ update() {}, commit() { return true; }, cancel() {} }) });
  controller.registerView(view());
  const first = controller.beginTransientTextInput()!;
  first.setInteraction!({ kind: "dictation", phase: "starting", startedAt: null, audioLevels: { subscribe: () => () => {} }, finish: async () => true, cancel() {} });
  controller.registerView(view());
  assert.equal(controller.getInputInteractionSnapshot(), null);
  controller.dispose();
});
test("replacing queued content invalidates dictation and stale result cannot mutate replacement", () => {
  const controller = createComposerController(existing("replace-voice"), services());
  let commits = 0;
  controller.registerView({ focus() {}, blur() {}, insertText() {}, undo() {}, redo() {}, beginTransientTextInput: () => ({ update() {}, commit() { commits++; return true; }, cancel() {} }) });
  const input = controller.beginTransientTextInput()!;
  input.setInteraction!({ kind: "dictation", phase: "listening", startedAt: 0, audioLevels: { subscribe: () => () => {} }, finish: async () => true, cancel() {} });
  controller.dispatch({ type: "replace-content", document: richDocument, attachments: [], context: [] });
  assert.equal(controller.getInputInteractionSnapshot(), null);
  assert.equal(input.commit("Late"), false);
  assert.equal(commits, 0);
});
test("physical insertion rejection is acknowledged as false, never successful finalization", () => {
  const controller = createComposerController(existing("rejected"), services());
  const outcomes: string[] = [];
  controller.registerView({ focus() {}, blur() {}, insertText() {}, undo() {}, redo() {}, beginTransientTextInput: () => ({ update() {}, commit() { return false; }, cancel() {} }) });
  const input = controller.beginTransientTextInput({ finalized: result => outcomes.push(`${result.mode}:${result.cause}`) })!;
  assert.equal(input.commit("Recognized"), false);
  assert.deepEqual(outcomes, ["cancel:commit-rejected"]);
});
test("write acknowledgement loses ownership if View write replaces content reentrantly", () => {
  const controller = createComposerController(existing("reentrant"), services());
  controller.registerView({ focus() {}, blur() {}, insertText() {}, undo() {}, redo() {}, beginTransientTextInput: () => ({ update() {}, commit() {
    controller.dispatch({ type: "replace-content", document: richDocument, attachments: [], context: [] }); return true;
  }, cancel() {} }) });
  assert.equal(controller.beginTransientTextInput()!.commit("Not an acknowledgement"), false);
  assert.deepEqual(controller.getSnapshot().draft.document, richDocument);
});
test("submission cannot consume original content when provisional insertion is rejected", () => {
  const controller = createComposerController(existing("failed-submit"), services());
  controller.dispatch({ type: "set-document", document: richDocument });
  controller.registerView({ focus() {}, blur() {}, insertText() {}, undo() {}, redo() {}, beginTransientTextInput: () => ({ update() {}, commit() { return false; }, cancel() {} }) });
  controller.beginTransientTextInput()!.update("Recognized");
  assert.throws(() => controller.createSubmitIntent(), /could not be inserted/);
});

test("Composer keeps independent drafts per target", () => {
  const controller = createComposerController(existing("thread-a"), services());
  controller.dispatch({ type: "set-document", document: richDocument });
  const firstDraftId = controller.getSnapshot().draft.id;

  controller.dispatch({ type: "switch-target", target: existing("thread-b") });
  assert.notEqual(controller.getSnapshot().draft.id, firstDraftId);
  assert.equal(
    composerDocumentToPlainText(controller.getSnapshot().draft.document),
    "",
  );

  controller.dispatch({ type: "switch-target", target: existing("thread-a") });
  assert.equal(controller.getSnapshot().draft.id, firstDraftId);
  assert.equal(
    composerDocumentToPlainText(controller.getSnapshot().draft.document),
    "Review @runtime.ts with review skill",
  );
});

test("replacing queued content is one atomic Composer-owned draft transaction", () => {
  const controller = createComposerController(existing("thread-a"), services());
  controller.dispatch({
    type: "set-selections",
    patch: { model: "gpt-5.6", effort: "high" },
  });
  controller.dispatch({
    type: "set-lifecycle",
    phase: "failed",
    error: "old failure",
  });
  const attachment = {
    id: "queued-image",
    name: "shot.png",
    mimeType: "image/png",
    size: 42,
    uri: "/tmp/shot.png",
    lifecycle: "ready" as const,
    error: null,
  };
  const context = {
    id: "queued-context",
    kind: "file" as const,
    title: "runtime.ts",
    uri: "file:///repo/runtime.ts",
    visible: true,
  };
  const beforeRevision = controller.getSnapshot().revision;

  controller.dispatch({
    type: "replace-content",
    document: richDocument,
    attachments: [attachment],
    context: [context],
  });

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.revision, beforeRevision + 1);
  assert.equal(snapshot.draft.document, richDocument);
  assert.deepEqual(snapshot.draft.attachments, [attachment]);
  assert.deepEqual(snapshot.draft.context, [context]);
  assert.deepEqual(snapshot.draft.selections, {
    model: "gpt-5.6",
    effort: "high",
  });
  assert.deepEqual(snapshot.draft.lifecycle, {
    phase: "editing",
    error: null,
  });
});

test("two New chat drafts in the same workspace never share Composer state", () => {
  const newDraft = (draftId: string): ComposerTarget => ({
    type: "new-thread",
    draftId,
    execution: {
      hostId: asHostId("local"),
      workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
    },
  });
  const controller = createComposerController(newDraft("draft-a"), services());
  controller.dispatch({ type: "set-document", document: richDocument });

  controller.dispatch({ type: "switch-target", target: newDraft("draft-b") });
  assert.equal(
    composerDocumentToPlainText(controller.getSnapshot().draft.document),
    "",
  );

  controller.dispatch({ type: "switch-target", target: newDraft("draft-a") });
  assert.equal(
    composerDocumentToPlainText(controller.getSnapshot().draft.document),
    "Review @runtime.ts with review skill",
  );
});

test("changing one Draft workspace preserves its identity and typed document", () => {
  const controller = createComposerController(
    {
      type: "new-thread",
      draftId: "draft-workspace",
      execution: {
        hostId: asHostId("local"),
        workspace: {
          cwd: "/workspace/one",
          runtimeWorkspaceRoots: ["/workspace/one"],
        },
      },
    },
    services(),
  );
  controller.dispatch({ type: "set-document", document: richDocument });
  controller.dispatch({
    type: "set-selections",
    patch: { model: "gpt-5.6", effort: "high" },
  });
  controller.dispatch({
    type: "add-attachment",
    attachment: {
      id: "asset-retarget",
      name: "context.png",
      mimeType: "image/png",
      size: 128,
      uri: "asset://context.png",
      lifecycle: "ready",
      error: null,
    },
  });
  controller.dispatch({
    type: "switch-target",
    target: {
      type: "new-thread",
      draftId: "draft-workspace",
      execution: {
        hostId: asHostId("ssh:build"),
        workspace: {
          cwd: "/workspace/two",
          runtimeWorkspaceRoots: ["/workspace/two"],
        },
      },
    },
  });

  assert.equal(controller.getSnapshot().draft.target.type, "new-thread");
  assert.equal(
    controller.getSnapshot().draft.target.type === "new-thread"
      ? controller.getSnapshot().draft.target.execution.workspace.cwd
      : null,
    "/workspace/two",
  );
  assert.equal(
    composerDocumentToPlainText(controller.getSnapshot().draft.document),
    "Review @runtime.ts with review skill",
  );
  assert.deepEqual(controller.getSnapshot().draft.selections, {
    model: "gpt-5.6",
    effort: "high",
  });
  assert.equal(
    controller.getSnapshot().draft.attachments[0]?.id,
    "asset-retarget",
  );
});

test("processing attachments prevent submission until the asset is ready", () => {
  const controller = createComposerController(existing("thread-a"), services());
  controller.dispatch({ type: "set-document", document: richDocument });
  controller.dispatch({
    type: "add-attachment",
    attachment: {
      id: "asset-1",
      name: "diagram.png",
      mimeType: "image/png",
      size: 200,
      uri: null,
      lifecycle: "uploading",
      error: null,
    },
  });
  assert.equal(controller.getSnapshot().hasProcessingAssets, true);
  assert.equal(controller.getSnapshot().hasUnavailableAssets, true);
  assert.equal(controller.getSnapshot().canSubmit, false);
  assert.throws(() => controller.createSubmitIntent(), /cannot be submitted/);

  controller.dispatch({
    type: "update-attachment",
    id: "asset-1",
    patch: { lifecycle: "failed", error: "Host staging failed" },
  });
  assert.equal(controller.getSnapshot().hasProcessingAssets, false);
  assert.equal(controller.getSnapshot().hasUnavailableAssets, true);
  assert.equal(controller.getSnapshot().canSubmit, false);

  controller.dispatch({
    type: "update-attachment",
    id: "asset-1",
    patch: { lifecycle: "ready", uri: "asset://asset-1" },
  });
  assert.equal(controller.getSnapshot().hasUnavailableAssets, false);
  assert.equal(controller.getSnapshot().canSubmit, true);
});

test("SubmitIntent is an immutable semantic snapshot rather than a flattened prompt", () => {
  const controller = createComposerController(
    {
      type: "fork-thread",
      key: createConversationKey("ssh:host", "thread-a"),
      fromTurnId: asTurnId("turn-9"),
    },
    services(),
  );
  controller.dispatch({ type: "set-document", document: richDocument });
  controller.dispatch({
    type: "set-selections",
    patch: { model: "gpt-5.6", effort: "high" },
  });
  const intent = controller.createSubmitIntent();

  assert.equal(intent.target.type, "fork-thread");
  assert.equal(intent.document.blocks[0]?.type, "paragraph");
  const firstParagraph = intent.document.blocks[0];
  assert.equal(
    firstParagraph?.type === "paragraph"
      ? firstParagraph.children[1]?.type
      : null,
    "mention",
  );
  assert.deepEqual(intent.selections, { model: "gpt-5.6", effort: "high" });

  controller.dispatch({ type: "clear" });
  assert.equal(intent.document, richDocument);
  assert.equal(
    composerDocumentToPlainText(intent.document),
    "Review @runtime.ts with review skill",
  );
});

test("legacy blocks migrate into the portable document without losing resource identity", () => {
  const projected = legacyContentBlocksToComposer([
    { type: "text", text: "Open " },
    { type: "mention", id: "m-1", label: "app.tsx" },
    { type: "resource", id: "r-1", title: "repo", uri: "file:///repo" },
    {
      type: "attachment",
      id: "a-1",
      name: "log.txt",
      mimeType: "text/plain",
      size: 12,
      uri: "asset://a-1",
    },
  ]);
  const paragraph = projected.document.blocks[0];
  assert.equal(
    paragraph?.type === "paragraph" ? paragraph.children[1]?.type : null,
    "mention",
  );
  assert.deepEqual(projected.context[0], {
    id: "r-1",
    kind: "resource",
    title: "repo",
    uri: "file:///repo",
    visible: true,
  });
  assert.equal(projected.attachments[0]?.id, "a-1");
});

test("all Composer targets are serializable without weakening Host identity", () => {
  const target: ComposerTarget = {
    type: "new-thread",
    draftId: "draft-new-thread",
    execution: {
      hostId: asHostId("durable"),
      workspace: { cwd: null, runtimeWorkspaceRoots: ["/workspace"] },
    },
  };
  const controller = createComposerController(target, services());
  assert.equal(controller.getSnapshot().draft.target, target);
});

test("the primary Composer action changes from Stop to Queue or Steer when a follow-up becomes sendable", () => {
  assert.equal(
    resolveComposerPrimaryAction({
      isResponseInProgress: true,
      canSubmit: false,
      defaultFollowUpAction: "queue",
    }),
    "stop",
  );
  assert.equal(
    resolveComposerPrimaryAction({
      isResponseInProgress: true,
      canSubmit: true,
      defaultFollowUpAction: "queue",
    }),
    "queue",
  );
  assert.equal(
    resolveComposerPrimaryAction({
      isResponseInProgress: true,
      canSubmit: true,
      defaultFollowUpAction: "steer",
    }),
    "steer",
  );
  assert.equal(
    resolveComposerPrimaryAction({
      isResponseInProgress: false,
      canSubmit: true,
      defaultFollowUpAction: "queue",
    }),
    "send",
  );
});

test("follow-up preferences cannot enable a denied queue operation", () => {
  assert.equal(resolveComposerFollowUpAction("queue", ["steer"]), "steer");
  assert.equal(resolveComposerFollowUpAction("steer", ["queue"]), "queue");
  assert.equal(resolveComposerFollowUpAction("queue", []), null);
  assert.equal(resolveComposerPrimaryAction({ isResponseInProgress: true, canSubmit: true,
    defaultFollowUpAction: "queue", availableFollowUpActions: ["steer"] }), "steer");
  assert.equal(resolveComposerPrimaryAction({ isResponseInProgress: true, canSubmit: true,
    defaultFollowUpAction: "steer", availableFollowUpActions: [] }), "stop");
});

test("the inverse follow-up shortcut changes one immutable intent without changing its draft target", () => {
  const controller = createComposerController(existing("thread-a"), services());
  controller.dispatch({ type: "set-document", document: richDocument });
  const original = controller.createSubmitIntent();
  const key = createConversationKey("local", "thread-a");
  const turnId = asTurnId("turn-active");

  const queued = retargetSubmitIntentForFollowUp(
    original,
    key,
    turnId,
    "queue",
  );
  const steered = retargetSubmitIntentForFollowUp(
    original,
    key,
    turnId,
    invertComposerFollowUpAction("queue"),
  );

  assert.deepEqual(queued.target, { type: "enqueue-follow-up", key });
  assert.deepEqual(steered.target, { type: "steer-active-turn", key, turnId });
  assert.equal(original.target.type, "existing-thread");
  assert.equal(controller.getSnapshot().draft.target.type, "existing-thread");
});

test("platform shells can delegate type-to-compose and focus without owning editor state", () => {
  const controller = createComposerController(existing("thread-a"), services());
  const calls: string[] = [];
  const transient = {
    update: (text: string) => calls.push(`preview:${text}`),
    commit: (text: string) => { calls.push(`commit:${text}`); return true; },
    cancel: () => calls.push("cancel-preview"),
  };
  const unregister = controller.registerView({
    focus: () => calls.push("focus"),
    blur: () => calls.push("blur"),
    insertText: (text) => calls.push(`insert:${text}`),
    beginTransientTextInput: () => {
      calls.push("begin-preview");
      return transient;
    },
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  });

  controller.insertText("你");
  const session = controller.beginTransientTextInput();
  session?.update("你好");
  session?.commit("你好");
  controller.focus();
  unregister();
  controller.insertText("ignored");
  assert.equal(controller.beginTransientTextInput(), null);

  assert.deepEqual(calls, [
    "insert:你",
    "begin-preview",
    "preview:你好",
    "commit:你好",
    "focus",
  ]);
});

test("provisional voice text is sendable and submission atomically commits it", () => {
  const controller = createComposerController(existing("thread-a"), services());
  const finalizations: string[] = [];
  let continuationReady = 0;
  let nextSpeech: ReturnType<typeof controller.beginTransientTextInput> = null;
  controller.registerView({
    focus() {},
    blur() {},
    insertText() {},
    beginTransientTextInput: () => ({
      update() {},
      commit(text) {
        controller.dispatch({
          type: "set-document",
          document: legacyContentBlocksToComposer([
            { type: "text", text },
          ]).document,
        });
        return true;
      },
      cancel() {},
    }),
    undo() {},
    redo() {},
  });

  const speech = controller.beginTransientTextInput({
    finalized: ({ mode, cause }) => finalizations.push(`${mode}:${cause}`),
    readyForNextInput: () => {
      continuationReady += 1;
      nextSpeech = controller.beginTransientTextInput();
    },
  });
  assert.ok(speech);
  assert.equal(controller.getSnapshot().canSubmit, false);

  speech.update("正在语音输入");
  assert.equal(controller.getSnapshot().hasTransientText, true);
  assert.equal(controller.getSnapshot().canSubmit, true);

  const intent = controller.createSubmitIntent();
  assert.equal(
    composerDocumentToPlainText(intent.document),
    "正在语音输入",
  );
  assert.equal(controller.getSnapshot().hasTransientText, false);
  assert.deepEqual(finalizations, ["commit:submission"]);
  assert.equal(continuationReady, 0);

  controller.dispatch({ type: "clear" });
  assert.equal(continuationReady, 0);
  controller.settleTransientTextContinuation();
  assert.equal(continuationReady, 1);

  // The consumed segment cannot repopulate the cleared draft.
  speech.update("不应复活");
  assert.equal(
    composerDocumentToPlainText(controller.getSnapshot().draft.document),
    "",
  );
  assert.ok(nextSpeech);
  nextSpeech.update("下一条语音");
  assert.equal(controller.getSnapshot().canSubmit, true);
});

test("selection quotes cannot mutate a submitting, transient or detached composer", () => {
  const controller = createComposerController(existing("thread-a"), services());
  let inserted = 0;
  assert.equal(controller.appendQuote("selected"), false);
  const unregister = controller.registerView({
    focus() {}, blur() {}, insertText() {}, undo() {}, redo() {},
    appendQuote() { inserted++; return true; },
    beginTransientTextInput: () => ({ update() {}, commit() { return true; }, cancel() {} }),
  });
  assert.equal(controller.appendQuote("  "), false);
  controller.dispatch({ type: "set-lifecycle", phase: "submitting" });
  assert.equal(controller.appendQuote("selected"), false);
  controller.dispatch({ type: "set-lifecycle", phase: "editing" });
  const input = controller.beginTransientTextInput();
  assert.equal(controller.appendQuote("selected"), false);
  input?.cancel();
  assert.equal(controller.appendQuote("selected"), true);
  assert.equal(inserted, 1);
  unregister();
  assert.equal(controller.appendQuote("selected"), false);
  controller.dispose();
  assert.equal(controller.appendQuote("selected"), false);
});
