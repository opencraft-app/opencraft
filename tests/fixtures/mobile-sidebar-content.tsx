import React from "react";
import type { ImageTimelineBlock, ReasoningTimelineBlock, ToolCallTimelineBlock, UserMessageTimelineBlock } from "@opencraft/chat-core";
import { ReasoningBlock } from "../../apps/workbench-web/src/components/conversation-renderers/activity/command-and-review-renderers";
import { GeneratedImageBlock, ImageViewToolBlock } from "../../apps/workbench-web/src/components/conversation-renderers/tool/tool-renderers";
import { UserMessageBlock } from "../../apps/workbench-web/src/components/conversation/user-message";
import { ConversationDocumentContext } from "../../apps/workbench-web/src/components/conversation/document-context";

const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2876c7"/></svg>')}`;
const reason: ReasoningTimelineBlock = { type: "reasoning", id: "swipe-reason", sourceItemIds: [], summary: "Checking sidebar gestures\nReasoning body stays collapsed during a swipe", detail: null, streaming: false };
const inspected: ToolCallTimelineBlock = { type: "tool-call", id: "swipe-inspected", sourceItemIds: [], callId: null, kind: "image-view", name: "view_image", server: null, namespace: null, input: {}, output: null, errorMessage: null, durationMs: null, readOnlyHint: true, appResourceUri: null, imagePaths: ["/work/image.png"], automaticApprovalReviews: [], status: "completed" };
const generated: ImageTimelineBlock = { type: "image", id: "swipe-generated", sourceItemIds: [], uri: image, alt: null, generated: true, savedPath: null, transparentBackground: false, failure: null, status: "completed" };
const sent: UserMessageTimelineBlock = { type: "user-message", id: "swipe-sent", sourceItemIds: [], message: "", content: [{ type: "image", source: image, detail: null }], attachments: [], messageKind: "user", clientId: null, steeringStatus: null, sentAtMs: null, deliveryStatus: null, referencesPriorConversation: false, reviewMode: false, pullRequestFixMode: false, autoResolveSync: false, goal: false, hookFeedback: false, commentCount: 0, hasExternalAttachments: false };

/** Real clickable renderers inside AppShell; no gesture handlers in the fixture. */
export function MobileSidebarContentProbe({ record }: { record(action: string): void }) {
  return <ConversationDocumentContext.Provider value={{ conversationId: "swipe", cwd: "/work", hostId: "fixture", theme: "light", resolveImageSource: () => image, onOpenResource: () => record("inspected-image") }}>
    <div style={{ padding: 16 }}>
      <div data-swipe-reason><ReasoningBlock block={reason} /></div>
      <div data-swipe-inspected><ImageViewToolBlock block={inspected} /></div>
      <div data-swipe-generated><GeneratedImageBlock block={generated} /></div>
      <div data-swipe-sent><UserMessageBlock block={sent} /></div>
      <button data-swipe-action type="button" onClick={() => record("button")}>Ordinary action</button>
      <a data-swipe-link href="#swipe-link" onClick={event => { event.preventDefault(); record("link"); }}>Ordinary link</a>
      <div data-swipe-role role="button" tabIndex={0} onClick={() => record("role-button")}>Custom action</div>
      <div data-swipe-ignore data-sidebar-gesture="ignore"><button type="button" onClick={() => record("ignored")}>Explicit gesture owner</button></div>
    </div>
  </ConversationDocumentContext.Provider>;
}
