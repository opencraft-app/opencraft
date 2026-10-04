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

/**
 * Source-equivalent UserMessage visibility policy. External attachments and
 * semantic context can stand alone; a truly empty message still receives the
 * `(No content)` bubble. This is Web layout state, not protocol state.
 */
export function deriveUserMessageWebLayout(block: UserMessageTimelineBlock): UserMessageWebLayout {
  const images = block.content.filter((part): part is UserMessageImagePart => part.type === "image" || part.type === "local-image");
  const audio = block.content.filter((part): part is UserMessageAudioPart => part.type === "audio" || part.type === "local-audio");
  const files = block.attachments.filter((attachment): attachment is UserMessageFileAttachment => attachment.type === "file");
  const fileTargets = new Set(files.flatMap((file) => file.target === null ? [] : [file.target]));
  const contexts = block.content.filter((part): part is UserMessageContextPart =>
    part.type === "skill" || (part.type === "mention" && !fileTargets.has(part.path)));
  const comments = block.attachments.filter((attachment): attachment is UserMessageCommentAttachment => attachment.type === "comment");
  const mcpContexts = block.attachments.filter((attachment): attachment is UserMessageMcpContextAttachment => attachment.type === "mcp-context");
  const hasText = block.message.trim().length > 0;
  const hasStatus = block.deliveryStatus === "not-sent"
    || block.deliveryStatus === "unknown"
    || block.deliveryStatus === "failed"
    || block.goal
    || block.hookFeedback
    || block.reviewMode
    || block.pullRequestFixMode
    || block.autoResolveSync
    || block.commentCount > 0;
  const hasSemanticAttachments = images.length > 0
    || audio.length > 0
    || contexts.length > 0
    || files.length > 0
    || comments.length > 0
    || mcpContexts.length > 0
    || block.hasExternalAttachments
    || block.referencesPriorConversation
    || block.reviewMode
    || block.pullRequestFixMode
    || block.autoResolveSync
    || block.commentCount > 0;
  const showBubble = hasText || !hasSemanticAttachments;
  return {
    images,
    audio,
    contexts,
    files,
    comments,
    mcpContexts,
    hasText,
    hasStatus,
    showBody: showBubble || hasStatus,
    showBubble,
  };
}
