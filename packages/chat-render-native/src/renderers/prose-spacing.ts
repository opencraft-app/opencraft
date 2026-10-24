import type { ChatDocumentDialect, ChatDocumentNode } from "@opencraft/chat-document";
import { containsHanText } from "@opencraft/chat-render-react";

type NodeKind = ChatDocumentNode["kind"];

export interface NativeParagraphPosition {
  readonly parentKind: NodeKind | null;
  readonly previousSiblingKind: NodeKind | null;
  readonly nextSiblingKind: NodeKind | null;
  readonly nextSibling?: ChatDocumentNode | null;
}

/** Mirrors Web's user-message paragraph rhythm without adding trailing bubble space. */
export function nativeParagraphSpacing(
  dialect: ChatDocumentDialect | undefined,
  position: NativeParagraphPosition | undefined,
  paragraph?: Extract<ChatDocumentNode, { kind: "paragraph" }>,
): { marginTop: number; marginBottom: number } {
  if (dialect === "user-message") {
    return {
      marginTop: position?.previousSiblingKind === "paragraph" && position.parentKind !== "list-item" ? 20 : 0,
      marginBottom: 0,
    };
  }
  if (position?.parentKind === "blockquote") return { marginTop: 0, marginBottom: 0 };
  if (position?.parentKind === "list-item") return {
    marginTop: position.previousSiblingKind === "paragraph" ? 11 : 0,
    marginBottom: 0,
  };
  const next = position?.nextSibling;
  const consecutiveHanParagraphs = position?.parentKind === null
    && paragraph !== undefined
    && containsHanText(paragraph.children)
    && next?.kind === "paragraph"
    && containsHanText(next.children);
  return { marginTop: 0, marginBottom: position?.nextSiblingKind === null ? 0 : consecutiveHanParagraphs ? 4 : 10 };
}

/** Web removes the outer margins of the first and last Markdown block. */
export function nativeHeadingSpacing(position: NativeParagraphPosition | undefined, dialect?: ChatDocumentDialect): { marginTop: number; marginBottom: number } {
  return {
    marginTop: position?.previousSiblingKind === null || position?.previousSiblingKind === "horizontal-rule"
      ? 0 : Math.max(0, 20 - precedingNativeBlockMargin(position, dialect)),
    marginBottom: position?.nextSiblingKind === null ? 0 : 10,
  };
}

export function nativeRuleSpacing(position: NativeParagraphPosition | undefined, dialect?: ChatDocumentDialect): { marginTop: number; marginBottom: number } {
  return {
    marginTop: position?.previousSiblingKind === null || position?.previousSiblingKind === "horizontal-rule"
      ? 0 : Math.max(0, 28 - precedingNativeBlockMargin(position, dialect)),
    marginBottom: position?.nextSiblingKind === null ? 0 : 28,
  };
}

/** CSS block margins collapse; RN View margins add. Account for the previous
 * block's Native trailing margin at the document level. */
function precedingNativeBlockMargin(position: NativeParagraphPosition | undefined, dialect?: ChatDocumentDialect): number {
  if (position?.parentKind !== null) return 0;
  switch (position.previousSiblingKind) {
    case "paragraph":
    case "list": return dialect === "user-message" ? 0 : 10;
    case "heading": return 10;
    case "blockquote": return 8;
    case "code-fence":
    case "table":
    case "math": return 9;
    default: return 0;
  }
}
