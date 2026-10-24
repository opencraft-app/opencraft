import React from "react";
import { deriveUserMessageSemantics, type UserMessageTimelineBlock } from "@opencraft/chat-core";
import { UserMessageBlock } from "../../apps/workbench-web/src/components/conversation/user-message";
import { ConversationDocumentContext } from "../../apps/workbench-web/src/components/conversation/document-context";
import { WorkbenchPresentationRootProvider } from "../../apps/workbench-web/src/components/workbench-presentation-root";
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
const cases: [string, Partial<UserMessageTimelineBlock>][] = [
  ["goal", { ...deriveUserMessageSemantics("## Code review guidelines: private context\n## My request: first\n## My request for Codex: /goal Ship the release"), sender: { kind: "employee", loginName: "reviewer" } }],
  ["empty", {}], ["review", { reviewMode: true }], ["prior", { referencesPriorConversation: true }],
  ["image", { content: [{ type: "image", source: image, detail: null }] }],
  ["file", { attachments: [file], content: [{ type: "mention", name: "index.ts", path: file.target }] }],
  ["context", { content: [{ type: "skill", name: "review", path: "/skills/review/SKILL.md" }] }],
  ["failed", { message: "Retry this", deliveryStatus: "failed" }],
  ["sending", { message: "Sending this", deliveryStatus: "sending" }],
  ["comment", { commentCount: 1, attachments: [{ type: "comment", id: "c", label: "note", target: null, body: "fix", line: null }] }],
  ["audio", { content: [{ type: "audio", source: "data:audio/wav;base64,UklGRg==" }] }],
];
createIntlTestRoot(root).render(<WorkbenchPresentationRootProvider target={root}>
  <ConversationDocumentContext.Provider value={{ conversationId: "fixture", cwd: "/workspace", hostId: "fixture", theme: dark ? "dark" : "light", onOpenResource: target => { document.documentElement.dataset.opened = target; } }}>
    {cases.map(([id, overrides]) => <section key={id} data-case={id}><UserMessageBlock block={{ ...base, ...overrides, id }} /></section>)}
  </ConversationDocumentContext.Provider>
</WorkbenchPresentationRootProvider>);
