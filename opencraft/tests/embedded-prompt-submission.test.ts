import assert from "node:assert/strict";
import test from "node:test";
import { createComposerController } from "@opencraft/composer-core";
import { submitEmbeddedPrompt } from "../apps/workbench-web/src/embedded-chat/embedded-prompt-submission";

function fixture() {
  let next = 0;
  const composer = createComposerController({ type: "new-thread", draftId: "workbench-draft", execution: { hostId: "bot-a", workspace: { cwd: null, runtimeWorkspaceRoots: [] } } }, { now: () => 1, createId: () => `id-${++next}` });
  return composer;
}
test("cold connection waits without consuming text, then admits exactly one immutable submission", () => {
  const composer = fixture();
  const intents: unknown[] = [];
  const submit = (intent: unknown) => { intents.push(intent); return true; };
  assert.equal(submitEmbeddedPrompt(composer, "bot-a", false, "template", submit), false);
  assert.equal(composer.getSnapshot().hasContent, false);
  assert.equal(intents.length, 0);
  assert.equal(submitEmbeddedPrompt(composer, "bot-a", true, "template", submit), true);
  assert.equal(intents.length, 1);
  assert.equal(composer.getSnapshot().hasContent, false);
  assert.deepEqual((intents[0] as { document: unknown }).document, { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "template" }] }] });
});
test("failed admission retains the document; another Bot or user's draft is never overwritten", () => {
  const composer = fixture();
  assert.equal(submitEmbeddedPrompt(composer, "bot-b", true, "template", () => { throw new Error("wrong Bot"); }), false);
  assert.throws(() => submitEmbeddedPrompt(composer, "bot-a", true, "template", () => { throw new Error("not admitted"); }), /not admitted/);
  assert.equal(composer.getSnapshot().hasContent, true);
  assert.equal(submitEmbeddedPrompt(composer, "bot-a", true, "replacement", () => { throw new Error("must preserve draft"); }), false);
  assert.equal(composer.createSubmitIntent().document.blocks[0]?.type, "paragraph");
});
