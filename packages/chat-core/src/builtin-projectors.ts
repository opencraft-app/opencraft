import { userInputQuestionExtensions } from "./request-user-input";
import { appEnvelope, MCP_APPS_NAMESPACE } from "@opencraft/appserver-protocol/mcp-apps";
import { asItemId } from "./identity";
import { displayAsyncQuestionReply, projectAsyncQuestions } from "./async-questions";
import { normalizeMcpElicitationMetadata } from "./mcp-elicitation";
import type {
  ApprovalTimelineBlock,
  AutomaticApprovalReview,
  AutomaticApprovalReviewAction,
  TimelineExecutionStatus,
  TimelineCommandAction,
  FileChange,
  QuestionOption,
  UserInputQuestion,
  TimelineBlock,
  TimelineStatus,
  TodoEntry,
  UserMessageAttachment,
  UserMessageContentPart,
  UserMessageTextElement,
  WebMcpToolSurfaceCall,
} from "./timeline";
import { summarizeTurnDiff } from "./turn-diff";
import { deriveUserMessageSemantics } from "./user-message";
import { parseRealtimeDelegation, realtimeDelegationHandoffId } from "./realtime-transcript";
import {
  TimelineProjectorRegistry,
  type TimelineItemProjection,
  type TimelineItemProjector,
  type TimelineProjectionContext,
  type TimelineSourceItem,
} from "./projection";

type RecordValue = Readonly<Record<string, unknown>>;

function record(value: unknown): RecordValue {
  return typeof value === "object" && value !== null ? value as RecordValue : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  const candidate = string(value);
  return candidate !== null && candidate.trim().length > 0 ? candidate : null;
}

function webMcpToolSurfaceCalls(value: unknown): readonly WebMcpToolSurfaceCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): readonly WebMcpToolSurfaceCall[] => {
    const source = record(entry);
    const kind = source.kind === "listTools" || source.kind === "invokeTool" ? source.kind : null;
    const name = nonEmptyString(source.name);
    if (kind === null || name === null || (kind === "listTools" && name !== "webmcp_list_tools")) return [];
    return [{
      kind,
      name,
      title: nonEmptyString(source.title),
      description: string(source.description),
      readOnlyHint: boolean(source.readOnlyHint),
      sourceHostname: nonEmptyString(source.sourceHostname),
      inputJson: kind === "invokeTool" ? string(source.inputJson) : null,
      inputTruncated: kind === "invokeTool" && source.inputTruncated === true,
      outputJson: string(source.outputJson),
      outputTruncated: source.outputTruncated === true,
    }];
  });
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join("\n");
  const source = record(value);
  return string(source.text)
    ?? string(source.content)
    ?? string(source.message)
    ?? (Array.isArray(source.content) ? textFrom(source.content) : "");
}

function userMessageTextElements(value: unknown): readonly UserMessageTextElement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): readonly UserMessageTextElement[] => {
    const source = record(entry);
    const byteRange = record(source.byteRange ?? source.byte_range);
    const start = number(byteRange.start);
    const end = number(byteRange.end);
    if (start === null || end === null || start < 0 || end < start) return [];
    return [{
      byteRange: { start, end },
      placeholder: string(source.placeholder),
    }];
  });
}

