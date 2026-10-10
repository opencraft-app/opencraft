import type { ChatDocumentNode } from "@opencraft/chat-document";

export type NativeMediaParagraphPart =
  | { readonly kind: "text"; readonly key: string; readonly nodes: readonly ChatDocumentNode[] }
  | { readonly kind: "image"; readonly key: string; readonly node: Extract<ChatDocumentNode, { kind: "image" }> };

/** Keep prose together for text selection while giving images their own block geometry. */
export function splitNativeMediaParagraph(nodes: readonly ChatDocumentNode[]): readonly NativeMediaParagraphPart[] {
  const parts: NativeMediaParagraphPart[] = [];
  let textNodes: ChatDocumentNode[] = [];
  const flushText = () => {
    if (textNodes.length === 0) return;
    parts.push({ kind: "text", key: textNodes[0]!.stableKey, nodes: textNodes });
    textNodes = [];
  };
  for (const node of nodes) {
    if (node.kind === "image") {
      flushText();
      parts.push({ kind: "image", key: node.stableKey, node });
    } else {
      textNodes.push(node);
    }
  }
  flushText();
  return parts;
}
