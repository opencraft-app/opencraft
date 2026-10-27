import React from "react";
import type { UserMessageTimelineBlock } from "@opencraft/chat-core";
import { createIntlTestRoot } from "./intl-root";
import { UserMessageBlock } from "../../apps/workbench-web/src/components/conversation/user-message";
import { WorkbenchPresentationRootProvider } from "../../apps/workbench-web/src/components/workbench-presentation-root";
import appStyles from "../../apps/workbench-web/src/styles/app.scss?inline";

const host = document.getElementById("host");
if (host === null) throw new Error("Missing sender preview host");
const shadow = host.attachShadow({ mode: "open" });
const style = document.createElement("style");
style.textContent = appStyles.replaceAll(":root", ":host");
shadow.append(style);
const presentationRoot = document.createElement("div");
presentationRoot.className = "opencraft-embedded-workbench-root";
shadow.append(presentationRoot);

const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#2876c7"/><text x="60" y="260" fill="white" font-size="54">Sent image</text></svg>')}`;
const block: UserMessageTimelineBlock = {
  type: "user-message",
  id: "sent-image",
  sourceItemIds: [],
  message: "",
  content: [{ type: "image", source: image, detail: null }],
  attachments: [],
  messageKind: "user",
  clientId: null,
  steeringStatus: null,
  sentAtMs: null,
  deliveryStatus: null,
  referencesPriorConversation: false,
  reviewMode: false,
  pullRequestFixMode: false,
  autoResolveSync: false,
  goal: false,
  hookFeedback: false,
  commentCount: 0,
  hasExternalAttachments: false,
};

presentationRoot.style.cssText = "--color-text:#21272b;--color-text-tertiary:#77818a;--color-background-surface:#fff;--opencraft-chat-font-size:15px;width:min(880px,100%);margin:32px auto;padding:24px;background:var(--color-background-surface);display:flex;flex-direction:column;gap:24px";
const examples = [
  { id: "first", message: "将发送者身份绑定到每条消息 ID", content: [], sender: { kind: "employee" as const, loginName: "alice" } },
  { id: "steer", message: "队列里的消息也保留原发送者", content: [], sender: { kind: "employee" as const, loginName: "alexli" }, messageKind: "steering" as const },
  { id: "anonymous", message: "未识别身份的消息", content: [], sender: null },
  { id: "attachment", message: "", content: block.content, sender: { kind: "employee" as const, loginName: "alice" } },
];
createIntlTestRoot(presentationRoot).render(
  <WorkbenchPresentationRootProvider target={presentationRoot}>
    {examples.map(example => <div key={example.id} data-fixture={example.id}><UserMessageBlock block={{...block, ...example}} /></div>)}
  </WorkbenchPresentationRootProvider>,
);