function userMessageContent(value: unknown): readonly UserMessageContentPart[] {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  return entries.flatMap((entry): readonly UserMessageContentPart[] => {
    if (typeof entry === "string") return [{ type: "text", text: entry, textElements: [] }];
    const source = record(entry);
    switch (source.type) {
      case "text": {
        const text = string(source.text);
        return text === null ? [] : [{
          type: "text",
          text,
          textElements: userMessageTextElements(source.text_elements ?? source.textElements),
        }];
      }
      case "image": {
        const url = string(source.url);
        return url === null ? [] : [{ type: "image", source: url, detail: string(source.detail) }];
      }
      case "localImage": {
        const path = string(source.path);
        return path === null ? [] : [{ type: "local-image", source: path, detail: string(source.detail) }];
      }
      case "audio": {
        const url = string(source.url);
        return url === null ? [] : [{ type: "audio", source: url }];
      }
      case "localAudio": {
        const path = string(source.path);
        return path === null ? [] : [{ type: "local-audio", source: path }];
      }
      case "skill":
      case "mention": {
        const name = string(source.name);
        const path = string(source.path);
        return name === null || path === null ? [] : [{ type: source.type, name, path }];
      }
      default: {
        const text = string(source.text) ?? string(source.content) ?? string(source.message);
        return text === null ? [] : [{ type: "text", text, textElements: [] }];
      }
    }
  });
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function attachmentTarget(source: RecordValue): string | null {
  return nonEmptyString(source.fsPath)
    ?? nonEmptyString(source.path)
    ?? nonEmptyString(source.uri)
    ?? nonEmptyString(source.url);
}

function attachmentName(target: string | null, source: RecordValue, fallback: string): string {
  const explicit = nonEmptyString(source.name)
    ?? nonEmptyString(source.fileName)
    ?? nonEmptyString(source.title)
    ?? nonEmptyString(source.label)
    ?? nonEmptyString(source.displayName);
  if (explicit !== null) return explicit;
  if (target !== null) {
    const path = target.replace(/[?#].*$/u, "").replace(/\\/gu, "/");
    const basename = path.split("/").filter(Boolean).at(-1);
    if (basename !== undefined) return basename;
  }
  return fallback;
}

function restoredMessageContext(source: RecordValue): RecordValue {
  return record(record(source.restoreMessage).context);
}

function userMessageAttachments(
  source: RecordValue,
  content: readonly UserMessageContentPart[],
): readonly UserMessageAttachment[] {
  const restoredContext = restoredMessageContext(source);
  const rawFiles = array(source.attachments ?? restoredContext.attachments);
  const rawComments = array(source.commentAttachments ?? restoredContext.commentAttachments);
  const rawMcpContexts = array(
    source.mcpAppModelContextAttachments ?? restoredContext.mcpAppModelContextAttachments,
  );
  const nonFileInputTargets = new Set(content.flatMap((part): string[] => {
    switch (part.type) {
      case "image":
      case "local-image":
      case "audio":
      case "local-audio": return [part.source];
      case "skill":
        return [part.path];
      case "mention": return [];
      case "text": return [];
    }
  }));
  const stagedFiles = content.flatMap((part, index): readonly { readonly name: string; readonly path: string }[] => {
    if (part.type !== "mention") return [];
    const preceding = content[index - 1];
    if (preceding?.type !== "text") return [];
    const fullSpan = preceding.textElements.some((element) => element.byteRange.start === 0
      && element.byteRange.end === new TextEncoder().encode(preceding.text).length
      && (element.placeholder === "opencraft:staged-file:v1"
        // The first Host build used an empty placeholder. Match its complete
        // generated locator, never an arbitrary user-written file path.
        || (element.placeholder === "" && preceding.text === `The user attached a file named ${JSON.stringify(part.name)}. Its readable path on this Host is ${JSON.stringify(part.path)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`)));
    return fullSpan ? [part] : [];
  });
  const stagedTargets = new Set(stagedFiles.map((part) => part.path));
  const files = rawFiles.flatMap((entry, index): readonly UserMessageAttachment[] => {
    const file = typeof entry === "string" ? { path: entry } : record(entry);
    const target = attachmentTarget(file);
    if (target !== null && nonFileInputTargets.has(target) && !stagedTargets.has(target)) return [];
    const id = nonEmptyString(file.id) ?? target ?? `file-${index}`;
    return [{
      type: "file",
      id,
      name: attachmentName(target, file, `Attachment ${index + 1}`),
      target,
      mimeType: nonEmptyString(file.mimeType) ?? nonEmptyString(file.mediaType),
      startLine: number(file.startLine),
      endLine: number(file.endLine),
    }];
  });
  const existingFileTargets = new Set(files.flatMap((file) => file.type === "file" && file.target !== null ? [file.target] : []));
  const restoredStagedFiles: UserMessageAttachment[] = [...new Map(stagedFiles.map((part) => [part.path, part] as const)).values()]
    .filter((part) => !existingFileTargets.has(part.path))
    .map((part) => ({
      type: "file", id: part.path, name: part.name, target: part.path,
      mimeType: null, startLine: null, endLine: null,
    }));
  const comments = rawComments.map((entry, index): UserMessageAttachment => {
    const comment = record(entry);
    const position = record(comment.position);
    const target = attachmentTarget(position) ?? attachmentTarget(comment);
    const body = string(comment.body) ?? string(comment.comment) ?? string(comment.text);
    return {
      type: "comment",
      id: nonEmptyString(comment.id) ?? nonEmptyString(comment.reviewThreadId) ?? `comment-${index}`,
      label: attachmentName(target, comment, `Comment ${index + 1}`),
      target,
      body,
      line: number(position.line) ?? number(position.startLine) ?? number(comment.line),
    };
  });
  const contexts = rawMcpContexts.map((entry, index): UserMessageAttachment => {
    const context = record(entry);
    const target = attachmentTarget(context);
    return {
      type: "mcp-context",
      id: nonEmptyString(context.id) ?? target ?? `mcp-context-${index}`,
      label: attachmentName(target, context, `Context ${index + 1}`),
      target,
      provider: nonEmptyString(context.provider)
        ?? nonEmptyString(context.serverName)
        ?? nonEmptyString(context.appName),
    };
  });
  return [...files, ...restoredStagedFiles, ...comments, ...contexts];
}

function hookPromptContent(source: RecordValue): readonly UserMessageContentPart[] {
  if (Array.isArray(source.fragments)) {
    const text = source.fragments.map((fragment) => string(record(fragment).text)).filter((value): value is string => value !== null).join("\n");
    return text.length === 0 ? [] : [{ type: "text", text, textElements: [] }];
  }
  return userMessageContent(source.content ?? source.text ?? source.message);
}

function userMessageText(content: readonly UserMessageContentPart[]): string {
  return content.flatMap((part) => {
    if (part.type !== "text") return [];
    const hidden = part.textElements.filter(element => element.placeholder === "" || element.placeholder === "opencraft:staged-file:v1");
    if (hidden.length === 0) return [part.text];
    // AppServer byte ranges refer to UTF-8, not JavaScript string indices.
    // An empty placeholder is an explicit UI-only span: the model still sees
    // its text, while the user message renders the neighboring attachment.
    const bytes = new TextEncoder().encode(part.text);
    const decoder = new TextDecoder();
    const ordered = [...hidden].sort((left, right) => left.byteRange.start - right.byteRange.start);
    let cursor = 0;
    let visible = "";
    for (const element of ordered) {
      const { start, end } = element.byteRange;
      if (start < cursor || end > bytes.length) return [part.text];
      visible += decoder.decode(bytes.slice(cursor, start));
      cursor = end;
    }
    visible += decoder.decode(bytes.slice(cursor));
    return visible.length === 0 ? [] : [visible];
  }).join("\n");
}

function userMessageDisplayText(source: RecordValue, content: readonly UserMessageContentPart[], attachments: readonly UserMessageAttachment[], rawMessage: string): string {
  return string(source.displayMessage)
    ?? (attachments.length === 0 && content.length === 1 ? displayAsyncQuestionReply(rawMessage) : null)
    ?? deriveUserMessageSemantics(rawMessage).message;
}

/** Shared visible text for message summaries; hidden context and attachments stay out. */
export function readUserMessageDisplayText(value: unknown): string | null {
  const source = record(value);
  if (source.type !== "userMessage" && source.type !== "steeringUserMessage") return null;
  if (["sending", "not-sent", "failed"].includes(String(source.deliveryStatus))) return null;
  const steering = source.__opencraftSteeringStatus ?? source.__velaSteeringStatus ?? source.steeringStatus
    ?? (source.type === "steeringUserMessage" || (source.__opencraftMessageKind ?? source.__velaMessageKind) === "steering" ? source.status : null);
  if (steering != null && steering !== "accepted") return null;
  const rawContent = source.content ?? source.input ?? source.text ?? source.message;
  if (parseRealtimeDelegation(rawContent) !== null) return null;
  const content = userMessageContent(rawContent);
  return userMessageDisplayText(source, content, userMessageAttachments(source, content), userMessageText(content));
}

function steeringStatus(value: unknown): "pending" | "accepted" | "declined" | "cancelled" | null {
  return value === "pending" || value === "accepted" || value === "declined" || value === "cancelled" ? value : null;
}

function userMessageDeliveryStatus(value: unknown): "sending" | "sent" | "not-sent" | "failed" | "unknown" | null {
  return value === "sending" || value === "sent" || value === "not-sent" || value === "failed" || value === "unknown" ? value : null;
}

function firstUserMessageIndex(context: TimelineProjectionContext): number {
  return context.turn.items.findIndex((item) => item.type === "userMessage");
}

function userMessageMetadata(
  source: RecordValue,
  content: readonly UserMessageContentPart[],
  attachments: readonly UserMessageAttachment[],
  context: TimelineProjectionContext,
  rawMessage = userMessageText(content),
) {
  const semantics = deriveUserMessageSemantics(rawMessage);
  const explicitSentAtMs = number(source.sentAtMs) ?? number(source.createdAtMs);
  const leadingUserMessage = context.itemIndex === firstUserMessageIndex(context);
  const hookBlocked = leadingUserMessage && (context.turn.hookStats?.blockedSources.length ?? 0) > 0;
  const comments = Array.isArray(source.comments) ? source.comments.length : 0;
  return {
    message: userMessageDisplayText(source, content, attachments, rawMessage),
    ...(record(source.sender).kind === "employee" && typeof record(source.sender).loginName === "string"
      ? { sender: { kind: "employee" as const, loginName: record(source.sender).loginName as string } } : {}),
    sentAtMs: explicitSentAtMs ?? (leadingUserMessage ? context.turn.startedAtMs ?? null : null),
    deliveryStatus: userMessageDeliveryStatus(source.deliveryStatus) ?? (hookBlocked ? "not-sent" as const : null),
    referencesPriorConversation: boolean(source.referencesPriorConversation) ?? semantics.referencesPriorConversation,
    reviewMode: boolean(source.reviewMode) ?? semantics.reviewMode,
    pullRequestFixMode: boolean(source.pullRequestFixMode) ?? semantics.pullRequestFixMode,
    autoResolveSync: boolean(source.autoResolveSync) ?? semantics.autoResolveSync,
    goal: boolean(source.goal) ?? semantics.goal,
    hookFeedback: boolean(source.hookFeedback) ?? false,
    commentCount: Math.max(0, Math.trunc(
      number(source.commentCount)
        ?? Math.max(comments, attachments.filter((attachment) => attachment.type === "comment").length),
    )),
    hasExternalAttachments: content.some((part) => part.type !== "text")
      || attachments.length > 0,
  };
}

function sourceIds(item: TimelineSourceItem) {
  const source = record(item.payload);
  const sourceItemIds = source.__opencraftSourceItemIds ?? source.__velaSourceItemIds;
  const explicit = Array.isArray(sourceItemIds)
    ? sourceItemIds.filter((value): value is string => typeof value === "string")
    : [];
  return (explicit.length === 0 ? [string(source.__opencraftSourceItemId ?? source.__velaSourceItemId) ?? item.id] : explicit).map(asItemId);
}

function blockBase<TType extends TimelineBlock["type"]>(item: TimelineSourceItem, type: TType) {
  const source = record(item.payload);
  const clientId = type === "user-message"
    ? string(source.clientId) ?? string(source.clientUserMessageId)
    : null;
  return {
    type,
    id: clientId === null ? `${type}:${item.id}` : `${type}:client:${clientId}`,
    sourceItemIds: sourceIds(item),
  } as const;
}

function executionStatus(value: unknown): TimelineExecutionStatus {
  switch (value) {
    case "inProgress":
    case "in_progress":
    case "running": return "running";
    case "completed":
    case "complete":
    case "success": return "complete";
    case "failed":
    case "declined": return "failed";
    case "interrupted":
    case "cancelled": return "interrupted";
    default: return "pending";
  }
}

function generatedImageUri(source: Readonly<Record<string, unknown>>): string | null {
  const explicit = string(source.src) ?? string(source.uri) ?? string(source.url);
  if (explicit !== null && explicit.length > 0) return explicit;
  const result = string(source.result);
  if (result === null || result.length === 0) return null;
  if (/^(?:data:|blob:|https?:|file:)/iu.test(result)) return result;
  // The current AppServer ImageGenerationItem carries PNG bytes as base64 in
  // `result`; normalize that transport field into display-item `src`.
  return `data:image/png;base64,${result}`;
}

function stateStatus(value: unknown): TimelineStatus {
  switch (value) {
    case "completed":
    case "complete": return "complete";
    case "failed": return "failed";
    case "interrupted":
    case "cancelled": return "interrupted";
    case "inProgress":
    case "streaming": return "streaming";
    default: return "pending";
  }
}

/** Completion belongs to the Item; Turn terminality closes legacy history Items. */
function isDisplayItemCompleted(source: Record<string, unknown>, context: TimelineProjectionContext): boolean {
  if (context.turn.status !== "streaming" && context.turn.status !== "pending") return true;
  if (source.completed === true || source.status === "completed") return true;
  return context.itemIndex < context.turn.items.length - 1;
}

function simpleProjector(
  name: string,
  itemTypes: readonly string[],
  project: (
    item: TimelineSourceItem,
    source: RecordValue,
    context: TimelineProjectionContext,
  ) => TimelineItemProjection,
): TimelineItemProjector {
  return {
    name,
    itemTypes,
    project(item, context) {
      const source = record(item.payload);
      let projected = project(item, source, context);
      if (projected.block && source.historyDetail) projected = { ...projected, block: { ...projected.block, historyDetail: JSON.stringify(source.historyDetail) } };
      if (projected.block && "requestId" in projected.block) {
        return { ...projected, block: { ...projected.block,
          ...(typeof source.canRespond === "boolean" ? { canRespond: source.canRespond } : {}),
          ...(["pending", "responding", "unconfirmed"].includes(String(source.responseState))
            ? { responseState: source.responseState as "pending" | "responding" | "unconfirmed" } : {}),
        } };
      }
      return projected;
    },
  };
}

function isUserAuthoredItem(item: TimelineSourceItem): boolean {
  return item.type === "userMessage"
    || item.type === "steeringUserMessage"
    || item.type === "hookPrompt";
}

function lastNonUserItemIndex(items: readonly TimelineSourceItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && !isUserAuthoredItem(item)) return index;
  }
  return -1;
}

function commandActions(value: unknown): readonly TimelineCommandAction[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry): TimelineCommandAction => {
    const source = record(entry);
    const type = string(source.type);
    const command = string(source.command) ?? "";
    if (type === "read") {
      return {
        type: "read",
        command,
        name: string(source.name) ?? "file",
        path: string(source.path) ?? string(source.name) ?? "",
      };
    }
    if (type === "listFiles" || type === "list_files") {
      return { type: "list-files", command, path: string(source.path) };
    }
    if (type === "search") {
      return { type: "search", command, query: string(source.query), path: string(source.path) };
    }
    return { type: "unknown", command };
  });
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function approvalNetworkContext(value: unknown): ApprovalTimelineBlock["networkApprovalContext"] {
  const source = record(value);
  const host = nonEmptyString(source.host);
  const protocol = nonEmptyString(source.protocol);
  return host === null || protocol === null ? null : { host, protocol };
}

