import assert from "node:assert/strict";
import test from "node:test";
import { ChatDocumentCompiler } from "@opencraft/chat-document";
import { createConversationKey } from "@opencraft/chat-core";
import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";
import { submittedMessageDisplay } from "@opencraft/workbench-runtime";
import { createReplicaConversationRuntime, type ConversationCommandPort, type ConversationReplicaReader } from "@opencraft/chat-runtime";
import { composerDocumentToPlainText, composerDocumentToMessageText, createComposerController, type ComposerDocument, type SubmissionReceipt } from "@opencraft/composer-core";
import { compileSubmitIntent } from "@opencraft/composer-appserver";

const key = createConversationKey("fixture", "quoted-thread");
function quotedIntent(document: ComposerDocument) {
  const composer = createComposerController({ type: "existing-thread", key }, { now: () => 100, createId: () => "quoted-message" });
  composer.dispatch({ type: "set-document", document });
  return composer.createSubmitIntent();
}
const quote: ComposerDocument = { version: 1, blocks: [
  { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "ProvisionInstanceBotIM 仍为 CREATED" }] }] },
  { type: "paragraph", children: [{ type: "text", text: "这是什么东西？" }] },
] };
const parser = new ChatDocumentCompiler();

function assertQuote(source: string) {
  const nodes = parser.compile(source, { dialect: "user-message" }).nodes;
  assert.equal(nodes[0]?.kind, "blockquote", "quoted text must have a visible quote renderer");
  assert.equal(nodes[1]?.kind, "paragraph", "the user's own request stays outside the quote");
}

test("optimistic, acknowledged and reopened user messages preserve the quote boundary", async () => {
  const intent = quotedIntent(quote);
  const compiled = compileSubmitIntent(intent);
  const text = compiled.input.flatMap(item => item.type === "text" ? [item.text] : []).join("");
  assert.equal(composerDocumentToMessageText(quote), text);
  assert.equal(submittedMessageDisplay(intent).message, text, "new-thread and route-handoff presentation share quote semantics");
  assert.equal(composerDocumentToPlainText(quote), "ProvisionInstanceBotIM 仍为 CREATED\n这是什么东西？", "plain previews retain their existing contract");
  let accept!: (value: SubmissionReceipt) => void;
  const listeners = new Set<() => void>();
  let entity: ReplicaJsonValue = { thread: { id: key.threadId, status: { type: "idle" } }, turns: [], pendingInteractions: [] };
  const replica: ConversationReplicaReader = { getSnapshot: () => ({ revision: 1, storageKey: "fixture", scope: "fixture", phase: "live", authoritative: true,
    epoch: "one", nextSeq: 1, journalStartSeq: 1, lastError: null, entities: new Map([[key.threadId, entity]]) }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const commands = { submit: () => new Promise<SubmissionReceipt>(resolve => { accept = resolve; }) } as ConversationCommandPort;
  const config = { key, replica, commands, history: { async loadOlder() {} } };
  const runtime = createReplicaConversationRuntime(config);
  const message = (value: typeof runtime) => {
    const blocks = value.getSnapshot().timeline.frames.flatMap(frame => frame.blocks).filter(block => block.type === "user-message");
    assert.equal(blocks.length, 1);
    return blocks[0]!.message;
  };
  try {
    const sending = runtime.submit(intent);
    assert.equal(message(runtime), text);
    assertQuote(message(runtime));
    accept({ commandId: intent.commandId, clientMessageId: intent.clientMessageId, hostId: key.hostId,
      threadId: key.threadId, turnId: "accepted-turn", acceptedAt: 101, replayed: false });
    await sending;
    assertQuote(message(runtime));
    entity = { thread: { id: key.threadId, status: { type: "active" } }, pendingInteractions: [], turns: [{ id: "accepted-turn", status: "inProgress", params: {
      clientUserMessageId: intent.clientMessageId, input: compiled.input,
    }, items: [{ id: "canonical-user", type: "userMessage", clientId: intent.clientMessageId, content: compiled.input }] }] };
    for (const listener of listeners) listener();
    assert.equal(message(runtime), text);
    assertQuote(message(runtime));
    const reopened = createReplicaConversationRuntime(config);
    try { assert.equal(message(reopened), text); assertQuote(message(reopened)); }
    finally { reopened.dispose(); }
  } finally { runtime.dispose(); }
});

test("multiline and nested quotes keep every line inside the quote through native compilation", () => {
  const document: ComposerDocument = { version: 1, blocks: [
    { type: "quote", children: [
      { type: "paragraph", children: [{ type: "text", text: "first\r\n\r\nsecond" }] },
      { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "nested" }] }] },
    ] },
    { type: "paragraph", children: [{ type: "text", text: "My question" }] },
  ] };
  const wire = compileSubmitIntent(quotedIntent(document)).input.flatMap(item => item.type === "text" ? [item.text] : []).join("");
  assert.equal(wire, "> first\n> \n> second\n> > nested\n\nMy question");
  assert.equal(composerDocumentToMessageText(document), wire);
  assertQuote(wire);
});
