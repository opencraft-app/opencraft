import test from "node:test";
import assert from "node:assert/strict";
import { MemoryExtensionPersistence } from "@opencraft/extension-runtime";
import { createScopedExtensionStorage } from "../../packages/extension-runtime/src/scoped-storage";
import {
  createComposerController,
  createEmptyComposerDocument,
  type ComposerSavedContent,
} from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { openChannelDraftStorage } from "../../plugins/im/src/channel-draft-storage";

const target = { type: "existing-thread" as const, key: createConversationKey("channels", "group:one") };
const content: ComposerSavedContent = {
  document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "keep my work" }] }] },
  attachments: [],
  context: [],
};
function fixture() {
  const backend = new MemoryExtensionPersistence();
  const local = createScopedExtensionStorage(backend, "opencraft.im", () => true);
  const open = (scope = "server:one/actor:alice", channel = "group:one", signal = new AbortController().signal) =>
    openChannelDraftStorage(local.api, scope, channel, signal, "Choose this file again");
  return { open, local };
}
test("channel composer restores saved content after a new controller, never across account/server/channel scope", async () => {
  const f = fixture(),
    store = await f.open();
  const controller = createComposerController(target, {
    now: Date.now,
    createId: () => crypto.randomUUID(),
    drafts: store.storage,
  });
  controller.dispatch({ type: "set-document", document: content.document });
  await store.flush();
  controller.dispose();
  const reopened = await f.open();
  assert.deepEqual(reopened.storage.read(target), content);
  for (const [scope, channel] of [
    ["server:one/actor:bob", "group:one"],
    ["server:two/actor:alice", "group:one"],
    ["server:one/actor:alice", "group:two"],
  ])
    assert.equal((await f.open(scope, channel)).storage.read(target), null);
  await f.local.dispose();
});
test("pending submission identity and quote survive reopen; accepted clear atomically retires text identity", async () => {
  const f = fixture(),
    s = await f.open();
  await s.storage.write(target, content);
  const attempt = {
    id: "original",
    payload: JSON.stringify(["text", "keep my work", {}]),
    document: JSON.stringify(content.document),
  };
  await s.setAttempt(attempt);
  await s.setReply({ messageId: "quote", author: "Alice", text: "quote" });
  const restored = await f.open();
  assert.deepEqual(restored.attempt, attempt);
  assert.equal(restored.reply?.messageId, "quote");
  await restored.storage.write(target, { ...content, document: createEmptyComposerDocument() });
  const final = await f.open();
  assert.equal(final.attempt, undefined);
  assert.deepEqual((await final.storage.read(target))?.document, createEmptyComposerDocument());
  await f.local.dispose();
});
test("attachment recovery preserves a visible unavailable item, never a stale blob or ready bytes", async () => {
  const f = fixture(),
    s = await f.open();
  await s.storage.write(target, {
    ...content,
    attachments: [
      {
        id: "file",
        name: "photo.png",
        mimeType: "image/png",
        size: 42,
        uri: "blob:old",
        lifecycle: "ready",
        error: null,
      },
    ],
  });
  const restored = await f.open(),
    value = await restored.storage.read(target);
  assert.equal(value?.attachments[0].uri, null);
  assert.equal(value?.attachments[0].lifecycle, "failed");
  assert.match(value!.attachments[0].error!, /Choose this file/);
  await f.local.dispose();
});
test("another window cannot silently overwrite an unread newer draft; failure remains visible through flush", async () => {
  const f = fixture(),
    first = await f.open(),
    second = await f.open();
  await first.storage.write(target, content);
  await assert.rejects(
    async () => second.storage.write(target, { ...content, document: createEmptyComposerDocument() }),
    /another window/,
  );
  await assert.rejects(second.flush(), /another window/);
  assert.deepEqual((await f.open()).storage.read(target), content);
  await f.local.dispose();
});
test("revoked activation does not write after cancellation", async () => {
  const f = fixture(),
    owner = new AbortController(),
    s = await f.open(undefined, undefined, owner.signal);
  owner.abort();
  await assert.rejects(async () => s.storage.write(target, content));
  assert.equal((await f.open()).storage.read(target), null);
  await f.local.dispose();
});

test("accepted first attachment and caption cannot resurrect when a later attachment is interrupted", async () => {
  const f = fixture(),
    s = await f.open();
  const file = (id: string) => ({
    id,
    name: id,
    mimeType: "text/plain",
    size: 1,
    uri: "blob:" + id,
    lifecycle: "ready" as const,
    error: null,
  });
  const original = { ...content, attachments: [file("first"), file("second")] };
  await s.storage.write(target, original);
  await s.setAttempt({
    id: "file:first",
    payload: "first",
    document: JSON.stringify(content.document),
    attachmentId: "first",
    documentAccepted: true,
  });
  await s.acceptAttachment("first", JSON.stringify(content.document));
  // An in-flight controller may still hold its captured original content.
  await s.storage.write(target, original);
  await s.setAttempt({
    id: "file:second",
    payload: "second",
    document: JSON.stringify(content.document),
    attachmentId: "second",
  });
  const next = await f.open(),
    restored = await next.storage.read(target);
  assert.deepEqual(
    restored?.attachments.map((a) => a.id),
    ["second"],
  );
  assert.deepEqual(restored?.document, createEmptyComposerDocument());
  assert.equal(next.attempt?.id, "file:second");
  await f.local.dispose();
});