function approvalNetworkPolicyAmendments(value: unknown): ApprovalTimelineBlock["proposedNetworkPolicyAmendments"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ApprovalTimelineBlock["proposedNetworkPolicyAmendments"] => {
    const source = record(entry);
    const host = nonEmptyString(source.host);
    const action = nonEmptyString(source.action);
    return host === null || action === null ? [] : [{ host, action }];
  });
}

function automaticApprovalReviewAction(value: unknown): AutomaticApprovalReviewAction | null {
  const source = record(value);
  const type = string(source.type);
  switch (type) {
    case "command": return {
      type,
      source: source.source,
      command: string(source.command) ?? "",
      cwd: string(source.cwd),
    };
    case "execve": return {
      type,
      source: source.source,
      program: string(source.program) ?? "",
      argv: stringArray(source.argv),
      cwd: string(source.cwd),
    };
    case "applyPatch": return {
      type,
      cwd: string(source.cwd),
      files: stringArray(source.files),
    };
    case "networkAccess": return {
      type,
      target: string(source.target) ?? "",
      host: string(source.host) ?? "",
      protocol: source.protocol,
      port: number(source.port),
    };
    case "mcpToolCall": return {
      type,
      server: string(source.server) ?? "",
      toolName: string(source.toolName) ?? "",
      connectorId: string(source.connectorId),
      connectorName: string(source.connectorName),
      toolTitle: string(source.toolTitle),
    };
    case "requestPermissions": return {
      type,
      reason: string(source.reason),
      permissions: source.permissions ?? null,
    };
    default: return null;
  }
}

