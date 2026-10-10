import assert from "node:assert/strict";
import test from "node:test";

import { createConversationKey } from "@opencraft/chat-core";
import { createComposerController, type ComposerAttachment } from "@opencraft/composer-core";
import { attachmentPreviewSession } from "../packages/codex-composer/src/attachment-preview-session";

function createController() {
  let id = 0;
  return createComposerController({ type: "existing-thread", key: createConversationKey("local", "photos") }, {
    now: Date.now,
    createId: () => `draft-${++id}`,
  });
}

test("image preview remains owned by the cached Draft across View remount and target switch", async () => {
  const composer = createController();
  const session = attachmentPreviewSession(composer);
  const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });
  let complete!: (attachment: ComposerAttachment) => void;
  const resolution = new Promise<ComposerAttachment>(resolve => { complete = resolve; });
  session.addFiles([file], () => resolution);
  const draftId = composer.getSnapshot().draft.id;
  const pending = composer.getSnapshot().draft.attachments[0]!;
  assert.equal(pending.lifecycle, "processing");
  assert.match(session.previewUrl(draftId, pending.id) ?? "", /^blob:/u);
  assert.equal(attachmentPreviewSession(composer), session);

  composer.dispatch({ type: "switch-target", target: { type: "existing-thread", key: createConversationKey("local", "other") } });
  complete({ ...pending, lifecycle: "ready", uri: "data:image/png;base64,AQID" });
  await new Promise(resolve => setImmediate(resolve));
  composer.dispatch({ type: "switch-target", target: { type: "existing-thread", key: createConversationKey("local", "photos") } });
  assert.equal(composer.getSnapshot().draft.attachments[0]?.lifecycle, "ready");
  assert.match(session.previewUrl(draftId, pending.id) ?? "", /^blob:/u);

  composer.dispatch({ type: "clear" });
  assert.equal(session.previewUrl(draftId, pending.id), null);
  composer.dispose();
});

test("removing an in-flight image aborts its job and late completion cannot restore it", async () => {
  const composer = createController();
  const session = attachmentPreviewSession(composer);
  let signal: AbortSignal | undefined;
  let complete!: (attachment: ComposerAttachment) => void;
  const resolution = new Promise<ComposerAttachment>(resolve => { complete = resolve; });
  session.addFiles([new File(["photo"], "photo.png", { type: "image/png" })], (_file, _pending, jobSignal) => {
    signal = jobSignal;
    return resolution;
  });
  await Promise.resolve();
  const { draft } = composer.getSnapshot();
  const attachment = draft.attachments[0]!;
  session.remove(draft.id, attachment.id);
  composer.dispatch({ type: "remove-attachment", id: attachment.id });
  assert.equal(signal?.aborted, true);
  complete({ ...attachment, lifecycle: "ready", uri: "data:image/png;base64,AQID" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(composer.getSnapshot().draft.attachments.length, 0);
  assert.equal(session.previewUrl(draft.id, attachment.id), null);
  composer.dispose();
});

test("a failed image remains visible and retries from the same selected File", async () => {
  const composer = createController();
  const session = attachmentPreviewSession(composer);
  const file = new File(["photo"], "retry.png", { type: "image/png" });
  session.addFiles([file], async () => { throw new Error("Image preparation failed"); });
  await new Promise(resolve => setImmediate(resolve));
  const { draft } = composer.getSnapshot();
  const attachment = draft.attachments[0]!;
  assert.equal(attachment.lifecycle, "failed");
  assert.equal(session.canRetry(draft.id, attachment.id), true);
  assert.match(session.previewUrl(draft.id, attachment.id) ?? "", /^blob:/u);
  assert.equal(session.retry(draft.id, attachment.id, async (selected, pending) => {
    assert.equal(selected, file);
    return { ...pending, lifecycle: "ready", uri: "data:image/png;base64,AQID", error: null };
  }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(composer.getSnapshot().draft.attachments[0]?.lifecycle, "ready");
  composer.dispose();
  assert.equal(session.previewUrl(draft.id, attachment.id), null);
});

test("ordinary file stays in its Draft, blocks sending until staged, and retries without reselection", async () => {
  const composer = createController();
  const session = attachmentPreviewSession(composer);
  const file = new File(["# Notes"], "notes.md", { type: "text/markdown" });
  let complete!: (attachment: ComposerAttachment) => void;
  session.addFiles([file], () => new Promise<ComposerAttachment>(resolve => { complete = resolve; }));
  const pending = composer.getSnapshot().draft.attachments[0]!;
  assert.equal(pending.lifecycle, "uploading");
  assert.equal(composer.getSnapshot().canSubmit, false);
  await Promise.resolve();
  complete({ ...pending, uri: "file:///host/attachments/notes.md", lifecycle: "ready" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(composer.getSnapshot().canSubmit, true);
  assert.equal(composer.getSnapshot().draft.attachments[0]?.uri, "file:///host/attachments/notes.md");
  composer.dispose();
});

test("a HEIC filename without browser MIME still enters image preparation with a preview", async () => {
  const composer = createController();
  const session = attachmentPreviewSession(composer);
  const file = new File(["camera photo"], "IMG_0001.HEIC");
  session.addFiles([file], () => new Promise<ComposerAttachment>(() => undefined));
  const { draft } = composer.getSnapshot();
  const attachment = draft.attachments[0]!;
  assert.equal(attachment.mimeType, "image/heic");
  assert.equal(attachment.lifecycle, "processing");
  assert.match(session.previewUrl(draft.id, attachment.id) ?? "", /^blob:/u);
  composer.dispose();
});

test("refused content admission releases the unowned image preview without starting a resolver", async (context) => {
  const base = createController();
  const composer = { ...base, dispatch() { throw new Error("content admission refused"); } };
  const session = attachmentPreviewSession(composer);
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  let preview = "";
  const revoked: string[] = [];
  context.mock.method(URL, "createObjectURL", (file: Blob) => { preview = createUrl(file); return preview; });
  context.mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url); revokeUrl(url); });
  let resolutions = 0;
  assert.throws(() => session.addFiles([new File(["image"], "photo.png", { type: "image/png" })], async (_, pending) => {
    resolutions++;
    return { ...pending, lifecycle: "ready", uri: "data:image/png;base64,aW1hZ2U=" };
  }), /content admission refused/u);
  assert.equal(base.getSnapshot().draft.attachments.length, 0);
  assert.deepEqual(revoked, [preview]);
  await Promise.resolve();
  assert.equal(resolutions, 0);
  await assert.rejects(fetch(preview));
  base.dispose();
});
