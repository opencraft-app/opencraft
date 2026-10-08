import assert from "node:assert/strict";
import test from "node:test";
import { createConversationKey } from "@opencraft/chat-core";
import { createComposerController, composerDocumentToPlainText, type ComposerDocument, type ComposerTarget } from "@opencraft/composer-core";
import { BrowserComposerDrafts } from "../apps/workbench-web/src/runtime/browser-composer-drafts";

class Storage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const document = (text: string): ComposerDocument => ({ version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text }] }] });
const target = (threadId = "room", hostId = "local"): ComposerTarget => ({ type: "existing-thread", key: createConversationKey(hostId, threadId) });
let id = 0;
const services = (drafts: BrowserComposerDrafts) => ({ drafts, now: Date.now, createId: () => `draft-${++id}` });

test("task and Bot controllers restore locally after disposal; lifecycle does not restore", () => {
  for (const namespace of ["task", "bot"]) {
    const storage = new Storage(); const drafts = new BrowserComposerDrafts(storage, namespace);
    const first = createComposerController(target(), services(drafts));
    const rich: ComposerDocument = { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "draft " }, { type: "mention", id: "f", label: "file.md", mentionKind: "file", uri: "/data/file.md" }] }] };
    first.dispatch({ type: "set-document", document: rich });
    first.dispatch({ type: "set-lifecycle", phase: "submitting" }); first.dispose();
    const second = createComposerController(target(), services(drafts));
    assert.deepEqual(second.getSnapshot().draft.document, rich);
    assert.equal(second.getSnapshot().draft.lifecycle.phase, "editing");
    assert.equal(second.getSnapshot().canSubmit, true);
    second.dispatch({ type: "set-lifecycle", phase: "failed", error: "failed admission" });
    assert.deepEqual(createComposerController(target(), services(drafts)).getSnapshot().draft.document, rich);
    second.dispatch({ type: "clear" });
    assert.equal(createComposerController(target(), services(drafts)).getSnapshot().hasContent, false);
    assert.equal(storage.values.size, 0);
  }
});
test("Host, conversation and task/Bot namespaces isolate drafts; switching back preserves content", () => {
  const storage = new Storage(); const drafts = new BrowserComposerDrafts(storage, "task");
  const first = createComposerController(target(), services(drafts));
  first.dispatch({ type: "set-document", document: document("one") });
  first.dispatch({ type: "switch-target", target: target("two") });
  first.dispatch({ type: "set-document", document: document("two") });
  first.dispatch({ type: "switch-target", target: target() });
  assert.equal(composerDocumentToPlainText(first.getSnapshot().draft.document), "one");
  assert.equal(createComposerController(target("room", "ssh"), services(drafts)).getSnapshot().hasContent, false);
  assert.equal(createComposerController(target(), services(new BrowserComposerDrafts(storage, "bot"))).getSnapshot().hasContent, false);
});
test("fresh surface without edits cannot erase newer stored content through status or disposal", () => {
  const drafts = new BrowserComposerDrafts(new Storage(), "task");
  const old = createComposerController(target(), services(drafts));
  const current = createComposerController(target(), services(drafts));
  current.dispatch({ type: "set-document", document: document("latest") });
  old.dispatch({ type: "set-lifecycle", phase: "editing" }); old.dispose();
  assert.equal(composerDocumentToPlainText(createComposerController(target(), services(drafts)).getSnapshot().draft.document), "latest");
});
test("local draft identities and workspace restore without reviving submission", () => {
  const drafts = new BrowserComposerDrafts(new Storage(), "task");
  const next: ComposerTarget = { type: "new-thread", draftId: "new-A", execution: { hostId: createConversationKey("ssh", "unused").hostId, workspace: { cwd: "/work", runtimeWorkspaceRoots: ["/work"] } } };
  const composer = createComposerController(next, services(drafts));
  composer.dispatch({ type: "set-document", document: document("new chat draft") });
  assert.equal(composerDocumentToPlainText(createComposerController(next, services(drafts)).getSnapshot().draft.document), "new chat draft");
  assert.equal(createComposerController({ ...next, draftId: "new-B" }, services(drafts)).getSnapshot().hasContent, false);
  composer.dispatch({ type: "clear" }); assert.equal(drafts.read(next), null);
});
test("expired browser files and unfinished uploads remain removable but never sendable after reload", () => {
  const drafts = new BrowserComposerDrafts(new Storage(), "bot");
  const first = createComposerController(target(), services(drafts));
  for (const [n, uri, lifecycle] of [["a", "blob:old-page", "ready"], ["b", null, "uploading"]] as const) {
    first.dispatch({ type: "add-attachment", attachment: { id: n, name: `${n}.md`, mimeType: "text/markdown", size: 11, uri, lifecycle, error: null } });
  }
  const second = createComposerController(target(), services(drafts));
  assert.equal(second.getSnapshot().draft.attachments.length, 2);
  assert.equal(second.getSnapshot().canSubmit, false);
  assert.ok(second.getSnapshot().draft.attachments.every(item => item.lifecycle === "failed" && item.uri === null));
  second.dispatch({ type: "remove-attachment", id: "a" }); second.dispatch({ type: "remove-attachment", id: "b" });
  assert.equal(createComposerController(target(), services(drafts)).getSnapshot().hasContent, false);
});
test("corrupt records and unavailable browser storage cannot crash editing", () => {
  const storage = new Storage(); const drafts = new BrowserComposerDrafts(storage, "task");
  storage.setItem('task:["existing-thread","local","room"]', '{"version":1,"content":{"document":{"version":1,"blocks":[{"type":"unknown"}]},"attachments":[],"context":[]}}');
  assert.equal(createComposerController(target(), services(drafts)).getSnapshot().hasContent, false);
  let errors = 0;
  const blocked = new BrowserComposerDrafts({ getItem() { throw Error("blocked"); }, setItem() { throw Error("quota"); }, removeItem() { throw Error("blocked"); } }, "task");
  const composer = createComposerController(target(), { ...services(blocked), onDraftStorageError: () => errors++ });
  composer.dispatch({ type: "set-document", document: document("kept in memory") });
  assert.equal(composerDocumentToPlainText(composer.getSnapshot().draft.document), "kept in memory");
  assert.equal(errors, 2);
});

test("account revocation clears only its own namespace and rejects late writes", () => {
  const storage = new Storage();
  const old = new BrowserComposerDrafts(storage, "bot.account-A");
  const other = new BrowserComposerDrafts(storage, "bot.account-B");
  const value = { document: document("private input"), attachments: [], context: [] };
  old.write(target(), value); other.write(target(), value);
  old.revokeAndClear(); old.write(target(), value);
  assert.equal(old.read(target()), null);
  assert.equal(new BrowserComposerDrafts(storage, "bot.account-A").read(target()), null);
  assert.deepEqual(other.read(target())?.document, value.document);
});