function automaticApprovalReview(
  value: unknown,
  context: TimelineProjectionContext,
): AutomaticApprovalReview | null {
  const source = record(value);
  const id = string(source.reviewId) ?? string(source.id);
  const startedAtMs = number(source.startedAtMs);
  let status = string(source.status);
  if (status === "inProgress" && context.turn.status === "interrupted") status = "aborted";
  if (
    id === null
    || startedAtMs === null
    || (status !== "inProgress" && status !== "approved" && status !== "denied" && status !== "timedOut" && status !== "aborted")
  ) return null;
  const riskLevel = string(source.riskLevel);
  const userAuthorization = string(source.userAuthorization);
  return {
    id,
    targetItemId: string(source.targetItemId),
    startedAtMs,
    completedAtMs: number(source.completedAtMs),
    status,
    riskLevel: riskLevel === "low" || riskLevel === "medium" || riskLevel === "high" || riskLevel === "critical"
      ? riskLevel
      : null,
    userAuthorization: userAuthorization === "unknown" || userAuthorization === "low" || userAuthorization === "medium" || userAuthorization === "high"
      ? userAuthorization
      : null,
    rationale: string(source.rationale),
    action: automaticApprovalReviewAction(source.action),
    decisionSource: source.decisionSource === "agent" ? "agent" : null,
  };
}

function automaticApprovalReviews(
  value: unknown,
  context: TimelineProjectionContext,
): readonly AutomaticApprovalReview[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): AutomaticApprovalReview[] => {
    const review = automaticApprovalReview(entry, context);
    return review === null || review.status === "approved" ? [] : [review];
  });
}

function fileChanges(value: unknown): readonly FileChange[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry): FileChange => {
    const source = record(entry);
    const rawKind = string(source.kind) ?? string(source.type) ?? string(source.status);
    const diff = string(source.diff) ?? string(source.unifiedDiff) ?? string(source.unified_diff);
    const additions = diff === null ? number(source.additions) : diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const deletions = diff === null ? number(source.deletions) : diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const kind = rawKind === "add" || rawKind === "added" ? "add"
      : rawKind === "modify" || rawKind === "modified" || rawKind === "update" || rawKind === "updated" ? "modify"
      : rawKind === "delete" || rawKind === "deleted" ? "delete"
      : "unknown";
    return {
      path: string(source.path) ?? string(source.file) ?? "Unknown file",
      kind,
      additions,
      deletions,
      unifiedDiff: diff,
      movePath: string(source.movePath) ?? string(source.move_path),
    };
  });
}

function todoEntries(value: unknown): readonly TodoEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index): TodoEntry => {
    const source = record(entry);
    const rawStatus = string(source.status);
    return {
      id: string(source.id) ?? `todo-${index}`,
      text: string(source.step) ?? string(source.text) ?? string(source.title) ?? textFrom(source.content),
      status: rawStatus === "completed" || rawStatus === "complete" ? "complete"
        : rawStatus === "inProgress" || rawStatus === "in-progress" ? "in-progress"
        : "pending",
    };
  });
}

function questionOptions(value: unknown): readonly QuestionOption[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index): QuestionOption => {
    if (typeof entry === "string") return { id: String(index), label: entry, description: null };
    const source = record(entry);
    return {
      id: string(source.id) ?? string(source.value) ?? String(index),
      label: string(source.label) ?? string(source.title) ?? String(source.value ?? index),
      description: string(source.description),
    };
  });
}

function userInputQuestions(value: unknown): readonly UserInputQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index): UserInputQuestion[] => {
    const source = record(entry);
    const id = string(source.id) ?? String(index);
    const prompt = string(source.prompt) ?? string(source.question);
    if (prompt === null) return [];
    return [{
      id,
      header: string(source.header),
      prompt,
      options: questionOptions(source.options),
      ...userInputQuestionExtensions(source),
      isOther: boolean(source.isOther) ?? false,
      isSecret: boolean(source.isSecret) ?? false,
    }];
  });
}

const AUTOMATION_UPDATE_MODES = new Map<string, Extract<TimelineBlock, { type: "automation-update" }>["mode"]>([
  ["view", "view"],
  ["create", "create"],
  ["update", "update"],
  ["delete", "delete"],
  ["suggested_create", "suggested-create"],
  ["suggested-create", "suggested-create"],
  ["suggested_update", "suggested-update"],
  ["suggested-update", "suggested-update"],
]);

function automationKind(value: unknown): Extract<TimelineBlock, { type: "automation-update" }>["kind"] {
  return value === "cron" || value === "heartbeat" ? value : null;
}

function automationResultMode(value: unknown): Extract<TimelineBlock, { type: "automation-update" }>["resultMode"] {
  return value === "create" || value === "update" || value === "delete" ? value : null;
}

function parseJsonRecord(value: unknown): RecordValue {
  if (typeof value !== "string") return {};
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function automationToolResult(source: RecordValue): RecordValue {
  const direct = record(source.result);
  if (string(direct.automationId) !== null || string(direct.mode) !== null || record(direct.snapshot).name !== undefined) return direct;
  const candidates = [source.contentItems, direct.contentItems, direct.content];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      const content = record(entry);
      if (content.type !== "inputText") continue;
      const parsed = parseJsonRecord(content.text);
      if (Object.keys(parsed).length > 0) return parsed;
    }
  }
  return {};
}

