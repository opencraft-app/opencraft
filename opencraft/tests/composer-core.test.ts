import assert from "node:assert/strict";
import test from "node:test";

import { asHostId, asTurnId, createConversationKey } from "@opencraft/chat-core";
import {
  composerDocumentToPlainText,
  createComposerController,
  invertComposerFollowUpAction,
  legacyContentBlocksToComposer,
  resolveComposerPrimaryAction,
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
  assert.equal(controller.getSnapshot().canSubmit, false);
  assert.throws(() => controller.createSubmitIntent(), /cannot be submitted/);

  controller.dispatch({
    type: "update-attachment",
    id: "asset-1",
    patch: { lifecycle: "ready", uri: "asset://asset-1" },
  });
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
    commit: (text: string) => calls.push(`commit:${text}`),
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
