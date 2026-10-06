import assert from "node:assert/strict";
import test from "node:test";

import { createConversationKey } from "@opencraft/chat-core";
import { createComposerController, type ComposerAttachment } from "@opencraft/composer-core";
const nativeSession = await import("../apps/workbench-expo/src/runtime/native-attachment-session.ts");
const { nativeAttachmentSession } = nativeSession.default ?? nativeSession;

function createController() {
  let id = 0;
  return createComposerController({ type: "existing-thread", key: createConversationKey("local", "native-assets") }, {
    now: Date.now,
    createId: () => `draft-${++id}`,
  });
}

const source = { uri: "file:///cache/notes.txt", name: "notes.txt", mimeType: "text/plain", size: 5 };
const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));

test("native attachment failure retries the same selected file across input remount", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  const released: ComposerAttachment[] = [];
  let attempts = 0;
  let failures = 0;
  session.add(source, async (selected, pending) => {
    assert.equal(selected, source);
    attempts += 1;
    if (attempts === 1) throw new Error("private Host detail");
    return { ...pending, lifecycle: "ready", uri: "file:///host/notes.txt", error: null };
  }, async attachment => { released.push(attachment); }, () => { failures += 1; });
  await nextTick();
  const { draft } = composer.getSnapshot();
  const attachment = draft.attachments[0]!;
  assert.equal(attachment.lifecycle, "failed");
  assert.equal(attachment.error, "Attachment failed");
  assert.equal(failures, 1);
  assert.equal(nativeAttachmentSession(composer), session);
  assert.equal(session.canRetry(draft.id, attachment.id), true);
  assert.equal(session.retry(draft.id, attachment.id), true);
  await nextTick();
  assert.equal(composer.getSnapshot().draft.attachments[0]?.lifecycle, "ready");
  assert.equal(attempts, 2);
  session.remove(draft.id, attachment.id);
  assert.equal(composer.getSnapshot().draft.attachments.length, 0);
  assert.equal(released.length, 1);
  composer.dispose();
});

test("multiple native files stage one at a time while retaining their Draft entries", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  let finishFirst!: (value: ComposerAttachment) => void;
  const firstResult = new Promise<ComposerAttachment>(resolve => { finishFirst = resolve; });
  const started: string[] = [];
  session.add(source, (_selected, pending) => {
    started.push("first");
    return firstResult;
  }, async () => undefined, () => undefined);
  session.add({ ...source, name: "second.txt" }, async (_selected, pending) => {
    started.push("second");
    return { ...pending, lifecycle: "ready", uri: "file:///host/second.txt", error: null };
  }, async () => undefined, () => undefined);
  await Promise.resolve();
  assert.deepEqual(started, ["first"]);
  const first = composer.getSnapshot().draft.attachments[0]!;
  assert.deepEqual(composer.getSnapshot().draft.attachments.map(attachment => attachment.lifecycle), ["uploading", "pending"]);
  finishFirst({ ...first, lifecycle: "ready", uri: "file:///host/notes.txt", error: null });
  await nextTick();
  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual(composer.getSnapshot().draft.attachments.map(attachment => attachment.lifecycle), ["ready", "ready"]);
  composer.dispose();
});

test("removing a queued file prevents its resolver from starting", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  let finishFirst!: (value: ComposerAttachment) => void;
  const firstResult = new Promise<ComposerAttachment>(resolve => { finishFirst = resolve; });
  session.add(source, () => firstResult, async () => undefined, () => undefined);
  let secondCalls = 0;
  session.add({ ...source, name: "second.txt" }, async (_selected, pending) => {
    secondCalls += 1;
    return { ...pending, lifecycle: "ready", uri: "file:///host/second.txt" };
  }, async () => undefined, () => undefined);
  const draft = composer.getSnapshot().draft;
  session.remove(draft.id, draft.attachments[1]!.id);
  finishFirst({ ...draft.attachments[0]!, lifecycle: "ready", uri: "file:///host/notes.txt" });
  await nextTick();
  assert.equal(secondCalls, 0);
  assert.equal(composer.getSnapshot().draft.attachments.length, 1);
  composer.dispose();
});

test("a canceled in-flight file releases its late Host ref before the next file starts", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  const released: ComposerAttachment[] = [];
  let finishFirst!: (value: ComposerAttachment) => void;
  const firstResult = new Promise<ComposerAttachment>(resolve => { finishFirst = resolve; });
  let firstSignal: AbortSignal | undefined;
  session.add(source, (_selected, _pending, signal) => {
    firstSignal = signal;
    return firstResult;
  }, async attachment => { released.push(attachment); }, () => undefined);
  let secondCalls = 0;
  session.add({ ...source, name: "second.txt" }, async (_selected, pending) => {
    secondCalls += 1;
    return { ...pending, lifecycle: "ready", uri: "file:///host/second.txt" };
  }, async () => undefined, () => undefined);
  await Promise.resolve();
  const draft = composer.getSnapshot().draft;
  session.remove(draft.id, draft.attachments[0]!.id);
  assert.equal(firstSignal?.aborted, true);
  assert.equal(secondCalls, 0);
  finishFirst({ ...draft.attachments[0]!, lifecycle: "ready", uri: "file:///host/notes.txt" });
  await nextTick();
  assert.deepEqual(released.map(attachment => attachment.uri), ["file:///host/notes.txt"]);
  assert.equal(secondCalls, 1);
  assert.equal(composer.getSnapshot().draft.attachments[0]?.uri, "file:///host/second.txt");
  composer.dispose();
});

