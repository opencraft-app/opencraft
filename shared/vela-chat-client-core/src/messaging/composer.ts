import type {ConversationAddress} from "./conversation.js";
import type {MessageQuote, MessageSubmissionReference} from "./model.js";
import type {AttachmentSource, MessageMention} from "./port.js";

export interface ComposerTextNode {
  text: string;
  type: "text";
}

export interface ComposerMentionNode {
  displayName: string;
  handle: string;
  imUserId: string;
  memberId: string;
  memberKind: "human" | "agent";
  type: "mention";
}

export type ComposerNode = ComposerTextNode | ComposerMentionNode;

export interface ComposerDocument {
  nodes: ComposerNode[];
  version: 1;
}

export interface ComposerEditorCursor {
  end: number;
  start: number;
}

export interface ComposerMentionTrigger {
  end: number;
  query: string;
  start: number;
}

export interface ComposerAttachmentDraft {
  id: string;
  kind: "file" | "image";
  mimeType?: string;
  name: string;
  previewUri?: string;
  size?: number;
  source: AttachmentSource;
}

export interface ComposerDraft {
  attachments: ComposerAttachmentDraft[];
  document: ComposerDocument;
  quote?: MessageQuote;
}

export type SubmissionPartStatus =
  | "queued"
  | "sending"
  | "reconciling"
  | "sent"
  | "failed"
  | "cancelled";

interface ComposerSubmissionPartBase {
  clientRequestId: string;
  error?: string;
  messageId?: string;
  quote?: MessageQuote;
  retryable?: boolean;
  status: SubmissionPartStatus;
  submission: MessageSubmissionReference;
}

export interface ComposerAttachmentPart extends ComposerSubmissionPartBase {
  attachment: ComposerAttachmentDraft;
  role: "attachment";
}

export interface ComposerCommitPart extends ComposerSubmissionPartBase {
  mentions: MessageMention[];
  role: "commit";
  text: string;
}

export type ComposerSubmissionPart =
  | ComposerAttachmentPart
  | ComposerCommitPart;

export interface ComposerSubmission {
  attachments: ComposerAttachmentDraft[];
  channel: ConversationAddress;
  conversationKey: string;
  document: ComposerDocument;
  id: string;
  parts: ComposerSubmissionPart[];
  phase: "queued" | "sending" | "blocked" | "committed" | "cancelled";
  quote?: MessageQuote;
}

export interface PlanComposerSubmissionInput {
  channel: ConversationAddress;
  clientRequestIds: string[];
  conversationKey: string;
  draft: ComposerDraft;
  submissionId: string;
}

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVISIBLE_TEXT = /[\s\u200b-\u200d\ufeff]/gu;

export function createComposerDocument(
  nodes: readonly ComposerNode[] = [],
): ComposerDocument {
  const normalized: ComposerNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (!node.text) continue;
      const previous = normalized.at(-1);
      if (previous?.type === "text") {
        previous.text += node.text;
      } else {
        normalized.push({text: node.text, type: "text"});
      }
      continue;
    }
    normalized.push({...node});
  }
  return {nodes: normalized, version: 1};
}

export function createComposerTextDocument(text = ""): ComposerDocument {
  return createComposerDocument(text ? [{text, type: "text"}] : []);
}

export function composerDocumentText(document: ComposerDocument): string {
  return document.nodes
    .map((node) =>
      node.type === "text" ? node.text : `@${node.displayName}`,
    )
    .join("");
}

export function composerDocumentHasContent(document: ComposerDocument): boolean {
  return document.nodes.some(
    (node) =>
      node.type === "mention" || node.text.replace(INVISIBLE_TEXT, "").length > 0,
  );
}

export function composerDocumentPreview(document: ComposerDocument): string {
  return composerDocumentText(document).replace(/\s+/gu, " ").trim();
}

export function composerDocumentMentions(
  document: ComposerDocument,
): MessageMention[] {
  const seen = new Set<string>();
  const mentions: MessageMention[] = [];
  for (const node of document.nodes) {
    if (node.type !== "mention" || seen.has(node.imUserId)) continue;
    seen.add(node.imUserId);
    mentions.push({
      displayName: node.displayName,
      imUserId: node.imUserId,
      memberId: node.memberId,
      memberKind: node.memberKind,
    });
  }
  return mentions;
}

