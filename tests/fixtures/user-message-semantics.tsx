import React, { useSyncExternalStore } from "react";
import { createConversationDisplayContinuity, createConversationScopeRegistry, submittedMessageDisplay } from "@opencraft/workbench-runtime";
import type { SubmitIntent } from "@opencraft/composer-core";
import { deriveUserMessageSemantics, type UserMessageTimelineBlock } from "@opencraft/chat-core";
import { UserMessageBlock } from "../../apps/workbench-web/src/components/conversation/user-message";
import { ConversationDocumentContext } from "../../apps/workbench-web/src/components/conversation/document-context";
import { WorkbenchPresentationRootProvider } from "../../apps/workbench-web/src/components/workbench-presentation-root";
import { PendingConversationPage } from "../../apps/workbench-web/src/components/pending-conversation-page";
import { createIntlTestRoot } from "./intl-root";
import styles from "../../apps/workbench-web/src/styles/app.scss?inline";

const dark = new URLSearchParams(location.search).has("dark");
const root = document.getElementById("root")!;
const style = document.createElement("style");
style.textContent = styles;
document.head.append(style);
document.body.style.margin = "0";
root.className = "opencraft-embedded-workbench-root";
root.style.cssText = `padding:16px;max-width:860px;margin:auto;background:${dark ? "#17191c" : "white"};color:${dark ? "#eee" : "#21272b"};--color-text:${dark ? "#eee" : "#21272b"};--color-text-tertiary:#77818a;--color-background-surface:${dark ? "#17191c" : "white"};--opencraft-chat-font-size:15px;display:flex;flex-direction:column;gap:20px`;
const base: UserMessageTimelineBlock = { type: "user-message", id: "base", sourceItemIds: [], message: "", content: [], attachments: [],
  messageKind: "user", clientId: null, steeringStatus: null, sentAtMs: null, deliveryStatus: null,
  referencesPriorConversation: false, reviewMode: false, pullRequestFixMode: false, autoResolveSync: false, goal: false,
  hookFeedback: false, commentCount: 0, hasExternalAttachments: false };
const file = { type: "file" as const, id: "f", name: "index.ts", target: "/workspace/index.ts", mimeType: null, startLine: 4, endLine: 8 };
const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#2876c7"/></svg>')}`;
const evidence = (confirmed: boolean): import('@opencraft/appserver-protocol').SteerInputStatus => ({
  inputId: 'fixture-input', clientRequestId: 'fixture-client', expectedTurnId: 'fixture-turn', disposition: 'steered', nativeExecutions: 1,
  registration: { value: 'registered', version: 1 }, admission: { value: 'accepted', version: 1 }, delivery: { value: 'native-inject', version: 1 },
  evidence: { value: confirmed ? 'context-confirmed' : 'none', version: confirmed ? 1 : 0 }, withdrawal: { value: 'none', version: 0 }, outcome: confirmed ? 'context-confirmed' : 'pending',
});
const cases: [string, Partial<UserMessageTimelineBlock>][] = [
  ["goal", { sentAtMs: 1_700_000_000_000, ...deriveUserMessageSemantics("## Code review guidelines: private context\n## My request: first\n## My request for Codex: /goal Ship the release"), sender: { kind: "employee", loginName: "reviewer" } }],
  ["empty", {}], ["review", { reviewMode: true }], ["prior", { referencesPriorConversation: true }],
  ["image", { content: [{ type: "image", source: image, detail: null }] }],
  ["file", { attachments: [file], content: [{ type: "mention", name: "index.ts", path: file.target }] }],
  ["context", { content: [{ type: "skill", name: "review", path: "/skills/review/SKILL.md" }] }],
  ["failed", { message: "Retry this", deliveryStatus: "failed" }],
  ["sending", { message: "Sending this", deliveryStatus: "sending" }],
  ["bridge-admission", { message: "Native follow-up", messageKind: "steering", steerEvidence: evidence(false) }],
  ["bridge-unknown", { message: "Unconfirmed follow-up", deliveryStatus: "unknown", steerEvidence: { ...evidence(false), admission: { value: "unknown", version: 1 }, outcome: "unknown" } }],
  ["bridge-confirmed", { message: "Native follow-up", messageKind: "steering", steerEvidence: evidence(true) }],
  ["steer-pending", { message: "Focus on the second option", messageKind: "steering", steeringStatus: "pending", deliveryStatus: "sent" }],
  ["steer-accepted", { message: "Focus on the second option", messageKind: "steering", steeringStatus: "accepted", deliveryStatus: "sent" }],
  ["steer-cancelled", { message: "Focus on the second option", messageKind: "steering", steeringStatus: "cancelled", deliveryStatus: "sent" }],
  ["steer-declined", { message: "Focus on the second option", messageKind: "steering", steeringStatus: "declined", deliveryStatus: "sent" }],
  ["comment", { commentCount: 1, attachments: [{ type: "comment", id: "c", label: "note", target: null, body: "fix", line: null }] }],
  ["audio", { content: [{ type: "audio", source: "data:audio/wav;base64,UklGRg==" }] }],
];
const context = { conversationId: "fixture", cwd: "/workspace", hostId: "fixture", theme: dark ? "dark" as const : "light" as const };
let account = "alice";
const scopes = createConversationScopeRegistry({ getSubmissionSender: () => ({ kind: "employee", loginName: account }) });
const firstDraft = scopes.openDraft({ draftId: "first-draft", execution: { hostId: "fixture", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: [] } } });
const firstInput: SubmitIntent = { commandId: "first-command", clientMessageId: "first-message", target: firstDraft.target,
  document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Keep this message steady" }] }] },
  attachments: [], context: [], selections: {}, options: { autoContext: false }, createdAt: 1_700_000_000_000 };