test("removing a pending native file aborts the task and releases a late Host result", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  const released: ComposerAttachment[] = [];
  let complete!: (value: ComposerAttachment) => void;
  let signal: AbortSignal | undefined;
  const result = new Promise<ComposerAttachment>(resolve => { complete = resolve; });
  session.add(source, (_selected, _pending, jobSignal) => {
    signal = jobSignal;
    return result;
  }, async attachment => { released.push(attachment); }, () => undefined);
  await Promise.resolve();
  const { draft } = composer.getSnapshot();
  const pending = draft.attachments[0]!;
  session.remove(draft.id, pending.id);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(released, []);
  complete({ ...pending, lifecycle: "ready", uri: "file:///host/notes.txt" });
  await nextTick();
  assert.equal(composer.getSnapshot().draft.attachments.length, 0);
  assert.equal(released.some(attachment => attachment.uri === "file:///host/notes.txt"), true);
  composer.dispose();
});

test("discarding a Draft releases its staged Host file", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  const released: ComposerAttachment[] = [];
  session.add(source, async (_selected, pending) => ({
    ...pending, lifecycle: "ready", uri: "file:///host/notes.txt", error: null,
  }), async attachment => { released.push(attachment); }, () => undefined);
  await nextTick();
  composer.dispatch({ type: "clear" });
  assert.equal(released.length, 1);
  assert.equal(released[0]?.uri, "file:///host/notes.txt");
  composer.dispose();
});

test("an accepted submission keeps its staged file for the conversation", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  const released: ComposerAttachment[] = [];
  session.add(source, async (_selected, pending) => ({
    ...pending, lifecycle: "ready", uri: "file:///host/notes.txt", error: null,
  }), async attachment => { released.push(attachment); }, () => undefined);
  await nextTick();
  composer.dispatch({ type: "set-document", document: { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Read this file" }] },
  ] } });
  const draftId = composer.getSnapshot().draft.id;
  const intent = composer.createSubmitIntent();
  composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
  assert.equal(composer.settleSubmission(draftId, intent, { status: "accepted" }), true);
  assert.equal(composer.getSnapshot().draft.attachments.length, 0);
  assert.equal(released.length, 0);
  composer.dispose();
  assert.equal(released.length, 0);
});

test("disposing during a send does not delete its Host file before acceptance", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  const released: ComposerAttachment[] = [];
  session.add(source, async (_selected, pending) => ({
    ...pending, lifecycle: "ready", uri: "file:///host/notes.txt", error: null,
  }), async attachment => { released.push(attachment); }, () => undefined);
  await nextTick();
  const draftId = composer.getSnapshot().draft.id;
  composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
  composer.dispose();
  assert.equal(released.length, 0);
  session.settleSubmission(draftId, "accepted");
  assert.equal(released.length, 0);
});

test("disposing during a failed send releases its Host file after settlement once", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  const released: ComposerAttachment[] = [];
  session.add(source, async (_selected, pending) => ({
    ...pending, lifecycle: "ready", uri: "file:///host/notes.txt", error: null,
  }), async attachment => { released.push(attachment); }, () => undefined);
  await nextTick();
  const draftId = composer.getSnapshot().draft.id;
  composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
  composer.dispose();
  assert.equal(released.length, 0);
  session.settleSubmission(draftId, "failed");
  session.settleSubmission(draftId, "failed");
  assert.equal(released.length, 1);
  assert.equal(released[0]?.uri, "file:///host/notes.txt");
});

test("a native file settles into its initiating Draft after target navigation", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  let complete!: (value: ComposerAttachment) => void;
  const result = new Promise<ComposerAttachment>(resolve => { complete = resolve; });
  session.add(source, () => result, async () => undefined, () => undefined);
  await Promise.resolve();
  const origin = composer.getSnapshot().draft;
  composer.dispatch({ type: "switch-target", target: {
    type: "existing-thread", key: createConversationKey("local", "other-native-assets"),
  } });
  assert.equal(composer.getSnapshot().draft.attachments.length, 0);
  complete({ ...origin.attachments[0]!, lifecycle: "ready", uri: "file:///host/notes.txt", error: null });
  await nextTick();
  composer.dispatch({ type: "switch-target", target: origin.target });
  assert.equal(composer.getSnapshot().draft.attachments[0]?.lifecycle, "ready");
  assert.equal(composer.getSnapshot().draft.attachments[0]?.uri, "file:///host/notes.txt");
  composer.dispose();
});