export function readComposerMentionTrigger(
  text: string,
  selection: ComposerEditorCursor | null,
): ComposerMentionTrigger | null {
  if (!selection) return null;
  // IME composition often leaves a range selection over the composing glyphs.
  // Mentions still resolve from the caret end so `@` keeps working mid-pinyin.
  const cursor = Math.max(0, Math.min(text.length, selection.end));
  const prefix = text.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(prefix);
  if (!match) return null;
  const query = match[1] ?? "";
  return {end: cursor, query, start: cursor - query.length - 1};
}

export function replaceComposerDocumentRangeWithMention(input: {
  document: ComposerDocument;
  end: number;
  mention: ComposerMentionNode;
  start: number;
}): {cursor: number; document: ComposerDocument} {
  const textLength = composerDocumentText(input.document).length;
  const start = clampOffset(input.start, textLength);
  const end = Math.max(start, clampOffset(input.end, textLength));
  const before: ComposerNode[] = [];
  const after: ComposerNode[] = [];
  let offset = 0;

  for (const node of input.document.nodes) {
    const visible = node.type === "text" ? node.text : `@${node.displayName}`;
    const nodeStart = offset;
    const nodeEnd = nodeStart + visible.length;
    offset = nodeEnd;
    if (nodeEnd <= start) {
      before.push({...node});
      continue;
    }
    if (nodeStart >= end) {
      after.push({...node});
      continue;
    }
    if (node.type !== "text") continue;
    if (nodeStart < start) {
      before.push({text: node.text.slice(0, start - nodeStart), type: "text"});
    }
    if (nodeEnd > end) {
      after.push({text: node.text.slice(end - nodeStart), type: "text"});
    }
  }

  const trailingText = composerDocumentText(createComposerDocument(after));
  const needsSpace = trailingText.length === 0 || !/^\s/u.test(trailingText);
  const document = createComposerDocument([
    ...before,
    {...input.mention},
    ...(needsSpace ? [{text: " ", type: "text" as const}] : []),
    ...after,
  ]);
  return {
    cursor:
      composerDocumentText(createComposerDocument(before)).length +
      input.mention.displayName.length +
      1 +
      (needsSpace ? 1 : 0),
    document,
  };
}

export function planComposerSubmission(
  input: PlanComposerSubmissionInput,
): ComposerSubmission {
  if (!UUID_V7.test(input.submissionId)) {
    throw new TypeError("submissionId must be a UUIDv7");
  }
  if (input.draft.attachments.length > 9) {
    throw new RangeError("composer supports at most 9 attachments");
  }
  const hasCommit = composerDocumentHasContent(input.draft.document);
  const partCount = input.draft.attachments.length + (hasCommit ? 1 : 0);
  if (partCount === 0) {
    throw new TypeError("composer submission cannot be empty");
  }
  if (input.clientRequestIds.length !== partCount) {
    throw new RangeError(`composer submission requires ${partCount} clientRequestIds`);
  }
  for (const clientRequestId of input.clientRequestIds) {
    if (!UUID_V7.test(clientRequestId)) {
      throw new TypeError("clientRequestId must be a UUIDv7");
    }
  }

  const parts: ComposerSubmissionPart[] = input.draft.attachments.map(
    (attachment, index) => ({
      attachment: {...attachment},
      clientRequestId: input.clientRequestIds[index] as string,
      ...(input.draft.quote && !hasCommit && index === 0
        ? {quote: input.draft.quote}
        : {}),
      role: "attachment" as const,
      status: "queued" as const,
      submission: {
        count: partCount,
        final: !hasCommit && index === partCount - 1,
        id: input.submissionId,
        index,
        role: "attachment" as const,
      },
    }),
  );

  if (hasCommit) {
    const index = parts.length;
    parts.push({
      clientRequestId: input.clientRequestIds[index] as string,
      mentions: composerDocumentMentions(input.draft.document),
      ...(input.draft.quote ? {quote: input.draft.quote} : {}),
      role: "commit",
      status: "queued",
      submission: {
        count: partCount,
        final: true,
        id: input.submissionId,
        index,
        role: "commit",
      },
      text: composerDocumentText(input.draft.document).trim(),
    });
  }

  return {
    attachments: input.draft.attachments.map((attachment) => ({...attachment})),
    channel: input.channel,
    conversationKey: input.conversationKey,
    document: createComposerDocument(input.draft.document.nodes),
    id: input.submissionId,
    parts,
    phase: "queued",
    ...(input.draft.quote ? {quote: input.draft.quote} : {}),
  };
}

function clampOffset(value: number, length: number): number {
  if (!Number.isFinite(value)) return length;
  return Math.max(0, Math.min(length, Math.trunc(value)));
}