scopes.beginSubmit(firstDraft.id, firstInput);
const display = createConversationDisplayContinuity({ namespace: "fixture", storage: { async load() { return null; }, async save() {}, async remove() {} } });
let firstPhase = "pending";
const firstListeners = new Set<() => void>();
Object.assign(window, { firstSubmissionFixture: {
  handoff() {
    account = "bob";
    const receipt = { commandId: firstInput.commandId, clientMessageId: firstInput.clientMessageId,
      hostId: "fixture", threadId: "created-thread", turnId: "first-turn", acceptedAt: firstInput.createdAt + 1, replayed: false };
    display.retainSubmission(firstInput, receipt, scopes.getDraft(firstDraft.id)!.submissionSender);
    scopes.acceptSubmission(firstDraft.id, receipt);
    scopes.beginPromotion(firstDraft.id);
    scopes.promoteDraft(firstDraft.id);
    firstPhase = "handoff";
    firstListeners.forEach(listener => listener());
  },
  acknowledge() { firstPhase = "confirmed"; firstListeners.forEach(listener => listener()); },
} });
function FirstSubmission() {
  const phase = useSyncExternalStore(listener => { firstListeners.add(listener); return () => { firstListeners.delete(listener); }; }, () => firstPhase);
  const echoed = display.peekSubmission("fixture", "created-thread")?.frames[0]?.blocks[0];
  return <section data-case="first-submission" data-phase={phase}>
    {phase === "pending" ? <PendingConversationPage embedded conversation={scopes.getDraft(firstDraft.id)!} documentContext={context} onRetry={() => {}} />
      : <UserMessageBlock block={phase === "handoff" && echoed?.type === "user-message" ? echoed
        : { ...submittedMessageDisplay(firstInput), deliveryStatus: "sent", sender: { kind: "employee", loginName: "alice" } }} />}
  </section>;
}
createIntlTestRoot(root, undefined, new URLSearchParams(location.search).get("locale") ?? "en-US").render(<WorkbenchPresentationRootProvider target={root}>
  <ConversationDocumentContext.Provider value={{ conversationId: "fixture", cwd: "/workspace", hostId: "fixture", theme: dark ? "dark" : "light", onOpenResource: target => { document.documentElement.dataset.opened = target; } }}>
    <FirstSubmission />
    {cases.map(([id, overrides]) => <section key={id} data-case={id}><UserMessageBlock block={{ ...base, ...overrides, id }} /></section>)}
  </ConversationDocumentContext.Provider>
</WorkbenchPresentationRootProvider>);