function projectAutomationUpdate(
  item: TimelineSourceItem,
  source: RecordValue,
): TimelineItemProjection | null {
  const input = record(source.arguments ?? source.input);
  const mode = AUTOMATION_UPDATE_MODES.get(string(input.mode) ?? "") ?? null;
  if (mode === null || source.success !== true || executionStatus(source.status) !== "complete") return null;
  const id = nonEmptyString(input.id);
  const kind = automationKind(input.kind);
  const requiresId = mode === "view" || mode === "update" || mode === "delete" || mode === "suggested-update";
  const requiresBody = mode === "create" || mode === "update" || mode === "suggested-create" || mode === "suggested-update";
  if ((requiresId && id === null) || (requiresBody && (kind === null || nonEmptyString(input.name) === null || nonEmptyString(input.prompt) === null || nonEmptyString(input.rrule) === null))) return null;
  const result = automationToolResult(source);
  const snapshotSource = record(result.snapshot);
  const snapshot = Object.keys(snapshotSource).length === 0 ? null : {
    kind: automationKind(snapshotSource.kind),
    name: nonEmptyString(snapshotSource.name),
    rrule: nonEmptyString(snapshotSource.rrule),
  };
  const resultMode = automationResultMode(result.mode);
  return {
    lane: "assistant",
    block: {
      ...blockBase(item, "automation-update"),
      callId: string(source.callId) ?? item.id,
      automationId: nonEmptyString(result.automationId) ?? id,
      mode,
      resultMode,
      deleteStatus: nonEmptyString(result.deleteStatus),
      kind,
      name: nonEmptyString(input.name),
      rrule: nonEmptyString(input.rrule),
      snapshot,
      input,
    },
    anchors: [{ type: "call", id: string(source.callId) ?? item.id }],
  };
}

function orchestrationSubagent(item: TimelineSourceItem, source: RecordValue, context: TimelineProjectionContext): TimelineItemProjection | null {
  const tool = string(source.tool) ?? string(source.name);
  const tools = {thread_spawn:"spawnAgent",thread_tell:"sendInput",thread_inspect:null,thread_wait:"wait"} as const;
  if (source.namespace || tool === null || !(tool in tools)) return null;
  const args = record(source.arguments);
  let receipt: RecordValue = {};
  // The Native transcript cache preserves the exact server tool receipt.
  for (const content of Array.isArray(source.contentItems) ? source.contentItems : []) {
    const text = string(record(content).text);
    if (text !== null) try { receipt = record(JSON.parse(text)); break; } catch { /* Non-JSON output has no control facts. */ }
  }
  const ids = [...stringArray(args.threadIds)];
  const single = string(receipt.threadId) ?? string(args.threadId);
  if (single !== null && !ids.includes(single)) ids.push(single);
  const states = Object.fromEntries((Array.isArray(receipt.threads) ? receipt.threads : []).flatMap(value => {
    const state = record(value), id = string(state.threadId);
    return id === null ? [] : [[id,{status:state.state ?? state.status}]];
  }));
  if (single !== null && receipt.status !== undefined) states[single] = {status:receipt.status};
  const toolCallStatus = source.success === false ? "failed" : executionStatus(source.status);
  return {lane:"assistant",block:{...blockBase(item,"subagent"),
    toolCallStatus,deliveryStatus:null,childRuntimeStatus:null,controlCall:{turnId:context.turn.id,itemId:item.id},
    agentId:ids[0] ?? null,label:string(args.title) ?? "Agent",action:"",tool:tools[tool as keyof typeof tools],
    senderThreadId:null,receiverThreadIds:ids,prompt:string(args.prompt) ?? string(args.message),
    model:string(args.model),reasoningEffort:string(args.reasoningEffort),agentStates:states,
    activityKind:null,agentPath:null,status:toolCallStatus}};
}