test("resetting cached Drafts releases a file staged after navigating away", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  const released: ComposerAttachment[] = [];
  let complete!: (value: ComposerAttachment) => void;
  const result = new Promise<ComposerAttachment>(resolve => { complete = resolve; });
  session.add(source, () => result, async attachment => { released.push(attachment); }, () => undefined);
  await Promise.resolve();
  const origin = composer.getSnapshot().draft;
  composer.dispatch({ type: "switch-target", target: {
    type: "existing-thread", key: createConversationKey("local", "other-cached-assets"),
  } });
  complete({ ...origin.attachments[0]!, lifecycle: "ready", uri: "file:///host/notes.txt", error: null });
  await nextTick();
  assert.equal(composer.getDraftAttachment(origin.id, origin.attachments[0]!.id)?.lifecycle, "ready");
  composer.dispatch({ type: "reset-all" });
  assert.equal(released.length, 1);
  assert.equal(released[0]?.uri, "file:///host/notes.txt");
  composer.dispose();
});

test("resetting a failed cached submission releases its staged file", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  const released: ComposerAttachment[] = [];
  session.add(source, async (_selected, pending) => ({
    ...pending, lifecycle: "ready", uri: "file:///host/notes.txt", error: null,
  }), async attachment => { released.push(attachment); }, () => undefined);
  await nextTick();
  composer.dispatch({ type: "set-document", document: { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Read this file" }] },
  ] } });
  const origin = composer.getSnapshot().draft;
  const intent = composer.createSubmitIntent();
  composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
  composer.dispatch({ type: "switch-target", target: {
    type: "existing-thread", key: createConversationKey("local", "other-failed-assets"),
  } });
  assert.equal(composer.settleSubmission(origin.id, intent, { status: "failed", error: "send failed" }), true);
  composer.dispatch({ type: "reset-all" });
  assert.equal(released.length, 1);
  composer.dispose();
});

test("an accepted cached submission retains its file for the conversation", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  const released: ComposerAttachment[] = [];
  session.add(source, async (_selected, pending) => ({
    ...pending, lifecycle: "ready", uri: "file:///host/notes.txt", error: null,
  }), async attachment => { released.push(attachment); }, () => undefined);
  await nextTick();
  composer.dispatch({ type: "set-document", document: { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Read this file" }] },
  ] } });
  const origin = composer.getSnapshot().draft;
  const intent = composer.createSubmitIntent();
  composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
  composer.dispatch({ type: "switch-target", target: {
    type: "existing-thread", key: createConversationKey("local", "other-accepted-assets"),
  } });
  assert.equal(composer.settleSubmission(origin.id, intent, { status: "accepted" }), true);
  composer.dispatch({ type: "reset-all" });
  composer.dispose();
  assert.equal(released.length, 0);
});

test("removing a restored attachment releases its Host ref without a picker entry", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  const attachment: ComposerAttachment = {
    id: "restored-file",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
    uri: "file:///host/notes.txt",
    lifecycle: "ready",
    error: null,
  };
  composer.dispatch({ type: "add-attachment", attachment });
  const released: ComposerAttachment[] = [];
  session.remove(composer.getSnapshot().draft.id, attachment.id, async value => { released.push(value); });
  assert.deepEqual(released, [attachment]);
  assert.equal(composer.getSnapshot().draft.attachments.length, 0);
  composer.dispose();
});

test("native image preview stays with its Draft and disappears on removal", async () => {
  const composer = createController();
  const session = nativeAttachmentSession(composer);
  const photo = { uri: "file:///cache/photo.heic", name: "photo.heic", mimeType: "image/heic", size: 10 };
  session.add(photo, async (_source, pending) => ({ ...pending, lifecycle: "ready", uri: "data:image/jpeg;base64,AA==" }),
    async () => undefined, () => undefined);
  const origin = composer.getSnapshot().draft;
  const attachmentId = origin.attachments[0]!.id;
  assert.equal(session.previewUri(origin.id, attachmentId), photo.uri);
  composer.dispatch({ type: "switch-target", target: {
    type: "existing-thread", key: createConversationKey("local", "another-photo-draft"),
  } });
  assert.equal(session.previewUri(composer.getSnapshot().draft.id, attachmentId), null);
  composer.dispatch({ type: "switch-target", target: origin.target });
  await nextTick();
  assert.equal(session.previewUri(origin.id, attachmentId), photo.uri);
  session.remove(origin.id, attachmentId);
  assert.equal(session.previewUri(origin.id, attachmentId), null);
  composer.dispose();
});
