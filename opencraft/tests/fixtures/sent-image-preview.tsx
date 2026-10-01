import React from "react";
import type { UserMessageTimelineBlock } from "@opencraft/chat-core";
import { createIntlTestRoot } from "./intl-root";
import { UserMessageBlock } from "../../apps/workbench-web/src/components/conversation/user-message";
import { WorkbenchPresentationRootProvider } from "../../apps/workbench-web/src/components/workbench-presentation-root";
import appStyles from "../../apps/workbench-web/src/styles/app.scss?inline";

const host = document.getElementById("host");
if (host === null) throw new Error("Missing image preview host");
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

createIntlTestRoot(presentationRoot).render(
  <WorkbenchPresentationRootProvider target={presentationRoot}>
    <UserMessageBlock block={block} />
  </WorkbenchPresentationRootProvider>,
);
