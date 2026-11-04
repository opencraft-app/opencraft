import type {
  UserMessageAttachment,
  UserMessageContentPart,
  UserMessageTimelineBlock,
} from "@opencraft/chat-core";

export type UserMessageImagePart = Extract<UserMessageContentPart, { type: "image" | "local-image" }>;
export type UserMessageAudioPart = Extract<UserMessageContentPart, { type: "audio" | "local-audio" }>;
export type UserMessageContextPart = Extract<UserMessageContentPart, { type: "skill" | "mention" }>;
export type UserMessageFileAttachment = Extract<UserMessageAttachment, { type: "file" }>;
export type UserMessageCommentAttachment = Extract<UserMessageAttachment, { type: "comment" }>;
export type UserMessageMcpContextAttachment = Extract<UserMessageAttachment, { type: "mcp-context" }>;

export interface UserMessageWebLayout {
  readonly images: readonly UserMessageImagePart[];
  readonly audio: readonly UserMessageAudioPart[];
  readonly contexts: readonly UserMessageContextPart[];
  readonly files: readonly UserMessageFileAttachment[];
  readonly comments: readonly UserMessageCommentAttachment[];
  readonly mcpContexts: readonly UserMessageMcpContextAttachment[];
  readonly hasText: boolean;
  readonly hasStatus: boolean;
  readonly showBody: boolean;
  readonly showBubble: boolean;
}


export function deriveUserMessageWebLayout(block: UserMessageTimelineBlock): UserMessageWebLayout {
  const images: UserMessageImagePart[] = [];
  const audio: UserMessageAudioPart[] = [];
  const contexts: UserMessageContextPart[] = [];
  const files: UserMessageFileAttachment[] = [];
  const comments: UserMessageCommentAttachment[] = [];
  const mcpContexts: UserMessageMcpContextAttachment[] = [];
  const fileTargets = new Set<string>();
  for (const attachment of block.attachments) {
    switch (attachment.type) {
      case "file":
        files.push(attachment);
        if (attachment.target !== null) fileTargets.add(attachment.target);
        break;
      case "comment": comments.push(attachment); break;
      case "mcp-context": mcpContexts.push(attachment); break;
    }
  }
  for (const part of block.content) {
    switch (part.type) {
      case "image": case "local-image": images.push(part); break;
      case "audio": case "local-audio": audio.push(part); break;
      case "skill": contexts.push(part); break;
      case "mention": if (!fileTargets.has(part.path)) contexts.push(part); break;
    }
  }
  const hasText = block.message.trim().length > 0;
  const hasStatus = block.goal || block.hookFeedback || block.reviewMode
    || block.pullRequestFixMode || block.autoResolveSync || block.commentCount > 0
    || block.deliveryStatus === "not-sent" || block.deliveryStatus === "failed"
    || block.deliveryStatus === "unknown";
  const standalone = block.hasExternalAttachments || block.referencesPriorConversation
    || block.reviewMode || block.pullRequestFixMode || block.autoResolveSync
    || block.commentCount > 0 || images.length + audio.length + contexts.length
      + files.length + comments.length + mcpContexts.length > 0;
  const showBubble = hasText || !standalone;
  return { images, audio, contexts, files, comments, mcpContexts, hasText,
    hasStatus, showBubble, showBody: showBubble || hasStatus };
}
