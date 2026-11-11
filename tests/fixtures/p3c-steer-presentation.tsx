import React from "react";
import { createIntlTestRoot } from "./intl-root";
import { UserMessageBlock } from "../../apps/workbench-web/src/components/conversation/user-message";
import { ConversationDocumentContext } from "../../apps/workbench-web/src/components/conversation/document-context";
import { WorkbenchPresentationRootProvider } from "../../apps/workbench-web/src/components/workbench-presentation-root";
import styles from "../../apps/workbench-web/src/styles/app.scss?inline";
import type { UserMessageTimelineBlock } from "@opencraft/chat-core";

const root = document.getElementById("root")!;
const style = document.createElement("style");
style.textContent = styles;
document.head.append(style);
root.className = "opencraft-embedded-workbench-root";
root.style.cssText = "padding:16px;max-width:860px;margin:auto;background:white;color:#21272b;--color-text:#21272b;--color-text-tertiary:#77818a;--color-background-surface:white;display:flex;flex-direction:column;gap:20px";
const base: UserMessageTimelineBlock = {
  type: "user-message", id: "base", sourceItemIds: [], message: "", content: [], attachments: [],
  messageKind: "user", clientId: null, steeringStatus: null, sentAtMs: null, deliveryStatus: null,
  referencesPriorConversation: false, reviewMode: false, pullRequestFixMode: false,
  autoResolveSync: false, goal: false, hookFeedback: false, commentCount: 0, hasExternalAttachments: false,
};
const cases: [string, Partial<UserMessageTimelineBlock>][] = [
  ["copilot-next-turn", { message: "Answer with the single word STEERED.", messageKind: "user", deliveryStatus: "sent" }],
  ["amp-native-steer", { message: "Answer with the single word STEERED.", messageKind: "steering", steeringStatus: "accepted", deliveryStatus: "sent" }],
  ["amp-pending", { message: "Answer with the single word STEERED.", messageKind: "steering", steeringStatus: "pending", deliveryStatus: "sent" }],
];
createIntlTestRoot(root).render(
  <WorkbenchPresentationRootProvider target={root}>
    <ConversationDocumentContext.Provider value={{ conversationId: "p3c", cwd: "/workspace/project", hostId: "fixture", theme: "light", onOpenResource: () => {} }}>
      {cases.map(([id, overrides]) => <section key={id} data-case={id}><UserMessageBlock block={{ ...base, ...overrides, id }} /></section>)}
    </ConversationDocumentContext.Provider>
  </WorkbenchPresentationRootProvider>,
);