export function createBuiltinTimelineProjectors(): readonly TimelineItemProjector[] {
  return [
    simpleProjector("user-message", ["userMessage"], (item, source, context) => {
      const rawContent = source.content ?? source.input ?? source.text ?? source.message;
      const realtime = parseRealtimeDelegation(rawContent);
      if (realtime !== null) {
        return {
          lane: "assistant",
          block: {
            ...blockBase(item, "realtime-transcript"),
            handoffId: (source.__opencraftTurnParamsMessage ?? source.__velaTurnParamsMessage) === true ? null : realtimeDelegationHandoffId(item.id),
            entries: realtime.transcript,
          },
        };
      }
      const content = userMessageContent(rawContent);
      const attachments = userMessageAttachments(source, content);
      const metadata = userMessageMetadata(source, content, attachments, context);
      const messageKind = (source.__opencraftMessageKind ?? source.__velaMessageKind) === "steering" ? "steering" : "user";
      return {
        lane: messageKind === "steering" ? "assistant" : "user",
        block: {
          ...blockBase(item, "user-message"),
          ...metadata,
          content,
          attachments,
          messageKind,
          clientId: string(source.clientId) ?? string(source.clientUserMessageId),
          steeringStatus: messageKind === "steering"
            ? steeringStatus(source.__opencraftSteeringStatus ?? source.__velaSteeringStatus ?? source.steeringStatus ?? source.status) ?? "accepted"
            : null,
        },
        anchors: string(source.clientId) === null && string(source.clientUserMessageId) === null
          ? undefined
          : [{ type: "message", id: string(source.clientId) ?? string(source.clientUserMessageId)! }],
      };
    }),
    simpleProjector("steering-user-message", ["steeringUserMessage"], (item, source, context) => {
      const rawContent = source.input ?? source.content ?? source.text ?? source.message;
      const realtime = parseRealtimeDelegation(rawContent);
      if (realtime !== null) {
        return {
          lane: "assistant",
          block: {
            ...blockBase(item, "realtime-transcript"),
            handoffId: realtimeDelegationHandoffId(item.id),
            entries: realtime.transcript,
          },
        };
      }
      const content = userMessageContent(rawContent);
      const attachments = userMessageAttachments(source, content);
      const metadata = userMessageMetadata(source, content, attachments, context);
      return {
        lane: "assistant",
        block: {
          ...blockBase(item, "user-message"),
          ...metadata,
          content,
          attachments,
          messageKind: "steering",
          clientId: string(source.clientId) ?? string(source.clientUserMessageId),
          steeringStatus: steeringStatus(source.status),
        },
        anchors: string(source.clientId) === null && string(source.clientUserMessageId) === null
          ? undefined
          : [{ type: "message", id: string(source.clientId) ?? string(source.clientUserMessageId)! }],
      };
    }),
    simpleProjector("hook-prompt", ["hookPrompt"], (item, source, context) => {
      const content = hookPromptContent(source);
      const attachments = userMessageAttachments(source, content);
      const metadata = userMessageMetadata(source, content, attachments, context);
      return {
        lane: "assistant",
        block: {
          ...blockBase(item, "user-message"),
          ...metadata,
          content,
          attachments,
          messageKind: "hook-prompt",
          clientId: null,
          steeringStatus: null,
          sentAtMs: null,
          hookFeedback: true,
        },
      };
    }),
    simpleProjector("assistant-message", ["agentMessage", "assistantMessage"], (item, source, context) => ({
      lane: "assistant",
      block: {
        ...blockBase(item, "text"),
        text: textFrom(source.content ?? source.text ?? source.message),
        streaming: !isDisplayItemCompleted(source, context),
        asyncQuestions: source.delivery === "async" ? projectAsyncQuestions(item.id, source.questions) : [],
        delivery: source.delivery === "async" ? "async" : null,
        completed: isDisplayItemCompleted(source, context),
        sentAtMs: number(source.sentAtMs) ?? number(source.startedAtMs) ??
          (context.itemIndex === context.turn.items.map((candidate) => candidate.type === "agentMessage" || candidate.type === "assistantMessage").lastIndexOf(true)
            ? context.turn.finalAssistantStartedAtMs ?? null : null),
        hasStructuredOutput: source.structuredOutput != null,
        phase: source.phase === "commentary" || source.phase === "final_answer" ? source.phase : null,
      },
    })),
    simpleProjector("reasoning", ["reasoning"], (item, source) => ({
      lane: "assistant",
      block: {
        ...blockBase(item, "reasoning"),
        summary: textFrom(source.summary),
        detail: string(source.detail) ?? (textFrom(source.content) || null),
        streaming: stateStatus(source.status) === "streaming" || boolean(source.completed) === false,
      },
    })),
    simpleProjector("command-execution", ["commandExecution"], (item, source, context) => ({
      lane: "assistant",
      block: {
        ...blockBase(item, "command-execution"),
        resultMissing: source.resultMissing === true,
        callId: string(source.callId) ?? item.id,
        command: textFrom(source.command ?? source.commandLine),
        cwd: string(source.cwd),
        processId: string(source.processId),
        startedAtMs: number(source.startedAtMs),
        turnInProgress: context.turn.status === "pending" || context.turn.status === "streaming",
        output: string(source.aggregatedOutput) ?? string(source.output),
        exitCode: number(source.exitCode),
        durationMs: number(source.durationMs),
        actions: commandActions(source.commandActions ?? source.parsedCmd),
        automaticApprovalReviews: automaticApprovalReviews(source.automaticApprovalReviews, context),
        status: executionStatus(source.status),
      },
      anchors: string(source.callId) === null ? undefined : [{ type: "call", id: string(source.callId)! }],
    })),
    simpleProjector("file-change", ["fileChange"], (item, source, context) => ({
      lane: "assistant",
      block: {
        ...blockBase(item, "patch"),
        title: string(source.title) ?? "Changed files",
        changes: fileChanges(source.changes),
        automaticApprovalReviews: automaticApprovalReviews(source.automaticApprovalReviews, context),
        status: executionStatus(source.status),
      },
    })),
    simpleProjector("turn-diff", ["turnDiff"], (item, source, context) => {
      const unifiedDiff = string(source.unifiedDiff) ?? string(source.diff) ?? "";
      const summary = summarizeTurnDiff(unifiedDiff);
      return {
        lane: "assistant",
        block: {
          ...blockBase(item, "turn-diff"),
          unifiedDiff,
          files: summary.files,
          additions: summary.additions,
          deletions: summary.deletions,
          status: context.turn.status === "pending" || context.turn.status === "streaming"
            ? "running"
            : context.turn.status === "failed"
              ? "failed"
              : context.turn.status === "interrupted"
                ? "interrupted"
                : "complete",
        },
      };
    }),
    simpleProjector("tool-call", ["mcpToolCall", "dynamicToolCall", "webSearch", "imageView", "sleep"], (item, source, context) => {
      const collaboration = item.type === "dynamicToolCall" ? orchestrationSubagent(item,source,context) : null;
      if (collaboration !== null) return collaboration;
      const appContext = record(source.appContext);
      const managedApp = (() => {
        if (item.type !== "dynamicToolCall" || !((source.namespace === MCP_APPS_NAMESPACE && (source.tool ?? source.name) === "manage")
          || (source.namespace === "deepseek-harness" && source.tool === `${MCP_APPS_NAMESPACE}__manage`))) return null;
        const text = Array.isArray(source.contentItems) ? source.contentItems.find(v => record(v).type === "inputText") : null;
        const output = record(text).text;
        if (typeof output !== "string" || output.length > 262144) return null;
        try { return appEnvelope(JSON.parse(output)); } catch { return null; }
      })();
      const appResourceUri = managedApp?.resourceUri ?? string(record(source.mcpAppUi).resourceUri) ?? string(appContext.resourceUri) ?? string(source.mcpAppResourceUri);
      const error = record(source.error);
      const result = record(source.result);
      const resultMeta = record(result._meta);
      const toolSurface = record(resultMeta["codex/toolSurface"]);
      const sourceKind = toolSurface.kind === "browserUse" || toolSurface.kind === "computerUse"
        ? toolSurface.kind
        : null;
      const sourceBackend = sourceKind === "browserUse"
        && (toolSurface.backend === "chrome" || toolSurface.backend === "iab" || toolSurface.backend === "cdp")
        ? toolSurface.backend
        : null;
      const toolSurfaceApp = record(toolSurface.app);
      const sourceApp = sourceKind !== "computerUse"
        ? null
        : toolSurfaceApp.kind === "appId" && string(toolSurfaceApp.appId) !== null
          ? { kind: "appId" as const, appId: string(toolSurfaceApp.appId)! }
          : toolSurfaceApp.kind === "displayName" && string(toolSurfaceApp.displayName) !== null
            ? { kind: "displayName" as const, displayName: string(toolSurfaceApp.displayName)! }
            : null;
      const screenshot = record(toolSurface.screenshot);
      const browserUseMeta = record(resultMeta.browser_use);
      const sourcePageUrl = sourceKind === "browserUse"
        ? string(screenshot.pageUrl) ?? string(browserUseMeta.url)
        : null;
      const webMcpCalls = sourceKind === "browserUse"
        ? webMcpToolSurfaceCalls(toolSurface.webMcpCalls)
        : [];
      const kind = managedApp || item.type === "mcpToolCall" ? "mcp"
        : item.type === "webSearch" ? "web-search"
        : item.type === "imageView" ? "image-view"
        : "dynamic";
      if (item.type === "dynamicToolCall" && (string(source.tool) ?? string(source.name)) === "automation_update") {
        const automationUpdate = projectAutomationUpdate(item, source);
        if (automationUpdate !== null) return automationUpdate;
      }
      const callId = string(source.callId) ?? item.id;
      const finalNonUserItemIndex = lastNonUserItemIndex(context.turn.items);
      const webSearchIsLive = item.type === "webSearch"
        && (context.turn.status === "pending" || context.turn.status === "streaming")
        && context.itemIndex === finalNonUserItemIndex;
      const status = item.type === "webSearch"
        ? (webSearchIsLive ? "running" : "complete")
        : item.type === "sleep" || item.type === "imageView" ? "complete"
        : executionStatus(source.status);
      const succeeded = boolean(source.success);
      return {
        lane: "assistant",
        block: {
          ...blockBase(item, "tool-call"),
          callId,
          kind,
          activityPresentation: (() => {
            const display = record(source.activityPresentation);
            if (display.grouping !== "groupable" && display.grouping !== "standalone") return null;
            return { grouping: display.grouping,
              operation: display.operation === "read" || display.operation === "search" ? display.operation : "other" as const,
              icon: display.icon === "read" || display.icon === "search" ? display.icon : "wrench" as const,
              active: string(display.active), completed: string(display.completed), hidden: display.hidden === true };
          })(),
          toolContext: string(source.toolContext),
          resultMissing: source.resultMissing === true,
          toolSummary: string(source.toolSummary),
          progressText: string(source.progressText),
          inlineDiff: string(source.inlineDiff),
          name: item.type === "sleep" ? "sleep"
            : item.type === "imageView" ? "view_image"
            : string(source.tool) ?? string(source.name) ?? (kind === "web-search" ? "Web search" : item.type),
          server: managedApp?.server ?? string(source.server) ?? string(source.serverName),
          namespace: item.type === "sleep" ? "clock" : item.type === "imageView" ? "vision" : string(source.namespace),
          input: item.type === "sleep" ? null : item.type === "imageView" ? { path: source.path ?? null } : kind === "web-search"
            ? { query: source.query ?? null, action: source.action ?? null }
            : (source.arguments ?? source.input ?? null),
          output: item.type === "imageView" ? null : source.structuredResult ?? source.result ?? source.contentItems ?? source.results ?? source.output ?? null,
          errorMessage: string(error.message),
          durationMs: number(source.durationMs),
          readOnlyHint: item.type === "imageView" ? true : boolean(source.readOnlyHint),
          appResourceUri,
          appToolResult: kind === "mcp" && appResourceUri !== null
            ? managedApp?.result ?? source.result ?? source.structuredResult ?? null : undefined,
          appName: string(record(record(managedApp?.result).structuredContent).title) ?? string(appContext.appName),
          actionName: managedApp ? "Open App" : string(appContext.actionName),
          pluginId: string(source.pluginId),
          sourceKind,
          sourceBackend,
          sourceApp,
          sourcePageUrl,
          webMcpCalls,
          imagePaths: item.type === "imageView"
            ? (string(source.path) === null ? [] : [string(source.path)!])
            : undefined,
          automaticApprovalReviews: automaticApprovalReviews(source.automaticApprovalReviews, context),
          status: succeeded === false ? "failed" : status,
        },
        anchors: [{ type: "call", id: callId }],
      };
    }),
    simpleProjector("automatic-approval-review", ["automaticApprovalReview", "automatic-approval-review"], (item, source, context) => {
      const review = automaticApprovalReview(source, context) ?? {
        id: item.id,
        targetItemId: null,
        startedAtMs: 0,
        completedAtMs: null,
        status: "aborted" as const,
        riskLevel: null,
        userAuthorization: null,
        rationale: null,
        action: null,
        decisionSource: null,
      };
      return {
        lane: "assistant",
        block: { ...blockBase(item, "automatic-approval-review"), review },
      };
    }),
    simpleProjector("auto-review-interruption-warning", ["autoReviewInterruptionWarning", "auto-review-interruption-warning"], (item) => ({
      lane: "assistant",
      block: {
        ...blockBase(item, "auto-review-interruption-warning"),
        message: "Turn ended by Auto-review",
        detail: "Auto-review stopped this turn after repeated denials. Add more context or choose a different permission mode to continue.",
      },
    })),
    simpleProjector("plan", ["plan", "proposedPlan"], (item, source, context) => ({
      lane: "assistant",
      block: {
        ...blockBase(item, "plan"),
        title: string(source.title),
        text: textFrom(source.plan ?? source.content ?? source.text),
        completed: isDisplayItemCompleted(source, context),
      },
    })),
    simpleProjector("plan-implementation", ["planImplementation"], (item, source) => ({
      lane: "assistant",
      block: {
        ...blockBase(item, "plan-implementation"),
        turnId: string(source.turnId),
        planContent: textFrom(source.planContent),
        isCompleted: source.isCompleted === true,
      },
    })),
    simpleProjector("todo", ["todo-list", "todoList"], (item, source) => ({
      lane: "assistant",
      block: { ...blockBase(item, "todo"), explanation: string(source.explanation), entries: todoEntries(source.plan ?? source.items ?? source.todos) },
    })),
    simpleProjector("subagent", ["collabAgentToolCall", "subAgentActivity", "multiAgentAction"], (item, source) => ({
      lane: "assistant",
      block: {
        ...blockBase(item, "subagent"),
        toolCallStatus: item.type === "subAgentActivity" ? source.kind === "interrupted" ? "interrupted" : "complete" : executionStatus(source.status),
        deliveryStatus:null,childRuntimeStatus:null,controlCall:null,
        agentId: string(source.agentId) ?? stringArray(source.receiverThreadIds)[0] ?? string(source.agentThreadId),
        label: string(source.agentName) ?? string(source.label) ?? "Agent",
        action: textFrom(source.action ?? source.content ?? source.message ?? source.prompt),
        tool: source.tool === "spawnAgent" || source.tool === "sendInput" || source.tool === "resumeAgent" || source.tool === "wait" || source.tool === "closeAgent" ? source.tool : null,
        senderThreadId: string(source.senderThreadId),
        receiverThreadIds: stringArray(source.receiverThreadIds),
        prompt: string(source.prompt),
        model: string(source.model),
        reasoningEffort: string(source.reasoningEffort),
        agentStates: source.agentsStates ?? null,
        activityKind: source.kind === "started" || source.kind === "interacted" || source.kind === "interrupted" ? source.kind : null,
        agentPath: string(source.agentPath),
        status: item.type === "subAgentActivity"
          ? source.kind === "interrupted" ? "interrupted" : "complete"
          : executionStatus(source.status),
      },
    })),
    simpleProjector("approval", ["permissionRequest", "requestApproval", "interaction:approval"], (item, source) => ({
      lane: "interaction",
      block: {
        ...blockBase(item, "approval"),
        requestId: string(source.requestId) ?? item.id,
        targetItemId: string(source.itemId),
        method: string(source.method),
        approvalKind: source.approvalKind === "command" || source.approvalKind === "file-change" || source.approvalKind === "permissions"
          ? source.approvalKind
          : "generic",
        title: string(source.title) ?? "Approval required",
        detail: string(source.detail) ?? string(source.command),
        reason: string(source.reason),
        command: string(source.command),
        cwd: string(source.cwd),
        grantRoot: string(source.grantRoot),
        permissions: source.permissions ?? null,
        networkApprovalContext: approvalNetworkContext(source.networkApprovalContext),
        proposedExecpolicyAmendment: stringArray(source.proposedExecpolicyAmendment),
        proposedNetworkPolicyAmendments: approvalNetworkPolicyAmendments(source.proposedNetworkPolicyAmendments),
        additionalPermissions: source.additionalPermissions ?? null,
        availableDecisions: stringArray(source.availableDecisions),
        ...(source.approvalScopes === undefined ? {} : {
          approvalScopes: stringArray(source.approvalScopes).filter((scope): scope is "once" | "session" | "always" | "deny" =>
            scope === "once" || scope === "session" || scope === "always" || scope === "deny"),
        }),
        state: source.state === "accepted" || source.state === "declined" || source.state === "cancelled" ? source.state : "pending",
      },
      anchors: [{ type: "request", id: string(source.requestId) ?? item.id }],
    })),
    simpleProjector("question", ["userInputRequest", "requestUserInput", "interaction:question"], (item, source) => {
      const requestId = string(source.requestId) ?? item.id;
      const projectedQuestions = userInputQuestions(source.questions);
      const questions = projectedQuestions.length > 0 ? projectedQuestions : [{
        id: string(source.questionId) ?? requestId,
        header: string(source.header),
        prompt: string(source.prompt) ?? string(source.question) ?? "Input required",
        options: questionOptions(source.options),
        ...userInputQuestionExtensions(source),
        isOther: boolean(source.isOther) ?? questionOptions(source.options).length === 0,
        isSecret: boolean(source.isSecret) ?? false,
      }];
      return {
        lane: "interaction",
        block: {
          ...blockBase(item, "question"),
          requestId,
          targetItemId: string(source.itemId),
          method: string(source.method),
          questions,
          state: source.state === "answered" || source.state === "cancelled" ? source.state : "pending",
        },
        anchors: [{ type: "request", id: requestId }],
      };
    }),
    simpleProjector("option-picker", ["interaction:option-picker"], (item, source) => {
      const requestId = string(source.requestId) ?? item.id;
      return {
        lane: "interaction",
        block: {
          ...blockBase(item, "option-picker"),
          requestId,
          targetItemId: string(source.itemId),
          method: source.method === "item/tool/requestOptionPicker" ? "item/tool/requestOptionPicker" : "item/tool/call",
          question: string(source.question) ?? "Choose an option",
          options: questionOptions(source.options),
          allowMultiple: boolean(source.allowMultiple) ?? false,
          submitLabel: string(source.submitLabel),
          skipLabel: string(source.skipLabel),
          state: source.state === "answered" || source.state === "cancelled" ? source.state : "pending",
        },
        anchors: [{ type: "request", id: requestId }],
      };
    }),
    // Accept old read-model input; all newly projected blocks use the owned type.
    simpleProjector("setup-step", ["interaction:setup-step", "interaction:setup-codex-step"], (item, source) => {
      const requestId = string(source.requestId) ?? item.id;
      const step = source.step === "task" || source.step === "context" ? source.step : "role";
      return {
        lane: "interaction",
        block: {
          ...blockBase(item, "setup-step"),
          requestId,
          targetItemId: string(source.itemId),
          method: "item/tool/call",
          step,
          state: source.state === "answered" || source.state === "cancelled" ? source.state : "pending",
        },
        anchors: [{ type: "request", id: requestId }],
      };
    }),
    simpleProjector("setup-context-picker", ["interaction:setup-context-picker"], (item, source) => {
      const requestId = string(source.requestId) ?? item.id;
      return {
        lane: "interaction",
        block: {
          ...blockBase(item, "setup-context-picker"),
          requestId,
          targetItemId: string(source.itemId),
          method: source.method === "item/tool/requestSetupCodexContextPicker"
            ? "item/tool/requestSetupCodexContextPicker"
            : "item/tool/call",
          state: source.state === "answered" || source.state === "cancelled" ? source.state : "pending",
        },
        anchors: [{ type: "request", id: requestId }],
      };
    }),
    simpleProjector("elicitation", ["mcpServerElicitation", "interaction:elicitation"], (item, source) => {
      const requestId = string(source.requestId) ?? item.id;
      const mode = source.mode === "url" || source.mode === "openai/form" ? source.mode : "form";
      const metadata = normalizeMcpElicitationMetadata(mode, source._meta, {
        serverName: string(source.serverName),
        message: string(source.message),
        requestedSchema: source.requestedSchema,
      });
      return {
        lane: "interaction",
        block: {
          ...blockBase(item, "elicitation"),
          requestId,
          targetItemId: string(source.itemId),
          method: "mcpServer/elicitation/request",
          serverName: string(source.serverName),
          message: string(source.message) ?? "MCP server requests input",
          mode,
          requestedSchema: source.requestedSchema ?? null,
          url: string(source.url),
          elicitationId: string(source.elicitationId),
          ...metadata,
          state: source.state === "accepted" || source.state === "declined" || source.state === "cancelled" ? source.state : "pending",
        },
        anchors: [{ type: "request", id: requestId }],
      };
    }),
    simpleProjector("error", ["error", "streamError", "systemError"], (item, source) => ({
      lane: "event",
      block: {
        ...blockBase(item, "error"),
        code: string(source.code) ?? string(source.errorInfo) ?? string(source.codexErrorInfo) ??
          Object.keys(record(source.errorInfo ?? source.codexErrorInfo))[0] ?? null,
        message: string(source.message) ?? (textFrom(source.error ?? source.content) || "Unknown error"),
        recovery: source.willRetry === true || item.type === "streamError" ? "automatic" : "terminal",
        additionalDetails: string(source.additionalDetails),
      },
    })),
    simpleProjector("compaction", ["contextCompaction"], (item, source, context) => ({
      // Context compaction participates in the Turn-level Activity plan. The
      // renderer suppresses a redundant Worked-for toggle when it is the only
      // collapsible item in the fixed presentation slot.
      lane: "assistant",
      block: { ...blockBase(item, "compaction"), summary: string(source.summary),
        // Unlike streamed text, historical compaction items can omit this flag.
        // Only an explicit false on an active Turn denotes ongoing compaction.
        completed: (context.turn.status !== "streaming" && context.turn.status !== "pending") || source.completed !== false,
        source: source.source === "manual" ? "manual" : "automatic" },
    })),
    simpleProjector("image", ["imageGeneration"], (item, source) => ({
      lane: "assistant",
      block: {
        ...blockBase(item, "image"),
        uri: generatedImageUri(source),
        alt: string(source.alt) ?? string(source.title) ?? string(source.revisedPrompt),
        generated: true,
        savedPath: string(source.savedPath),
        transparentBackground: boolean(source.transparentBackground) ?? false,
        failure: (() => {
          const failure = record(source.failure);
          const type = string(failure.type);
          return type === null ? null : {
            type,
            limitId: string(failure.limitId),
            resetsAt: number(failure.resetsAt),
          };
        })(),
        status: executionStatus(source.status),
      },
    })),
  ];
}

export function createDefaultTimelineProjectorRegistry(): TimelineProjectorRegistry {
  const registry = new TimelineProjectorRegistry();
  registry.registerAll(createBuiltinTimelineProjectors());
  return registry;
}
