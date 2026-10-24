import { composerDocumentToPlainText, type SubmitIntent } from "@opencraft/composer-core";
import type { UserMessageTimelineBlock } from "@opencraft/chat-core";

/** Immutable local presentation only; never an execution or author authority. */
export function submittedMessageDisplay(submission: SubmitIntent): UserMessageTimelineBlock {
  return {
    type: "user-message", id: submission.clientMessageId, sourceItemIds: [],
    message: composerDocumentToPlainText(submission.document), content: [],
    attachments: submission.attachments.map(attachment => ({
      type: "file", id: attachment.id, name: attachment.name,
      target: attachment.uri, mimeType: attachment.mimeType, startLine: null, endLine: null,
    })),
    messageKind: "user", clientId: submission.clientMessageId, sentAtMs: submission.createdAt,
    steeringStatus: null, deliveryStatus: "sending", referencesPriorConversation: false,
    reviewMode: false, pullRequestFixMode: false, autoResolveSync: false,
    goal: false, hookFeedback: false, commentCount: 0,
    hasExternalAttachments: submission.attachments.length > 0,
  };
}
