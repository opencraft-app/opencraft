import React, { useSyncExternalStore } from "react";
import { createIntlTestRoot } from "./intl-root";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { createComposerController, composerDocumentToPlainText, type SubmissionReceipt, type SubmitIntent } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { createConversationScopeRegistry, createWorkbenchSubmissionPipeline } from "@opencraft/workbench-runtime";
import { createReplicaConversationRuntime } from "@opencraft/chat-runtime";
import type { ReplicaClientSnapshot } from "@opencraft/appserver-replica";
import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";
import { initializeAppearanceTheme } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";
initializeAppearanceTheme();
const target = (id: string) => ({ type: "existing-thread" as const, key: createConversationKey("fixture", id) });
const controller = createComposerController(target("a"), { now: Date.now, createId: () => crypto.randomUUID() });
let accept: (() => void) | null = null;
let reject: (() => void) | null = null;
let refreshStarted = false;
let submitted: SubmitIntent | null = null;
const listeners = new Set<() => void>();
let replica: ReplicaClientSnapshot<ReplicaJsonValue> = { revision: 1, storageKey: "fixture", scope: "fixture", phase: "live", authoritative: true,
  epoch: "fixture", nextSeq: 1, journalStartSeq: 1, entities: new Map([["a", { turns: [], pendingInteractions: [] }]]), lastError: null };
const unused = async (): Promise<never> => { throw new Error("unused"); };
const conversation = createReplicaConversationRuntime({ key: target("a").key,
  replica: { getSnapshot: () => replica, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } },
  history: { loadOlder: unused }, commands: {
    createThread: unused, interrupt: unused, continueTurn: unused, respond: unused,
    updateQueuedSubmission: unused, deleteQueuedSubmission: unused, discardUnconfirmedSteer: unused,
    reorderQueuedSubmissions: unused, startQueuedSubmission: unused, steerQueuedSubmission: unused,
    submit: intent => new Promise<SubmissionReceipt>((resolve, fail) => {
      submitted = intent;
      accept = () => resolve({ commandId: intent.commandId, clientMessageId: intent.clientMessageId,
        hostId: "fixture", threadId: "a", turnId: "turn", acceptedAt: Date.now(), replayed: false });
      reject = () => fail(new Error("admission refused"));
    }),
  },
});
const pipeline = createWorkbenchSubmissionPipeline({ scopes: createConversationScopeRegistry(),
  submitExistingThread: intent => conversation.submit(intent),
  submitNewThread: async () => { throw new Error("unused"); },
  submitFirstTurn: async () => { throw new Error("unused"); }, promoteDraft: async () => {},
  afterAccepted: () => { refreshStarted = true; return new Promise<void>(() => {}); },
});
(window as any).fixture = {
  confirmReplica: () => {
    if (!submitted) throw new Error("No submitted input");
    replica = { ...replica, revision: replica.revision + 1, entities: new Map([["a", { turns: [{ id: "turn", status: "inProgress", items: [
      { id: "server-user", type: "userMessage", clientUserMessageId: submitted.clientMessageId, content: [{ type: "text", text: "sent text with two images" }] },
    ] }], pendingInteractions: [] }]]) };
    for (const listener of listeners) listener();
  },
  lateNativeInput: () => controller.insertText("late native input"),
  reserialize: () => {
    const draft = controller.getSnapshot().draft;
    controller.dispatch({ type: "set-document", document: structuredClone(draft.document) });
    for (const attachment of draft.attachments) controller.updateDraftAttachment(draft.id, attachment.id, { lifecycle: "ready", error: null });
  },
  accept: () => accept?.(), reject: () => reject?.(),
  switch: (id: string) => controller.dispatch({ type: "switch-target", target: target(id) }),
  text: () => composerDocumentToPlainText(controller.getSnapshot().draft.document),
  snapshot: controller.getSnapshot, refresh: () => refreshStarted,
  addImages: () => { for (let n = 0; n < 2; n++) controller.dispatch({ type: "add-attachment", attachment: {
    id: `image-${n}`, name: `image-${n}.png`, mimeType: "image/png", size: 68,
    uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1r8AAAAASUVORK5CYII=", lifecycle: "ready", error: null,
  } }); },
};
function Fixture() {
  const snapshot = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
  const messages = snapshot.timeline.frames.flatMap(frame => frame.blocks).filter(block => block.type === "user-message");
  return <><div data-testid="timeline">{messages.map(block => <div key={block.id}>{block.type === "user-message" ? block.message : ""}</div>)}</div>
    <OpenCraftComposer controller={controller} awaitSubmission
      onSubmit={async intent => { await pipeline.submit(intent); return true; }} onCancel={() => {}} /></>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Fixture />);
